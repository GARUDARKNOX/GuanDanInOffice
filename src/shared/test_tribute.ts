/**
 * 进贡 / 还贡 规则校验测试（用完即删）
 * ----------------------------------------
 * 覆盖两条规则：
 *  1. 不能进贡/还贡手里没有的牌（BOT 自动还贡也必须来自自己手牌）
 *  2. 红桃级牌(逢人配)不能进贡
 */
import { Game } from '../server/game';
import { Card, Rank, Suit } from './types';
import { sortCards, getLogicValue } from './rules';
import { updateCardProperties } from './deck';

const LEVEL = 7;

let uid = 0;
const mk = (s: number, r: number): Card =>
  ({ id: `k${++uid}`, suit: s as Suit, rank: r as Rank, isWild: false, isLevelCard: false });

const ioStub: any = {
  to: () => ({ emit: () => {} }),
  emit: () => {},
  sockets: { to: () => ({ emit: () => {} }) },
};

function makeGame(isBotFlags: boolean[]) {
  const players = isBotFlags.map((b, i) => ({
    id: `p${i}`, name: b ? `Bot${i}` : `Human${i}`, seatIndex: i, isBot: b,
  }));
  return new Game(ioStub, 'test-room', players as any, undefined as any, undefined as any);
}

/** 给某一手塞牌并排序（isWild 由 updateCardProperties 决定：红桃+level） */
function setup(g: any, hands: Card[][]) {
  g.hands = hands.map(h => sortCards(updateCardProperties(h, LEVEL), LEVEL));
  g.level = LEVEL;
}

