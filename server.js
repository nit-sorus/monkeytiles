import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';

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

// MongoDB Setup for Persistent Scores
const mongoUri = process.env.MONGODB_URI;
let db = null;
let scoresCollection = null;
let lifetimeScores = { Manya: 0, Nitish: 0 }; 

if (mongoUri) {
  const client = new MongoClient(mongoUri);
  client.connect().then(() => {
    console.log('Connected to MongoDB');
    db = client.db('monkeytiles');
    scoresCollection = db.collection('scores');
    
    scoresCollection.findOne({ _id: 'room_0314_lifetime' }).then(doc => {
      if (doc) {
        lifetimeScores = { Manya: doc.Manya || 0, Nitish: doc.Nitish || 0 };
        console.log('Loaded lifetime scores:', lifetimeScores);
      } else {
        scoresCollection.insertOne({ _id: 'room_0314_lifetime', Manya: 0, Nitish: 0 });
      }
    });
  }).catch(err => {
    console.error('MongoDB connection error:', err);
  });
}

async function updateLifetimeScore(winnerName) {
  if (!winnerName) return;
  const name = winnerName.toLowerCase();
  let key = null;
  if (name.includes('nitish')) key = 'Nitish';
  if (name.includes('manya')) key = 'Manya';
  if (!key) return;

  lifetimeScores[key] += 1;
  
  if (scoresCollection) {
    try {
      await scoresCollection.updateOne(
        { _id: 'room_0314_lifetime' },
        { $inc: { [key]: 1 } },
        { upsert: true }
      );
    } catch (err) {
      console.error('Failed to update score:', err);
    }
  }
}

// Initialize permanent room 0314
rooms.set('M-0314', {
  id: 'M-0314',
  hostToken: 'PERMANENT',
  lastActivityAt: Date.now(),
  players: [],
  board: [],
  gridSize: 6,
  firstFlippedIndex: null,
  activePlayerIndex: 0,
  gameStarted: false,
  isWaiting: false,
  winner: null
});

// Card Decks (synchronized with frontend)
const CARD_DECKS = {
  animals: [ '🐼', '🦁', '🐯', '🐨', '🦊', '🐸', '🐙', '🦋', '🦖', '🦄', '🦈', '🐝', '🦉', '🦩', '🦚', '🐉', '🍄', '🌵', '🐱', '🐶', '🐷', '🐮', '🐹', '🐰', '🐻', '🐵', '🐔', '🐧', '🐦', '🐣', '🦅', '🦆' ],
  food: [ '🍎', '🍕', '🍔', '🍟', '🌭', '🍿', '🍩', '🍪', '🎂', '🍦', '🍓', '🍇', '🍉', '🥑', '🌮', '🍣', '🧋', '☕', '🥨', '🥐', '🥞', '🧇', '🥓', '🍳', '🧀', '🫐', '🍍', '🥭', '🍒', '🍐', '🍋', '🍊' ],
  fun: [ '⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🎱', '🎯', '🎨', '🎸', '🎧', '🚀', '⛵', '🛸', '🚗', '🎮', '🎲', '♟️', '🎪', '🎭', '🎟️', '🏆', '🥇', '🎁', '🎈', '🎉', '⚡', '🔥', '🌈', '⭐', '💎', '🔮' ]
};

function generateBoard(gridSize = 6, deckId = 'animals') {
  const numPairs = (gridSize * gridSize) / 2;
  const pool = CARD_DECKS[deckId] || CARD_DECKS.animals;
  const shuffledPool = [...pool].sort(() => 0.5 - Math.random());
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
    symbol: card.symbol,
    isFlipped: card.isFlipped,
    isMatched: card.isMatched
  }));
}

