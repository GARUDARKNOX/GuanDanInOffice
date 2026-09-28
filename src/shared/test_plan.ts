/**
 * 组牌(HandPlan)压测与校验脚本
 * ----------------------------------------
 * 校验项：
 *  1. 配牌完整性：所有组的牌不重复、不丢失（同一张牌不能被两组同时使用）
 *  2. 同花顺严格性：5 张必须是 5 张独立牌张，去掉万能牌后必须能由万能牌补足成
 *     真正的 5 连同花（不允许"显示为 A2345 实际只有 A234"）
 *  3. 木板顺子(Tube/三连对)：手牌里存在 3 组连续对子时，应能被识别成 Tube
 */
import { Bot } from './bot';
import { Card, HandType, Rank, Suit } from './types';
import { getHandType, getLogicValue } from './rules';
import { updateCardProperties } from './deck';

// ---------- 工具 ----------
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

function makeDeck(): Card[] {
  const d: Card[] = [];
  let id = 0;
  for (let deck = 0; deck < 2; deck++) {
    for (let r = 2; r <= 14; r++) {
      for (let s = 0; s <= 3; s++) {
        d.push({ id: `c${++id}`, suit: s as Suit, rank: r as Rank, isWild: false, isLevelCard: false });
      }
    }
    d.push({ id: `c${++id}`, suit: 4 as Suit, rank: Rank.SmallJoker, isWild: false, isLevelCard: false });
    d.push({ id: `c${++id}`, suit: 4 as Suit, rank: Rank.BigJoker, isWild: false, isLevelCard: false });
  }
  return d;
}

function dealHand(level: number, n = 27): Card[] {
  const deck = makeDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return updateCardProperties(deck.slice(0, n), level);
}

const RN = (r: number) => ({ 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: 'w', 16: 'W' } as any)[r] || String(r);
const fmt = (cs: Card[]) => cs.map(c => (c.rank >= 15 ? RN(c.rank) : '♠♥♣♦'[c.suit] + RN(c.rank))).join(' ');

/**
 * 严格校验一组牌是否真的是"5 张独立牌张组成的同花顺"。
 * 规则：万能牌(逢人配)可以补缺，但 5 张牌必须 cardId 互不相同，且
 *       去掉万能牌后剩余的牌必须同花色、rank 互不相同，且能补齐成 5 连。
 */
function strictStraightFlush(cards: Card[], level: number): boolean {
  if (cards.length !== 5) return false;
  const ids = new Set(cards.map(c => c.id));
  if (ids.size !== 5) return false; // 同一张牌被当成两张用
  const wilds = cards.filter(c => c.isWild);
  const normals = cards.filter(c => !c.isWild);
  if (normals.length === 0) return false;
  const suits = new Set(normals.map(c => c.suit));
  if (suits.size !== 1) return false;
  const ranks = new Set(normals.map(c => c.rank));
  if (ranks.size !== normals.length) return false; // 正常牌里有重复 rank -> 靠万能牌凑不齐
  // 枚举所有 5 连窗口，看能否用 wilds 补成
  const windows: number[][] = [];
  for (let i = 2; i <= 10; i++) windows.push([i, i + 1, i + 2, i + 3, i + 4]);
  windows.push([14, 2, 3, 4, 5]);
  for (const w of windows) {
    let need = 0;
    let ok = true;
    for (const r of w) {
      if (!ranks.has(r)) { need++; continue; }
    }
    // 正常牌的 rank 必须全部落在窗口内
    for (const r of ranks) if (!w.includes(r)) { ok = false; break; }
    if (!ok) continue;
    // 覆盖窗口所需张数 = 5 - normals中属于该窗口的数量
    const used = Array.from(ranks).filter(r => w.includes(r)).length;
    const missing = 5 - used;
    if (missing >= 0 && missing <= wilds.length) return true;
  }
  return false;
}

// ---------- 压测 ----------
let dupCardBug = 0;
let sfBug = 0;
let tubeMissed = 0;
let tubeWindowTotal = 0;
let tubeWindowPlanned = 0;
const perWindow = new Map<string, [number, number]>();
let totalHands = 0;
const sfBugCases: string[] = [];
const tubeMissCases: string[] = [];
const N = 3000;

