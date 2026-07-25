import React, { useState, useEffect } from 'react';
import { io } from 'socket.io-client';
import { 
  Gamepad2, 
  Check, 
  Trophy, 
  RefreshCw, 
  Share2, 
  BookOpen,
  Layers,
  LogOut,
  Loader2,
  Play
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
      '⚽', '🏀', '🏈', '⚾', '<ctrl42>', '🏐', '🎱', '🎯', 
      '🎨', '🎸', '🎧', '🚀', '⛵', '🛸', '🚗', '🎮', 
      '🎲', '♟️', '🎪', '🎭', '🎟️', '🏆', '🥇', '🎁', 
      '🎈', '🎉', '⚡', '🔥', '🌈', '⭐', '💎', '🔮'
    ]
  }
};

// Web Audio API synthesized match chime (works cross-browser without external assets)
function playMatchSound() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    
    // Note 1: E5 (659.25Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, now);
    gain1.gain.setValueAtTime(0.15, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.3);

    // Note 2: A5 (880Hz)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880, now + 0.1);
    gain2.gain.setValueAtTime(0.2, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.1);
    osc2.stop(now + 0.45);
  } catch (e) {
    // Silently ignore browser audio policy restrictions
  }
}

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
  const [sessionToken] = useState(() => {
    let token = localStorage.getItem('memory_sessionToken');
    if (!token) {
      token = window.crypto && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2) + Date.now().toString(36);
      localStorage.setItem('memory_sessionToken', token);
    }
    return token;
  });
  const [isNameSet, setIsNameSet] = useState(false);
  const [roomIdInput, setRoomIdInput] = useState('');
  const [roomId, setRoomId] = useState('');
  const [gameState, setGameState] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [showPermanentRoomModal, setShowPermanentRoomModal] = useState(false);

  // Clash Royale Style Emote Overlay State
  const [activeEmotes, setActiveEmotes] = useState([]);

  // Initialize Boards for all modes (including placeholder board for Friend lobby)
  useEffect(() => {
    if (gameMode === 'daily') {
      const today = new Date();
      const dateSeed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
      setSoloBoard(generateSeededBoard(gridSize, dateSeed, selectedDeck));
    } else {
      setSoloBoard(generateLocalBoard(gridSize, selectedDeck));
    }
    setSoloFlipped([]);
    setWastedTurns(0);
    setSoloIsWaiting(false);
    setSoloWinner(false);
    setLocalP1Score(0);
    setLocalP2Score(0);
    setLocalActivePlayer(1);
    setLocalWinner(null);
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
  useEffect(() => {
    if (gameMode !== 'friend') {
      if (socket) {
        socket.disconnect();
        setSocket(null);
      }
      return;
    }

    const newSocket = io(SOCKET_URL, {
      transports: ['websocket'],
      reconnectionAttempts: 10
    });
    setSocket(newSocket);

    newSocket.on('connect', () => {
      // Secretly pass Session Token to resume any dropped sessions
      newSocket.emit('rejoin-room', { sessionToken });
    });

    newSocket.on('room-created', (createdRoomId) => {
      setRoomId(createdRoomId);
      setIsJoining(false);
      setErrorMsg('');
      const newUrl = `${window.location.origin}${window.location.pathname}?room=${createdRoomId}`;
      window.history.pushState({ path: newUrl }, '', newUrl);
    });

    newSocket.on('room-closed', (msg) => {
      setIsJoining(false);
      setGameState(null);
      setRoomId('');
      setErrorMsg(msg || 'Room was closed.');
      const newUrl = `${window.location.origin}${window.location.pathname}`;
      window.history.pushState({ path: newUrl }, '', newUrl);
    });

    newSocket.on('game-state', (state) => {
      if (state && state.id) {
        setRoomId(state.id);
      }
      setIsJoining(false);
      setGameState(prev => {
        // Trigger sound if a new match was made on server
        if (prev && state && state.board) {
          const prevMatches = prev.board.filter(c => c.isMatched).length;
          const newMatches = state.board.filter(c => c.isMatched).length;
          if (newMatches > prevMatches) {
            playMatchSound();
          }
        }
        return state;
      });
      if (state.gridSize) setGridSize(state.gridSize);
      if (state.deck) setSelectedDeck(state.deck);
      setErrorMsg('');
    });

    newSocket.on('player-left', (msg) => {
      setIsJoining(false);
      setErrorMsg(msg || 'A player left the game.');
      setGameState(prev => prev ? { ...prev, gameStarted: false, winner: null } : null);
    });

    newSocket.on('receive-emote', (emoteData) => {
      setActiveEmotes(prev => [...prev, emoteData]);
      setTimeout(() => {
        setActiveEmotes(prev => prev.filter(e => e.id !== emoteData.id));
      }, 3000);
    });

    newSocket.on('error-message', (err) => {
      setIsJoining(false);
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

    const updatedBoard = soloBoard.map((c, i) => i === cardIndex ? { ...c, isFlipped: true } : { ...c });
    setSoloBoard(updatedBoard);

    const newFlipped = [...soloFlipped, cardIndex];
    setSoloFlipped(newFlipped);

    if (newFlipped.length === 2) {
      const [firstIndex, secondIndex] = newFlipped;
      const firstCard = updatedBoard[firstIndex];
      const secondCard = updatedBoard[secondIndex];

      if (firstCard.symbol === secondCard.symbol) {
        // MATCH FOUND
        playMatchSound();
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

  // Online Multiplayer Tile Click — Optimistic local flip for 0ms instant response!
  const handleCardClick = (cardIndex) => {
    if (!socket || !gameState || gameState.isWaiting || gameState.winner) return;
    
    const me = gameState.players.find(p => p.id === socket.id);
    const activePlayer = gameState.players[gameState.activePlayerIndex];
    if (!me || !activePlayer || me.id !== activePlayer.id) return;

    const card = gameState.board[cardIndex];
    if (!card || card.isFlipped || card.isMatched) return;

    // Instant local flip (0ms latency UI update using Client-Side Prediction)
    setGameState(prev => {
      if (!prev) return prev;
      const updatedBoard = prev.board.map((c, idx) => 
        idx === cardIndex ? { ...c, isFlipped: true } : c
      );
      return { ...prev, board: updatedBoard };
    });

    // Send flip action to server and wait for simultaneous flip + symbol reveal
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
    
    const isBooting = socket && !socket.connected;
    if (isBooting) {
      setErrorMsg('Waking up server... this may take up to 50 seconds.');
    } else {
      setErrorMsg('');
    }
    
    setIsJoining(true);
    setGameState(null);
    socket.emit('create-room', { playerName, gridSize, sessionToken, deck: selectedDeck });
    
    const timeoutMs = isBooting ? 60000 : 8000;
    
    setTimeout(() => {
      setIsJoining(prev => {
        if (prev) {
          setErrorMsg('Server request timed out. Please try again.');
          return false;
        }
        return prev;
      });
    }, timeoutMs);
  };

  const executeJoinRoom = (cleanCode, name) => {
    setIsJoining(true);
    
    // If the socket isn't connected yet (server is booting from sleep), give it more time.
    const isBooting = socket && !socket.connected;
    if (isBooting) {
      setErrorMsg('Waking up server... this may take up to 50 seconds.');
    }
    
    socket.emit('join-room', { roomId: cleanCode, playerName: name, sessionToken });
    
    const timeoutMs = isBooting ? 60000 : 8000;
    
    setTimeout(() => {
      setIsJoining(prev => {
        if (prev) {
          setErrorMsg('Server request timed out. Please try again.');
          return false;
        }
        return prev;
      });
    }, timeoutMs);
  };

  const handleJoinRoom = (e) => {
    e.preventDefault();
    if (!socket || !roomIdInput.trim()) return;
    setErrorMsg('');

    let cleanCode = roomIdInput.trim().toUpperCase();
    if (!cleanCode.startsWith('M-') && /^\d{4}$/.test(cleanCode)) {
      cleanCode = 'M-' + cleanCode;
    }

    if (cleanCode === 'M-0314') {
      setShowPermanentRoomModal(true);
      return;
    }

    executeJoinRoom(cleanCode, playerName);
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
      socket.emit('explicit-leave', { sessionToken });
    }
    setRoomId('');
    setRoomIdInput('');
    setGameState(null);
    setErrorMsg('');
    setIsJoining(false);
    const newUrl = `${window.location.origin}${window.location.pathname}`;
    window.history.pushState({ path: newUrl }, '', newUrl);
  };

  const copyRoomLink = () => {
    const link = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }).catch(() => fallbackCopy(link));
    } else {
      fallbackCopy(link);
    }
  };

  const fallbackCopy = (text) => {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      console.error('Copy fallback failed', err);
    }
    document.body.removeChild(textArea);
  };

  const handleSendEmote = (emote) => {
    if (socket && roomId) {
      socket.emit('send-emote', { emote });
    }
  };

  const isMyTurn = gameState && gameState.players && gameState.players[gameState.activePlayerIndex]?.id === socket?.id;
  const activePlayerObj = gameState?.players ? gameState.players[gameState.activePlayerIndex] : null;

  // Calculate Net Score for Solo / Daily mode
  const matchedPairsCount = Math.floor(soloBoard.filter(c => c.isMatched).length / 2);
  const netScore = Math.max(0, (matchedPairsCount * 10) - (wastedTurns * 5));

  return (
    <>
      {/* Header */}
      <header style={{ margin: '16px auto 24px', width: '90%', maxWidth: '1200px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <a href={window.location.pathname} style={{ display: 'flex', alignItems: 'center', gap: '12px', textDecoration: 'none' }}>
          <span style={{ fontSize: '3.0rem', filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.4))' }}>🐵</span>
          <h1 style={{ fontSize: '2.0rem', margin: 0, fontWeight: 800, textTransform: 'lowercase', letterSpacing: '0.25em', color: '#ffffff', textShadow: '0 2px 8px rgba(0,0,0,0.6)' }}>
            monkeytiles
          </h1>
        </a>
      </header>

      {/* Permanent Room 0314 Modal */}
      {showPermanentRoomModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(10px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div className="glass-panel" style={{ width: '100%', maxWidth: '400px', padding: '30px', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <h2 style={{ margin: 0, fontSize: '1.8rem', fontWeight: 800 }}>Welcome to 0314</h2>
            <p style={{ margin: 0, color: 'var(--text-secondary)' }}>Who are you?</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
              <button 
                className="btn-primary" 
                onClick={() => {
                  setPlayerName('Manya');
                  localStorage.setItem('memory_playerName', 'Manya');
                  setShowPermanentRoomModal(false);
                  executeJoinRoom('M-0314', 'Manya');
                }}
              >
                Manya
              </button>
              <button 
                className="btn-primary" 
                onClick={() => {
                  setPlayerName('Nitish');
                  localStorage.setItem('memory_playerName', 'Nitish');
                  setShowPermanentRoomModal(false);
                  executeJoinRoom('M-0314', 'Nitish');
                }}
                style={{ background: 'linear-gradient(135deg, #FF6B6B 0%, #FF8E53 100%)' }}
              >
                Nitish
              </button>
            </div>
            <button className="btn-secondary" onClick={() => setShowPermanentRoomModal(false)} style={{ marginTop: '10px' }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Main Container */}
      <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 16px 24px' }}>
        <div className="game-container">
          
          {/* Left Column: Options, Controls & Scoring */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '100%' }}>
            
            {/* Game Modes Panel */}
            {gameMode !== 'friend' && (
              <div className="glass-panel" style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <h2 style={{ fontSize: '1.05rem', fontWeight: 800, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
                  <Gamepad2 size={18} style={{ color: 'var(--accent-primary)' }} /> Select Game Mode
                </h2>
                
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  {[
                    { key: 'solo', label: '🎮 Play Solo' },
                    { key: 'friend', label: '👥 With Friend' },
                  ].map(({ key, label }) => (
                    <button
                      key={key}
                      className={`btn-secondary${gameMode === key ? ' active' : ''}`}
                      onClick={() => setGameMode(key)}
                      style={{
                        padding: '12px 10px',
                        fontSize: '0.92rem',
                        justifyContent: 'center',
                        fontWeight: 700
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* Grid Size Selector */}
                {gameMode !== 'friend' && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px', borderTop: '1px solid rgba(0,0,0,0.08)', paddingTop: '12px' }}>
                    <span style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-secondary)' }}>Grid Size:</span>
                    <div className="grid-toggle-bar">
                      {[4, 6, 8].map(size => (
                        <button 
                          key={size}
                          className={`grid-toggle-btn${gridSize === size ? ' active' : ''}`}
                          onClick={() => setGridSize(size)}
                        >
                          {size}×{size}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Card Deck Selector */}
                {gameMode !== 'friend' && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Layers size={16} /> Card Deck:
                    </span>
                    <select 
                      className="input-field" 
                      value={selectedDeck} 
                      onChange={(e) => setSelectedDeck(e.target.value)}
                      style={{ width: 'auto', padding: '6px 12px', fontSize: '0.9rem' }}
                    >
                      {Object.entries(CARD_DECKS).map(([key, deck]) => (
                        <option key={key} value={key}>{deck.name}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            {/* Online Multiplayer Lobby Panel */}
            {gameMode === 'friend' && (
              <div className="glass-panel" style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {!isNameSet ? (
                  <form onSubmit={handleSaveName} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <h3 style={{ fontSize: '0.95rem', color: 'var(--text-primary)', margin: 0, fontWeight: 700 }}>Enter Nickname:</h3>
                    <input
                      type="text"
                      className="input-field"
                      placeholder="Your Nickname"
                      value={playerName}
                      onChange={(e) => setPlayerName(e.target.value)}
                      maxLength={15}
                      required
                    />
                    <button type="submit" className="btn-primary" style={{ width: '100%', padding: '12px', fontSize: '0.95rem' }}>
                      Set Name
                    </button>
                  </form>
                ) : !roomId ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <button onClick={handleCreateRoom} disabled={isJoining || !playerName.trim()} className="btn-primary" style={{ width: '100%', padding: '12px', fontSize: '0.95rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                      {isJoining ? (
                        <>
                          <Loader2 size={18} className="anim-rotate" /> Creating Room...
                        </>
                      ) : (
                        <>
                          <PlusCircle size={18} /> Create Room
                        </>
                      )}
                    </button>
                    
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <hr style={{ flex: 1, border: 'none', borderBottom: '1px solid var(--border-color)' }} />
                      <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)' }}>OR JOIN</span>
                      <hr style={{ flex: 1, border: 'none', borderBottom: '1px solid var(--border-color)' }} />
                    </div>

                    <form onSubmit={handleJoinRoom} style={{ display: 'flex', gap: '8px' }}>
                      <input
                        type="text"
                        className="input-field"
                        placeholder="Room Code (e.g. M-1234 or 1234)"
                        value={roomIdInput}
                        onChange={(e) => setRoomIdInput(e.target.value)}
                        required
                        disabled={isJoining}
                        style={{ padding: '10px 12px', fontSize: '0.9rem' }}
                      />
                      <button type="submit" disabled={isJoining} className="btn-secondary" style={{ padding: '10px 16px', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {isJoining ? (
                          <>
                            <Loader2 size={16} className="anim-rotate" /> Joining...
                          </>
                        ) : (
                          'Join'
                        )}
                      </button>
                    </form>

                    {errorMsg && (
                      <div style={{ padding: '8px 10px', background: 'rgba(235, 87, 87, 0.12)', border: '1px solid var(--accent-danger)', borderRadius: '8px', fontSize: '0.82rem', color: 'var(--accent-danger)', fontWeight: 700, textAlign: 'center' }}>
                        ❌ {errorMsg}
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {/* Room code + Share Link */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.03)', padding: '8px 12px', borderRadius: '10px', border: '1px solid rgba(0,0,0,0.06)' }}>
                      <span style={{ fontSize: '0.95rem', fontWeight: 800 }}>
                        Code: <strong style={{ color: 'var(--accent-primary)', letterSpacing: '0.05em' }}>{roomId}</strong>
                      </span>
                      <button onClick={copyRoomLink} className="btn-secondary" style={{ padding: '6px 12px', fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {copied ? (
                          <>
                            <Check size={16} style={{ color: 'var(--accent-success)' }} /> Copied!
                          </>
                        ) : (
                          <>
                            <Share2 size={16} style={{ color: 'var(--accent-primary)' }} /> Share Link
                          </>
                        )}
                      </button>
                    </div>

                    {/* Room Settings (Host Only, Pre-game) */}
                    {!gameState?.gameStarted && gameState?.hostId === socket?.id && (
                      <div style={{ padding: '12px', background: 'rgba(0,0,0,0.02)', borderRadius: '10px', display: 'flex', flexDirection: 'column', gap: '10px', border: '1px solid rgba(0,0,0,0.05)' }}>
                        <h4 style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Room Settings (Host)</h4>
                        
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: '0.9rem', fontWeight: 700 }}>Grid Size:</span>
                          <div className="grid-toggle-bar" style={{ background: 'var(--bg-secondary)', padding: '3px' }}>
                            {[4, 6, 8].map(size => (
                              <button 
                                key={size}
                                className={`grid-toggle-btn${gridSize === size ? ' active' : ''}`}
                                onClick={() => {
                                  setGridSize(size);
                                  socket.emit('update-room-settings', { gridSize: size, deck: selectedDeck });
                                }}
                                style={{ padding: '4px 8px', fontSize: '0.85rem' }}
                              >
                                {size}×{size}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: '0.9rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <Layers size={14} /> Card Deck:
                          </span>
                          <select 
                            className="input-field" 
                            value={selectedDeck} 
                            onChange={(e) => {
                              setSelectedDeck(e.target.value);
                              socket.emit('update-room-settings', { gridSize, deck: e.target.value });
                            }}
                            style={{ width: 'auto', padding: '4px 8px', fontSize: '0.85rem' }}
                          >
                            {Object.entries(CARD_DECKS).map(([key, deck]) => (
                              <option key={key} value={key}>{deck.name}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    )}

                    {/* Turn indicator */}
                    {gameState?.gameStarted && !gameState.winner && (
                      <div style={{
                        textAlign: 'center',
                        padding: '8px 12px',
                        background: isMyTurn ? 'rgba(0,168,132,0.15)' : 'rgba(0,0,0,0.04)',
                        borderRadius: '10px',
                        fontSize: '0.9rem',
                        fontWeight: 800,
                        color: isMyTurn ? 'var(--accent-primary)' : 'var(--text-secondary)'
                      }}>
                        {isMyTurn ? '🎯 Your turn!' : `⏳ ${activePlayerObj?.name || 'Player'}'s turn…`}
                      </div>
                    )}

                    {/* Lifetime Scoreboard for M-0314 */}
                    {gameState?.id === 'M-0314' && gameState?.lifetimeScores && (
                      <div style={{ background: 'linear-gradient(135deg, rgba(255,193,7,0.1) 0%, rgba(255,152,0,0.1) 100%)', border: '1px solid rgba(255,193,7,0.3)', padding: '12px', borderRadius: '12px', marginBottom: '8px' }}>
                        <div style={{ textAlign: 'center', fontSize: '0.85rem', fontWeight: 800, color: 'var(--accent-warning)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '10px' }}>
                          ⭐ Lifetime Scoreboard
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
                          <span>Manya: <span style={{ color: 'var(--accent-warning)', fontSize: '1.1rem' }}>{gameState.lifetimeScores.Manya}</span></span>
                          <span>Nitish: <span style={{ color: 'var(--accent-warning)', fontSize: '1.1rem' }}>{gameState.lifetimeScores.Nitish}</span></span>
                        </div>
                      </div>
                    )}

                    {/* Lobby Status / Players Leaderboard with Win Tracking */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
                      {gameState?.players?.map((p, i) => {
                        const isMe = p.id === socket?.id;
                        const isCurrent = i === gameState.activePlayerIndex;
                        return (
                          <div key={p.id || i} style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.88rem',
                            padding: '8px 12px', borderRadius: '8px', fontWeight: 700,
                            background: isCurrent && gameState?.gameStarted && !gameState.winner ? 'rgba(0,168,132,0.12)' : 'rgba(0,0,0,0.03)',
                            border: `1.5px solid ${isCurrent && gameState?.gameStarted && !gameState.winner ? 'var(--accent-primary)' : 'transparent'}`
                          }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', opacity: p.isDisconnected ? 0.5 : 1 }}>
                              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>P{i+1}</span>
                              <span style={{ textDecoration: p.isDisconnected ? 'line-through' : 'none' }}>
                                {p.name} {isMe && '(You)'} {p.isDisconnected && <span style={{ fontSize: '0.7rem', color: 'var(--accent-danger)' }}>(Offline)</span>}
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                              <span style={{ fontSize: '0.75rem', color: 'var(--accent-primary)', background: 'rgba(0,168,132,0.12)', padding: '2px 8px', borderRadius: '6px', fontWeight: 800 }}>
                                🏆 {p.wins || 0}
                              </span>
                              <strong>{p.score}</strong>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Host Start Game Button (for 2, 3, or 4 players) */}
                    {!gameState?.gameStarted && gameState?.players?.length >= 2 && gameState?.hostId === socket?.id && (
                      <button onClick={() => socket?.emit('start-game')} className="btn-primary" style={{ width: '100%', padding: '10px', fontSize: '0.9rem', marginTop: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                        <Play size={16} /> Start Game ({gameState.players.length}/4 Players)
                      </button>
                    )}

                    {!gameState?.gameStarted && gameState?.players?.length < 2 && (
                      <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', textAlign: 'center', padding: '6px' }}>
                        Waiting for at least 1 more player to join (Up to 4 players)…
                      </div>
                    )}

                    {/* Persistent Room Controls (Create New Room / Leave Room) */}
                    <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                      <button onClick={handleLeaveRoom} className="btn-secondary" style={{ width: '100%', padding: '8px 12px', fontSize: '0.82rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                        <LogOut size={14} /> Exit Room
                      </button>
                    </div>

                    {/* Winner Banner */}
                    {gameState?.winner && (
                      <div style={{ marginTop: '6px', padding: '12px', background: 'rgba(0, 168, 132, 0.1)', borderRadius: '8px', border: '1px solid var(--accent-primary)', display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center' }}>
                        <div style={{ fontSize: '1.15rem', fontWeight: 800, color: 'var(--accent-primary)', textAlign: 'center' }}>
                          🏆 {gameState.winner}
                        </div>
                        <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
                          <button onClick={handleRestartGame} className="btn-primary" style={{ flex: 1, padding: '8px', fontSize: '0.85rem', display: 'flex', gap: '4px', alignItems: 'center', justifyContent: 'center' }}>
                            <RefreshCw size={14} /> Play Again
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {errorMsg && <div style={{ fontSize: '0.8rem', color: 'var(--accent-danger)', textAlign: 'center', marginTop: '4px' }}>{errorMsg}</div>}
              </div>
            )}

            {/* Pass & Play Scores */}
            {gameMode === 'local' && (
              <div className="glass-panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {[
                  { label: 'Player 1', score: localP1Score, active: localActivePlayer === 1 && !localWinner },
                  { label: 'Player 2', score: localP2Score, active: localActivePlayer === 2 && !localWinner }
                ].map(({ label, score, active }, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem', padding: '8px 12px', fontWeight: 700,
                    background: active ? 'rgba(0,168,132,0.1)' : 'rgba(0,0,0,0.03)',
                    border: `1.5px solid ${active ? 'var(--accent-primary)' : 'transparent'}`, borderRadius: '8px'
                  }}>
                    <span>{label} {active ? '🎯' : ''}</span>
                    <strong>{score} pairs</strong>
                  </div>
                ))}

                {localWinner && (
                  <div style={{ marginTop: '6px', padding: '12px', background: 'rgba(0, 168, 132, 0.1)', borderRadius: '8px', border: '1px solid var(--accent-primary)', textAlign: 'center' }}>
                    <div style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--accent-primary)', marginBottom: '8px' }}>
                      {localWinner === 'Draw' ? "🤝 It's a Tie!" : `🏆 ${localWinner} Wins!`}
                    </div>
                    <button onClick={handleRestartGame} className="btn-primary" style={{ width: '100%', padding: '8px', fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                      <RefreshCw size={14} /> Play Again
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Solo Net Score Card */}
            {gameMode === 'solo' && (
              <div className="glass-panel" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Trophy size={18} style={{ color: 'var(--accent-warning)' }} /> Score
                  </span>
                  <strong style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--accent-primary)' }}>
                    {netScore} <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)' }}>pts</span>
                  </strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: 'var(--text-muted)', borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: '6px' }}>
                  <span>Matches: <strong style={{ color: 'var(--accent-success)' }}>{matchedPairsCount}</strong></span>
                  <span>Wasted Turns: <strong style={{ color: wastedTurns > 8 ? 'var(--accent-danger)' : 'var(--text-secondary)' }}>{wastedTurns}</strong></span>
                </div>
              </div>
            )}
            
            {/* Clash Royale Style Monkey Emote Bar */}
            {gameMode === 'friend' && roomId && (
              <div className="emote-bar">
                {['🐵', '🙈', '🙉', '🙊', '🍌', '👑', '🔥', '🏆', '😂', '😎'].map((emoji) => (
                  <button
                    key={emoji}
                    className="emote-btn"
                    onClick={() => handleSendEmote(emoji)}
                    title={`Send ${emoji} emote`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}

          </div>

          {/* Right Column: Game Grid (0.8x Opaque Glass Container) */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
            
            <div className="grid-panel">
              
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
                          <div className="tile-face tile-front">
                            {!isVisible && <span className="tile-watermark">🐵</span>}
                          </div>
                          <div className="tile-face tile-back">
                            {isVisible ? card.symbol : ''}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Online Multiplayer Board — driven by server state + instant optimistic local flip */}
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
                          <div className="tile-face tile-front">
                            {!isVisible && <span className="tile-watermark">🐵</span>}
                          </div>
                          <div className="tile-face tile-back">
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
              <div className="glass-panel" style={{ width: '90%', maxWidth: '320px', padding: '28px', textAlign: 'center' }}>
                <div style={{ fontSize: '3.5rem', marginBottom: '8px' }}>🎉</div>
                <h2 style={{ fontSize: '1.4rem', margin: '0 0 8px', color: 'var(--accent-primary)' }}>Board Cleared!</h2>
                
                <div style={{ padding: '14px', background: 'rgba(0, 168, 132, 0.08)', borderRadius: '12px', marginBottom: '16px', border: '1px solid var(--accent-primary)' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'block', marginBottom: '2px' }}>Final Score</span>
                  <strong style={{ fontSize: '2.2rem', color: 'var(--accent-primary)', display: 'block' }}>{netScore} pts</strong>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    {matchedPairsCount} Matches • {wastedTurns} Wasted Turns
                  </span>
                </div>

                <button onClick={handleRestartGame} className="btn-primary" style={{ width: '100%', padding: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                  <RefreshCw size={16} /> Play Again
                </button>
              </div>
            </div>
          )}

        </div>
      </main>

      {/* Floating Clash Royale Emote Overlay */}
      {activeEmotes.length > 0 && (
        <div className="emote-pop-container">
          {activeEmotes.map((e) => (
            <div key={e.id} className="emote-bubble">
              {e.emote}
            </div>
          ))}
        </div>
      )}

      <footer style={{ padding: '10px 0', fontSize: '0.7rem', textAlign: 'center', color: 'var(--text-muted)' }}>
        monkeytiles © 2026
      </footer>
    </>
  );
}

export default App;
