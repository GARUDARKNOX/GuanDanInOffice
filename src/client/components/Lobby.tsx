import React, { useState, useEffect } from 'react';
import { GameMode } from '../../shared/types';

interface RoomInfo {
  id: string;
  playerCount: number;
  maxPlayers: number;
  inGame: boolean;
  gameMode: GameMode;
  hostName: string;
}

interface Props {
  onJoin: (name: string, roomId: string) => void;
  roomList: RoomInfo[];
  onFetchRoomList: () => void;
}

const SUITS = ['♠', '♥', '♣', '♦'];

export const Lobby: React.FC<Props> = ({ onJoin, roomList, onFetchRoomList }) => {
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState('default');
  const [showRoomList, setShowRoomList] = useState(true);

  useEffect(() => {
    if (showRoomList) {
      onFetchRoomList();
      const interval = setInterval(onFetchRoomList, 3000);
      return () => clearInterval(interval);
    }
  }, [showRoomList, onFetchRoomList]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) onJoin(name, roomId);
  };

  const handleQuickJoin = (targetRoomId: string) => {
    setRoomId(targetRoomId);
    if (name.trim()) {
      onJoin(name, targetRoomId);
    }
  };

  const handleCreateRoom = () => {
    const newId = 'room-' + Math.random().toString(36).slice(2, 8);
    setRoomId(newId);
    if (name.trim()) {
      onJoin(name, newId);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-[#1e1e1e] text-gray-300 p-4 relative overflow-hidden">
      {/* Subtle background pattern - card suit watermark */}
      <div className="absolute inset-0 pointer-events-none select-none overflow-hidden opacity-[0.03]">
        <div className="absolute top-[10%] left-[5%] text-[20rem] leading-none">♠</div>
        <div className="absolute top-[50%] right-[8%] text-[16rem] leading-none">♥</div>
        <div className="absolute bottom-[5%] left-[15%] text-[14rem] leading-none">♣</div>
        <div className="absolute top-[20%] right-[25%] text-[12rem] leading-none">♦</div>
      </div>

      {/* Header */}
      <div className="relative z-10 text-center mb-10">
        <div className="flex items-center justify-center gap-3 mb-3">
          {SUITS.map((suit, i) => (
            <span
              key={i}
              className={`text-2xl ${suit === '♥' || suit === '♦' ? 'text-red-500/60' : 'text-gray-500/60'}`}
            >
              {suit}
            </span>
          ))}
        </div>
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
          <span className="text-[#569cd6]">Guan</span>
          <span className="text-[#ce9178]">Dan</span>
        </h1>
        <p className="text-[#6a9955] text-sm mt-2 font-mono">
          // 局域网掼蛋 · 按 i 进入摸鱼模式
        </p>
      </div>

      {/* Main card */}
      <div className="relative z-10 flex flex-col md:flex-row gap-6 items-start">
        {/* Join Form */}
        <form
          onSubmit={handleSubmit}
          className="bg-[#252526] p-8 rounded-lg border border-[#333333] flex flex-col gap-5 w-80
                     shadow-2xl shadow-black/30 transition-shadow duration-300 hover:shadow-black/50"
        >
          {/* Status bar mimic */}
          <div className="flex items-center gap-2 pb-3 border-b border-[#333333]">
            <span className="w-3 h-3 rounded-full bg-[#ff5f56]"></span>
            <span className="w-3 h-3 rounded-full bg-[#ffbd2e]"></span>
            <span className="w-3 h-3 rounded-full bg-[#27c93f]"></span>
            <span className="text-[11px] text-[#808080] ml-2 font-mono">lobby.tsx</span>
          </div>

          <div>
            <label className="block text-[11px] font-mono uppercase tracking-wider mb-2 text-[#569cd6]">
              Player Name
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full bg-[#1e1e1e] border border-[#3c3c3c] p-2.5 rounded text-[#d4d4d4] text-sm
                         placeholder:text-[#5a5a5a] focus:outline-none focus:border-[#007acc] focus:ring-1 focus:ring-[#007acc]/30
                         transition-all duration-200"
              placeholder="输入用户名..."
              maxLength={10}
              required
            />
          </div>

          <div>
            <label className="block text-[11px] font-mono uppercase tracking-wider mb-2 text-[#569cd6]">
              Room ID
            </label>
            <input
              type="text"
              value={roomId}
              onChange={e => setRoomId(e.target.value)}
              className="w-full bg-[#1e1e1e] border border-[#3c3c3c] p-2.5 rounded text-[#d4d4d4] text-sm
                         placeholder:text-[#5a5a5a] focus:outline-none focus:border-[#007acc] focus:ring-1 focus:ring-[#007acc]/30
                         transition-all duration-200"
              placeholder="default"
            />
          </div>

          <button
            type="submit"
            className="w-full bg-[#0e639c] hover:bg-[#1177bb] active:bg-[#0d5689] text-white py-2.5 rounded
                       font-bold text-sm tracking-wide transition-all duration-150
                       active:scale-[0.98]"
          >
            加入游戏
          </button>

          <button
            type="button"
            onClick={handleCreateRoom}
            className="w-full bg-[#5a8d3c] hover:bg-[#6aa04a] active:bg-[#4a7a2e] text-white py-2.5 rounded
                       font-bold text-sm tracking-wide transition-all duration-150
                       active:scale-[0.98]"
          >
            + 创建新房间
          </button>

          <button
            type="button"
            onClick={() => setShowRoomList(!showRoomList)}
            className="w-full bg-transparent hover:bg-[#2a2d2e] text-[#808080] hover:text-[#cccccc]
                       py-2 rounded border border-[#3c3c3c] text-sm font-mono
                       transition-all duration-150"
          >
            {showRoomList ? '隐藏房间列表' : '查看房间列表'}
          </button>

          {/* Tip */}
          <p className="text-[10px] text-[#5a5a5a] text-center font-mono">
            按 i 键切换摸鱼模式 · VS Code 伪装界面
          </p>
        </form>

        {/* Room List */}
        {showRoomList && (
          <div className="bg-[#252526] p-6 rounded-lg border border-[#333333] w-96 max-h-96 overflow-y-auto
                          shadow-2xl shadow-black/30">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-mono font-bold text-[#569cd6] uppercase tracking-wider">
                活跃房间
              </h2>
              <span className="text-[10px] text-[#5a5a5a] font-mono">
                {roomList.length} 个房间
              </span>
            </div>

            {roomList.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-[#5a5a5a]">
                <span className="text-4xl mb-3 opacity-30">♢</span>
                <p className="text-sm font-mono">暂无活跃房间</p>
                <p className="text-[10px] mt-1">创建房间后这里会显示</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {roomList.map((room, i) => (
                  <div
                    key={room.id}
                    onClick={() => handleQuickJoin(room.id)}
                    className="group bg-[#1e1e1e] p-4 rounded border border-[#3c3c3c]
                               hover:border-[#007acc] hover:bg-[#1e1e1e]/80
                               cursor-pointer transition-all duration-200
                               animate-[fadeIn_0.3s_ease-out_both]"
                    style={{ animationDelay: `${i * 60}ms` }}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[#9cdcfe] font-bold text-sm font-mono">
                          {room.id}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded font-mono ${
                            room.inGame
                              ? 'bg-[#5a1a1a] text-[#f48771]'
                              : 'bg-[#1a3a1a] text-[#89d185]'
                          }`}
                        >
                          {room.inGame ? '游戏中' : '等待中'}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleQuickJoin(room.id);
                          }}
                          disabled={room.inGame && room.playerCount >= 4}
                          className={`text-[10px] px-2 py-0.5 rounded font-mono transition-colors ${
                            room.inGame && room.playerCount >= 4
                              ? 'bg-[#3c3c3c] text-[#5a5a5a] cursor-not-allowed'
                              : 'bg-[#0e639c] text-white hover:bg-[#1177bb]'
                          }`}
                        >
                          加入
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-xs">
                      <span className="text-[#808080]">
                        <span className="text-[#569cd6]">host:</span> {room.hostName}
                      </span>
                      <span className="text-[#808080] font-mono">
                        {room.playerCount}/{room.maxPlayers}
                      </span>
                    </div>

                    <div className="flex items-center gap-1 mt-1.5">
                      <span className="text-[10px] text-[#5a5a5a] font-mono">
                        {room.gameMode === GameMode.Normal ? '普通模式' : '技能模式'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="relative z-10 mt-12 text-[10px] text-[#4a4a4a] font-mono text-center">
        GuanDan v2.0 · LAN Multiplayer · Press i for Stealth Mode
      </div>
    </div>
  );
};
