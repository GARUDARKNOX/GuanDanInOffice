
import { Bot } from './bot';
import { Card, HandType } from './types';
import { getHandType, getLogicValue } from './rules';

const cards: Card[] = [];
let id = 0;
const mk = (s: number, r: number): Card => ({ id: String(++id), suit: s as any, rank: r as any, isWild: false });

cards.push(mk(0,15)); // SmallJoker
for (let i = 0; i < 4; i++) cards.push(mk(i,2));
cards.push(mk(0,13)); // K
cards.push(mk(0,12), mk(1,12)); // QQ
cards.push(mk(0,11), mk(1,11)); // JJ
for (let i = 0; i < 4; i++) cards.push(mk(i,10));
for (let i = 0; i < 4; i++) cards.push(mk(i,9));
cards.push(mk(0,8), mk(1,8));
cards.push(mk(0,6), mk(1,6), mk(2,6));
cards.push(mk(0,4));
cards.push(mk(0,3), mk(1,3), mk(2,3));

const bot = new Bot(cards, 2, 0, [27,27,27,27]);
const hp = (bot as any).handPlan;

console.log('=== PLAN GROUPS ===');
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
console.log('\n=== HINT SUGGESTS ===');
if (move) {
  const h = getHandType(move, 2);
  console.log(`  ${move.length} cards, type=${h ? HandType[h.type] : 'unknown'}`);
  console.log(`  Cards: ${move.map(c => `[${c.rank}:${c.suit}]`).join(' ')}`);
}