function broadcastGameState(roomId, room) {
  const baseState = {
    id: room.id,
    players: room.players.map(p => ({ 
      id: p.id, 
      name: p.name, 
      score: p.score, 
      wins: p.wins || 0,
      isDisconnected: p.isDisconnected 
    })),
    gridSize: room.gridSize,
    activePlayerIndex: room.activePlayerIndex,
    gameStarted: room.gameStarted,
    winner: room.winner,
    isWaiting: room.isWaiting,
    deck: room.deck,
    hostId: room.players[0] ? room.players[0].id : null,
    board: buildBoardView(room.board),
    lifetimeScores: room.id === 'M-0314' ? lifetimeScores : undefined
  };

  // Send identical state to all players in the room
  io.to(roomId).emit('game-state', baseState);
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Create a Room
  socket.on('create-room', ({ playerName, gridSize, sessionToken, deck }) => {
    const roomId = `M-${Math.floor(1000 + Math.random() * 9000)}`;
    const size = parseInt(gridSize) || 6;
    const newRoom = {
      id: roomId,
      hostToken: sessionToken,
      lastActivityAt: Date.now(),
      players: [{ 
        id: socket.id, 
        sessionToken, 
        name: playerName || 'Player 1', 
        score: 0, 
        wins: 0,
        isDisconnected: false 
      }],
      board: [],
      gridSize: size,
      deck: deck || 'animals',
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
  socket.on('join-room', ({ roomId, playerName, sessionToken }) => {
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

    // Update room activity
    room.lastActivityAt = Date.now();

    room.players.push({
      id: socket.id,
      sessionToken,
      name: playerName || `Player ${room.players.length + 1}`,
      score: 0,
      wins: 0,
      isDisconnected: false
    });

    socket.join(cleanCode);
    socket.roomId = cleanCode;

    console.log(`User ${playerName} joined room: ${cleanCode}. Total players: ${room.players.length}`);
    broadcastGameState(cleanCode, room);
  });

  // Rejoin a Room
  socket.on('rejoin-room', ({ sessionToken }) => {
    if (!sessionToken) return;
    
    for (const [roomId, room] of rooms.entries()) {
      const player = room.players.find(p => p.sessionToken === sessionToken);
      if (player) {
        // Stop the disconnect deletion timer
        if (player.disconnectTimeout) {
          clearTimeout(player.disconnectTimeout);
          player.disconnectTimeout = null;
        }
        
        // Restore player
        player.id = socket.id;
        player.isDisconnected = false;
        
        room.lastActivityAt = Date.now();
        socket.join(roomId);
        socket.roomId = roomId;
        
        console.log(`User ${player.name} reconnected to room: ${roomId}`);
        socket.emit('room-created', roomId); // Force client to see they joined successfully
        broadcastGameState(roomId, room);
        return;
      }
    }
  });

  // Host starts game
  socket.on('start-game', () => {
    const roomId = socket.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    
    room.lastActivityAt = Date.now();

    if (room.players.length < 2) {
      socket.emit('error-message', 'Need at least 2 players to start!');
      return;
    }

    // Reset scores for all players
    room.players.forEach(p => p.score = 0);
    room.board = generateBoard(room.gridSize, room.deck);
    room.firstFlippedIndex = null;
    room.activePlayerIndex = Math.floor(Math.random() * room.players.length);
    room.gameStarted = true;
    room.isWaiting = false;
    room.winner = null;

    broadcastGameState(roomId, room);
  });

  // Flip Card logic
  socket.on('flip-card', (cardIndex) => {
    const roomId = socket.roomId;
    const room = rooms.get(roomId);
    if (!room || room.isWaiting || room.winner || !room.gameStarted) return;
    
    room.lastActivityAt = Date.now();

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
        
        if (room.board.every(c => c.isMatched)) {
          const p1Score = room.players[0]?.score || 0;
          const p2Score = room.players[1]?.score || 0;
          if (p1Score > p2Score) {
            room.winner = room.players[0].name;
            room.players[0].wins = (room.players[0].wins || 0) + 1;
          } else if (p2Score > p1Score) {
            room.winner = room.players[1].name;
            room.players[1].wins = (room.players[1].wins || 0) + 1;
          } else {
            room.winner = 'Tie';
          }
          room.gameStarted = false;
          
          // Permanent Room 0314 Logic
          if (room.id === 'M-0314' && room.winner !== 'Tie') {
            updateLifetimeScore(room.winner).then(() => {
              broadcastGameState(roomId, room);
            });
          } else {
            broadcastGameState(roomId, room);
          }
        } else {
          broadcastGameState(roomId, room);
        }

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
    room.lastActivityAt = Date.now();
    
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
    
    room.lastActivityAt = Date.now();

    room.players.forEach(p => p.score = 0);
    room.board = generateBoard(room.gridSize, room.deck);
    room.firstFlippedIndex = null;
    room.activePlayerIndex = Math.floor(Math.random() * room.players.length);
    room.gameStarted = true;
    room.isWaiting = false;
    room.winner = null;

    broadcastGameState(roomId, room);
  });

  // Explicit Leave (bypasses grace period)
  socket.on('explicit-leave', ({ sessionToken }) => {
    const roomId = socket.roomId;
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.players = room.players.filter(p => p.sessionToken !== sessionToken);
      
      if (room.id !== 'M-0314' && (room.players.length === 0 || room.hostToken === sessionToken)) {
        io.to(roomId).emit('room-closed');
        rooms.delete(roomId);
        console.log(`Room ${roomId} deleted (empty or host left explicitly)`);
      } else {
        if (room.activePlayerIndex >= room.players.length) {
          room.activePlayerIndex = 0;
        }
        io.to(roomId).emit('player-left', 'A player explicitly left the room');
        broadcastGameState(roomId, room);
      }
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    const roomId = socket.roomId;
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      const player = room.players.find(p => p.id === socket.id);
      
      if (player) {
        player.isDisconnected = true;
        
        // Start 60 second grace period
        player.disconnectTimeout = setTimeout(() => {
          const currentRoom = rooms.get(roomId);
          if (!currentRoom) return;
          
          currentRoom.players = currentRoom.players.filter(p => p.sessionToken !== player.sessionToken);
          
          // Delete room if empty OR if the host left (except for M-0314)
          if (currentRoom.id !== 'M-0314' && (currentRoom.players.length === 0 || currentRoom.hostToken === player.sessionToken)) {
            io.to(roomId).emit('room-closed');
            rooms.delete(roomId);
            console.log(`Room ${roomId} deleted (empty or host left)`);
          } else {
            if (currentRoom.activePlayerIndex >= currentRoom.players.length) {
              currentRoom.activePlayerIndex = 0;
            }
            io.to(roomId).emit('player-left', 'A player left the room');
            broadcastGameState(roomId, currentRoom);
          }
        }, 60000);
        
        // Broadcast immediately to show greyed out state
        broadcastGameState(roomId, room);
      }
    }
  });
});

// Zombie room cleanup interval (every 1 minute)
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    // Exempt M-0314 from cleanup
    if (roomId === 'M-0314') continue;
    
    // If no activity for 10 minutes (600,000 ms)
    if (now - room.lastActivityAt > 600000) {
      io.to(roomId).emit('room-closed');
      rooms.delete(roomId);
      console.log(`Zombie room deleted due to inactivity: ${roomId}`);
    }
  }
}, 60000);

httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
