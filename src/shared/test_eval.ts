import { Bot } from './bot';
import { Card, HandType } from './types';
import { getHandType } from './rules';

function testHand(name: string, cards: Card[]) {
  const bot = new Bot(cards, 2, 0, [27,27,27,27]);
  const hp = (bot as any).handPlan;
  const groups = hp.groups as any[];
  const bombIndices = hp.bombIndices as Set<number>;
  console.log('=== ' + name + ' ===');
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const h = getHandType(g.cards, 2);
    const bomb = bombIndices.has(i) ? ' [B]' : '';
    const desc = h ? HandType[h.type] + ' v' + h.value : '?';
    console.log('  G' + i + ': ' + desc + bomb + '  ' + g.cards.map(c => '[' + c.rank + ':' + c.suit + (c.isWild ? '*' : '') + ']').join(' '));
  }
  const move = bot.decideMove(null);
  if (move) {
    const h = getHandType(move, 2);
    console.log('  => HINT: ' + (h ? HandType[h.type] : '?') + ' v' + (h ? h.value : '?') + '  ' + move.map(c => '[' + c.rank + ':' + c.suit + ']').join(' '));
  }
  console.log('');
}

let id = 0;
const mk = (s: number, r: number, w = false): Card => ({ id: String(++id), suit: s as any, rank: r as any, isWild: w });

// Test A: Multiple straights - 333-444-555-666-777-888-999-101010 + 大小王
testHand('A-多顺子', [
  mk(0,16), mk(0,15),
  mk(0,3), mk(1,3), mk(2,3),
  mk(0,4), mk(1,4), mk(2,4),
  mk(0,5), mk(1,5), mk(2,5),
  mk(0,6), mk(1,6), mk(2,6),
  mk(0,7), mk(1,7), mk(2,7),
  mk(0,8), mk(1,8), mk(2,8),
  mk(0,9), mk(1,9), mk(2,9),
  mk(0,10), mk(1,10), mk(2,10),
]);

// Test B: All bombs - 四个2/5/9/10 + 三条Q/K/3 + 四个王
id = 0;
testHand('B-多炸弹', [
  mk(0,15), mk(1,15),
  mk(0,16), mk(1,16),
  mk(0,2), mk(1,2), mk(2,2), mk(3,2),
  mk(0,5), mk(1,5), mk(2,5), mk(3,5),
  mk(0,9), mk(1,9), mk(2,9), mk(3,9),
  mk(0,10), mk(1,10), mk(2,10), mk(3,10),
  mk(0,12), mk(1,12), mk(2,12),
  mk(0,13), mk(1,13), mk(2,13),
  mk(0,3), mk(1,3), mk(2,3),
]);

// Test C: Scattered cards
id = 0;
testHand('C-散牌多', [
  mk(0,16), mk(0,15),
  mk(0,2), mk(1,2), mk(2,2),
  mk(0,14),
  mk(0,13), mk(1,13),
  mk(0,12),
  mk(0,11), mk(1,11),
  mk(0,10),
  mk(0,9),
  mk(0,8),
  mk(0,7), mk(1,7),
  mk(0,6), mk(1,6),
  mk(0,5), mk(1,5),
  mk(0,4),
  mk(0,3), mk(1,3),
]);

// Test D: With wild card
id = 0;
testHand('D-红桃配牌', [
  mk(0,16), mk(0,15),
  mk(0,2), mk(1,2,true), mk(2,2), mk(3,2),
  mk(0,14), mk(1,14),
  mk(0,10), mk(1,10),
  mk(0,8), mk(1,8),
  mk(0,7), mk(1,7),
  mk(0,6), mk(1,6), mk(2,6),
  mk(0,5), mk(1,5),
  mk(0,4),
  mk(0,3), mk(1,3), mk(2,3),
]);

// Test E: Long straight possible
id = 0;
testHand('E-长顺子', [
  mk(0,3), mk(1,3),
  mk(0,4), mk(1,4),
  mk(0,5), mk(1,5),
  mk(0,6), mk(1,6),
  mk(0,7), mk(1,7),
  mk(0,8), mk(1,8),
  mk(0,9), mk(1,9),
  mk(0,10), mk(1,10),
  mk(0,11), mk(1,11),
  mk(0,12), mk(1,12),
  mk(0,13), mk(1,13),
  mk(0,14), mk(1,14),
  mk(0,2), mk(1,2),
  mk(0,16), mk(0,15),
]);
