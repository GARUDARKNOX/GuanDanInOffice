import React, { useState, useEffect, useRef } from 'react';
import { HistoryEntry, HistoryEventType } from '../../shared/types';

interface GameHistoryProps {
  history: HistoryEntry[];
  currentRound: number;
  isOpen: boolean;
  onClose: () => void;
}

export const GameHistory: React.FC<GameHistoryProps> = ({ history, currentRound, isOpen, onClose }) => {
  const [filter, setFilter] = useState<HistoryEventType | 'all'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const historyEndRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScroll && historyEndRef.current) {
      historyEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [history, autoScroll]);

  if (!isOpen) return null;

  // Filter history entries
  const filteredHistory = history.filter(entry => {
    const matchesFilter = filter === 'all' || entry.type === filter;
    const matchesSearch = searchTerm === '' || 
      entry.message.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (entry.playerName && entry.playerName.toLowerCase().includes(searchTerm.toLowerCase()));
    return matchesFilter && matchesSearch;
  });

  // Get event type display name and color
  const getEventTypeInfo = (type: HistoryEventType) => {
    const info = {
      [HistoryEventType.GameStart]: { name: '游戏开始', color: 'text-green-400', bgColor: 'bg-green-900/30' },
      [HistoryEventType.PhaseChange]: { name: '阶段变化', color: 'text-blue-400', bgColor: 'bg-blue-900/30' },
      [HistoryEventType.Play]: { name: '出牌', color: 'text-yellow-400', bgColor: 'bg-yellow-900/30' },
      [HistoryEventType.Pass]: { name: '过牌', color: 'text-gray-400', bgColor: 'bg-gray-900/30' },
      [HistoryEventType.Tribute]: { name: '进贡', color: 'text-purple-400', bgColor: 'bg-purple-900/30' },
      [HistoryEventType.ReturnTribute]: { name: '还贡', color: 'text-pink-400', bgColor: 'bg-pink-900/30' },
      [HistoryEventType.SkillUse]: { name: '技能', color: 'text-cyan-400', bgColor: 'bg-cyan-900/30' },
      [HistoryEventType.RoundEnd]: { name: '回合结束', color: 'text-orange-400', bgColor: 'bg-orange-900/30' },
      [HistoryEventType.PlayerFinish]: { name: '出完', color: 'text-red-400', bgColor: 'bg-red-900/30' },
      [HistoryEventType.GameEnd]: { name: '游戏结束', color: 'text-red-500', bgColor: 'bg-red-900/50' },
      [HistoryEventType.LevelUp]: { name: '升级', color: 'text-green-500', bgColor: 'bg-green-900/50' }
    };
    return info[type] || { name: type, color: 'text-gray-400', bgColor: 'bg-gray-900/30' };
  };

  // Format timestamp
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  // Handle scroll to detect if user scrolled up
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const element = e.currentTarget;
    const isAtBottom = element.scrollHeight - element.scrollTop <= element.clientHeight + 50;
    setAutoScroll(isAtBottom);
  };

  return (
    <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center z-50 p-3 sm:p-6">
      <div className="glass-strong w-full max-w-4xl h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div>
            <h2 className="text-lg sm:text-2xl font-bold text-white">游戏历史记录</h2>
            <p className="text-xs sm:text-sm text-slate-400 mt-0.5">第 {currentRound} 局 · 共 {filteredHistory.length} 条记录</p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white text-2xl leading-none w-9 h-9 rounded-full hover:bg-white/10 transition-colors"
          >
            ×
          </button>
        </div>

        {/* Filters */}
        <div className="p-4 border-b border-white/10 space-y-3">
          {/* Search */}
          <input
            type="text"
            placeholder="搜索玩家名或事件..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="field"
          />

          {/* Event type filter */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setFilter('all')}
              className={filter === 'all' ? 'chip-info !px-3 !py-1 !text-xs' : 'chip bg-white/[0.06] text-slate-400 hover:bg-white/[0.12] !px-3 !py-1 !text-xs'}
            >
              全部
            </button>
            {Object.values(HistoryEventType).map((type) => {
              const info = getEventTypeInfo(type);
              return (
                <button
                  key={type}
                  onClick={() => setFilter(type)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition border ${
                    filter === type
                      ? `${info.bgColor} ${info.color} border-current`
                      : 'bg-white/[0.05] border-white/10 text-slate-400 hover:bg-white/[0.12]'
                  }`}
                >
                  {info.name}
                </button>
              );
            })}
          </div>
        </div>

        {/* History list */}
        <div 
          className="flex-1 overflow-y-auto p-4 space-y-2"
          onScroll={handleScroll}
        >
          {filteredHistory.length === 0 ? (
            <div className="text-center text-slate-500 py-8 text-sm">
              {searchTerm || filter !== 'all' ? '没有匹配的记录' : '暂无历史记录'}
            </div>
          ) : (
            filteredHistory.map((entry) => {
              const info = getEventTypeInfo(entry.type);
              return (
                <div
                  key={entry.id}
                  className={`${info.bgColor} rounded-xl p-3 border border-white/10 hover:border-white/25 transition`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-xs font-bold ${info.color} px-2 py-0.5 rounded`}>
                          {info.name}
                        </span>
                        {entry.playerName && (
                          <span className="text-xs text-slate-400">
                            {entry.playerName}
                          </span>
                        )}
                        <span className="text-[11px] text-slate-500 tabular-nums">
                          {formatTime(entry.timestamp)}
                        </span>
                      </div>
                      <p className="text-slate-100 text-sm leading-relaxed">
                        {entry.message}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })
          )}
          <div ref={historyEndRef} />
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-white/10 flex items-center justify-between">
          <label className="flex items-center gap-2 text-xs sm:text-sm text-slate-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="rounded bg-slate-900 border-white/20 text-sky-500 focus:ring-sky-400/40"
            />
            自动滚动到最新
          </label>
          <button
            onClick={onClose}
            className="btn-ghost !px-6 !py-2"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};
