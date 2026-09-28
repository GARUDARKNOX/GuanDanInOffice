import React from 'react';
import { SkillCardType, SkillCardNames } from '../../shared/types';

interface Player {
  name: string;
  seatIndex: number;
  handCount: number;
}

interface Props {
  skillType: SkillCardType;
  players: Player[];
  mySeat: number;
  onSelect: (targetSeat: number) => void;
  onCancel: () => void;
}

export const TargetSelectModal: React.FC<Props> = ({ skillType, players, mySeat, onSelect, onCancel }) => {
  // Filter out self and players with no cards
  const validTargets = players.filter(p => p.seatIndex !== mySeat && p.handCount > 0);
  const skillName = SkillCardNames[skillType];

  return (
    <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center z-50 px-4">
      <div className="glass-strong p-6 w-full max-w-sm">
        <h2 className="text-lg sm:text-xl font-bold text-white mb-5 text-center">
          选择【{skillName}】的目标
        </h2>

        <div className="flex flex-col gap-2.5">
          {validTargets.length === 0 ? (
            <p className="text-slate-400 text-center text-sm">没有可选择的目标</p>
          ) : (
            validTargets.map(player => (
              <button
                key={player.seatIndex}
                onClick={() => onSelect(player.seatIndex)}
                className={`
                  px-4 py-3 rounded-xl text-white font-medium transition-all border
                  flex justify-between items-center
                  ${player.seatIndex % 2 === mySeat % 2
                    ? 'bg-sky-500/20 border-sky-400/40 hover:bg-sky-500/30'
                    : 'bg-rose-500/20 border-rose-400/40 hover:bg-rose-500/30'}
                `}
              >
                <span>{player.name}</span>
                <span className="text-xs opacity-80">
                  {player.seatIndex % 2 === mySeat % 2 ? '队友' : '对手'}
                  · {player.handCount}张牌
                </span>
              </button>
            ))
          )}
        </div>

        <button
          onClick={onCancel}
          className="btn-ghost mt-5 w-full"
        >
          取消
        </button>
      </div>
    </div>
  );
};
