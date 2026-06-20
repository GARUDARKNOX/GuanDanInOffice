import React, { useState, useEffect, useMemo } from 'react';
import { useGame } from './useGame';
import { Lobby } from './components/Lobby';
import { GameTable } from './components/GameTable';
import { FakeIDE } from './components/FakeIDE';

function App() {
  const { 
    inRoom, 
    roomState, 
    gameState, 
    mySeat, 
    error,
    chatMessages,
    roomList,
    actions 
  } = useGame();
  
  const [showFakeIDE, setShowFakeIDE] = useState(false);
  // 粒子位置固定，避免每次render重新生成导致动画重置
  const [particles] = useState(() => 
    Array.from({ length: 20 }).map(() => ({
      left: `${Math.random() * 100}%`,
      top: `${Math.random() * 100}%`,
      delay: `${Math.random() * 5}s`,
      duration: `${6 + Math.random() * 6}s`,
    }))
  );

  useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
          // Toggle on 'i' key, but avoid input fields
          if (e.key.toLowerCase() === 'i') {
              const target = e.target as HTMLElement;
              if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
              setShowFakeIDE(prev => !prev);
          }
      };
      
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="animated-bg min-h-screen text-gray-300 relative overflow-hidden">
      {/* 浮动粒子 - 位置固定避免每帧重新生成 */}
      <div className="fixed inset-0 pointer-events-none z-0">
        {particles.map((p, i) => (
          <div key={i} className="particle" style={{
            left: p.left,
            top: p.top,
            animationDelay: p.delay,
            animationDuration: p.duration,
          }} />
        ))}
      </div>
      
      {showFakeIDE && <FakeIDE />}
      
      <div className="relative z-10">
      
      {error && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 bg-red-500 text-white px-6 py-2 rounded-full shadow-lg z-50 font-bold animate-pulse">
          {error}
        </div>
      )}

      {!inRoom ? (
        <Lobby onJoin={actions.joinRoom} roomList={roomList} onFetchRoomList={actions.fetchRoomList} />
      ) : (
          roomState && (
            <GameTable 
              gameState={gameState} 
              roomState={roomState}
              mySeat={mySeat}
              onPlay={actions.playHand}
              onPass={actions.passTurn}
              onReady={actions.setReady}
              onStart={actions.startGame}
              onTribute={actions.payTribute}
              onReturnTribute={actions.returnTribute}
              chatMessages={chatMessages}
              onSendChat={actions.sendChat}
              onSwitchSeat={actions.switchSeat}
              onSetGameMode={actions.setGameMode}
              onUseSkill={actions.useSkill}
              onForceEndGame={actions.forceEndGame}
            />
        )
      )}
    </div>
    </div>
  );
}

export default App;
