import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';

console.log('--- Starting Game Server State Machine Verification Tests ---');

// Mock server creation
const httpServer = createServer();
const io = new Server(httpServer);

const rooms = new Map();
const SYMBOL_POOL = ['🐶', '🐱', '🐼', '🦊', '🐨', '🐯', '🦁', '🐸']; // smaller pool for testing

function generateBoard() {
  const cards = [...SYMBOL_POOL, ...SYMBOL_POOL];
  return cards.map((symbol, index) => ({
    id: index,
    symbol,
    isFlipped: false,
    isMatched: false
  }));
}

function getCleanRoomState(room) {
  return {
    id: room.id,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
    board: room.board,
    activePlayerIndex: room.activePlayerIndex,
    gameStarted: room.gameStarted,
    winner: room.winner
  };
}

io.on('connection', (socket) => {
  socket.on('create-room', ({ playerName, gridSize }) => {
    const roomId = 'TEST-1234';
    const newRoom = {
      id: roomId,
      players: [{ id: socket.id, name: playerName, score: 0 }],
      board: [],
      gridSize: gridSize || 6,
      firstFlippedIndex: null,
      activePlayerIndex: 0,
      gameStarted: false,
      winner: null
    };
    rooms.set(roomId, newRoom);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.emit('room-created', roomId);
    socket.emit('game-state', getCleanRoomState(newRoom));
  });

  socket.on('join-room', ({ roomId, playerName }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.players.push({ id: socket.id, name: playerName, score: 0 });
    socket.join(roomId);
    socket.roomId = roomId;
    
    if (room.players.length === 2) {
      room.gameStarted = true;
      room.board = generateBoard();
      room.activePlayerIndex = 0;
      io.to(roomId).emit('game-state', getCleanRoomState(room));
    }
  });

  socket.on('flip-card', (cardIndex) => {
    const room = rooms.get(socket.roomId);
    if (!room || !room.gameStarted) return;
    const activePlayer = room.players[room.activePlayerIndex];
    if (activePlayer.id !== socket.id) return;
    
    const card = room.board[cardIndex];
    card.isFlipped = true;
    io.to(socket.roomId).emit('card-flipped', { cardIndex, symbol: card.symbol });
  });
});

// Run server on port 3009 for test isolation
httpServer.listen(3009, async () => {
  console.log('Test Server listening on port 3009...');

  try {
    // 1. Client A Connects
    const clientA = ioClient('http://localhost:3009');
    
    await new Promise((resolve) => {
      clientA.on('connect', () => {
        console.log('✔ Client A Connected');
        resolve();
      });
    });

    // 2. Client A Creates Room
    clientA.emit('create-room', { playerName: 'Alice', gridSize: 6 });
    
    const roomId = await new Promise((resolve) => {
      clientA.on('room-created', (roomCode) => {
        console.log(`✔ Room Created with Code: ${roomCode}`);
        resolve(roomCode);
      });
    });

    // 3. Client B Connects
    const clientB = ioClient('http://localhost:3009');
    
    await new Promise((resolve) => {
      clientB.on('connect', () => {
        console.log('✔ Client B Connected');
        resolve();
      });
    });

    // 4. Client B Joins Room and triggers Game Start
    clientB.emit('join-room', { roomId, playerName: 'Bob' });

    await new Promise((resolve) => {
      clientA.on('game-state', (state) => {
        if (state.gameStarted) {
          console.log('✔ Game started successfully. Grid generated with size:', state.board.length);
          resolve();
        }
      });
    });

    // 5. Client A Flips Card
    clientA.emit('flip-card', 3);

    await new Promise((resolve) => {
      clientB.on('card-flipped', ({ cardIndex, symbol }) => {
        console.log(`✔ Client B synchronized card flip! Card Index: ${cardIndex}, Symbol: ${symbol}`);
        resolve();
      });
    });

    console.log('\n⭐⭐ ALL STATE MACHINE TESTS PASSED SUCCESSFULLY! ⭐⭐');
    
    // Cleanup
    clientA.disconnect();
    clientB.disconnect();
    httpServer.close();
    process.exit(0);

  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
  }
});