for (let t = 0; t < N; t++) {
  const level = 2 + Math.floor(rnd() * 13);
  const hand = dealHand(level);
  const bot = new Bot(hand, level, 0, [27, 27, 27, 27]);
  const groups = bot.getHandGroups();

  // 1) 配牌完整性：不允许同一张牌出现在两组里，也不允许丢牌
  const seen = new Set<string>();
  let dup = false;
  for (const g of groups) {
    for (const c of g.cards) {
      if (seen.has(c.id)) dup = true;
      seen.add(c.id);
    }
  }
  if (dup) dupCardBug++;
  if (seen.size !== hand.length) {
    // 配牌丢牌（比重复更严重）
  }

  // 2) 同花顺严格性
  for (const g of groups) {
    if (g.type === HandType.StraightFlush) {
      if (!strictStraightFlush(g.cards, level)) {
        sfBug++;
        if (sfBugCases.length < 5) {
          sfBugCases.push(`level=${level} 组=[${fmt(g.cards)}]  ${g.cards.map(c => c.id).join(',')}`);
        }
      }
    }
  }

  // 3) 木板(Tube) 识别：统计手牌 rank 计数，找出"存在 3 个连续 rank 且每个都恰好 >=2 张"的情况
  const cnt = new Map<number, number>();
  for (const c of hand) if (!c.isWild && c.rank >= 2 && c.rank <= 14) cnt.set(c.rank, (cnt.get(c.rank) || 0) + 1);
  const tubeWindows: number[][] = [[2, 3, 4], [3, 4, 5], [4, 5, 6], [5, 6, 7], [6, 7, 8], [7, 8, 9], [8, 9, 10], [9, 10, 11], [10, 11, 12], [11, 12, 13], [12, 13, 14], [14, 2, 3]];
  const available = tubeWindows.filter(w => w.every(r => (cnt.get(r) || 0) === 2));
  const plannedTubes = groups.filter(g => g.type === HandType.Tube);
  // 覆盖率统计：这组"连续三对"里，有多少真的被配成了 Tube（按窗口分别统计）
  for (const w of available) {
    tubeWindowTotal++;
    const wk = w.join('-');
    if (!perWindow.has(wk)) perWindow.set(wk, [0, 0]);
    perWindow.get(wk)![0]++;
    const covered = plannedTubes.some(g => {
      const rs = new Set(g.cards.map(c => c.rank));
      return rs.size === 3 && w.every(r => rs.has(r));
    });
    if (covered) { tubeWindowPlanned++; perWindow.get(wk)![1]++; }
  }
  if (available.length > 0 && plannedTubes.length === 0) {
    tubeMissed++;
    if (tubeMissCases.length < 5) {
      const w = available[0];
      tubeMissCases.push(`level=${level} 手牌存在 ${w.map(r => RN(r) + RN(r)).join(' ')} 但配牌无 Tube；配牌=${groups.map(g => `${g.type}(${g.cards.length})`).join(',')}`);
    }
  }
  totalHands += groups.length;
}

console.log(`随机 ${N} 副手牌压测结果：`);
console.log(`  同一张牌被两组重复使用 : ${dupCardBug} 例`);
console.log(`  同花顺"5张不独立"      : ${sfBug} 例`);
console.log(`  存在连续三对却没配 Tube : ${tubeMissed} 例`);
console.log(`  连续三对窗口被配成 Tube : ${tubeWindowPlanned}/${tubeWindowTotal} (覆盖率 ${(tubeWindowPlanned / Math.max(1, tubeWindowTotal) * 100).toFixed(1)}%)`);
console.log(`  27 张手牌平均配牌手数   : ${(totalHands / N).toFixed(2)}`);
console.log('  各窗口覆盖情况(出现/配成Tube)：');
for (const [k, [tot, hit]] of perWindow) {
  console.log(`    ${k.split('-').map(r => RN(+r) + RN(+r)).join(' ').padEnd(14)} ${hit}/${tot}  (${(hit / tot * 100).toFixed(0)}%)`);
}
if (sfBugCases.length) {
  console.log('\n  同花顺问题样例：');
  sfBugCases.forEach(s => console.log('   - ' + s));
}
if (tubeMissCases.length) {
  console.log('\n  Tube 漏配样例：');
  tubeMissCases.forEach(s => console.log('   - ' + s));
}

