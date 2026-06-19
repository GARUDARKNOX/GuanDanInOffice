import { Bot } from './bot';
import { Card, HandType, Suit } from './types';
import { getHandType } from './rules';

const cards: Card[] = [];
let id = 0;
const mk = (s: Suit, r: number, wild = false): Card =>
  ({ id: String(++id), suit: s, rank: r as any, isWild: wild });

// 最新截图：大王小王 4个2 2个A 2个K 1个Q 2个J ...
cards.push(mk(0,15), mk(0,16)); // SmallJoker(spade), BigJoker(spade)
// 4个2：将红桃2(Suit.Hearts=1)标记为wild
cards.push(mk(0,2), mk(1,2, true), mk(2,2), mk(3,2));
cards.push(mk(0,14), mk(1,14)); // AA
cards.push(mk(0,13), mk(1,13)); // KK
cards.push(mk(0,12)); // Q
cards.push(mk(0,11), mk(1,11)); // JJ
cards.push(mk(0,10)); // 10
cards.push(mk(0,9)); // 9
cards.push(mk(0,8), mk(1,8)); // 88
cards.push(mk(0,7)); // 7
cards.push(mk(0,6), mk(1,6), mk(2,6)); // 666
cards.push(mk(0,5), mk(1,5)); // 55
cards.push(mk(0,4)); // 4
cards.push(mk(0,3), mk(1,3), mk(2,3)); // 333

console.log('Cards:', cards.length);

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
    const grp = g.cards.map((c: Card) => `[${c.rank}:${c.suit}${c.isWild?'*':''}]`).join(' ');
    console.log(`  G${i}: ${desc}${bomb}  ${grp}`);
}

const move = bot.decideMove(null);
console.log('\\n=== HINT ===');
if (move) {
  const h = getHandType(move, 2);
  console.log(`  ${move.length} cards, type=${h ? HandType[h.type] : 'unknown'}`);
  console.log(`  ${move.map(c => `[${c.rank}:${c.suit}${c.isWild?'*':''}]`).join(' ')}`);
}