const names = (cs: Card[]) => cs.map(c => '♠♥♣♦'[c.suit] + ({ 2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A',15:'w',16:'W' } as any)[c.rank] + (c.isWild ? '★' : '')).join(' ');
const total = (g: any) => g.hands.reduce((s: number, h: Card[]) => s + h.length, 0);

// ---------------- 用例1：进贡手里没有的牌 → 拒绝 ----------------
{
  const g: any = makeGame([false, false, false, false]);
  setup(g, [
    [mk(0, 5), mk(1, 9), mk(2, 13)],  // seat0 手牌
    [mk(3, 4), mk(1, 6)],
    [mk(0, 2)],
    [mk(1, 3)],
  ]);
  g.currentPhase = 'Tribute';
  g.tributeState = { pendingTributes: [{ from: 0, to: 1 }], pendingReturns: [] };
  const before = total(g);
  const ghost = mk(2, 16); // 大王，但根本不在 seat0 手里
  g.handleTribute(0, [ghost]);
  const ok = g.tributeState.pendingTributes[0].card === undefined && total(g) === before;
  console.log(`[用例1] 进贡手里没有的牌 -> ${ok ? '✔ 已拒绝，牌数不变' : '✘ 被接受（BUG）'} (total=${total(g)}, before=${before})`);
  console.log(`        seat0 手牌: ${names(g.hands[0])}`);
}

// ---------------- 用例2：进贡红桃级牌 → 拒绝 ----------------
{
  const g: any = makeGame([false, false, false, false]);
  // seat0 手里最大的牌是 ♥7（红桃级牌 = 逢人配，逻辑值19，比 K 大）
  setup(g, [
    [mk(0, 5), mk(0, 13), mk(1, 7)],
    [mk(3, 4)],
    [mk(0, 2)],
    [mk(1, 3)],
  ]);
  g.currentPhase = 'Tribute';
  g.tributeState = { pendingTributes: [{ from: 0, to: 1 }], pendingReturns: [] };
  const wild = g.hands[0].find((c: Card) => c.isWild);
  const before = total(g);
  g.handleTribute(0, [wild]);
  const ok = g.tributeState.pendingTributes[0].card === undefined && total(g) === before;
  console.log(`[用例2] 进贡红桃级牌 ${names([wild])} -> ${ok ? '✔ 已拒绝' : '✘ 被接受（BUG）'}`);

  // 接着贡"次大的 K"应被接受（红桃级牌不可进贡，因此不参与"最大牌"比较）
  const k = g.hands[0].find((c: Card) => c.rank === 13);
  g.handleTribute(0, [k]);
  const ok2 = g.hands[0].every((c: Card) => c.id !== k.id) && g.hands[1].some((c: Card) => c.id === k.id);
  console.log(`        改贡次大牌 ${names([k])} -> ${ok2 ? '✔ 已接受' : '✘ 被拒绝（BUG）'}，seat1=${names(g.hands[1])}`);
}

// ---------------- 用例3：还贡手里没有的牌 → 拒绝 ----------------
{
  const g: any = makeGame([false, false, false, false]);
  setup(g, [[mk(0, 5)], [mk(3, 4), mk(1, 9)], [mk(0, 2)], [mk(1, 3)]]);
  g.currentPhase = 'ReturnTribute';
  g.tributeState = { pendingTributes: [], pendingReturns: [{ from: 1, to: 0 }] };
  const before = total(g);
  g.handleReturnTribute(1, [mk(2, 16)]); // 不存在于 seat1 的牌
  const ok = g.tributeState.pendingReturns[0].card === undefined && total(g) === before;
  console.log(`[用例3] 还贡手里没有的牌 -> ${ok ? '✔ 已拒绝，牌数不变' : '✘ 被接受（BUG）'}`);
}

// ---------------- 用例4：BOT 自动进贡/还贡，牌必须来自自己手牌且总数守恒 ----------------
{
  const g: any = makeGame([false, true, false, false]); // seat1 是 BOT（头游，收贡后要还贡）
  setup(g, [
    [mk(0, 5), mk(0, 13), mk(1, 7), mk(2, 8)],   // seat0 末游：进贡
    [mk(3, 4), mk(1, 9), mk(2, 10), mk(3, 11)],  // seat1 BOT：收贡后还贡
    [mk(0, 2)],
    [mk(1, 3)],
  ]);
  const before = total(g);
  const seat1Before = g.hands[1].map((c: Card) => c.id);
  g.currentPhase = 'Tribute';
  g.tributeState = { pendingTributes: [{ from: 0, to: 1 }], pendingReturns: [] };

  // seat0 进贡最大的可进贡牌（排除红桃级牌）
  const largest = (g as any).getTributableLargestCard(0);
  g.handleTribute(0, [largest]);

  // 还贡完成后 tributeState 会被清空，因此用"手牌差集"反推 BOT 还了哪张牌
  const returned = g.hands[0].filter((c: Card) => seat1Before.includes(c.id));
  const retOk = returned.length === 1 && !g.hands[1].some((c: Card) => c.id === returned[0].id);
  console.log(`[用例4] BOT(seat1) 还贡 ${returned.length ? names(returned) : '无'} -> ${retOk ? '✔ 来自BOT自己手牌且已转出' : '✘ 异常'}；牌数 ${before} -> ${total(g)} ${total(g) === before ? '✔ 守恒' : '✘ 不守恒'}`);
  console.log(`        seat0: ${names(g.hands[0])}`);
  console.log(`        seat1: ${names(g.hands[1])}`);
}

// ---------------- 用例5：BOT 自动进贡也不能进贡红桃级牌 ----------------
{
  const g: any = makeGame([true, false, false, false]); // seat0 是 BOT（末游，进贡）
  setup(g, [
    [mk(0, 5), mk(1, 7), mk(0, 13)],   // ♥7★ 是逢人配且是最大逻辑值，但不可进贡
    [mk(3, 4)],
    [mk(0, 2)],
    [mk(1, 3)],
  ]);
  g.currentPhase = 'Tribute';
  g.tributeState = { pendingTributes: [{ from: 0, to: 1 }], pendingReturns: [] };
  (g as any).processAutoTribute();
  // seat1 原本只有 ♦4，多出来的那张就是 BOT 进贡的牌
  const paid = g.hands[1].find((c: Card) => c.id !== g.hands[1].find((x: Card) => x.suit === 3 && x.rank === 4).id);
  console.log(`[用例5] BOT 自动进贡 -> ${paid && !paid.isWild ? `✔ 贡了 ${names([paid])}（非红桃级牌）` : `✘ 贡了 ${paid ? names([paid]) : '无'}（BUG）`}`);
  console.log(`        seat0 剩余: ${names(g.hands[0])}`);
}
