import React from 'react';
import { Card as CardType, Suit, Rank } from '../../shared/types';

interface Props {
  card: CardType;
  selected?: boolean;
  onClick?: () => void;
  small?: boolean;
  isHighlighted?: boolean;
  animateEnter?: boolean;
}

const getSuitSymbol = (suit: Suit) => {
  switch (suit) {
    case Suit.Spades: return '♠';
    case Suit.Hearts: return '♥';
    case Suit.Clubs: return '♣';
    case Suit.Diamonds: return '♦';
    case Suit.Joker: return 'J'; // Special handling
  }
};

const getRankLabel = (rank: Rank) => {
  switch (rank) {
    case Rank.Two: return '2';
    case Rank.Three: return '3';
    case Rank.Four: return '4';
    case Rank.Five: return '5';
    case Rank.Six: return '6';
    case Rank.Seven: return '7';
    case Rank.Eight: return '8';
    case Rank.Nine: return '9';
    case Rank.Ten: return '10';
    case Rank.Jack: return 'J';
    case Rank.Queen: return 'Q';
    case Rank.King: return 'K';
    case Rank.Ace: return 'A';
    case Rank.SmallJoker: return 'Small Joker';
    case Rank.BigJoker: return 'Big Joker';
  }
};

export const Card: React.FC<Props> = ({ card, selected, onClick, small, isHighlighted, animateEnter }) => {
  const isRed = card.suit === Suit.Hearts || card.suit === Suit.Diamonds || card.rank === Rank.BigJoker;
  const isJoker = card.suit === Suit.Joker;
  
  // 现代卡牌外观：更大圆角、柔和渐变、细边框与层次阴影
  const baseClasses = "relative flex flex-col justify-between select-none cursor-pointer " +
    "bg-gradient-to-b from-white to-slate-100 border border-slate-300/80 " +
    "shadow-card transition-all duration-200 hover:shadow-lg";
  const sizeClasses = small
    ? "w-8 h-12 text-xs p-1 rounded-md"
    : "w-16 h-24 text-base p-2 rounded-xl hover:-translate-y-2";
  const selectClasses = selected ? "ring-2 ring-sky-400 ring-offset-2 ring-offset-slate-900 -translate-y-4" : "";
  const colorClass = isRed ? "text-rose-600" : "text-slate-900";
  const enterClass = animateEnter ? "card-enter" : "";
  const highlightClasses = isHighlighted
    ? "ring-2 ring-amber-300 shadow-[0_0_18px_rgba(252,211,77,0.65)]"
    : "";

  if (isJoker) {
     return (
        <div 
          className={`${baseClasses} ${sizeClasses} ${selectClasses} ${enterClass} ${highlightClasses} ${colorClass}`}
          onClick={onClick}
        >
           <div className="text-center w-full h-full flex items-center justify-center font-bold writing-vertical">
               {card.rank === Rank.SmallJoker ? '小王' : '大王'}
           </div>
        </div>
     );
  }

  return (
    <div 
      className={`${baseClasses} ${sizeClasses} ${selectClasses} ${enterClass} ${highlightClasses} ${colorClass}`}
      onClick={onClick}
    >
      <div className="font-extrabold text-left leading-none tracking-tight">{getRankLabel(card.rank)}</div>
      <div className="absolute inset-0 flex items-center justify-center text-3xl opacity-[0.14] pointer-events-none">
          {getSuitSymbol(card.suit)}
      </div>
      <div className="text-right leading-none self-end text-sm">{getSuitSymbol(card.suit)}</div>

      {card.isLevelCard && (
          <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-amber-400 rounded-full ring-2 ring-white/70"></div>
      )}
    </div>
  );
};
