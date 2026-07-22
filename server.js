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
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, wins: p.wins || 0 })),
    gridSize: room.gridSize,
    activePlayerIndex: room.activePlayerIndex,
    gameStarted: room.gameStarted,
    winner: room.winner,
    isWaiting: room.isWaiting,
    hostId: room.players[0] ? room.players[0].id : null,
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
      players: [{ id: socket.id, name: playerName || 'Player 1', score: 0, wins: 0 }],
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

  // Join a Room (supports up to 4 players)
  socket.on('join-room', ({ roomId, playerName }) => {
    let cleanCode = (roomId || '').trim().toUpperCase();
    if (!cleanCode.startsWith('M-') && /^\d{4}$/.test(cleanCode)) {
      cleanCode = 'M-' + cleanCode;
    }

    const room = rooms.get(cleanCode);
    if (!room) {
      socket.emit('error-message', 'Invalid room code. Please check the code and try again.');
      return;
    }

    if (room.players.length >= 4) {
      socket.emit('error-message', 'Room is full (max 4 players)');
      return;
    }

    if (room.gameStarted) {
      socket.emit('error-message', 'Game is already in progress');
      return;
    }

    room.players.push({
      id: socket.id,
      name: playerName || `Player ${room.players.length + 1}`,
      score: 0,
      wins: 0
    });

    socket.join(cleanCode);
    socket.roomId = cleanCode;

    console.log(`User ${playerName} joined room: ${cleanCode}. Total players: ${room.players.length}`);
    broadcastGameState(cleanCode, room);
  });

  // Host starts game
  socket.on('start-game', () => {
    const roomId = socket.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.players.length < 2) {
      socket.emit('error-message', 'Need at least 2 players to start!');
      return;
    }

    room.players.forEach(p => p.score = 0);
    room.board = generateBoard(room.gridSize);
    room.activePlayerIndex = Math.floor(Math.random() * room.players.length);
    room.gameStarted = true;
    room.isWaiting = false;
    room.winner = null;

    broadcastGameState(roomId, room);
  });

  // Flip Card — Server is single source of truth
  socket.on('flip-card', (cardIndex) => {
    const roomId = socket.roomId;
    const room = rooms.get(roomId);
    
    if (!room || !room.gameStarted || room.isWaiting) return;

    const activePlayer = room.players[room.activePlayerIndex];
    if (!activePlayer || activePlayer.id !== socket.id) return; // silently ignore, not their turn

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
        // MATCH FOUND — keep flipped & add score
        firstCard.isMatched = true;
        card.isMatched = true;
        room.players[room.activePlayerIndex].score++;
        
        const allMatched = room.board.every(c => c.isMatched);
        if (allMatched) {
          const maxScore = Math.max(...room.players.map(p => p.score));
          const winners = room.players.filter(p => p.score === maxScore);
          
          if (winners.length === 1) {
            winners[0].wins = (winners[0].wins || 0) + 1;
            room.winner = winners[0].name;
          } else {
            winners.forEach(w => w.wins = (w.wins || 0) + 1);
            room.winner = `Draw between ${winners.map(w => w.name).join(' & ')}`;
          }
          room.gameStarted = false;
        }

        // On match, active player keeps turn
        broadcastGameState(roomId, room);

      } else {
        // MISMATCH — show both briefly, then flip back
        room.isWaiting = true;
        broadcastGameState(roomId, room);

        setTimeout(() => {
          const currentRoom = rooms.get(roomId);
          if (!currentRoom) return;

          firstCard.isFlipped = false;
          card.isFlipped = false;
          currentRoom.isWaiting = false;
          
          // Rotate turn to next player (2, 3, or 4 players)
          currentRoom.activePlayerIndex = (currentRoom.activePlayerIndex + 1) % currentRoom.players.length;
          
          broadcastGameState(roomId, currentRoom);
        }, 1200);
      }
    }
  });

  // Emote Broadcasting (Clash Royale Style)
  socket.on('send-emote', ({ emote }) => {
    const roomId = socket.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    const senderName = player ? player.name : 'Player';

    io.to(roomId).emit('receive-emote', {
      socketId: socket.id,
      senderName,
      emote,
      id: Date.now() + Math.random()
    });
  });

  // Restart Game
  socket.on('restart-game', () => {
    const roomId = socket.roomId;
    const room = rooms.get(roomId);
    if (!room) return;

    room.players.forEach(p => p.score = 0);
    room.board = generateBoard(room.gridSize);
    room.firstFlippedIndex = null;
    room.activePlayerIndex = Math.floor(Math.random() * room.players.length);
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
        if (room.activePlayerIndex >= room.players.length) {
          room.activePlayerIndex = 0;
        }
        io.to(roomId).emit('player-left', 'A player left the room');
        broadcastGameState(roomId, room);
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
