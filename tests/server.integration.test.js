import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { io as createClient } from 'socket.io-client';
import { startServer, stopServer } from '../server.js';

const EVENT_TIMEOUT_MS = 2000;

let serverUrl;
let host;
let guest;

function waitForEvent(socket, eventName, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, handleEvent);
      reject(new Error(`Timed out waiting for "${eventName}"`));
    }, EVENT_TIMEOUT_MS);

    const handleEvent = (payload) => {
      if (!predicate(payload)) return;

      clearTimeout(timeout);
      socket.off(eventName, handleEvent);
      resolve(payload);
    };

    socket.on(eventName, handleEvent);
  });
}

function connectClient(url) {
  return new Promise((resolve, reject) => {
    const socket = createClient(url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });

    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

before(async () => {
  const address = await startServer(0);
  serverUrl = `http://127.0.0.1:${address.port}`;
  [host, guest] = await Promise.all([
    connectClient(serverUrl),
    connectClient(serverUrl)
  ]);
});

after(async () => {
  await stopServer();
});

test('two clients can create, join, start, and synchronize a card flip', async () => {
  const roomCreated = waitForEvent(host, 'room-created');
  const hostAloneState = waitForEvent(
    host,
    'game-state',
    state => state.players.length === 1
  );

  host.emit('create-room', {
    playerName: 'Host',
    gridSize: 4,
    sessionToken: 'host-test-token',
    deck: 'animals'
  });

  const [roomId, initialState] = await Promise.all([
    roomCreated,
    hostAloneState
  ]);

  assert.match(roomId, /^M-\d{4}$/);
  assert.equal(initialState.players[0].name, 'Host');
  assert.equal(initialState.gameStarted, false);

  const hostJoinedState = waitForEvent(
    host,
    'game-state',
    state => state.players.length === 2
  );
  const guestJoinedState = waitForEvent(
    guest,
    'game-state',
    state => state.players.length === 2
  );

  guest.emit('join-room', {
    roomId,
    playerName: 'Guest',
    sessionToken: 'guest-test-token'
  });

  const [hostLobby, guestLobby] = await Promise.all([
    hostJoinedState,
    guestJoinedState
  ]);

  assert.deepEqual(
    hostLobby.players.map(player => player.name),
    ['Host', 'Guest']
  );
  assert.deepEqual(hostLobby.players, guestLobby.players);

  const hostStartedState = waitForEvent(
    host,
    'game-state',
    state => state.gameStarted
  );
  const guestStartedState = waitForEvent(
    guest,
    'game-state',
    state => state.gameStarted
  );

  host.emit('start-game');

  const [hostGame, guestGame] = await Promise.all([
    hostStartedState,
    guestStartedState
  ]);

  assert.equal(hostGame.board.length, 16);
  assert.deepEqual(hostGame.board, guestGame.board);

  const activePlayer = hostGame.players[hostGame.activePlayerIndex];
  const activeSocket = activePlayer.id === host.id ? host : guest;

  const hostFlippedState = waitForEvent(
    host,
    'game-state',
    state => state.board[0]?.isFlipped === true
  );
  const guestFlippedState = waitForEvent(
    guest,
    'game-state',
    state => state.board[0]?.isFlipped === true
  );

  activeSocket.emit('flip-card', 0);

  const [hostAfterFlip, guestAfterFlip] = await Promise.all([
    hostFlippedState,
    guestFlippedState
  ]);

  assert.equal(hostAfterFlip.board[0].isFlipped, true);
  assert.deepEqual(hostAfterFlip.board, guestAfterFlip.board);
});

test.todo('face-down card symbols are hidden from clients');
test.todo('a non-host player cannot start or restart a game');
test.todo('a duplicate nickname cannot replace an active player identity');