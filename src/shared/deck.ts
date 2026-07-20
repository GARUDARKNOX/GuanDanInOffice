import { Card, Rank, Suit } from './types';

export function createDeck(): Card[] {
  const cards: Card[] = [];
  const suits = [Suit.Spades, Suit.Hearts, Suit.Clubs, Suit.Diamonds];
  const ranks = [
    Rank.Two, Rank.Three, Rank.Four, Rank.Five, Rank.Six, Rank.Seven,
    Rank.Eight, Rank.Nine, Rank.Ten, Rank.Jack, Rank.Queen, Rank.King, Rank.Ace
  ];

  // Two decks
  for (let i = 0; i < 2; i++) {
    // Standard cards
    for (const suit of suits) {
      for (const rank of ranks) {
        cards.push({
          suit,
          rank,
          id: `${suit}-${rank}-${i}`
        });
      }
    }
    // Jokers
    cards.push({ suit: Suit.Joker, rank: Rank.SmallJoker, id: `joker-small-${i}` });
    cards.push({ suit: Suit.Joker, rank: Rank.BigJoker, id: `joker-big-${i}` });
  }

  return cards;
}

/**
 * 三人掼蛋牌组：两副牌去掉梅花全部26张 + 去掉1张大王 = 81张
 * 每人27张，3张王(2小+1大)组成最大炸弹
 */
export function createThreePlayerDeck(): Card[] {
  const cards: Card[] = [];
  // 三人模式只用3种花色：黑桃、红桃、方块（去掉梅花）
  const suits = [Suit.Spades, Suit.Hearts, Suit.Diamonds];
  const ranks = [
    Rank.Two, Rank.Three, Rank.Four, Rank.Five, Rank.Six, Rank.Seven,
    Rank.Eight, Rank.Nine, Rank.Ten, Rank.Jack, Rank.Queen, Rank.King, Rank.Ace
  ];

  // Two decks, 3 suits only = 78 cards
  for (let i = 0; i < 2; i++) {
    for (const suit of suits) {
      for (const rank of ranks) {
        cards.push({ suit, rank, id: `3p-${suit}-${rank}-${i}` });
      }
    }
  }

  // 2 small jokers + 1 big joker = 3 jokers (total 81)
  cards.push({ suit: Suit.Joker, rank: Rank.SmallJoker, id: `3p-joker-small-0` });
  cards.push({ suit: Suit.Joker, rank: Rank.SmallJoker, id: `3p-joker-small-1` });
  cards.push({ suit: Suit.Joker, rank: Rank.BigJoker, id: `3p-joker-big-0` });

  return cards; // 78 + 3 = 81
}

export function shuffleDeck(cards: Card[]): Card[] {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

// Helper to update card properties based on current game level
export function updateCardProperties(cards: Card[], currentLevel: number): Card[] {
  return cards.map(card => {
    const isLevelCard = card.rank === currentLevel;
    const isWild = isLevelCard && card.suit === Suit.Hearts;
    return { ...card, isLevelCard, isWild };
  });
}