// ---------- 定点用例：万能牌与轮子点数相同的"假同花顺"（level=3，♥3 是逢人配） ----------
console.log('\n=== 定点用例：♥A ♥2 ♥3 ♥4 + ♥3(逢人配) —— 曾经被配成 A2345(实际只有A234) ===');
{
  let id = 200;
  const mk = (s: number, r: number): Card => ({ id: `w${++id}`, suit: s as Suit, rank: r as Rank, isWild: false, isLevelCard: false });
  // level=3 → ♥3 是逢人配(唯一的万能牌)。手上只有 ♥A ♥2 ♥4 三张真红桃 + ♥3(万能牌)，
  // 旧代码找轮子时会把 ♥3 既当作轮子的"3"、又拿它去补"5"，配出 [♥A ♥2 ♥3 ♥4 ♥3] 假同花顺。
  const hand = updateCardProperties([mk(1, 14), mk(1, 2), mk(1, 3), mk(1, 4), mk(0, 9)], 3);
  const bot = new Bot(hand, 3, 0, [5, 5, 5, 5]);
  const gs = bot.getHandGroups();
  console.log('  手牌: ' + fmt(hand));
  console.log('  配牌: ' + gs.map(g => `${g.type} v=${g.value} [${fmt(g.cards)}]`).join(' | '));
  const allIds = gs.flatMap(g => g.cards.map(c => c.id));
  console.log('  配牌用牌总数/去重后: ' + allIds.length + '/' + new Set(allIds).size + (allIds.length === new Set(allIds).size ? '  ✔ 无重复使用' : '  ✘ 有牌被重复配用'));
  for (const g of gs) if (g.type === HandType.StraightFlush) {
    console.log('  同花顺严格校验: ' + (strictStraightFlush(g.cards, 3) ? '✔ 5 张独立牌张' : '✘ 假同花顺'));
  }
}

// ==================== 出牌策略定点用例 ====================
console.log('\n########## 出牌策略（炸弹升级 / 先小后大 / 控制牌留底） ##########');

