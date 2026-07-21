import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  // Reduce ping/pong overhead for snappier feel
  pingInterval: 10000,
  pingTimeout: 5000
});

const PORT = process.env.PORT || 3001;

// Serve static files from the dist directory in production
app.use(express.static(path.join(__dirname, 'dist')));

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.url.startsWith('/socket.io')) {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  } else {
    next();
  }
});

// Game state storage
const rooms = new Map();

// Expanded symbols for memory cards (supports up to 8x8 grid = 32 pairs)
const SYMBOL_POOL = [
  '🐼', '🦁', '🐯', '🐨', '🦊', '🐸', '🐙', '🦋', 
  '🦖', '🦄', '🦈', '🐝', '🦉', '🦩', '🦚', '🐉', 
  '🍄', '🌵', '🐱', '🐶', '🐷', '🐮', '🐹', '🐰', 
  '🐻', '🐵', '🐔', '🐧', '🐦', '🐣', '🦅', '🦆'
];

function generateBoard(gridSize = 6) {
  const numPairs = (gridSize * gridSize) / 2;
  const shuffledPool = [...SYMBOL_POOL].sort(() => 0.5 - Math.random());
  const selectedSymbols = shuffledPool.slice(0, numPairs);
  const cards = [...selectedSymbols, ...selectedSymbols];
  const shuffledCards = cards.sort(() => 0.5 - Math.random());
  
  return shuffledCards.map((symbol, index) => ({
    id: index,
    symbol,        // always stored on server
    isFlipped: false,
    isMatched: false
  }));
}

/**
 * Build a "view" of the board for a specific socket.
 * Hides symbols for cards that are face-down and not matched.
 * This prevents cheating and ensures both players see cards correctly.
 */
function buildBoardView(board) {
  return board.map(card => ({
    id: card.id,
    symbol: (card.isFlipped || card.isMatched) ? card.symbol : null,
    isFlipped: card.isFlipped,
    isMatched: card.isMatched
  }));
}

function broadcastGameState(roomId, room) {
  const baseState = {
    id: room.id,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
    gridSize: room.gridSize,
    activePlayerIndex: room.activePlayerIndex,
    gameStarted: room.gameStarted,
    winner: room.winner,
    isWaiting: room.isWaiting,
    board: buildBoardView(room.board)
  };

  // Send identical state to all players in the room
  io.to(roomId).emit('game-state', baseState);
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Create a Room
  socket.on('create-room', ({ playerName, gridSize }) => {
    const roomId = `M-${Math.floor(1000 + Math.random() * 9000)}`;
    const size = parseInt(gridSize) || 6;
    const newRoom = {
      id: roomId,
      players: [{ id: socket.id, name: playerName || 'Player 1', score: 0 }],
      board: [],
      gridSize: size,
      firstFlippedIndex: null,
      activePlayerIndex: 0,
      gameStarted: false,
      isWaiting: false,
      winner: null
    };

    rooms.set(roomId, newRoom);
    socket.join(roomId);
    socket.roomId = roomId;

    socket.emit('room-created', roomId);
    broadcastGameState(roomId, newRoom);
    console.log(`Room created: ${roomId} with gridSize: ${size} by ${playerName}`);
  });

  // Join a Room
  socket.on('join-room', ({ roomId, playerName }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error-message', 'Room not found');
      return;
    }

    if (room.players.length >= 2) {
      socket.emit('error-message', 'Room is full');
      return;
    }

    room.players.push({
      id: socket.id,
      name: playerName || `Player ${room.players.length + 1}`,
      score: 0
    });

    socket.join(roomId);
    socket.roomId = roomId;

    console.log(`User ${playerName} joined room: ${roomId}`);
    
    if (room.players.length === 2) {
      room.gameStarted = true;
      room.board = generateBoard(room.gridSize);
      room.activePlayerIndex = Math.floor(Math.random() * 2);
      broadcastGameState(roomId, room);
    } else {
      broadcastGameState(roomId, room);
    }
  });

  // Flip Card — Server is the single source of truth
  socket.on('flip-card', (cardIndex) => {
    const roomId = socket.roomId;
    const room = rooms.get(roomId);
    
    if (!room || !room.gameStarted || room.isWaiting) return;

    const activePlayer = room.players[room.activePlayerIndex];
    if (activePlayer.id !== socket.id) return; // silently ignore, not their turn

    const card = room.board[cardIndex];
    if (!card || card.isFlipped || card.isMatched) return;

    // Flip the card
    card.isFlipped = true;

    if (room.firstFlippedIndex === null) {
      // First card of the pair
      room.firstFlippedIndex = cardIndex;
      broadcastGameState(roomId, room);

    } else {
      // Second card of the pair
      const firstIndex = room.firstFlippedIndex;
      const firstCard = room.board[firstIndex];
      room.firstFlippedIndex = null;

      if (firstCard.symbol === card.symbol) {
        // MATCH FOUND — keep flipped
        firstCard.isMatched = true;
        card.isMatched = true;
        room.players[room.activePlayerIndex].score++;
        
        const allMatched = room.board.every(c => c.isMatched);
        if (allMatched) {
          const p1 = room.players[0];
          const p2 = room.players[1];
          let winner;
          if (p1.score > p2.score) winner = p1.name;
          else if (p2.score > p1.score) winner = p2.name;
          else winner = 'Draw';
          room.winner = winner;
          room.gameStarted = false;
        }

        // On a match, the same player keeps their turn
        broadcastGameState(roomId, room);

      } else {
        // MISMATCH — show both briefly, then flip back
        room.isWaiting = true;
        broadcastGameState(roomId, room); // show both face-up for 1.2s

        setTimeout(() => {
          const currentRoom = rooms.get(roomId);
          if (!currentRoom) return;

          firstCard.isFlipped = false;
          card.isFlipped = false;
          currentRoom.isWaiting = false;
          // Switch turn to the other player
          currentRoom.activePlayerIndex = currentRoom.activePlayerIndex === 0 ? 1 : 0;
          
          broadcastGameState(roomId, currentRoom);
        }, 1200);
      }
    }
  });

  // Restart Game
  socket.on('restart-game', () => {
    const roomId = socket.roomId;
    const room = rooms.get(roomId);
    if (!room) return;

    room.players.forEach(p => p.score = 0);
    room.board = generateBoard(room.gridSize);
    room.firstFlippedIndex = null;
    room.activePlayerIndex = Math.floor(Math.random() * 2);
    room.gameStarted = true;
    room.isWaiting = false;
    room.winner = null;

    broadcastGameState(roomId, room);
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    const roomId = socket.roomId;
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.players = room.players.filter(p => p.id !== socket.id);

      if (room.players.length === 0) {
        rooms.delete(roomId);
        console.log(`Room ${roomId} deleted (empty)`);
      } else {
        room.gameStarted = false;
        room.winner = null;
        room.board = [];
        room.firstFlippedIndex = null;
        io.to(roomId).emit('player-left', 'Opponent disconnected');
        broadcastGameState(roomId, room);
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
