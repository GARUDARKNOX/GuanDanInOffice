import React, { useState, useEffect } from 'react';
import { GameMode, GameVariant } from '../../shared/types';

interface RoomInfo {
  id: string;
  playerCount: number;
  maxPlayers: number;
  inGame: boolean;
  gameMode: GameMode;
  gameVariant?: GameVariant;
  hostName: string;
}

interface Props {
  onJoin: (name: string, roomId: string, variant?: GameVariant) => void;
  roomList: RoomInfo[];
  onFetchRoomList: () => void;
}

const SUITS = ['♠', '♥', '♣', '♦'];

export const Lobby: React.FC<Props> = ({ onJoin, roomList, onFetchRoomList }) => {
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState('default');
  const [showRoomList, setShowRoomList] = useState(true);
  const [selectedVariant, setSelectedVariant] = useState<GameVariant>(GameVariant.FourPlayer);

  useEffect(() => {
    if (showRoomList) {
      onFetchRoomList();
      const interval = setInterval(onFetchRoomList, 3000);
      return () => clearInterval(interval);
    }
  }, [showRoomList, onFetchRoomList]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) onJoin(name, roomId, selectedVariant);
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
      onJoin(name, newId, selectedVariant);
    }
  };

  return (
    <div className="relative flex flex-col items-center justify-center min-h-screen px-4 py-10 overflow-hidden">
      {/* 背景层：封面图 + 渐变遮罩 + 花色水印 */}
      <div className="absolute inset-0 pointer-events-none">
        <img src="/lobby-bg.png" alt="" className="w-full h-full object-cover opacity-25" />
        <div className="absolute inset-0 bg-gradient-to-b from-slate-950/85 via-slate-950/75 to-slate-950/90" />
      </div>
      <div className="absolute inset-0 pointer-events-none select-none overflow-hidden opacity-[0.04]">
        <div className="absolute top-[8%] left-[4%] text-[16rem] sm:text-[22rem] leading-none text-white">♠</div>
        <div className="absolute top-[48%] right-[6%] text-[12rem] sm:text-[18rem] leading-none text-white">♥</div>
        <div className="absolute bottom-[4%] left-[12%] text-[10rem] sm:text-[15rem] leading-none text-white">♣</div>
        <div className="absolute top-[18%] right-[24%] text-[9rem] sm:text-[13rem] leading-none text-white">♦</div>
      </div>

      {/* 头部 */}
      <header className="relative z-10 text-center mb-8 sm:mb-12">
        <div className="flex items-center justify-center gap-3 mb-4">
          {SUITS.map((suit, i) => (
            <span
              key={i}
              className={`text-xl sm:text-2xl ${suit === '♥' || suit === '♦' ? 'text-rose-400/70' : 'text-slate-400/60'}`}
            >
              {suit}
            </span>
          ))}
        </div>
        <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight">
          <span className="bg-gradient-to-r from-sky-300 via-indigo-300 to-violet-300 bg-clip-text text-transparent">
            掼蛋
          </span>
        </h1>
        <p className="text-slate-400 text-xs sm:text-sm mt-3 tracking-wide">
          局域网联机 · 支持四人 / 三人玩法
        </p>
      </header>

      {/* 主体 */}
      <div className="relative z-10 flex flex-col lg:flex-row gap-5 items-stretch lg:items-start w-full max-w-5xl">
        {/* 加入表单 */}
        <form
          onSubmit={handleSubmit}
          className="glass p-6 sm:p-8 w-full lg:w-[22rem] flex flex-col gap-5 shrink-0"
        >
          <div>
            <span className="section-label">玩法</span>
            <div className="grid grid-cols-2 gap-2.5 mt-2.5">
              <button
                type="button"
                onClick={() => setSelectedVariant(GameVariant.FourPlayer)}
                className={`py-3 rounded-xl text-sm font-semibold transition-all duration-200 border ${
                  selectedVariant === GameVariant.FourPlayer
                    ? 'bg-gradient-to-r from-sky-500 to-indigo-500 text-white border-transparent shadow-lg shadow-sky-500/25'
                    : 'bg-white/[0.04] text-slate-400 border-white/10 hover:border-sky-400/50 hover:text-slate-200'
                }`}
              >
                <div className="flex flex-col items-center gap-1">
                  <span className="text-lg">♠♥♣♦</span>
                  <span className="text-xs">四人掼蛋</span>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setSelectedVariant(GameVariant.ThreePlayer)}
                className={`py-3 rounded-xl text-sm font-semibold transition-all duration-200 border ${
                  selectedVariant === GameVariant.ThreePlayer
                    ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white border-transparent shadow-lg shadow-emerald-500/25'
                    : 'bg-white/[0.04] text-slate-400 border-white/10 hover:border-emerald-400/50 hover:text-slate-200'
                }`}
              >
                <div className="flex flex-col items-center gap-1">
                  <span className="text-lg">♠♥♦</span>
                  <span className="text-xs">三人掼蛋</span>
                </div>
              </button>
            </div>
          </div>

          <div>
            <label className="section-label block mb-2">昵称</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="field"
              placeholder="输入用户名..."
              maxLength={10}
              required
            />
          </div>

          <div>
            <label className="section-label block mb-2">房间号</label>
            <input
              type="text"
              value={roomId}
              onChange={e => setRoomId(e.target.value)}
              className="field font-mono"
              placeholder="default"
            />
          </div>

          <button type="submit" className="btn-primary w-full">
            加入游戏
          </button>

          <button type="button" onClick={handleCreateRoom} className="btn-success w-full">
            + 创建新房间
          </button>

          <button
            type="button"
            onClick={() => setShowRoomList(!showRoomList)}
            className="btn-ghost w-full"
          >
            {showRoomList ? '隐藏房间列表' : '查看房间列表'}
          </button>

          <p className="text-[11px] text-slate-500 text-center">
            牌桌内按 <kbd className="px-1.5 py-0.5 rounded bg-white/10 text-slate-300">i</kbd> 切换摸鱼模式
          </p>
        </form>

        {/* 房间列表 */}
        {showRoomList && (
          <div className="glass p-5 sm:p-6 w-full lg:flex-1 max-h-[70vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="section-label">活跃房间</h2>
              <span className="chip-info">{roomList.length} 个</span>
            </div>

            {roomList.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-14 text-slate-500">
                <span className="text-4xl mb-3 opacity-30">♢</span>
                <p className="text-sm">暂无活跃房间</p>
                <p className="text-[11px] mt-1">创建房间后这里会显示</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {roomList.map((room, i) => (
                  <div
                    key={room.id}
                    onClick={() => handleQuickJoin(room.id)}
                    className="group glass-soft px-4 py-3.5 hover:bg-white/[0.09] hover:border-sky-400/40
                               cursor-pointer transition-all duration-200 animate-fade-in"
                    style={{ animationDelay: `${i * 50}ms` }}
                  >
                    <div className="flex justify-between items-start gap-3">
                      <div className="min-w-0">
                        <div className="text-sky-300 font-semibold text-sm font-mono truncate">
                          {room.id}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-1 truncate">
                          房主 {room.hostName}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {room.inGame ? (
                          <span className="chip-danger">游戏中</span>
                        ) : (
                          <span className="chip-success">等待中</span>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleQuickJoin(room.id);
                          }}
                          disabled={room.inGame && room.playerCount >= 4}
                          className={
                            room.inGame && room.playerCount >= 4
                              ? 'btn bg-white/5 text-slate-500 px-3 py-1 text-xs'
                              : 'btn-primary px-3 py-1 text-xs'
                          }
                        >
                          加入
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center justify-between mt-2.5 text-[11px] text-slate-400">
                      <span className="chip-violet">
                        {room.gameMode === GameMode.Normal ? '普通模式' : '技能模式'}
                      </span>
                      <span className="font-mono tabular-nums">
                        {room.playerCount}/{room.maxPlayers}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="relative z-10 mt-10 text-[11px] text-slate-600 tracking-wide text-center">
        GuanDan · LAN Multiplayer
      </footer>
    </div>
  );
};
