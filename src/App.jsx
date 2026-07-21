import React, { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { 
  Gamepad2, 
  Check, 
  Trophy, 
  RefreshCw, 
  Share2, 
  BookOpen,
  Layers
} from 'lucide-react';

const SOCKET_URL = import.meta.env.DEV 
  ? 'http://localhost:3001' 
  : 'https://monkeytiles.onrender.com';

const CARD_DECKS = {
  animals: {
    name: 'Animals 🦁',
    symbols: [
      '🐼', '🦁', '🐯', '🐨', '🦊', '🐸', '🐙', '🦋', 
      '🦖', '🦄', '🦈', '🐝', '🦉', '🦩', '🦚', '🐉', 
      '🍄', '🌵', '🐱', '🐶', '🐷', '🐮', '🐹', '🐰', 
      '🐻', '🐵', '🐔', '🐧', '🐦', '🐣', '🦅', '🦆'
    ]
  },
  food: {
    name: 'Food & Treats 🍕',
    symbols: [
      '🍎', '🍕', '🍔', '🍟', '🌭', '🍿', '🍩', '🍪', 
      '🎂', '🍦', '🍓', '🍇', '🍉', '🥑', '🌮', '🍣', 
      '🧋', '☕', '🥨', '🥐', '🥞', '🧇', '🥓', '🍳', 
      '🧀', '🫐', '🍍', '🥭', '🍒', '🍐', '🍋', '🍊'
    ]
  },
  fun: {
    name: 'Sports & Fun ⚽',
    symbols: [
      '⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🎱', '🎯', 
      '🎨', '🎸', '🎧', '🚀', '⛵', '🛸', '🚗', '🎮', 
      '🎲', '♟️', '🎪', '🎭', '🎟️', '🏆', '🥇', '🎁', 
      '🎈', '🎉', '⚡', '🔥', '🌈', '⭐', '💎', '🔮'
    ]
  }
};

// Seeded random number generator for Daily Board
function seededRandom(seed) {
  const x = Math.sin(seed++) * 10000;
  return x - Math.floor(x);
}

function generateSeededBoard(gridSize, dateSeed, deckKey = 'animals') {
  const pool = CARD_DECKS[deckKey]?.symbols || CARD_DECKS.animals.symbols;
  const numPairs = (gridSize * gridSize) / 2;
  const symbols = pool.slice(0, numPairs);
  const cards = [...symbols, ...symbols];
  
  let seed = dateSeed;
  for (let i = cards.length - 1; i > 0; i--) {
    const r = seededRandom(seed);
    seed += 1;
    const j = Math.floor(r * (i + 1));
    const temp = cards[i];
    cards[i] = cards[j];
    cards[j] = temp;
  }
  
  return cards.map((symbol, index) => ({
    id: index,
    symbol,
    isFlipped: false,
    isMatched: false
  }));
}

function generateLocalBoard(gridSize, deckKey = 'animals') {
  const pool = CARD_DECKS[deckKey]?.symbols || CARD_DECKS.animals.symbols;
  const numPairs = (gridSize * gridSize) / 2;
  const shuffledPool = [...pool].sort(() => 0.5 - Math.random());
  const selectedSymbols = shuffledPool.slice(0, numPairs);
  const cards = [...selectedSymbols, ...selectedSymbols];
  const shuffledCards = cards.sort(() => 0.5 - Math.random());
  
  return shuffledCards.map((symbol, index) => ({
    id: index,
    symbol,
    isFlipped: false,
    isMatched: false
  }));
}

function App() {
  const [socket, setSocket] = useState(null);
  const [gameMode, setGameMode] = useState('solo'); // 'solo', 'local', 'friend', 'daily'
  const [gridSize, setGridSize] = useState(6);
  const [selectedDeck, setSelectedDeck] = useState('animals');
  
  // Local (Solo / Daily / Pass & Play) State
  const [soloBoard, setSoloBoard] = useState([]);
  const [soloFlipped, setSoloFlipped] = useState([]);
  const [wastedTurns, setWastedTurns] = useState(0);
  const [soloIsWaiting, setSoloIsWaiting] = useState(false);
  const [soloWinner, setSoloWinner] = useState(false);

  // Pass & Play 2-Player State
  const [localP1Score, setLocalP1Score] = useState(0);
  const [localP2Score, setLocalP2Score] = useState(0);
  const [localActivePlayer, setLocalActivePlayer] = useState(1);
  const [localWinner, setLocalWinner] = useState(null);

  // Online Friend Mode Socket State
  const [playerName, setPlayerName] = useState(() => localStorage.getItem('memory_playerName') || '');
  const [isNameSet, setIsNameSet] = useState(false);
  const [roomIdInput, setRoomIdInput] = useState('');
  const [roomId, setRoomId] = useState('');
  const [gameState, setGameState] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [copied, setCopied] = useState(false);

  // Initialize Local Boards (Solo, Daily, Local Pass & Play)
  useEffect(() => {
    if (gameMode === 'solo' || gameMode === 'local') {
      setSoloBoard(generateLocalBoard(gridSize, selectedDeck));
      setSoloFlipped([]);
      setWastedTurns(0);
      setSoloIsWaiting(false);
      setSoloWinner(false);
      setLocalP1Score(0);
      setLocalP2Score(0);
      setLocalActivePlayer(1);
      setLocalWinner(null);
    } else if (gameMode === 'daily') {
      const today = new Date();
      const dateSeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
      setSoloBoard(generateSeededBoard(gridSize, dateSeed, selectedDeck));
      setSoloFlipped([]);
      setWastedTurns(0);
      setSoloIsWaiting(false);
      setSoloWinner(false);
    }
  }, [gameMode, gridSize, selectedDeck]);

  // Parse room from URL query on load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      setGameMode('friend');
      setRoomIdInput(roomParam);
    }
  }, []);

  // Socket setup for online multiplayer
  // Server is the SINGLE SOURCE OF TRUTH — all updates come only from 'game-state' events
  useEffect(() => {
    if (gameMode !== 'friend') {
      if (socket) {
        socket.disconnect();
        setSocket(null);
      }
      return;
    }

    const newSocket = io(SOCKET_URL, {
      transports: ['websocket'], // skip polling, connect faster
      reconnectionAttempts: 5
    });
    setSocket(newSocket);

    newSocket.on('room-created', (createdRoomId) => {
      setRoomId(createdRoomId);
      setErrorMsg('');
      const newUrl = `${window.location.origin}${window.location.pathname}?room=${createdRoomId}`;
      window.history.pushState({ path: newUrl }, '', newUrl);
    });

    // *** ALL board state comes from here — no card-flipped/card-flipped-back events ***
    newSocket.on('game-state', (state) => {
      setGameState(state);
      if (state.gridSize) setGridSize(state.gridSize);
      setErrorMsg('');
    });

    newSocket.on('player-left', () => {
      setErrorMsg('Opponent left the game.');
      setGameState(prev => prev ? { ...prev, gameStarted: false, winner: null, board: [] } : null);
    });

    newSocket.on('error-message', (err) => {
      setErrorMsg(err);
    });

    return () => {
      newSocket.disconnect();
    };
  }, [gameMode]);

  // Local Board Click (Solo, Daily, and Pass & Play)
  const handleSoloCardClick = (cardIndex) => {
    if (soloIsWaiting || soloWinner || localWinner) return;

    const clickedCard = soloBoard[cardIndex];
    if (clickedCard.isFlipped || clickedCard.isMatched) return;

    // Deep clone the board to avoid mutation bugs
    const updatedBoard = soloBoard.map((c, i) => i === cardIndex ? { ...c, isFlipped: true } : { ...c });
    setSoloBoard(updatedBoard);

    const newFlipped = [...soloFlipped, cardIndex];
    setSoloFlipped(newFlipped);

    if (newFlipped.length === 2) {
      const [firstIndex, secondIndex] = newFlipped;
      const firstCard = updatedBoard[firstIndex];
      const secondCard = updatedBoard[secondIndex];

      if (firstCard.symbol === secondCard.symbol) {
        // MATCH
        const matchedBoard = updatedBoard.map((c, i) =>
          i === firstIndex || i === secondIndex ? { ...c, isMatched: true } : c
        );
        setSoloBoard(matchedBoard);
        setSoloFlipped([]);

        const newP1 = localP1Score + (gameMode === 'local' && localActivePlayer === 1 ? 1 : 0);
        const newP2 = localP2Score + (gameMode === 'local' && localActivePlayer === 2 ? 1 : 0);

        if (gameMode === 'local') {
          if (localActivePlayer === 1) setLocalP1Score(prev => prev + 1);
          else setLocalP2Score(prev => prev + 1);
        }
        
        const allMatched = matchedBoard.every(c => c.isMatched);
        if (allMatched) {
          if (gameMode === 'local') {
            if (newP1 > newP2) setLocalWinner('Player 1');
            else if (newP2 > newP1) setLocalWinner('Player 2');
            else setLocalWinner('Draw');
          } else {
            setSoloWinner(true);
          }
        }
      } else {
        // MISMATCH
        setSoloIsWaiting(true);
        if (gameMode !== 'local') setWastedTurns(prev => prev + 1);
        
        setTimeout(() => {
          setSoloBoard(prev => prev.map((c, i) =>
            i === firstIndex || i === secondIndex ? { ...c, isFlipped: false } : c
          ));
          setSoloFlipped([]);
          setSoloIsWaiting(false);

          if (gameMode === 'local') {
            setWastedTurns(prev => prev + 1);
            setLocalActivePlayer(prev => prev === 1 ? 2 : 1);
          }
        }, 1000);
      }
    }
  };

  // Online Multiplayer Tile Click — just emit the intent; server sends back full state
  const handleCardClick = (cardIndex) => {
    if (!socket || !gameState || gameState.isWaiting || gameState.winner) return;
    
    const me = gameState.players.find(p => p.id === socket.id);
    const activePlayer = gameState.players[gameState.activePlayerIndex];
    if (!me || !activePlayer || me.id !== activePlayer.id) return;

    const card = gameState.board[cardIndex];
    if (!card || card.isFlipped || card.isMatched) return;

    // Do NOT update state locally — wait for server's game-state event
    socket.emit('flip-card', cardIndex);
  };

  const handleSaveName = (e) => {
    e.preventDefault();
    if (playerName.trim()) {
      localStorage.setItem('memory_playerName', playerName.trim());
      setIsNameSet(true);
    }
  };

  const handleCreateRoom = () => {
    if (!socket) return;
    socket.emit('create-room', { playerName, gridSize });
  };

  const handleJoinRoom = (e) => {
    e.preventDefault();
    if (!socket || !roomIdInput.trim()) return;
    const cleanRoomId = roomIdInput.trim().toUpperCase();
    socket.emit('join-room', { roomId: cleanRoomId, playerName });
    setRoomId(cleanRoomId);
  };

  const handleRestartGame = () => {
    if (gameMode === 'solo' || gameMode === 'daily' || gameMode === 'local') {
      const currentMode = gameMode;
      setGameMode('');
      setTimeout(() => setGameMode(currentMode), 0);
    } else if (socket) {
      socket.emit('restart-game');
    }
  };

  const handleLeaveRoom = () => {
    if (socket) {
      socket.disconnect();
      setSocket(null);
    }
    setRoomId('');
    setRoomIdInput('');
    setGameState(null);
    setErrorMsg('');
    const newUrl = `${window.location.origin}${window.location.pathname}`;
    window.history.pushState({ path: newUrl }, '', newUrl);
    setGameMode('solo');
  };

  const copyRoomLink = () => {
    const link = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const myPlayer = gameState?.players.find(p => p.id === socket?.id);
  const opponentPlayer = gameState?.players.find(p => p.id !== socket?.id);
  const isMyTurn = gameState && socket && !gameState.winner &&
    gameState.players[gameState.activePlayerIndex]?.id === socket.id;

  return (
    <>
      {/* Header */}
      <header style={{ margin: '16px auto 24px', width: '90%', maxWidth: '1200px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '3.0rem', filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.12))' }}>🐵</span>
          <h1 style={{ fontSize: '2.0rem', margin: 0, fontWeight: 800, textTransform: 'lowercase', letterSpacing: '0.25em', color: 'var(--text-primary)' }}>
            monkeytiles
          </h1>
        </div>
      </header>

      {/* Main Container */}
      <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px 24px' }}>
        <div className="game-container">
          
          {/* Left Column: Options, Controls & Scoring */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '100%' }}>
            
            {/* Game Modes Panel */}
            <div className="glass-panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <h2 style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px', margin: 0 }}>
                <Gamepad2 size={16} style={{ color: 'var(--accent-primary)' }} /> Select Game Mode
              </h2>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                {[
                  { key: 'solo', label: '🎮 Play Solo' },
                  { key: 'friend', label: '👥 With Friend' },
                  { key: 'local', label: '🎲 Pass & Play' },
                  { key: 'daily', label: '📅 "Your People"' },
                ].map(({ key, label }) => (
                  <button
                    key={key}
                    className={`btn-secondary${gameMode === key ? ' active' : ''}`}
                    onClick={() => setGameMode(key)}
                    style={{
                      padding: '10px 8px',
                      fontSize: '0.8rem',
                      justifyContent: 'center',
                      background: gameMode === key ? 'rgba(0,168,132,0.15)' : 'rgba(255,255,255,0.5)',
                      border: `1.5px solid ${gameMode === key ? 'var(--accent-primary)' : 'rgba(0,0,0,0.08)'}`,
                      fontWeight: gameMode === key ? 700 : 500
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Grid Size Selector */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px', borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: '10px' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)' }}>Grid:</span>
                <div className="grid-toggle-bar">
                  {[4, 6, 8].map(size => (
                    <button 
                      key={size}
                      className={`grid-toggle-btn${gridSize === size ? ' active' : ''}`}
                      onClick={() => { if (gameMode !== 'friend' || !roomId) setGridSize(size); }}
                      disabled={gameMode === 'friend' && !!roomId}
                    >
                      {size}×{size}
                    </button>
                  ))}
                </div>
              </div>

              {/* Card Deck Selector */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Layers size={13} /> Deck:
                </span>
                <select 
                  className="input-field" 
                  value={selectedDeck} 
                  onChange={(e) => setSelectedDeck(e.target.value)}
                  style={{ width: 'auto', padding: '4px 8px', fontSize: '0.8rem' }}
                >
                  {Object.entries(CARD_DECKS).map(([key, deck]) => (
                    <option key={key} value={key}>{deck.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Online Multiplayer Lobby Panel */}
            {gameMode === 'friend' && (
              <div className="glass-panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {!isNameSet ? (
                  <form onSubmit={handleSaveName} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <h3 style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>Enter Nickname:</h3>
                    <input
                      type="text"
                      className="input-field"
                      placeholder="Your Nickname"
                      value={playerName}
                      onChange={(e) => setPlayerName(e.target.value)}
                      maxLength={15}
                      required
                    />
                    <button type="submit" className="btn-primary" style={{ width: '100%', padding: '8px', fontSize: '0.85rem' }}>
                      Set Name
                    </button>
                  </form>
                ) : !roomId ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <button onClick={handleCreateRoom} className="btn-primary" style={{ width: '100%', padding: '10px', fontSize: '0.85rem' }}>
                      Create Room ({gridSize}×{gridSize})
                    </button>
                    
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <hr style={{ flex: 1, border: 'none', borderBottom: '1px solid var(--border-color)' }} />
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>OR JOIN</span>
                      <hr style={{ flex: 1, border: 'none', borderBottom: '1px solid var(--border-color)' }} />
                    </div>

                    <form onSubmit={handleJoinRoom} style={{ display: 'flex', gap: '6px' }}>
                      <input
                        type="text"
                        className="input-field"
                        placeholder="Room Code"
                        value={roomIdInput}
                        onChange={(e) => setRoomIdInput(e.target.value)}
                        required
                        style={{ padding: '8px 10px', fontSize: '0.8rem' }}
                      />
                      <button type="submit" className="btn-secondary" style={{ padding: '8px 12px', fontSize: '0.8rem' }}>
                        Join
                      </button>
                    </form>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {/* Room code + share */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                        Code: <strong style={{ color: 'var(--accent-primary)', letterSpacing: '0.05em' }}>{roomId}</strong>
                      </span>
                      <button onClick={copyRoomLink} className="btn-icon" title="Copy link">
                        {copied ? <Check size={14} style={{ color: 'var(--accent-success)' }} /> : <Share2 size={14} />}
                      </button>
                    </div>

                    {/* Turn indicator */}
                    {gameState?.gameStarted && !gameState.winner && (
                      <div style={{
                        textAlign: 'center',
                        padding: '6px 10px',
                        background: isMyTurn ? 'rgba(0,168,132,0.15)' : 'rgba(0,0,0,0.04)',
                        borderRadius: '8px',
                        fontSize: '0.82rem',
                        fontWeight: 700,
                        color: isMyTurn ? 'var(--accent-primary)' : 'var(--text-secondary)'
                      }}>
                        {isMyTurn ? '🎯 Your turn!' : `⏳ ${opponentPlayer?.name || 'Opponent'}'s turn…`}
                      </div>
                    )}

                    {/* Scores */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginTop: '4px' }}>
                      {[
                        { player: myPlayer, label: `${playerName} (You)`, isActive: isMyTurn },
                        { player: opponentPlayer, label: opponentPlayer?.name || 'Waiting for opponent…', isActive: !isMyTurn && gameState?.gameStarted }
                      ].map(({ player, label, isActive }, i) => (
                        <div key={i} style={{
                          display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem',
                          padding: '7px 10px', borderRadius: '6px',
                          background: isActive && gameState?.gameStarted && !gameState.winner ? 'rgba(0,168,132,0.08)' : 'rgba(0,0,0,0.03)',
                          border: `1px solid ${isActive && gameState?.gameStarted && !gameState.winner ? 'var(--accent-primary)' : 'transparent'}`
                        }}>
                          <span>{label}</span>
                          <strong>{player?.score ?? 0} pairs</strong>
                        </div>
                      ))}
                    </div>

                    {/* Winner Banner */}
                    {gameState?.winner && (
                      <div style={{ marginTop: '6px', padding: '12px', background: 'rgba(0, 168, 132, 0.1)', borderRadius: '8px', border: '1px solid var(--accent-primary)', display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center' }}>
                        <div style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--accent-primary)' }}>
                          {gameState.winner === 'Draw' ? "🤝 It's a Tie!" : `🏆 ${gameState.winner} Wins!`}
                        </div>
                        <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
                          <button onClick={handleRestartGame} className="btn-primary" style={{ flex: 1, padding: '7px', fontSize: '0.8rem', display: 'flex', gap: '4px', alignItems: 'center', justifyContent: 'center' }}>
                            <RefreshCw size={12} /> Play Again
                          </button>
                          <button onClick={handleLeaveRoom} className="btn-secondary" style={{ padding: '7px 12px', fontSize: '0.8rem' }}>
                            Leave
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {errorMsg && <div style={{ fontSize: '0.75rem', color: 'var(--accent-danger)', textAlign: 'center', marginTop: '4px' }}>{errorMsg}</div>}
              </div>
            )}

            {/* Pass & Play Scores */}
            {gameMode === 'local' && (
              <div className="glass-panel" style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {[
                  { label: 'Player 1', score: localP1Score, active: localActivePlayer === 1 && !localWinner },
                  { label: 'Player 2', score: localP2Score, active: localActivePlayer === 2 && !localWinner }
                ].map(({ label, score, active }, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', padding: '7px 10px',
                    background: active ? 'rgba(0,168,132,0.1)' : 'rgba(0,0,0,0.03)',
                    border: `1px solid ${active ? 'var(--accent-primary)' : 'transparent'}`, borderRadius: '7px'
                  }}>
                    <span>{label} {active ? '🎯' : ''}</span>
                    <strong>{score} pairs</strong>
                  </div>
                ))}

                {localWinner && (
                  <div style={{ marginTop: '6px', padding: '10px', background: 'rgba(0, 168, 132, 0.1)', borderRadius: '8px', border: '1px solid var(--accent-primary)', textAlign: 'center' }}>
                    <div style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--accent-primary)', marginBottom: '8px' }}>
                      {localWinner === 'Draw' ? "🤝 It's a Tie!" : `🏆 ${localWinner} Wins!`}
                    </div>
                    <button onClick={handleRestartGame} className="btn-primary" style={{ width: '100%', padding: '7px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                      <RefreshCw size={12} /> Play Again
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Solo / Daily Score */}
            {(gameMode === 'solo' || gameMode === 'daily') && (
              <div className="glass-panel" style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Trophy size={14} style={{ color: 'var(--accent-warning)' }} /> Wasted Turns
                </span>
                <strong style={{ fontSize: '1.3rem', color: wastedTurns > 8 ? 'var(--accent-danger)' : 'var(--text-primary)' }}>
                  {wastedTurns}
                </strong>
              </div>
            )}

            {/* Rules */}
            <div className="glass-panel" style={{ padding: '14px' }}>
              <h3 style={{ fontSize: '0.82rem', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-secondary)', margin: '0 0 6px' }}>
                <BookOpen size={13} style={{ color: 'var(--accent-primary)' }} /> How to Play
              </h3>
              <p style={{ fontSize: '0.73rem', color: 'var(--text-muted)', lineHeight: '1.45', margin: 0 }}>
                Flip 2 cards at a time to find matching pairs. A match keeps them open and earns a point — then flip again. No match? Cards flip back and the turn passes. Most pairs wins!
              </p>
            </div>

          </div>

          {/* Right Column: Game Grid */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
            
            <div className="glass-panel" style={{ padding: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%' }}>
              
              {/* Local Board: Solo, Daily, Pass&Play, or Friend waiting for opponent */}
              {((gameMode !== 'friend') || (gameMode === 'friend' && (!gameState || (!gameState.gameStarted && !gameState.winner)))) && (
                <div className={`game-grid grid-${gridSize}`}>
                  {soloBoard.map((card, index) => {
                    const isVisible = card.isFlipped || card.isMatched;
                    return (
                      <div 
                        key={card.id}
                        className={`tile-card${isVisible ? ' flipped' : ''}${card.isMatched ? ' matched' : ''}`}
                        onClick={() => handleSoloCardClick(index)}
                      >
                        <div className="tile-inner">
                          <div className="tile-face tile-front" />
                          <div className="tile-face tile-back">
                            {!isVisible && <span className="tile-back-watermark">MT</span>}
                            {isVisible ? card.symbol : ''}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Online Multiplayer Board — driven entirely by server game-state */}
              {gameMode === 'friend' && gameState && (gameState.gameStarted || gameState.winner) && (
                <div className={`game-grid grid-${gridSize}`}>
                  {gameState.board.map((card, index) => {
                    const isVisible = card.isFlipped || card.isMatched;
                    return (
                      <div 
                        key={card.id}
                        className={`tile-card${isVisible ? ' flipped' : ''}${card.isMatched ? ' matched' : ''}`}
                        onClick={() => handleCardClick(index)}
                        style={{ cursor: isMyTurn && !card.isFlipped && !card.isMatched && !gameState.winner ? 'pointer' : 'default' }}
                      >
                        <div className="tile-inner">
                          <div className="tile-face tile-front" />
                          <div className="tile-face tile-back">
                            {!isVisible && <span className="tile-back-watermark">MT</span>}
                            {isVisible ? card.symbol : ''}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

            </div>
          </div>

          {/* Solo/Daily Win Overlay */}
          {(gameMode === 'solo' || gameMode === 'daily') && soloWinner && (
            <div style={{
              position: 'fixed', inset: 0,
              background: 'rgba(11, 20, 26, 0.6)',
              backdropFilter: 'blur(4px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
            }}>
              <div className="glass-panel" style={{ width: '90%', maxWidth: '300px', padding: '28px', textAlign: 'center' }}>
                <div style={{ fontSize: '3.5rem', marginBottom: '8px' }}>🎉</div>
                <h2 style={{ fontSize: '1.4rem', margin: '0 0 12px', color: 'var(--accent-primary)' }}>Board Cleared!</h2>
                <div style={{ padding: '12px', background: 'rgba(0, 168, 132, 0.08)', borderRadius: '8px', marginBottom: '16px' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'block', marginBottom: '2px' }}>Wasted Turns</span>
                  <strong style={{ fontSize: '2rem', color: 'var(--accent-primary)' }}>{wastedTurns}</strong>
                </div>
                <button onClick={handleRestartGame} className="btn-primary" style={{ width: '100%', padding: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                  <RefreshCw size={14} /> Play Again
                </button>
              </div>
            </div>
          )}

        </div>
      </main>

      <footer style={{ padding: '10px 0', fontSize: '0.7rem', textAlign: 'center', color: 'var(--text-muted)' }}>
        monkeytiles © 2026
      </footer>
    </>
  );
}

export default App;
