import { Bot } from './bot';
import { Card, HandType } from './types';
import { getHandType } from './rules';

const cards: Card[] = [];
let id = 0;
const mk = (s: number, r: number): Card => ({ id: String(++id), suit: s as any, rank: r as any, isWild: false });

// First hand from screenshot: BigJoker, 2x2, A, K, QQQ, 10x2, 9, 888, 7777, 6x2, 5x2, 444, 3x2
cards.push(mk(0,16)); // BigJoker
cards.push(mk(0,2), mk(1,2)); // two 2s
cards.push(mk(0,14), mk(0,13));
cards.push(mk(0,12), mk(1,12), mk(2,12));
cards.push(mk(0,10), mk(1,10));
cards.push(mk(0,9));
cards.push(mk(0,8), mk(1,8), mk(2,8));
cards.push(mk(0,7), mk(1,7), mk(2,7), mk(3,7));
cards.push(mk(0,6), mk(1,6));
cards.push(mk(0,5), mk(1,5));
cards.push(mk(0,4), mk(1,4), mk(2,4));
cards.push(mk(0,3), mk(1,3));

const bot = new Bot(cards, 2, 0, [27,27,27,27]);
const hp = (bot as any).handPlan;

console.log('=== HAND 1 (BigJoker + many pairs/trips) ===');
const groups = hp.groups as any[];
const bombIndices = hp.bombIndices as Set<number>;
for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const h = getHandType(g.cards, 2);
    const bomb = bombIndices.has(i) ? ' [BOMB]' : '';
    const desc = h ? `${HandType[h.type]} val=${h.value}` : 'unknown';
    const grp = g.cards.map((c: Card) => `[${c.rank}:${c.suit}]`).join(' ');
    console.log(`  G${i}: ${desc}${bomb}  ${grp}`);
}

const move = bot.decideMove(null);
console.log('\nHint:');
if (move) {
  const h = getHandType(move, 2);
  console.log(`  ${move.length} cards, type=${h ? HandType[h.type] : 'unknown'}`);
  console.log(`  Cards: ${move.map(c => `[${c.rank}:${c.suit}]`).join(' ')}`);
}