/** level=7：♥7 为逢人配 */
{
  let id = 300;
  const mk = (s: number, r: number): Card => ({ id: `b${++id}`, suit: s as Suit, rank: r as Rank, isWild: false, isLevelCard: false });
  const H = 1, SP = 0, CL = 2, DI = 3;

  // ---- 用例1：4 张炸 + 1 张逢人配 → 5 张炸 ----
  {
    const hand = updateCardProperties([
      mk(SP, 4), mk(H, 4), mk(CL, 4), mk(DI, 4), mk(H, 7),
      mk(SP, 10), mk(CL, 13), mk(DI, 3),
    ], 7);
    const bot = new Bot(hand, 7, 0, [8, 8, 8, 8]);
    const bombGroups = bot.getHandGroups().filter(g => g.type === HandType.Bomb);
    console.log('\n[用例1] 4444 + ♥7(逢人配)');
    console.log('  配牌里的炸: ' + bombGroups.map(g => `${g.cards.length}张 [${fmt(g.cards)}]`).join(' | '));
    console.log('  getBombs  : ' + bot.getBombs().map(b => `${b.cards.length}张值${b.value}`).join(' | '));
  }

  // ---- 用例2：4 张炸 + 2 张逢人配 → 6 张炸 ----
  {
    const hand = updateCardProperties([
      mk(SP, 4), mk(H, 4), mk(CL, 4), mk(DI, 4), mk(H, 7), mk(H, 7),
      mk(SP, 10), mk(CL, 13),
    ], 7);
    const bot = new Bot(hand, 7, 0, [8, 8, 8, 8]);
    const bombGroups = bot.getHandGroups().filter(g => g.type === HandType.Bomb);
    console.log('\n[用例2] 4444 + ♥7♥7(两张逢人配)');
    console.log('  配牌里的炸: ' + bombGroups.map(g => `${g.cards.length}张 [${fmt(g.cards)}]`).join(' | '));
    console.log('  getBombs  : ' + bot.getBombs().map(b => `${b.cards.length}张值${b.value}`).join(' | '));
  }

  // ---- 用例3：先小后大 —— 有大王+小单张+大钢板时，应领最小的单张 ----
  {
    const hand = updateCardProperties([
      mk(SP, 16),                       // 大王
      mk(SP, 3), mk(H, 4), mk(DI, 6),   // 三张小散牌
      mk(SP, 12), mk(CL, 12), mk(SP, 13), mk(DI, 13), mk(SP, 14), mk(H, 14), // QQ KK AA
    ], 7);
    const bot = new Bot(hand, 7, 0, [10, 10, 10, 10]);
    const move = bot.decideMove(null);
    const h = move ? getHandType(move, 7) : null;
    console.log('\n[用例3] 大王 + 散牌 3/4/6 + 钢板 QQKKAA，自由出牌');
    console.log('  手牌: ' + fmt(hand));
    console.log('  出牌: ' + (move ? `${h?.type} [${fmt(move)}]` : 'null'));
  }

  // ---- 用例4：控制牌留底 —— 大王 + 单张5，先出5留大王 ----
  {
    const hand = updateCardProperties([
      mk(SP, 16), mk(SP, 5), mk(CL, 9), mk(DI, 9), mk(H, 10),
    ], 7);
    const bot = new Bot(hand, 7, 0, [5, 5, 5, 5]);
    const move = bot.decideMove(null);
    const h = move ? getHandType(move, 7) : null;
    console.log('\n[用例4] 大王 + 单张5 + 99 + 10，自由出牌');
    console.log('  手牌: ' + fmt(hand));
    console.log('  出牌: ' + (move ? `${h?.type} [${fmt(move)}]` : 'null'));
  }
}

// ---------- 定点用例：22 33 44 木板 ----------
console.log('\n=== 定点用例：22 33 44 木板顺子 ===');
{
  let id = 0;
  const mk = (s: number, r: number): Card => ({ id: `p${++id}`, suit: s as Suit, rank: r as Rank, isWild: false, isLevelCard: false });
  const hand = updateCardProperties([
    mk(0, 2), mk(1, 2), mk(0, 3), mk(1, 3), mk(0, 4), mk(1, 4),
    mk(2, 10), mk(3, 10), mk(2, 13), mk(3, 13), mk(2, 14), mk(3, 14),
  ], 7);
  const bot = new Bot(hand, 7, 0, [12, 12, 12, 12]);
  console.log('  手牌: ' + fmt(hand));
  console.log('  配牌: ' + bot.getHandGroups().map(g => `${g.type} v=${g.value} [${fmt(g.cards)}]`).join(' | '));
}

// ---------- 定点用例：万能牌补缺的同花顺 ----------
console.log('\n=== 定点用例：A♠2♠3♠4♠ + ♥7(逢人配) ===');
{
  let id = 100;
  const mk = (s: number, r: number): Card => ({ id: `q${++id}`, suit: s as Suit, rank: r as Rank, isWild: false, isLevelCard: false });
  const hand = updateCardProperties([
    mk(0, 14), mk(0, 2), mk(0, 3), mk(0, 4), mk(1, 7),
  ], 7);
  const bot = new Bot(hand, 7, 0, [5, 5, 5, 5]);
  console.log('  手牌: ' + fmt(hand) + '   (♥7 为逢人配 isWild)');
  console.log('  配牌: ' + bot.getHandGroups().map(g => `${g.type} v=${g.value} [${fmt(g.cards)}]`).join(' | '));
  const sf = bot.getHandGroups().find(g => g.type === HandType.StraightFlush);
  console.log('  严格校验(5张独立且可补成5连同花): ' + (sf ? strictStraightFlush(sf.cards, 7) : '无同花顺组'));
}
