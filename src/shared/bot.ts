import { getHandType, getAllPossibleHandTypes, compareHands, sortCards, getLogicValue, isConsecutive } from './rules';
import { Rank, Card, Hand, HandType, Suit } from './types';

/** 炸弹强度：张数优先，点数次要（6炸>5炸>4炸，同张数比点数）；同花顺/天王炸特殊处理 */
function bombStrength(g: { cards: Card[]; type: HandType; value: number }, level: number): number {
  const h = getHandType(g.cards, level);
  if (!h) return 0;
  if (h.type === HandType.FourKings) return 10000;
  if (h.type === HandType.StraightFlush) return 5000 + h.value;
  return (h.bombCount || 4) * 1000 + h.value;
}

/**
 * 严格校验一组牌是否是"真正的 5 张同花顺"。
 *
 * 为什么不能只信 getHandType：
 *  getHandType 只看"非万能牌的 rank 是否落在 5 连区间内 + 是否同花色"，它不检查
 *  **这 5 张是不是 5 张不同的牌**。于是出现经典事故：level=3 时手上
 *  ♥A ♥2 ♥3 ♥4 + 万能牌 ♥3（逢人配），配牌把 ♥3 既当作轮子里的 3、又拿去补 5，
 *  得到 [♥A ♥2 ♥3 ♥4 ♥3] —— 界面显示"A2345"，实际只有 A234 四张牌，
 *  ♥3 一张牌被当成两张用（id 重复）。
 *
 * 校验规则：
 *  1. 5 张牌 cardId 必须互不相同（杜绝同一张牌重复计数）
 *  2. 非万能牌必须同花色、且 rank 互不相同（同 rank 的缺口一个万能牌补不了）
 *  3. 非万能牌的 rank 必须全部落在同一个 5 连窗口内，且缺口数 ≤ 万能牌数
 */
function isValidStraightFlushCombo(cards: Card[], level: number): boolean {
  if (!cards || cards.length !== 5) return false;
  const ids = new Set(cards.map(c => c.id));
  if (ids.size !== 5) return false; // 同一张牌被当成两张用
  const wilds = cards.filter(c => c.isWild);
  const normals = cards.filter(c => !c.isWild);
  if (normals.length === 0) return false;
  const suit = normals[0].suit;
  if (normals.some(c => c.suit !== suit)) return false;
  if (normals.some(c => c.rank > Rank.Ace || c.rank < 2)) return false; // 王不能进同花顺
  const rankSet = new Set(normals.map(c => c.rank));
  if (rankSet.size !== normals.length) return false; // 有重复 rank，万能牌补不出 5 连

  const windows: number[][] = [];
  for (let i = 2; i <= 10; i++) windows.push([i, i + 1, i + 2, i + 3, i + 4]);
  windows.push([14, 2, 3, 4, 5]); // A-2-3-4-5 轮子（最小同花顺）
  for (const w of windows) {
    let allIn = true;
    for (const r of rankSet) if (!w.includes(r)) { allIn = false; break; }
    if (!allIn) continue;
    const missing = 5 - normals.length; // 需要万能牌补的张数
    if (missing >= 0 && missing <= wilds.length) return true;
  }
  return false;
}

// ---- 全局牌追踪器（108张牌，两副标准扑克） ----

/* ... CardTracker class ... */
const TOTAL_PER_RANK: { [rank: number]: number } = {};
for (let r = 2; r <= 14; r++) TOTAL_PER_RANK[r] = 8;
TOTAL_PER_RANK[15] = 4;
TOTAL_PER_RANK[16] = 4;

/** 单个座位的"出牌套路"观察记录（用于判断他手里还剩什么结构的牌） */
export interface SeatPlayLog {
  plays: { type: HandType; value: number; len: number; lead: boolean }[];
  /** 明确过牌（pass）过的牌型 —— pass 过某牌型通常意味着他没有该类牌 */
  passedTypes: HandType[];
}

export class CardTracker {
  private playedByRank: Map<number, number> = new Map();
  private totalPlayed: number = 0;
  /** 每座位出牌套路（跨决策累积，每局开局清空） */
  private seatLogs: Map<number, SeatPlayLog> = new Map();
  /** 最近一次"炸弹类出牌"是谁打的（用于炸后连走节奏） */
  private lastBombSeat: number = -1;

  getTotalPlayed(): number { return this.totalPlayed; }

  constructor(playedCards?: Card[]) {
    if (playedCards) {
      for (const c of playedCards) this.record(c);
    }
  }

  record(card: Card) {
    const r = card.rank;
    this.playedByRank.set(r, (this.playedByRank.get(r) || 0) + 1);
    this.totalPlayed++;
  }

  recordPlay(cards: Card[], seatIndex?: number, hand?: Hand | null, isLead?: boolean) {
    for (const c of cards) this.record(c);
    if (seatIndex === undefined) return;
    const l = this.seatLog(seatIndex);
    const type = hand ? hand.type : HandType.Single;
    l.plays.push({ type, value: hand ? hand.value : 0, len: cards.length, lead: !!isLead });
    const isBombPlay = type === HandType.Bomb || type === HandType.StraightFlush
      || type === HandType.FourKings || type === HandType.ThreeKings;
    // 只有"刚炸完且无人盖过"才算握有节奏；别人一出牌节奏就转移/消失
    this.lastBombSeat = isBombPlay ? seatIndex : -1;
  }

  /** 记录某人对某牌型选择了过牌 */
  recordPass(seatIndex: number, targetType?: HandType) {
    if (targetType === undefined) return;
    const l = this.seatLog(seatIndex);
    if (!l.passedTypes.includes(targetType)) l.passedTypes.push(targetType);
  }

  private seatLog(seat: number): SeatPlayLog {
    let l = this.seatLogs.get(seat);
    if (!l) { l = { plays: [], passedTypes: [] }; this.seatLogs.set(seat, l); }
    return l;
  }

  getSeatLog(seat: number): SeatPlayLog {
    return this.seatLogs.get(seat) || { plays: [], passedTypes: [] };
  }

  /** 最近一次炸弹是谁打的（-1 = 本轮无人炸过 / 节奏已被别人出牌覆盖） */
  getLastBombSeat(): number { return this.lastBombSeat; }

  /** 每局开局清空"套路"观察（rank 计数仍按原逻辑累积） */
  resetSeatLogs() {
    this.seatLogs.clear();
    this.lastBombSeat = -1;
  }

  getRemaining(rank: number): number {
    const total = TOTAL_PER_RANK[rank] || 8;
    const played = this.playedByRank.get(rank) || 0;
    return total - played;
  }

  couldHaveBomb(rank: number): boolean {
    return this.getRemaining(rank) >= 4;
  }

  isRankSafe(rank: number): boolean {
    const rem = this.getRemaining(rank);
    return rem <= 2;
  }

  isRankExhausted(rank: number): boolean {
    return this.getRemaining(rank) === 0;
  }

  countOpponentPotentialBombs(seatIndex: number, handsInfo: number[]): number {
    let count = 0;
    for (let r = 2; r <= 16; r++) {
      if (this.couldHaveBomb(r)) {
        const rem = this.getRemaining(r);
        if (rem >= 6) count += 2;
        else if (rem >= 4) count += 1;
      }
    }
    return count;
  }

  getDangerRanks(): number[] {
    const danger: number[] = [];
    for (let r = 2; r <= 16; r++) {
      if (this.couldHaveBomb(r)) danger.push(r);
    }
    return danger;
  }

  getHighestExhaustedRank(): number {
    for (let r = 16; r >= 13; r--) {
      if (this.isRankExhausted(r)) return r;
    }
    return -1;
  }

  estimatePlayerMaxSingle(seatIndex: number, myCards: Card[], handsInfo: number[]): number {
    const myRanks = new Set(myCards.map(c => c.rank));
    for (let r = 16; r >= 14; r--) {
      if (myRanks.has(r)) continue;
      const rem = this.getRemaining(r);
      if (rem > 0) return r;
    }
    return -1;
  }
}

// ---- 手牌规划器（评分贪心最优分解） ----

class HandPlan {
  groups: { cards: Card[]; type: HandType; value: number }[] = [];
  private bombIndices: Set<number> = new Set();

  getBombIndices(): Set<number> { return this.bombIndices; }

  constructor(cards: Card[], level: number) {
    this.build(cards, level);
  }

  private build(cards: Card[], level: number) {
    const remaining = [...cards];
    this.groups = [];
    this.bombIndices.clear();

    // 1. 提取5+同rank真炸弹（优先提取最大炸弹，不拆5+/6+为4+2）
    const groups = this.groupCards(remaining);
    const bombGroups: { cards: Card[]; type: HandType; value: number }[] = [];
    for (const [r, cs] of groups) {
      if (r === Rank.SmallJoker || r === Rank.BigJoker) continue;
      const nonWild = cs.filter(c => !c.isWild);
      if (nonWild.length >= 4) {
        // 5+张全部作为炸弹，不拆成4+剩余
        const bombCards = nonWild.slice(0, Math.min(nonWild.length, 8));
        const hand = getHandType(bombCards, level);
        if (hand && hand.type === HandType.Bomb) {
          bombGroups.push({ cards: bombCards, type: HandType.Bomb, value: hand.value });
          this.removeCards(remaining, bombCards.map(c => c.id));
        }
      }
    }

    // 四大天王（2小+2大）
    const sj = cards.filter(c => c.rank === Rank.SmallJoker);
    const bj = cards.filter(c => c.rank === Rank.BigJoker);
    if (sj.length === 2 && bj.length === 2) {
      bombGroups.push({ cards: [...sj, ...bj], type: HandType.FourKings, value: 999 });
      this.removeCards(remaining, [...sj, ...bj].map(c => c.id));
    }

    // 1.5 预提取纯同花顺（不用万能牌，纯天然5张同花连续）
    const sfGroups = this.extractPureStraightFlushes(remaining, level);
    for (const g of sfGroups) {
      bombGroups.push(g);
    }

    // 1.6 万能牌优先配同花顺和炸弹（逢人配不浪费在散牌上）
    const wildGroups = this.extractWildCardBombs(remaining, level);
    for (const g of wildGroups) {
      bombGroups.push(g);
    }

    // 1.7 ★ 用剩下的逢人配把已有 4 张炸弹升级成 5 张/6 张炸弹
    //     （4+1=5炸、4+2=6炸、5+1=6炸）。掼蛋里 5 炸压所有 4 炸、6 炸几乎无人能压，
    //     旧实现只在"3张+万能牌=4炸"这一条路上用逢人配，导致手里 4444 + 级牌★ 时
    //     永远只有 4 张炸、被对面的 5 炸/6 炸压死（BOT 有级牌却不会配大炸事故）。
    //     放在同花顺之后执行：同花顺(5.5 强度)的优先级高于 5 炸。
    this.upgradeBombsWithWilds(remaining, bombGroups, level);

    // 2. 逐轮评分选最优组（剩余非炸弹牌）
    while (remaining.length > 0) {
      const best = this.findBestGroup(remaining, level);
      if (!best) break;
      this.groups.push(best);
      this.removeCards(remaining, best.cards.map(c => c.id));
    }

    // 3. 标记炸弹索引（炸弹始终在最后）
    for (const b of bombGroups) {
      this.bombIndices.add(this.groups.length);
      this.groups.push(b);
    }

    // 4. 排序：非炸弹组升序，炸弹最后
    this.sortByPlayOrder();

    // 5. 后处理：评估拆炸弹能否减少手数
    this.optimizeByUnbombing(level);

    // 6. 后处理：交换优化（尝试交换相邻组的牌看手数是否减少）
    this.optimizeBySwapping(level);
  }

  /**
   * 合并优化：尝试把两个非炸弹组合并成"一手合法牌型"，减少总手数。
   * ★ 修复：原实现用 findBestTwoGroups 重新拆分两组，但条件写死
   *   （newGroups.length < 2 直接跳过、oldHandCount=2 导致 2<2 恒假），
   *   整段逻辑是死代码，从未执行过。现改为直接检测"两组牌合并后恰好是
   *   一手牌型"（如两个三张->木板、三带二、两个散单->对子等），严格减少1手。
   */
  private optimizeBySwapping(level: number): void {
    let improved = true;
    let iterations = 0;
    while (improved && iterations < 3) {
      improved = false;
      iterations++;
      const nonBombIdxs: number[] = [];
      for (let i = 0; i < this.groups.length; i++) {
        if (!this.bombIndices.has(i)) nonBombIdxs.push(i);
      }
      for (let a = 0; a < nonBombIdxs.length && !improved; a++) {
        for (let b = a + 1; b < nonBombIdxs.length && !improved; b++) {
          const ia = nonBombIdxs[a];
          const ib = nonBombIdxs[b];
          const ga = this.groups[ia];
          const gb = this.groups[ib];
          const combined = [...ga.cards, ...gb.cards];
          // 合并后必须是"一手能出完"的合法牌型（长度≤6），炸弹走独立逻辑
          if (combined.length > 6) continue;
          const merged = getHandType(combined, level);
          if (!merged) continue;
          if (merged.type === HandType.Bomb || merged.type === HandType.StraightFlush || merged.type === HandType.FourKings || merged.type === HandType.ThreeKings) continue;
          // 级牌不进顺子/连对/木板（级牌是控制牌）
          if (merged.type === HandType.Straight || merged.type === HandType.Tube || merged.type === HandType.Plate) {
            if (combined.some(c => c.rank === level)) continue;
          }
          // 用合并后的一组替换原来的两组
          this.groups.splice(ib, 1);
          this.groups.splice(ia, 1, { cards: combined, type: merged.type, value: merged.value });
          // 重建bombIndices
          const newBombIdxs = new Set<number>();
          for (let i = 0; i < this.groups.length; i++) {
            const h = getHandType(this.groups[i].cards, level);
            if (h && (h.type === HandType.Bomb || h.type === HandType.StraightFlush || h.type === HandType.FourKings)) {
              newBombIdxs.add(i);
            }
          }
          this.bombIndices = newBombIdxs;
          this.sortByPlayOrder();
          improved = true;
        }
      }
    }
  }

  /**
   * 后处理：评估拆掉一个炸弹能否减少总手数。
   * 如果拆炸弹后能组成更多顺子/连对，且总手数减少，则拆。
   * 只拆4炸，不拆5炸+。
   */
  private optimizeByUnbombing(level: number): void {
    const bombIdxs = Array.from(this.bombIndices).sort((a, b) => a - b);
    if (bombIdxs.length === 0) return;

    // 只保留4张炸弹（5+炸太珍贵不拆）
    const fourBombs = bombIdxs.filter(i => {
      const g = this.groups[i];
      return g.cards.length === 4;
    });
    if (fourBombs.length === 0) return;

    let bestPlan = { groups: this.groups, bombIndices: this.bombIndices, handCount: this.estimateTotalHands() };

    for (const bi of fourBombs) {
      const bombGroup = this.groups[bi];
      if (!bombGroup) continue;
      const bombRank = bombGroup.cards[0].rank;

      // 不拆级牌炸弹（级牌炸弹是强炸，拆了浪费）
      if (bombRank === level) continue;

      // 模拟拆掉这个炸弹：把4张牌放回散牌池重新组
      const allCards: Card[] = [];
      for (let i = 0; i < this.groups.length; i++) {
        if (i === bi) {
          allCards.push(...bombGroup.cards); // 拆掉的炸弹牌放回
        } else {
          allCards.push(...this.groups[i].cards);
        }
      }

      // 重新组牌（不提取这个rank的炸弹）
      const newGroups = this.regroupWithoutBomb(allCards, level, bombRank);
      const newBombIndices = new Set<number>();
      for (let i = 0; i < newGroups.length; i++) {
        const h = getHandType(newGroups[i].cards, level);
        if (h && (h.type === HandType.Bomb || h.type === HandType.StraightFlush || h.type === HandType.FourKings)) {
          newBombIndices.add(i);
        }
      }
      const newHandCount = this.countHandsFromGroups(newGroups);

      // 只有手数减少≥2才拆炸（减少1手不值得拆炸弹）
      if (bestPlan.handCount - newHandCount >= 2) {
        const oldBombCount = this.bombIndices.size;
        const newBombCount = newBombIndices.size;
        // ★ 绝不能拆掉最后一个炸弹（炸弹是垫底控盘的核心资产）
        //   拆一个炸后炸弹数-1可以接受，但不能把炸弹数降到0
        if (newBombCount >= 1 && oldBombCount - newBombCount <= 1) {
          // 检查新方案不能把级牌配成连对/顺子的组成部分
          let badPlan = false;
          for (const ng of newGroups) {
            const h = getHandType(ng.cards, level);
            if (!h) continue;
            if (h.type === HandType.Tube || h.type === HandType.Straight) {
              if (ng.cards.some(c => c.rank === level)) {
                badPlan = true; // 级牌被配进连对/顺子，不采用
                break;
              }
            }
          }
          if (!badPlan) {
            bestPlan = { groups: newGroups, bombIndices: newBombIndices, handCount: newHandCount };
          }
        }
      }
    }

    this.groups = bestPlan.groups;
    this.bombIndices = bestPlan.bombIndices;
    this.sortByPlayOrder();
  }

  /** 不提取指定rank的炸弹，重新组牌 */
  private regroupWithoutBomb(cards: Card[], level: number, excludeRank: number): { cards: Card[]; type: HandType; value: number }[] {
    const remaining = [...cards];
    const result: { cards: Card[]; type: HandType; value: number }[] = [];
    const bombGroups: { cards: Card[]; type: HandType; value: number }[] = [];

    // 提取炸弹（跳过excludeRank）
    const g = this.groupCards(remaining);
    for (const [r, cs] of g) {
      if (r === Rank.SmallJoker || r === Rank.BigJoker) continue;
      if (r === excludeRank) continue; // 跳过要拆的rank
      const nonWild = cs.filter(c => !c.isWild);
      if (nonWild.length >= 4) {
        const bombCards = nonWild.slice(0, Math.min(nonWild.length, 8));
        const hand = getHandType(bombCards, level);
        if (hand && hand.type === HandType.Bomb) {
          bombGroups.push({ cards: bombCards, type: HandType.Bomb, value: hand.value });
          this.removeCards(remaining, bombCards.map(c => c.id));
        }
      }
    }

    // 四大天王
    const sj = cards.filter(c => c.rank === Rank.SmallJoker);
    const bj = cards.filter(c => c.rank === Rank.BigJoker);
    if (sj.length === 2 && bj.length === 2) {
      bombGroups.push({ cards: [...sj, ...bj], type: HandType.FourKings, value: 999 });
      this.removeCards(remaining, [...sj, ...bj].map(c => c.id));
    }

    // 纯同花顺
    const sfGroups = this.extractPureStraightFlushes(remaining, level);
    for (const sg of sfGroups) bombGroups.push(sg);

    // 万能牌配同花顺/炸弹
    const wildGroups = this.extractWildCardBombs(remaining, level);
    for (const wg of wildGroups) bombGroups.push(wg);

    // 贪心组非炸弹牌
    while (remaining.length > 0) {
      const best = this.findBestGroup(remaining, level);
      if (!best) break;
      result.push(best);
      this.removeCards(remaining, best.cards.map(c => c.id));
    }

    // 炸弹放最后
    for (const b of bombGroups) result.push(b);
    return result;
  }

  /** 估算当前分组总手数 */
  private estimateTotalHands(): number {
    return this.countHandsFromGroups(this.groups);
  }

  /** 从分组列表估算手数 */
  private countHandsFromGroups(groups: { cards: Card[]; type: HandType; value: number }[]): number {
    return groups.length;
  }

  private findAllBombs(cards: Card[], level: number): { cards: Card[]; type: HandType; value: number }[] {
    const result: { cards: Card[]; type: HandType; value: number }[] = [];
    const groups = this.groupCards(cards);

    // 四大天王
    const sj = cards.filter(c => c.rank === Rank.SmallJoker);
    const bj = cards.filter(c => c.rank === Rank.BigJoker);
    if (sj.length === 2 && bj.length === 2) {
      result.push({ cards: [...sj, ...bj], type: HandType.FourKings, value: 999 });
    }

    // 只提取4张+的同rank炸弹，同花顺不预提取（留给plan自由组合）
    for (const [r, cs] of groups) {
      if (r === Rank.SmallJoker || r === Rank.BigJoker) continue;
      if (cs.length >= 4) {
        result.push({ cards: cs.slice(0, 4), type: HandType.Bomb, value: r });
      }
    }

    return result;
  }

  /**
   * 预提取纯同花顺（5张同花连续，不用万能牌）。
   * 从大到小扫描每个花色，贪心提取不重叠的同花顺。
   * 提取后从 remaining 移除，防止被散顺子/连对消耗。
   */
  private extractPureStraightFlushes(remaining: Card[], level: number): { cards: Card[]; type: HandType; value: number }[] {
    const result: { cards: Card[]; type: HandType; value: number }[] = [];
    const usedIds = new Set<string>();

    for (const s of [Suit.Spades, Suit.Hearts, Suit.Clubs, Suit.Diamonds]) {
      // 取该花色未使用的非万能牌，按rank降序
      const suitCards = remaining
        .filter(c => c.suit === s && !c.isWild && c.rank <= Rank.Ace && !usedIds.has(c.id))
        .sort((a, b) => b.rank - a.rank);

      // 滑动窗口找连续5张
      // ★ 修复：窗口里若已有卡被前面的同花顺占用则跳过——否则会提取互相重叠的
      //   同花顺（如 9-8-7-6-5 和 8-7-6-5-4 共用4张卡），造成配牌重复使用卡片、
      //   出现"假炸弹"幻觉、手牌一变配牌就整体跳变（配牌突然全变事故）。
      for (let i = 0; i <= suitCards.length - 5; i++) {
        const window = suitCards.slice(i, i + 5);
        if (window.some(c => usedIds.has(c.id))) continue; // 已用于别的同花顺的卡不再用
        const ascRanks = window.map(c => c.rank).sort((a, b) => a - b);
        if (isConsecutive(ascRanks)) {
          const hand = getHandType(window, 2); // level 不影响同花顺识别
          if (hand && hand.type === HandType.StraightFlush) {
            result.push({ cards: [...window], type: HandType.StraightFlush, value: hand.value });
            window.forEach(c => usedIds.add(c.id));
          }
        }
      }

      // 也检查 A-2-3-4-5 轮子（最小同花顺）
      // ★ 修复：必须排除万能牌(isWild)。万能牌只能当"补缺的第五张"，不能同时被当成
      //   轮子里的 3/4/5 —— 否则 level=3 时 ♥3(逢人配) 会被既算作轮子的 3、又拿去补 5，
      //   同一张牌被 push 两次，配出"♥A♥2♥3♥4♥3"这种假同花顺（显示 A2345 实际只有 A234）。
      const ace = remaining.find(c => c.suit === s && c.rank === 14 && !c.isWild && !usedIds.has(c.id));
      if (ace) {
        const low = [2, 3, 4, 5].map(r =>
          remaining.find(c => c.suit === s && c.rank === r && !c.isWild && !usedIds.has(c.id))
        );
        if (low.every(c => c)) {
          const wheel = [ace, ...low] as Card[];
          if (isValidStraightFlushCombo(wheel, level)) {
            result.push({ cards: wheel, type: HandType.StraightFlush, value: getHandType(wheel, level)?.value ?? 5 });
            wheel.forEach(c => usedIds.add(c.id));
          }
        }
      }
    }

    this.removeCards(remaining, Array.from(usedIds));
    return result;
  }

  /**
   * 万能牌优先配同花顺（1张补缺）和炸弹（3+1）。
   * 简洁安全：只用getHandType验证，不用getAllPossibleHandTypes。
   */
  private extractWildCardBombs(remaining: Card[], level: number): { cards: Card[]; type: HandType; value: number }[] {
    const result: { cards: Card[]; type: HandType; value: number }[] = [];
    const usedIds = new Set<string>();
    const wilds = () => remaining.filter(c => c.isWild && !usedIds.has(c.id));

    // 1. 同花顺：4张同花连续 + 1张万能牌补缺
    for (const s of [Suit.Spades, Suit.Hearts, Suit.Clubs, Suit.Diamonds]) {
      if (wilds().length === 0) break;
      const suitCards = remaining
        .filter(c => c.suit === s && !c.isWild && c.rank <= Rank.Ace && !usedIds.has(c.id))
        .sort((a, b) => a.rank - b.rank);

      // 找4张连续的窗口
      for (let i = 0; i <= suitCards.length - 4 && wilds().length > 0; i++) {
        const w = suitCards.slice(i, i + 4);
        if (!isConsecutive(w.map(c => c.rank))) continue;
        // ★ 修复：窗口里已有被占用的卡则跳过（与纯同花顺同理，防重叠重复配牌）
        if (w.some(c => usedIds.has(c.id))) continue;

        // 尝试在前后补一张万能牌组成5张同花顺
        const wCard = wilds()[0];
        const five = [...w, wCard];
        // ★ 修复：必须先用 isValidStraightFlushCombo 校验"5 张都是独立牌张"，
        //   只靠 getHandType 会放行"同一张万能牌被算两次"的假同花顺。
        const hand = getHandType(five, level);
        if (hand && hand.type === HandType.StraightFlush && isValidStraightFlushCombo(five, level)) {
          result.push({ cards: five, type: HandType.StraightFlush, value: hand.value });
          five.forEach(c => usedIds.add(c.id));
        }
      }

      // 也试 A-2-3-4 + 万能牌
      if (wilds().length > 0) {
        const lowRanks = [2, 3, 4];
        // ★ 修复：与纯同花顺同理，轮子里找 2/3/4/A 时必须排除万能牌
        const lowCards = lowRanks.map(r =>
          remaining.find(c => c.suit === s && c.rank === r && !c.isWild && !usedIds.has(c.id))
        );
        const ace = remaining.find(c => c.suit === s && c.rank === 14 && !c.isWild && !usedIds.has(c.id));
        if (lowCards.every(c => c) && ace && wilds().length > 0) {
          const five = [ace, ...lowCards, wilds()[0]] as Card[];
          const hand = getHandType(five, level);
          if (hand && hand.type === HandType.StraightFlush && isValidStraightFlushCombo(five, level)) {
            result.push({ cards: five, type: HandType.StraightFlush, value: hand.value });
            five.forEach(c => usedIds.add(c.id));
          }
        }
      }
    }

    // 2. 炸弹：3张同rank + 1张万能牌（仅配强炸value>=7，不配弱炸浪费万能牌）
    if (wilds().length > 0) {
      const existingBombRanks = new Set<number>();
      // 已经提取的炸弹rank不再配（避免重复）
      for (const g of result) {
        if (g.type === HandType.Bomb) {
          g.cards.forEach(c => { if (!c.isWild) existingBombRanks.add(c.rank); });
        }
      }
      const g = this.groupCards(remaining.filter(c => !usedIds.has(c.id)));
      // 按normals数量降序排序：3张同rank优先配（1张万能牌换1个炸弹），
      // 2张次之（2张万能牌换1个炸弹），避免万能牌被小rank抢走
      const sortedEntries = Array.from(g.entries()).sort((a, b) => {
        const na = a[1].filter(c => !c.isWild).length;
        const nb = b[1].filter(c => !c.isWild).length;
        return nb - na; // normals多的优先
      });
      for (const [r, cs] of sortedEntries) {
        if (wilds().length === 0) break;
        if (r === Rank.SmallJoker || r === Rank.BigJoker) continue;
        if (r < 2 || r > 14) continue; // 万能牌配炸弹（级牌万能配所有rank≥2）
        if (existingBombRanks.has(r)) continue; // 已有同rank炸弹不重复配
        const normals = cs.filter(c => !c.isWild);
        // 万能牌配炸弹：用所有normals + 足够万能牌凑成4+张炸弹
        // 如: 3normals+1wild=4炸, 2normals+2wild=4炸, 2normals+3wild=5炸, etc.
        if (normals.length >= 1 && normals.length < 4) {
          const needWilds = Math.max(0, 4 - normals.length);
          const maxWilds = Math.min(wilds().length, 8 - normals.length);
          for (let wc = needWilds; wc <= maxWilds; wc++) {
            if (wc === 0) continue;
            const bombCards = [...normals];
            for (let j = 0; j < wc; j++) bombCards.push(wilds()[j]);
            const hand = getHandType(bombCards, level);
            if (hand && hand.type === HandType.Bomb) {
              result.push({ cards: bombCards, type: HandType.Bomb, value: hand.value });
              bombCards.forEach(c => usedIds.add(c.id));
              break; // 取最小的炸弹（少用万能牌）
            }
          }
        }
      }
    }

    this.removeCards(remaining, Array.from(usedIds));
    return result;
  }

  /**
   * 用剩余万能牌(逢人配)把已有炸弹"升舱"：4张→5张→6张。
   * 只升级 type===Bomb 的组（同花顺/天王炸不动），最多升到 6 张
   * （6 张炸仅次于天王炸，再往上堆万能牌是浪费）。
   */
  private upgradeBombsWithWilds(
    remaining: Card[],
    bombGroups: { cards: Card[]; type: HandType; value: number }[],
    level: number
  ): void {
    if (!remaining || remaining.length === 0 || bombGroups.length === 0) return;
    const usedIds = new Set<string>();
    for (const g of bombGroups) for (const c of g.cards) usedIds.add(c.id);
    const takeWild = (): Card | undefined => remaining.find(c => c.isWild && !usedIds.has(c.id));

    // 张数多的先升（5→6 比 4→5 更值），同张数点数大的先升
    const upgradable = bombGroups
      .filter(g => g.type === HandType.Bomb && g.cards.length >= 4 && g.cards.length < 6)
      .sort((a, b) => (b.cards.length - a.cards.length) || (b.value - a.value));

    for (const g of upgradable) {
      while (g.cards.length < 6) {
        const w = takeWild();
        if (!w) break;
        const next = [...g.cards, w];
        const hand = getHandType(next, level);
        if (!hand || hand.type !== HandType.Bomb) break;
        g.cards = next;
        g.value = hand.value;
        usedIds.add(w.id);
      }
    }
    this.removeCards(remaining, Array.from(usedIds));
  }

  private findBestGroup(cards: Card[], level: number): { cards: Card[]; type: HandType; value: number } | null {
    if (cards.length === 0) return null;
    const candidates = this.generateCandidates(cards, level);
    if (candidates.length === 0) {
      // 兜底：如果只剩万能牌或无法组队的散牌，允许出单张（含万能牌）
      // 万能牌优先用于配炸/顺，但若确实无牌可出，可作最后单张
      for (const c of cards) {
        const hand = getHandType([c], level);
        if (hand) return { cards: [c], type: HandType.Single, value: hand.value };
      }
      return null;
    }

    let best = candidates[0];
    let bestScore = -999999;
    for (const c of candidates) {
      const score = this.scoreGroup(c, cards, level);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  private generateCandidates(cards: Card[], level: number): { cards: Card[]; type: HandType; value: number }[] {
    const result: { cards: Card[]; type: HandType; value: number }[] = [];
    const g = this.groupCards(cards);

    // ★ 关键：4+张同rank是炸弹，绝对不拆成三带二/三条/对子/单张
    // 三带二：只从3张的rank里取三条，配2张的对子(不配4+张)
    const sortedTrips = Array.from(g.entries())
      .filter(([r, cs]) => r >= 2 && r <= 14 && cs.length === 3) // 严格3张，不拆4+炸
      .sort((a, b) => getLogicValue(a[0], level) - getLogicValue(b[0], level));
    
    for (const [r, cs] of sortedTrips) {
      const trip = cs.slice(0, 3);
      // 优先配比自己小的对子（小三张配小对子），不配4+张
      const sortedPairs = Array.from(g.entries())
        .filter(([pr, pcs]) => pr !== r && pr >= 2 && pr <= 14 && pr !== level && pcs.length === 2) // 严格2张
        .sort((a, b) => getLogicValue(a[0], level) - getLogicValue(b[0], level));
      
      for (const [pr, pcs] of sortedPairs) {
        const pair = pcs.slice(0, 2);
        const combined = [...trip, ...pair];
        const hand = getHandType(combined, level);
        if (hand && hand.type === HandType.TripsWithPair) {
          result.push({ cards: combined, type: HandType.TripsWithPair, value: hand.value });
        }
      }
    }

    // 三条：只从严格3张的rank取，排除万能牌（万能牌该配炸/顺）
    for (const [r, cs] of g) {
      if (r < 2 || r > 14 || cs.length !== 3) continue; // 严格3张
      const nonWild = cs.filter(c => !c.isWild);
      if (nonWild.length < 3) continue; // 万能牌不参与三条
      const trip = nonWild.slice(0, 3);
      const hand = getHandType(trip, level);
      if (hand && hand.type === HandType.Trips) {
        result.push({ cards: trip, type: HandType.Trips, value: hand.value });
      }
    }

    // 对子：只从严格2张的rank取（不拆3张的三条、不拆4+炸、不含万能牌）
    for (const [r, cs] of g) {
      if (r < 2 || r > 14 || cs.length !== 2) continue;
      const nonWild = cs.filter(c => !c.isWild);
      if (nonWild.length < 2) continue; // 万能牌不参与对子
      const pair = nonWild.slice(0, 2);
      result.push({ cards: pair, type: HandType.Pair, value: getLogicValue(pair[0].rank, level) });
    }

    // 单张：只从严格1张的rank取（不拆对子/三条/炸弹，不含万能牌）
    for (const c of cards) {
      if (c.isWild) continue; // 万能牌绝不作为单张出
      const sameCount = cards.filter(card => card.rank === c.rank).length;
      if (sameCount === 1 && c.rank >= 2 && c.rank <= 16) {
        result.push({ cards: [c], type: HandType.Single, value: getLogicValue(c.rank, level) });
      }
    }

    // 顺子（5连）：支持逢人配补缺口
    const wilds = cards.filter(c => c.isWild);

    const addCandidate = (candidateCards: Card[]) => {
      const hands = getAllPossibleHandTypes(candidateCards, level);
      for (const hand of hands) {
        // 同花顺属于炸弹资源，不放进普通顺子候选，避免自由出牌浪费炸弹
        if (![HandType.Straight, HandType.Tube, HandType.Plate].includes(hand.type)) continue;
        const exists = result.some(r =>
          r.type === hand.type &&
          r.value === hand.value &&
          r.cards.length === candidateCards.length &&
          r.cards.every(c => candidateCards.some(cc => cc.id === c.id))
        );
        if (!exists) result.push({ cards: candidateCards, type: hand.type, value: hand.value });
      }
    };

    const straightStarts = [2, 3, 4, 5, 6, 7, 8, 9, 10, 14];
    for (const start of straightStarts) {
      const ranks = start === 14 ? [14, 2, 3, 4, 5] : [start, start + 1, start + 2, start + 3, start + 4];
      const seq: Card[] = [];
      let wildUsed = 0;
      let valid = true;
      for (const r of ranks) {
        const cs = g.get(r) || [];
        const normal = cs.find(c => !c.isWild);
        if (normal) seq.push(normal);
        else if (wildUsed < wilds.length) seq.push(wilds[wildUsed++]);
        else { valid = false; break; }
      }
      if (valid) addCandidate(seq);
    }

    // 连对 Tube（三连对 / 俗称"木板顺子"：22 33 44 这种 3 个连续对子，6 张一手）
    // ★ 修复：原 tubeStarts 从 3 起、注释写"不含2(级牌)"——但级牌是随局变化的
    //   （如本局 level=7），于是 22-33-44 这种最小木板**永远不会被生成**
    //   （BOT 从不组 22 33 44 事故）。现在与 rules.ts 的 TUBE_STARTS 完全对齐：
    //   起点 2~12，外加 A-2-3 轮子。
    // ★ 修复：不再因"窗口含级牌"整条跳过——6 张一手清牌的收益通常大于留一对级牌
    //   当控制牌；是否真出由后续评分/出牌策略决定。
    // ★ 修复：不再因某 rank 有 3 张就整条作废——取 2 张配连对、剩 1 张另作他用，
    //   "1 手 6 张 + 1 张散牌"通常优于"三条 + 对子 + 对子"三手。
    const tubeStarts: number[][] = [];
    for (let r = 2; r <= 12; r++) tubeStarts.push([r, r + 1, r + 2]);
    tubeStarts.push([14, 2, 3]); // A-2-3 轮子（与 rules.ts TUBE_STARTS 一致）
    for (const ranks of tubeStarts) {
      const tubeCards: Card[] = [];
      let wildUsed = 0;
      let valid = true;
      for (const r of ranks) {
        const normals = (g.get(r) || []).filter(c => !c.isWild);
        if (normals.length >= 2) {
          tubeCards.push(normals[0], normals[1]);
        } else if (normals.length === 1 && wildUsed < wilds.length) {
          tubeCards.push(normals[0], wilds[wildUsed++]); // 逢人配补一对
        } else if (normals.length === 0 && wildUsed + 2 <= wilds.length) {
          tubeCards.push(wilds[wildUsed++], wilds[wildUsed++]);
        } else { valid = false; break; }
      }
      if (valid) addCandidate(tubeCards);
    }

    // 木板（Plate）：2个连续三条，支持逢人配补三条
    const plateStarts = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
    for (const start of plateStarts) {
      const ranks = [start, start + 1];
      const plateCards: Card[] = [];
      let wildUsed = 0;
      let valid = true;
      for (const r of ranks) {
        const normals = (g.get(r) || []).filter(c => !c.isWild).slice(0, 3);
        plateCards.push(...normals);
        const need = 3 - normals.length;
        if (wildUsed + need > wilds.length) { valid = false; break; }
        for (let i = 0; i < need; i++) plateCards.push(wilds[wildUsed++]);
      }
      if (valid) addCandidate(plateCards);
    }

    // 炸弹（4+同rank）
    for (const [r, cs] of g) {
      if (cs.length >= 4) {
        const bombCards = cs.slice(0, 4);
        const hand = getHandType(bombCards, level);
        if (hand && hand.type === HandType.Bomb) {
          result.push({ cards: bombCards, type: HandType.Bomb, value: hand.value });
        }
      }
    }

    return result;
  }

  /** 评分函数：分值=牌数×10 + 类型分 + 价值/5 + 剩余整合度奖励 - 剩余手数惩罚 */
  private scoreGroup(grp: { cards: Card[]; type: HandType; value: number; bombCount?: number }, remaining: Card[], level: number): number {
    let score = grp.cards.length * 10;
    switch (grp.type) {
      case HandType.TripsWithPair: score += 25; break;
      case HandType.Trips:         score += 12; break;
      // ★ 修复：连对(木板) 6 张 1 手，清牌数比顺子(5张1手)还多，
      //   原 +18 与顺子(+28)相抵后总分持平(60+18=78 vs 50+28=78)，贪心常常错过
      //   22-33-44 这类木板。提到 +24 让"6 张 1 手"稳定胜过"5 张 1 手"。
      case HandType.Tube:          score += 24; break;
      case HandType.Straight:      score += 28; break; // 顺子优先级最高，5张变1轮
      case HandType.Plate:         score += 35; break; // 钢板6张1手，高于三带二
      case HandType.Pair:          score += 5;  break;
      case HandType.Single:        score += 0;  break;
      case HandType.Bomb:          score += 0;  break;
    }
    score += grp.value / 5;
    // ★ 大师配牌修正：三带二该"小三张配小对子"甩弱牌、留大三条/大对子作控制，
    //   且大配大、小配小（避免交叉配：大AAA带小44 + 小333配大KK）。
    //   原来 +grp.value/5 反而奖励"大三条配三带二"，导致交叉配胜出；
    //   而且 pairVal>=13 → -30 误伤"大配大"(AAA+KK 也被罚)。
    if (grp.type === HandType.TripsWithPair) {
      const pairRank = grp.cards[3].rank;
      const pairVal = getLogicValue(pairRank, level);
      const tripVal = grp.value;
      // 三条价值越高越该留作控制 → 配三带二反向扣分（333:-3, QQQ:-12, AAA:-14）
      score -= tripVal;
      // 用大对子(K/A/级牌对)配小三张是浪费 → 对子明显大于三条时罚
      //   （333配KK/AA罚；QQQ/AAA配KK是"大配大"不罚；有更小对子时自然选小对子）
      if (pairVal - tripVal >= 3) score -= 15;
      // 级牌三条绝不配三带二（级牌留作控制）
      if (tripVal >= 15) score -= 30;
      const pairCnt = remaining.filter(c => c.rank === pairRank).length;
      if (pairCnt === 3) score -= 12; // 拆了三条
    }
    // 出完这组后评估剩余牌
    const after = remaining.filter(c => !grp.cards.some(gc => gc.id === c.id));
    const ag = this.groupCards(after);
    // 剩余三条数奖励
    let tripsLeft = 0;
    for (const [, cs] of ag) if (cs.length >= 3) tripsLeft++;
    score += tripsLeft * 2;
    // 剩余单张数惩罚（每多一张散单张扣分）
    let singlesLeft = 0;
    for (const [, cs] of ag) if (cs.length === 1) singlesLeft++;
    if (singlesLeft > tripsLeft) {
      score -= (singlesLeft - tripsLeft) * 12;
    }
    // 剩余手数估计（越少越好）
    const estimatedHands = this.estimateHands(after, level);
    score -= estimatedHands * 3;
    return score;
  }

  /**
   * 粗略估计剩余牌需要几手出完。
   * ★ 修复：原来按"同rank一组算一手"——一条5连顺子会被数成5手，
   *   严重高估剩余手数，导致配牌评分失真、不整合顺子/钢板。
   *   现在贪心识别 木板(2连×3) / 连对(3连×2) / 顺子(5连×1) 后再数剩余组。
   */
  private estimateHands(cards: Card[], level: number): number {
    if (cards.length === 0) return 0;
    const counts = new Map<number, number>();
    let jokers = 0;
    for (const c of cards) {
      if (c.rank > Rank.Ace) { jokers++; continue; } // 大小王单独算
      const r = c.isWild ? level : c.rank;           // 万能牌并入级牌组
      counts.set(r, (counts.get(r) || 0) + 1);
    }
    const take = (r: number, n: number): boolean => {
      const c = counts.get(r) || 0;
      if (c >= n) { counts.set(r, c - n); return true; }
      return false;
    };
    let hands = 0;
    const ranks = Array.from(counts.keys()).sort((a, b) => a - b);
    // 木板：2连 rank 各取3（6张1手，省1手）
    for (let i = 0; i < ranks.length - 1; i++) {
      const a = ranks[i], b = ranks[i + 1];
      while (b === a + 1 && take(a, 3) && take(b, 3)) hands++;
    }
    // 连对：3连 rank 各取2（6张1手，省2手）
    for (let i = 0; i < ranks.length - 2; i++) {
      const a = ranks[i], b = ranks[i + 1], c = ranks[i + 2];
      while (b === a + 1 && c === b + 1 && take(a, 2) && take(b, 2) && take(c, 2)) hands++;
    }
    // 顺子：5连 rank 各取1（5张1手，省4手）
    for (let i = 0; i <= ranks.length - 5; i++) {
      const w = ranks.slice(i, i + 5);
      if (w[4] !== w[0] + 4) continue;
      let ok = true;
      for (const r of w) if ((counts.get(r) || 0) < 1) { ok = false; break; }
      if (ok) { for (const r of w) counts.set(r, (counts.get(r) || 0) - 1); hands++; }
    }
    // 剩余按 rank 组数
    for (const [, c] of counts) {
      if (c <= 0) continue;
      hands++; // 每个剩余rank组至少一手（炸弹/三条/对子/单张）
    }
    hands += jokers; // 王：每张1手
    return hands;
  }

  getNextFreePlay(cardsInHand: Card[]): Card[] | null {
    const available = new Map<string, Card[]>();
    for (const c of cardsInHand) {
      const key = c.suit + ':' + c.rank;
      if (!available.has(key)) available.set(key, []);
      available.get(key)!.push(c);
    }

    // 检查一组牌是否全部可用
    const tryGroup = (g: typeof this.groups[number]): Card[] | null => {
      const needed = new Map<string, number>();
      for (const c of g.cards) {
        const key = c.suit + ':' + c.rank;
        needed.set(key, (needed.get(key) || 0) + 1);
      }
      for (const [key, count] of needed) {
        if ((available.get(key)?.length || 0) < count) return null;
      }
      const result: Card[] = [];
      for (const [key, count] of needed) {
        for (let i = 0; i < count; i++) result.push(available.get(key)![i]);
      }
      return result;
    };

    // helper：找最合适的可用组（从低value到高，跳过太弱的）
    const findBestInTypes = (types: Set<HandType>, skipValBelow: number = 0): Card[] | null => {
      for (let i = 0; i < this.groups.length; i++) {
        const g = this.groups[i];
        if (this.bombIndices.has(i)) continue;
        if (!types.has(g.type)) continue;
        if (g.value < skipValBelow) continue; // 太弱的跳过
        const r = tryGroup(g);
        if (r) return r;
      }
      return null;
    };

    // 第一轮：三带二（从最小value开始）
    const r1 = findBestInTypes(new Set([HandType.TripsWithPair]));
    if (r1) return r1;
    // 第二轮：三条（从最小value开始）
    const r2 = findBestInTypes(new Set([HandType.Trips]));
    if (r2) return r2;
    // 第三轮：顺子/连对（清牌效率高）
    const r3 = findBestInTypes(new Set([HandType.Tube, HandType.Straight]));
    if (r3) return r3;
    // 第四轮：对子（从最弱开始）
    const r4 = findBestInTypes(new Set([HandType.Pair]));
    if (r4) return r4;
    // 第五轮：单张（最弱优先）
    for (const g of this.groups) {
      if (g.type === HandType.Single && !this.bombIndices.has(this.groups.indexOf(g))) {
        const r = tryGroup(g);
        if (r) return r;
      }
    }
    return null;
  }

  isExactPlanGroup(cards: Card[]): boolean {
    const byKey = new Map<string, number>();
    for (const c of cards) {
      const key = c.suit + ':' + c.rank;
      byKey.set(key, (byKey.get(key) || 0) + 1);
    }
    for (const g of this.groups) {
      const gByKey = new Map<string, number>();
      for (const c of g.cards) {
        const key = c.suit + ':' + c.rank;
        gByKey.set(key, (gByKey.get(key) || 0) + 1);
      }
      if (byKey.size !== gByKey.size) continue;
      let match = true;
      for (const [key, count] of byKey) {
        if (gByKey.get(key) !== count) { match = false; break; }
      }
      if (match) return true;
    }
    return false;
  }

  matchesPlan(cards: Card[]): boolean { return this.isExactPlanGroup(cards); }

  rebuild(cards: Card[], level: number) {
    this.groups = [];
    this.bombIndices.clear();
    this.build(cards, level);
  }

  private groupCards(cards: Card[]): Map<number, Card[]> {
    const map = new Map<number, Card[]>();
    for (const c of cards) {
      const r = c.rank;
      if (!map.has(r)) map.set(r, []);
      map.get(r)!.push(c);
    }
    return new Map([...map.entries()].sort((a, b) => a[0] - b[0]));
  }

  private sortByPlayOrder() {
    const nonBombGroups: { cards: Card[]; type: HandType; value: number }[] = [];
    const bombGroups: { cards: Card[]; type: HandType; value: number }[] = [];
    for (let i = 0; i < this.groups.length; i++) {
      if (this.bombIndices.has(i)) bombGroups.push(this.groups[i]);
      else nonBombGroups.push(this.groups[i]);
    }
    nonBombGroups.sort((a, b) => a.value - b.value);
    bombGroups.sort((a, b) => b.value - a.value); // 炸弹从大到小

    this.groups = [];
    this.bombIndices.clear();
    for (const g of nonBombGroups) this.groups.push(g);
    for (const g of bombGroups) {
      this.bombIndices.add(this.groups.length);
      this.groups.push(g);
    }
  }

  private findSFs(cards: Card[]): { cards: Card[]; value: number }[] {
    const result: { cards: Card[]; value: number }[] = [];
    for (const s of [0, 1, 2, 3]) {
      const suitCards = cards.filter(c => c.suit === s && !c.isWild && c.rank <= Rank.Ace);
      suitCards.sort((a, b) => a.rank - b.rank);
      for (let i = 0; i <= suitCards.length - 5; i++) {
        const w = suitCards.slice(i, i + 5);
        if (isConsecutive(w.map(c => c.rank))) {
          result.push({ cards: w, value: w[4].rank });
        }
      }
    }
    return result;
  }

  private removeCards(cards: Card[], idsToRemove: string[]) {
    const removeSet = new Set(idsToRemove);
    for (let i = cards.length - 1; i >= 0; i--) {
      if (removeSet.has(cards[i].id)) cards.splice(i, 1);
    }
  }
}

/**
 * 掼蛋 Bot AI v4
 *
 * 核心设计：
 * 1. 牌力评估 + 角色定位（主攻/助攻）
 * 2. 开局策略：回手K原则、倒数第二大、对子先行
 * 3. 炸弹策略：炸上家不炸下家、经济配火
 * 4. 终局对手牌数分析（枪不打四、七炸八不炸）
 * 5. 队友配合：接牌回传、送牌梯度
 * 6. 手牌规划：减少轮次、控制力评估
 */

// ---- 牌值工具（用原始 rank，不用 logic value） ----

/** 原始 rank 比较（不涉及级牌升级逻辑，纯牌面大小） */
function rawRank(card: Card): number {
  return card.rank;
}

/** 按原始 rank 降序排列 */
function sortByRawRank(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => b.rank - a.rank || b.suit - a.suit);
}

export class Bot {
  cards: Card[];
  level: number;
  seatIndex: number;
  handsInfo: number[];
  tracker: CardTracker;
  private handPlan: HandPlan;
  private lastFreePlayType: 'None' | 'Pair' | 'Single' | 'TripsWithPair' | 'Sequence' = 'None';
  /** 三人模式: isAlly永远false */
  private isThreePlayer: boolean = false;
  /**
   * 规划中"三带二"的对子部分 rank 集合（如 555KK -> {13}）。
   * 跟牌时允许拆出这套对子去压对子（拆后剩余三条仍是一手），这是掼蛋里合理的"拆牌"。
   * 与顺子/连对/钢板（多rank组合，拆一张就废）严格区分。
   */
  private tripsWithPairPairRanks: Set<number> = new Set();

  /** 返回当前手牌的最优分组方案（供前端自动组牌使用） */
  getHandGroups(): { cards: Card[]; type: HandType; value: number; isBomb: boolean }[] {
    const bombIdxs = this.handPlan.getBombIndices();
    return this.handPlan.groups.map((g, i) => ({
      cards: g.cards,
      type: g.type,
      value: g.value,
      isBomb: bombIdxs.has(i)
    }));
  }

  constructor(cards: Card[], level: number, seatIndex: number = 0, handsInfo: number[] = [0,0,0,0], tracker?: CardTracker, isThreePlayer: boolean = false) {
    this.cards = sortCards(cards, level);
    this.level = level;
    this.seatIndex = seatIndex;
    this.handsInfo = handsInfo;
    this.tracker = tracker || new CardTracker();
    this.isThreePlayer = isThreePlayer;
    this.handPlan = new HandPlan(this.cards, this.level);
    // 收集所有三带二规划组的"对子部分"rank（跟牌时可拆对子压对子）
    this.tripsWithPairPairRanks = new Set<number>();
    for (const g of this.handPlan.groups) {
      const h = getHandType(g.cards, this.level);
      if (!h || h.type !== HandType.TripsWithPair) continue;
      const counts = new Map<number, number>();
      for (const c of g.cards) counts.set(c.rank, (counts.get(c.rank) || 0) + 1);
      for (const [rank, cnt] of counts) if (cnt === 2) this.tripsWithPairPairRanks.add(rank);
    }
  }

  private isAlly(idx: number): boolean {
    if (this.isThreePlayer) return false;
    return idx >= 0 && idx % 2 === this.seatIndex % 2;
  }

  private partnerIdx(): number {
    return (this.seatIndex + 2) % 4;
  }

  /** 估算队友手里某 rank 的张数（按队友手数占场外剩余牌的比例分摊） */
  private estimatePartnerHolds(rank: number): number {
    if (this.isThreePlayer) return 0;
    const partner = this.partnerIdx();
    const partnerCount = this.handsInfo[partner];
    if (partnerCount <= 0) return 0;
    if (!this.tracker) return 0;
    // 场外剩余总张数 = 各 rank 剩余之和
    let totalRemaining = 0;
    for (let r = 2; r <= 16; r++) totalRemaining += this.tracker.getRemaining(r);
    if (totalRemaining <= 0) return 0;
    const rem = this.tracker.getRemaining(rank);
    return Math.round((partnerCount / totalRemaining) * rem);
  }

  /** 对手（非我、非队友）可能持有的某rank剩余数 = 总剩余 - 我手里的 - 队友手里的 */
  private getEnemyRemaining(rank: number): number {
    if (!this.tracker) return 0;
    let mine = this.cards.filter(c => c.rank === rank).length;
    let totalRem = this.tracker.getRemaining(rank);
    let partnerHolds = this.estimatePartnerHolds(rank);
    return Math.max(0, totalRem - mine - partnerHolds);
  }

  /**
   * 对手是否可能握有"双大王"（抗贡成功 = 负方两张大王者都在手 / 大小王分落敌方）。
   * 此时领出单张必被王压走送控制权 —— 必须改出对子/顺子/连对/三带二等可控牌型，
   * 让"单张王"这个点打不出来。这是"对方抗贡"局面下的核心出牌原则。
   */
  private opponentsHoldDoubleJokers(): boolean {
    if (!this.tracker) return false;
    const bjRem = this.getEnemyRemaining(Rank.BigJoker);
    const sjRem = this.getEnemyRemaining(Rank.SmallJoker);
    return bjRem >= 2 || (bjRem >= 1 && sjRem >= 1);
  }

  /** 某rank在我手里之外（桌面已出 + 其他三家手里）还剩几张 */
  private getRemainingOutsideMyHand(rank: number): number {
    if (!this.tracker) return 0;
    const mine = this.cards.filter(c => c.rank === rank).length;
    return Math.max(0, this.tracker.getRemaining(rank) - mine);
  }

  /** 对手可能持有的炸弹数（已减掉我手里的牌） */
  private countEnemyPotentialBombs(): number {
    if (!this.tracker) return 0;
    // 牌局早期（出牌少）数据不足，无法可靠判断对手炸弹，保守返回0
    // 否则会把所有剩余牌都当威胁，导致牌力被严重低估
    if (this.tracker.getTotalPlayed() < 10) return 0;
    let count = 0;
    for (let r = 2; r <= 16; r++) {
      const rem = this.getEnemyRemaining(r);
      // 只有剩余≥6才可能凑成炸弹（≥4分散在多个对手手里，不构成威胁）
      if (rem >= 8) count += 2;
      else if (rem >= 6) count += 1;
    }
    return count;
  }

  /** 当前游戏阶段 */
  private getPhase(): 'opening' | 'mid' | 'endgame' {
    if (this.cards.length > 20) return 'opening';
    if (this.cards.length <= 10) return 'endgame';
    // ★ 修复：残局不能只看自己手牌数——自己牌多但场上其他人已进入
    //   低手数阶段，同样已是残局（对手/队友都在准备走牌了）
    const others = this.handsInfo.filter((_, i) => i !== this.seatIndex);
    if (others.some(c => c > 0 && c <= 8)) return 'endgame';
    return 'mid';
  }

  /** 下家敌人是否只剩1张？如果是，绝对不能出单张 */
  private nextEnemyHasOne(): boolean {
    const next = (this.seatIndex + 1) % 4;
    return !this.isAlly(next) && this.handsInfo[next] === 1;
  }

  /** 下家敌人是否濒临走牌（≤3张） */
  private nextEnemyDanger(): boolean {
    const next = (this.seatIndex + 1) % 4;
    return !this.isAlly(next) && this.handsInfo[next] <= 3;
  }

  /**
   * 联盟是否濒临走牌（还剩 1-3 张）。
   * ★ 修复：队友已经走完（0 张）不算"濒临走牌"——队友头游后应转为
   *   为自己抢名次（走 findControllingPlay 控牌/保结构），而不是继续
   *   给一个已经赢了的队友"送最弱牌"。
   */
  private allyNearOut(): boolean {
    const p = this.partnerIdx();
    const cards = this.handsInfo[p];
    // ★ 放宽到 ≤5 张：联盟方剩 4~5 张（一手对子/三带二/顺子）同样需要抬牌送他走头游，
    //   不能死等"只剩 1-3 张"才反应——那时队友往往已经错过最佳出牌权窗口。
    return cards > 0 && cards <= 5;
  }

  decideMove(target: Hand | null, lastPlayerIndex: number = -1): Card[] | null {
    if (this.cards.length === 0) return null;
    let result: Card[] | null;
    if (!target) {
      result = this.decideFreePlay();
    } else {
      result = this.decideFollowPlay(target, lastPlayerIndex);
    }
    // 出牌前验证合法性
    if (result && !getHandType(result, this.level)) {
      console.warn('[Bot] Invalid play generated, falling back');
      result = null;
    }
    if (result) {
      // 记录自由出牌的牌型（用于轮换）
      if (!target) {
        const hand = getHandType(result, this.level);
        if (hand) {
          if (hand.type === HandType.Pair) this.lastFreePlayType = 'Pair';
          else if (hand.type === HandType.Single) this.lastFreePlayType = 'Single';
          else if (hand.type === HandType.TripsWithPair) this.lastFreePlayType = 'TripsWithPair';
          else if (hand.type === HandType.Straight || hand.type === HandType.Tube) this.lastFreePlayType = 'Sequence';
          else this.lastFreePlayType = 'None';
        }
      }
      this.handPlan.rebuild(this.cards, this.level);
    }
    return result;
  }

  // ---- 牌力评估与角色定位 ----

  private assessHandStrength(): number {
    let score = 0;
    const groups = this.groupByRawRank();
    for (const [r, cs] of groups) {
      if (cs.length >= 4) score += 15;
    }
    const sfs = this.findStraightFlushes();
    score += sfs.length * 20;
    const sj = this.cards.filter(c => c.rank === Rank.SmallJoker).length;
    const bj = this.cards.filter(c => c.rank === Rank.BigJoker).length;
    if (sj === 2 && bj === 2) score += 40;
    score += bj * 8 + sj * 5;
    const levelCards = this.cards.filter(c => c.rank === this.level).length;
    score += levelCards * 3;
    const bigCards = this.cards.filter(c => c.rank >= 13 && c.rank <= 14).length;
    score += bigCards * 1;
    const types = this.countHandTypes(this.cards);
    score += Math.max(0, 15 - types * 3);
    // 手数因子：手数越少牌力越强
    const handCount = this.estimateTotalHandsForStrength();
    score += Math.max(0, 12 - handCount) * 2;

    // ★ 记忆增强：外面已出的大牌越多，我手里对应的大牌/级牌实际牌力越强
    if (this.tracker) {
      // 大王全出完 -> 我手里的大王是绝对控制，小王/A 显著升值
      const bjRem = this.getEnemyRemaining(Rank.BigJoker);
      const sjRem = this.getEnemyRemaining(Rank.SmallJoker);
      if (bjRem === 0) {
        score += 8; // 大王已尽，控制力上升
        if (sj > 0) score += 4; // 我手里小王就是单张霸王
        if (this.cards.some(c => getLogicValue(c.rank, this.level) >= 19)) score += 3; // 级牌升值
      }
      // 小王也全出完 -> 我的 A 成为顶级单张
      if (bjRem === 0 && sjRem === 0) {
        if (this.cards.some(c => c.rank === Rank.Ace)) score += 4;
        if (this.cards.some(c => c.rank >= 13)) score += 3;
      }
      // 敌方可能炸弹越少，我越敢打（牌力相对提升）
      const oppBombs = this.countEnemyPotentialBombs();
      score -= oppBombs * 2; // 对手炸弹威胁大 -> 牌力折扣
      // 我已出的某些 rank 耗尽 -> 这些牌型安全可控
      if (this.tracker.getHighestExhaustedRank() >= 14) score += 3;
    }

    return Math.min(100, Math.max(0, score));
  }

  /** 估算当前手牌需要几手出完（不考虑炸弹） */
  private estimateTotalHandsForStrength(): number {
    // 用handPlan的分组数估算（炸弹也算一手）
    if (this.handPlan && this.handPlan.groups.length > 0) {
      return this.handPlan.groups.length;
    }
    const groups = this.groupByRawRank();
    let hands = 0;
    for (const [, cs] of groups) {
      if (cs.length >= 4) { hands++; continue; } // 炸弹/炸组
      if (cs.length === 3) { hands++; continue; } // 三条
      if (cs.length === 2) { hands++; continue; } // 对子
      if (cs.length === 1) { hands++; continue; } // 单张
    }
    return hands;
  }

  private getRole(): 'attacker' | 'supporter' {
    const strength = this.assessHandStrength();
    const partnerCards = this.handsInfo[this.partnerIdx()];
    if (strength >= 40) return 'attacker';
    if (strength <= 20) return 'supporter';
    return partnerCards <= 8 ? 'supporter' : 'attacker';
  }

  /**
   * 我是否具备"一口气冲头游"的资本：剩余手数 ≤3，且每一手都是"硬牌"
   * （炸弹/同花顺/≥5张成型组合/三带二/对子/三条，以及高位控制单张），
   * 对手光靠普通牌压不住、需要连续硬牌才能打断。
   *
   * 满足时应当主动领出硬牌冲刺抢头游，而不是被动等对手先走（BOT2 被 Bot3
   * 一路 A2345→6666→钢板 冲走头游、自己却在后面墨迹散牌的事故）。
   */
  private canSprintToWin(): boolean {
    const groups = this.handPlan.groups;
    const bombIdxs = this.handPlan.getBombIndices();
    if (groups.length > 3) return false; // 手数太多，谈不上一口气
    for (let i = 0; i < groups.length; i++) {
      const h = getHandType(groups[i].cards, this.level);
      if (!h) return false;
      if (bombIdxs.has(i)) continue; // 炸弹/同花顺 = 硬牌
      if (h.type === HandType.Single) {
        // 只有王/级牌/逢人配这种绝对控制单张才允许算"硬单张"，小单张不配
        const v = getLogicValue(groups[i].cards[0].rank, this.level);
        if (v < 17) return false;
        continue;
      }
      // 对子/三条/三带二/顺子/连对/钢板 都算硬牌
    }
    return true;
  }

  // ==================== 自由出牌（控制发牌权） ====================

  private decideFreePlay(): Card[] {
    // 能一把走完
    const allOut = this.tryPlayAll();
    if (allOut) return allOut;

    // === 必胜冲刺：还在场上的所有对手手牌数都 < 4 张 ===
    // 他们凑不出4张以上的组合、也没有炸弹，所以我手里的任何≥4张成型组合
    // (三带二/顺子/连对/钢板)都是必胜的——直接出张数最多的那个冲牌、保住出牌权。
    // 必须放在所有分支之前：否则下家敌人剩1张时会先走 nextEnemyHasOne 分支，
    // 把最大单张(如A)或拆炸弹出单张(如JJJJ拆J)打出去，被对手唯一一张大牌压走、
    // 白白把必胜的 678910 顺子 / 34567 顺子捂在手里送对手头游（BOT2 对手都<4张
    // 却先出单张事故）。炸弹/同花顺不在此冲——它们留底做绝对控制。
    const activeEnemies = [0, 1, 2, 3].filter(s => !this.isAlly(s) && this.handsInfo[s] > 0);
    // ★ 抢头游意图：两种情形都切换到"冲刺模式"——
    //   1) 所有对手都 <4 张（他们出不了成型组合，我任何≥4张组合必胜）——原有逻辑
    //   2) 我自己能一口气冲完（≤3 手全是硬牌）且场上已有对手在跑(≤8张)——
    //      此时必须主动领硬牌抢头游，而不是被动等对手先走完（BOT2 被 Bot3 一路
    //      A2345→6666→钢板 冲走、自己墨迹散牌的事故）。
    const allEnemiesLow = activeEnemies.length > 0 && activeEnemies.every(s => this.handsInfo[s] < 4);
    const sprintMode = allEnemiesLow ||
      (this.canSprintToWin() && activeEnemies.some(s => this.handsInfo[s] > 0 && this.handsInfo[s] <= 8));
    if (sprintMode) {
      const winningCombos = this.handPlan.groups.filter(g => {
        const h = getHandType(g.cards, this.level);
        if (!h || h.type === HandType.Bomb || h.type === HandType.StraightFlush || h.type === HandType.FourKings || h.type === HandType.ThreeKings) return false;
        return g.cards.length >= 4;
      });
      if (winningCombos.length > 0) {
        // 张数多优先(清牌最多)，同张数选价值小(小组合先出、大组合留收尾)
        winningCombos.sort((a, b) => {
          if (a.cards.length !== b.cards.length) return b.cards.length - a.cards.length;
          const ha = getHandType(a.cards, this.level);
          const hb = getHandType(b.cards, this.level);
          return (ha?.value || 0) - (hb?.value || 0);
        });
        if (this.canPlay(winningCombos[0].cards)) return winningCombos[0].cards;
      }
    }

    // === 终局保护：下家敌人剩1张 -> 绝对不出单张 ===
    if (this.nextEnemyHasOne() && this.cards.length > 1) {
      const nonSingle = this.findBestNonSingle();
      if (nonSingle) return nonSingle;
      return this.playBiggestSingle();
    }

    // === 队友快走牌(≤5张) -> 送队友需要的牌型 ===
    // ★ 修复：只有自己牌多(中局)才送队友；自己已进入终局(≤12张)时必须先冲自己的
    //   成型组合——BOT2 剩 999JJ三带二+2+5、对手皆濒走时却先出单张2去"送队友"，
    //   被对手大单(如J)压走控制、送对手走完，三带二被压后差点走不掉。掼蛋大师原则：
    //   中局帮队友抬牌，终局有成型组合先冲自己保控制。
    if (this.allyNearOut() && this.cards.length > 12) {
      const weak = this.findWeakestPlanPlay();
      if (weak) return weak;
    }

    // === 核心策略：出能收回发牌权的牌 ===
    const controllingPlay = this.findControllingPlay();
    if (controllingPlay) return controllingPlay;

    // === 兜底 ===
    return this.decideFreePlayFallback();
  }

  /**
   * 找一手能控制发牌权的牌。
   * 优先级：
   * 1. 出小牌+手里有同类型大牌能收回
   * 2. 出对手接不了的牌型（已出完的牌型）
   * 3. 出队友能接的牌型
   * 4. 出最大的单张/对子封锁
   */
  private findControllingPlay(): Card[] | null {
    const myGroups = this.handPlan.groups;
    const bombIdxs = this.handPlan.getBombIndices();
    const nonBombGroups = myGroups.filter((_, i) => !bombIdxs.has(i));
    const myBombs = bombIdxs.size;
    const myCards = this.cards.length;
    // ★ 刚用炸弹夺回出牌权：这一手是"花钱买来的"，必须立刻切换到自己能掌控的牌路
    //   ——优先甩成型组合、一次清掉最多的牌，而不是再去探路出小散单。
    const bombMomentum = !!this.tracker && this.tracker.getLastBombSeat() === this.seatIndex;

    // ★ 同花顺 = 炸弹级资源，绝不优先甩（留底保控制权）
    //    同花顺已包含在 bombIndices 中，走下方"炸弹留底/终局冲刺"逻辑：
    //    - 出完同花顺剩余0张 → 直接出走头游
    //    - 出完剩余1手 → 先出那手，同花顺保底
    //    不能像普通顺子一样优先清牌甩掉，那是浪费炸弹

    // ★ 终局冲刺：如果出完炸弹后剩余牌≤1手能走完，直接出炸弹冲头游
    if (myBombs > 0) {
      const bombGroups = myGroups.filter((_, i) => bombIdxs.has(i));
      // 最弱的炸弹（按强度：张数优先，点数次要）
      bombGroups.sort((a, b) => bombStrength(a, this.level) - bombStrength(b, this.level));
      if (bombGroups.length > 0) {
        const smallestBomb = bombGroups[0];
        const bombCardCount = smallestBomb.cards.length;
        const remainingAfterBomb = myCards - bombCardCount;
        // 出炸弹后剩0张 -> 直接走头游
        if (remainingAfterBomb === 0) {
          if (this.canPlay(smallestBomb.cards)) return smallestBomb.cards;
        }
        // 出炸弹后剩>0张：不应先出炸弹（炸弹应留到最后保底）
        // 正确策略：先出剩余的非炸弹手牌减手数，炸弹留最后一手控制权
        if (remainingAfterBomb > 0 && remainingAfterBomb <= 5) {
          // 如果剩余牌正好是一手合法牌型 -> 先出这手非炸弹牌，炸弹留最后
          const remainingCards = this.cards.filter(c => !smallestBomb.cards.some(bc => bc.id === c.id));
          const remainingHand = getHandType(remainingCards, this.level);
          if (remainingHand && this.canPlay(remainingCards)) {
            // ★ 修复：剩余牌若也是炸弹（双炸 / 炸+同花顺 / 炸+天王炸），
            //   绝不能先出剩余的那手——必须"先出小炸、留大炸"。先甩大炸会把
            //   最后一张保底/收尾的炸提前暴露，被对手用小炸一压就收不了尾。
            if (remainingHand.type === HandType.Bomb || remainingHand.type === HandType.StraightFlush || remainingHand.type === HandType.FourKings) {
              return smallestBomb.cards; // 先出小炸，大炸留最后（出小留大）
            }
            return remainingCards; // 剩余是普通牌型 -> 先出这手，炸弹保底
          }
          // 剩余牌不是一手（多张散牌）-> 更不该先出炸弹，交给下面的散牌逻辑
        }
      }
    }

    // ★ 牌力强(≥2炸弹)且只剩散牌(单张/对子)时，主动用最小炸抢节奏——
    //   否则抱着一堆大炸墨迹出散牌探路，把节奏让给对手、对手趁机用炸清牌头游
    //   （BOT2 持 3炸+大王+级牌却出 55/9 散牌墨迹，seat0 用8888/QQQQ主动清牌头游）。
    //   ★ 修复：只在"有绝对大炸(6张，几乎无人能压) / 对手濒走(<4张) / 自己快走(≤8张)"
    //     时才主动用炸——5炸甚至4炸主动领出都是白送(4444 被压就废；BOT2 持 5555/666万/
    //     JJJJ/QQQQQ 连续主动炸4个、剩散牌末游事故)。掼蛋大师原则：只有6炸/天王炸这种
    //     绝对控制才配主动换出牌权且稳赚；普通炸一律留底，用来压对手的炸/阻断濒走。
    if (myBombs >= 1) {
      const bombGroups = myGroups.filter((_, i) => bombIdxs.has(i));
      const maxBombLen = bombGroups.reduce((m, b) => Math.max(m, b.cards.length), 0);
      const activeEnemies = [0, 1, 2, 3].filter(s => !this.isAlly(s) && this.handsInfo[s] > 0);
      const enemiesLow = activeEnemies.length > 0 && activeEnemies.every(s => this.handsInfo[s] < 4);
      // ★ 修复：主动领出炸弹的唯一正当收益是"冲刺"——出完这颗炸后剩余牌能顺利走完。
      //   原"myCards <= 12 就主动出炸"和"多炸+只剩散牌就抢节奏"都太激进，导致 BOT2
      //   剩 12 张(9999※+55+77+1010+KK)却主动甩 9999※、剩 4 手对子走不完(#63 事故)。
      //   现在只有：对手都濒走(<4) / 我有6张绝对大炸 / 出完最小炸后剩余≤1手(或全炸)
      //   且我已残局(≤12) 才会主动领出炸弹；否则炸弹一律留底压对手的炸/阻断成型牌。
      const sortedBombs = [...bombGroups].sort((a, b) => bombStrength(a, this.level) - bombStrength(b, this.level));
      const smallestBombCards = sortedBombs.length ? sortedBombs[0].cards : [];
      const afterSmallest = this.cards.filter(c => !smallestBombCards.some(bc => bc.id === c.id));
      const canFinishWithBomb = afterSmallest.length === 0 ||
        (afterSmallest.length > 0 && !!getHandType(afterSmallest, this.level)) ||
        this.areAllCardsBombs();
      const shouldLeadBomb =
        enemiesLow ||
        maxBombLen >= 6 ||
        (canFinishWithBomb && myCards <= 12);
      // 开局牌太多时仍然留炸（6张绝对大炸 / 对手濒走 除外）
      const notTooEarly = myCards <= 15 || enemiesLow || maxBombLen >= 6;
      if (shouldLeadBomb && notTooEarly) {
        // ★ 修复：有绝对大炸(6张)主动抢节奏时出6张大炸(几乎无人能压)，不出最小炸
        //   ——原来出 bombGroups[0](最小) 会把 4张9999 白送(被更大炸压就废)。
        //   安全约束：炸完必须还能掌控牌路，否则等于白送炸弹。
        const useBig = maxBombLen >= 6;
        const sorted = [...bombGroups].sort((a, b) => useBig
          ? bombStrength(b, this.level) - bombStrength(a, this.level)
          : bombStrength(a, this.level) - bombStrength(b, this.level));
        if (sorted.length > 0 && this.canControlAfterBomb() && this.canPlay(sorted[0].cards)) {
          return sorted[0].cards;
        }
      }
    }

    // ★★ 残局"散牌先行、控制留底"（必须排在"出成型组合"之前！）
    //   手里同时有 (a) 散单张 和 (b) 能稳稳收回一手的成型大组合/炸弹 时，先出最小的散单，
    //   把大组合留到最后收尾。反之若先把大组合甩掉（清牌再高也只清一手），手上剩下的
    //   就全是"随便一张更小的单/对就能压死、且永远抢不回出牌权"的小散牌，必然末游。
    //   ——本局 BOT2 事故：13 张手牌 AA KK QQ + 555 + 6,4,3,2 时，先甩掉 Tube(QQ-KK-AA)
    //   这唯一能压制全场的一手，剩下 555+6+4+3+2 四手小牌再也抢不到出牌权，
    //   最终 ♠4♥3 卡底末游。正确顺序是先清 2/3/4/6 之类的死牌，用 AA/KK/QQ 收尾。
    //   例外：下家敌人濒走(≤5张)时不留手——必须立刻出稳赢的那一手保住出牌权。
    const nextSeatL = (this.seatIndex + 1) % 4;
    const nextEnemyL = this.isAlly(nextSeatL) ? 999 : this.handsInfo[nextSeatL];
    // ★ 控制资产：能"稳吃一手"的资源（王 / 级牌 / 逢人配 / 炸弹 / 同花顺 / 大成型组合）。
    //   有控制资产 = 丢一次出牌权也能抢回来 → 可以放心先清小牌（先小后大）；
    //   没有控制资产 = 这手领出很可能就是最后一次 → 必须一次清掉最多的牌。
    const hasControlAsset = this.hasControlAsset(nonBombGroups);
    // ★ 抗贡/双大王意识：对手握双大王时，领出单张必被王压走送控制——
    //   即便"先小后大"想清散单也必须让位，改出可控的对子/顺子/连对/三带二。
    const doubleJokerDanger = this.opponentsHoldDoubleJokers();
    if (nextEnemyL > 5 && hasControlAsset && !bombMomentum && !doubleJokerDanger) {
      const looseSingles = nonBombGroups.filter(g => {
        const h = getHandType(g.cards, this.level);
        return h && h.type === HandType.Single;
      });
      // 至少要清得动 2 张散单才做这个"先小后大"的换位；残局更深(≤10张)时 1 张也先清
      if (looseSingles.length >= 2 || (looseSingles.length === 1 && myCards <= 10)) {
        looseSingles.sort((a, b) => getLogicValue(a.cards[0].rank, this.level) - getLogicValue(b.cards[0].rank, this.level));
        for (const s of looseSingles) {
          const c = s.cards[0];
          // 王/级牌/逢人配是绝对控制牌，必须留底收尾，绝不拿来"先出小牌"
          if (c.rank === Rank.BigJoker || c.rank === Rank.SmallJoker) continue;
          if (c.isWild || c.rank === this.level) continue;
          // 只清"真小牌"(≤10)；J/Q/K/A 属于半控制牌，留在后面出
          if (getLogicValue(c.rank, this.level) > 10) break;
          if (this.canPlay(s.cards)) return s.cards;
        }
      }
    }

    // ★ 修复：先出成型的顺子/连对/钢板（清牌效率高、还难被压）。
    //   原本"安全牌"规则(0.5)排在它前面，会把手里最大的对子(如AA)当"安全牌"先打出，
    //   导致握着 56789 顺子却先甩 AA、AA 被双小王压掉抢走控制（BOT 先出AA复盘事故）。
    //   掼蛋大师思路：先出成型顺子/钢板减少手数，AA 这种控制牌留最后收尾。
    const mySequences = nonBombGroups.filter(g => {
      const h = getHandType(g.cards, this.level);
      return h && (h.type === HandType.Straight || h.type === HandType.Tube || h.type === HandType.Plate);
    });
    if (mySequences.length > 0) {
      // ★ 修复：选哪一条序列也讲"先小后大"——
      //   有控制资产（丢权能抢回）→ 按 value 升序，先出最小的组合，把 KKKAAA 这种
      //     绝对控制留到收尾（BOT2 开局/残局先甩大钢板、剩散牌末游事故）；
      //   没有控制资产（很可能只剩这一次领出）→ 按张数降序，一次清掉最多的牌。
      mySequences.sort((a, b) => {
        const ha = getHandType(a.cards, this.level);
        const hb = getHandType(b.cards, this.level);
        if (hasControlAsset && !bombMomentum) {
          // 先小后大：value 升序；同 value 取张数多的（多清牌）
          if ((ha?.value || 0) !== (hb?.value || 0)) return (ha?.value || 0) - (hb?.value || 0);
          return b.cards.length - a.cards.length;
        }
        // 刚炸完夺权（或无控制资产）：这一手很可能就是唯一机会 → 一次清掉最多的牌
        // 张数多优先（清牌更多），同张数比value小优先
        if (a.cards.length !== b.cards.length) return b.cards.length - a.cards.length;
        return (ha?.value || 0) - (hb?.value || 0);
      });
      const seq0 = mySequences[0];
      const seq0h = getHandType(seq0.cards, this.level);
      // ★ 修复：开局(手牌很多)时不出"大序列"(v≥12)——大钢板/大顺子是几乎无人能压的
      //   控制牌，开局该先出散牌探路、大序列留中后期收尾；一上来就把 KKKAAA 这种
      //   绝对控制甩掉，等于把收尾牌提前暴露（BOT2 开局领出 KKKAAA 大钢板事故）。
      //   只有手牌较少(≤18)或序列较小(v<12)时才优先清牌出序列。
      const skipBig = myCards > 18 && (seq0h?.value || 0) >= 12;
      if (!skipBig && this.canPlay(seq0.cards)) return seq0.cards;
    }

    // 按牌型分组，找"有大小两组"的类型（出小留大收回）
    const typeMap = new Map<HandType, { cards: Card[]; value: number; index: number }[]>();
    for (let i = 0; i < nonBombGroups.length; i++) {
      const g = nonBombGroups[i];
      const hand = getHandType(g.cards, this.level);
      if (!hand) continue;
      if (!typeMap.has(hand.type)) typeMap.set(hand.type, []);
      typeMap.get(hand.type)!.push({ cards: g.cards, value: hand.value, index: i });
    }

    // 0. 如果有炸弹且有散牌，优先出散牌，炸弹垫底
    // 只有非炸弹组全部出完才出炸弹（除非终局）
    if (myBombs > 0 && nonBombGroups.length > 0 && myCards > 6) {
      // 跳过炸弹，直接走下面的散牌逻辑
    }

    // 0.5 tracker驱动：优先出对手已出完rank的牌（安全牌）
    // ★ 修复：原来用 tracker.isRankExhausted(rank) 判断"某rank已出完"，
    //   但该函数算的是"全桌已出数 == 总数"，而这里检查的 rank 正是自己
    //   握着的牌，导致它永远为 false，整段逻辑从未生效。现在改为
    //   "该 rank 在我手里之外已耗尽"（桌面已出 + 其他三家手里都没有），
    //   出这个 rank 的单张/对子才真正安全（不会被同 rank 压）。
    if (this.tracker) {
      for (const g of nonBombGroups) {
        const hand = getHandType(g.cards, this.level);
        if (!hand) continue;
        // ★ 修复：单张彻底不走"安全牌"——单张比大小、任何更大的单张都能压，
        //   "rank在外耗尽"只防同rank、不防更大单，安全意义有限；反而会先出
        //   rank耗尽的非最小单张(如8)、把最小的2留到最后（BOT2 留2末游事故）。
        //   散单张统一交给最后的单张步骤"出最小探路、大牌留底收尾"。
        if (hand.type === HandType.Pair) {
          // ★ 修复：终局(≤12张)时"安全牌"不抢对子的出牌顺序——否则会把最大对子
          //   (如AA)当安全牌先出，而终局正确顺序是先出小对子(QQ)、AA 留最后收尾
          //   （AA 被双小王/双大王压掉就送控制）。
          if (myCards <= 12) continue;
          const cardRank = g.cards[0].rank;
          if (this.getRemainingOutsideMyHand(cardRank) === 0) {
            if (this.canPlay(g.cards)) return g.cards;
          }
        }
      }
      // ★ 修复：三条/三带二不走"rank在外耗尽"安全牌——三带二/三条比的是 value
      //   （会被更大三带二/三条压），"rank耗尽"只防同rank，判断无效且有害：
      //   BOT2 因 7 在外耗尽把大三带二 77799 当"安全牌"先出、把最小 222+99
      //   留后拆散卡底（BOT2 先出大77799、222卡底末游事故）。三条交给下方
      //   "最小三条"步骤，三带二交给"最小三带二"步骤统一按 value 排序出小。
    }

    // ★ 最小三条优先出：三条(如 222/333)最难回收——要等别人出三条/三带二才能跟，
    //   最小的 v2/v3 留底必死。三张一起出清3张，比冲散单(如10)强；被压就换手，
    //   总比卡底末游好。出最小的三条探路。（BOT2 把 222 三条留最后、冲散单10
    //   被压、222 卡底末游事故。）
    const myTrips = nonBombGroups.filter(g => {
      const h = getHandType(g.cards, this.level);
      return h && h.type === HandType.Trips;
    });
    if (myTrips.length > 0) {
      myTrips.sort((a, b) => {
        const ha = getHandType(a.cards, this.level);
        const hb = getHandType(b.cards, this.level);
        return (ha?.value || 0) - (hb?.value || 0);
      });
      if (this.canPlay(myTrips[0].cards)) return myTrips[0].cards;
    }

    // ★ 散单张优先探路：手里有散单张(尤其最小的2/3/4)时，先出最小的散单(非王)。
    //   单张是全场最难回收的牌——最小的2谁都压得过、留底必死；对子/三带二相对
    //   好处理可后出。原来单张步骤排在对子/三带二之后，BOT2 先出完 88/1010/AA/
    //   JJJ66/KKK33、把唯一散单2留到最后一手（BOT2 先出大牌最后剩2末游事故）。
    //   先出最小散单探路（被压就让对手出、不浪费控制），大牌/组合留后收尾。
    //   王/级牌(绝对控制)不参与探路，留作收尾。
    const probeSingles = nonBombGroups.filter(g => {
      const h = getHandType(g.cards, this.level);
      return h && h.type === HandType.Single;
    });
    if (probeSingles.length > 0) {
      probeSingles.sort((a, b) => getLogicValue(a.cards[0].rank, this.level) - getLogicValue(b.cards[0].rank, this.level));
      for (const s of probeSingles) {
        const c = s.cards[0];
        if (c.rank === Rank.BigJoker || c.rank === Rank.SmallJoker) continue;
        if (this.canPlay(s.cards)) return s.cards;
      }
    }

    // ★ 修复：先出三带二（清5张），再出对子——原来"对子先行"会把大控制对子
    //   （级牌对22/AA/KK）当探路牌先甩掉（BOT2 先出级牌22 事故：手里 QQQ+88 三带二
    //   却先出 2★2★，再 QQQ+88，把最大对子白白交出）。成型组合(三带二/顺子/钢板)
    //   清牌效率高应优先出；对子(尤其大控制对子)留后收尾。与上方"顺子/钢板优先"一致。
    //   ★ 修复：三带二必须排在"出小留大"之前——否则 step1 会先把对子(99/KK/AA)
    //   出小留大、把最小三带二(222+33)留后，末游时最小组合没出完
    //   （BOT2 先出一堆对子/大牌、最后剩 222+33 末游事故）。
    const myTripsWithPair = nonBombGroups.filter(g => {
      const h = getHandType(g.cards, this.level);
      return h && h.type === HandType.TripsWithPair;
    });
    if (myTripsWithPair.length > 0) {
      myTripsWithPair.sort((a, b) => {
        const ha = getHandType(a.cards, this.level);
        const hb = getHandType(b.cards, this.level);
        return (ha?.value || 0) - (hb?.value || 0);
      });
      if (this.canPlay(myTripsWithPair[0].cards)) return myTripsWithPair[0].cards;
    }

    // 1. 找有大小两组的同类型 -> 出小的，大的留着收回
    // ★ 修复：排除单张——散单张不该在成型组合(三带二/对子)之前"出小留大"，否则终局
    //   会先甩散单(如 #27 的 4)被对手压走丢控制、把 33322 三带二留后面最后走不掉
    //   （BOT2 先甩大牌剩小牌输掉事故）。单张统一交给最后的单张步骤"出小探路"。
    for (const [type, groups] of typeMap) {
      if (type === HandType.Single) continue; // 单张不在此处出
      if (groups.length >= 2) {
        groups.sort((a, b) => a.value - b.value);
        const small = groups[0];
        if (this.canPlay(small.cards)) return small.cards;
      }
    }

    // 对子：情况不明对子先行，出最小的（小对子探路；大控制对子自然留后）
    const myPairs = nonBombGroups.filter(g => {
      const h = getHandType(g.cards, this.level);
      return h && h.type === HandType.Pair;
    });
    if (myPairs.length > 0) {
      myPairs.sort((a, b) => {
        const ha = getHandType(a.cards, this.level);
        const hb = getHandType(b.cards, this.level);
        return (ha?.value || 0) - (hb?.value || 0);
      });
      if (this.canPlay(myPairs[0].cards)) return myPairs[0].cards;
    }

    // 5. 单张：大牌留着收回，出小牌探路
    // 散单张最难回收，掼蛋大师原则是留到最后出
    const mySingles = nonBombGroups.filter(g => {
      const h = getHandType(g.cards, this.level);
      return h && h.type === HandType.Single;
    });

    // tracker驱动：对手双大王/大小王都有 → 避免出单张送控制权
    if (this.tracker && mySingles.length > 0) {
      const bjRem = this.getEnemyRemaining(Rank.BigJoker);
      const sjRem = this.getEnemyRemaining(Rank.SmallJoker);
      if (bjRem >= 2 || (bjRem >= 1 && sjRem >= 1)) {
        const nonSingle = this.findBestNonSingle();
        if (nonSingle) return nonSingle;
      }
    }

    if (mySingles.length > 0) {
      // 统计大小王数量，如果有2+张王，保持成对不拆
      const jokerCount = this.cards.filter(c => c.rank === Rank.SmallJoker || c.rank === Rank.BigJoker).length;
      const keepJokers = jokerCount >= 2;

      // ★ 按从小到大排序：先出小牌探路，大牌留着控制
      const sortedSingles = mySingles.sort((a, b) => {
        const va = getLogicValue(a.cards[0].rank, this.level);
        const vb = getLogicValue(b.cards[0].rank, this.level);
        return va - vb;
      });
      // 第一轮：出小牌探路（跳过大小王等控制牌）
      // ★ 修复：只要还有非王的单张，就绝不主动把王领出去——
      //   "手里有大王+单张"时正确打法是先出那张小单、把大王留作收尾控制
      //   （旧逻辑 myCards=4 时会把大王当"探路牌"先甩，第二轮就没牌能抢回出牌权了）。
      const hasNonJokerSingle = sortedSingles.some(s =>
        s.cards[0].rank !== Rank.BigJoker && s.cards[0].rank !== Rank.SmallJoker);
      for (const s of sortedSingles) {
        const c = s.cards[0];
        const val = getLogicValue(c.rank, this.level);
        if (c.rank === Rank.BigJoker || c.rank === Rank.SmallJoker) {
          if (hasNonJokerSingle) continue; // 有别的单张就先把王按住
        }
        if (val >= 14 && mySingles.length <= 2) continue;
        if (this.canPlay(s.cards)) return s.cards;
      }
      // 第二轮：实在没有小牌了，出最小的非王
      for (const s of sortedSingles) {
        const c = s.cards[0];
        if (c.rank === Rank.BigJoker || c.rank === Rank.SmallJoker) {
          if (myCards <= 3 && !keepJokers && !hasNonJokerSingle) return s.cards;
          continue;
        }
        if (this.canPlay(s.cards)) return s.cards;
      }
      // 最后才出王（极小牌数兜底）
      return sortedSingles[0].cards;
    }

    // 6. 最后出最小单张（排除大小王）- 兜底
    for (const g of nonBombGroups) {
      const h = getHandType(g.cards, this.level);
      if (h && h.type === HandType.Single && this.canPlay(g.cards)) {
        const c = g.cards[0];
        if (c.rank === Rank.BigJoker || c.rank === Rank.SmallJoker) {
          if (myCards > 3) continue;
        }
        return g.cards;
      }
    }

    // 7. 实在没牌出了，出炸弹（从最弱开始：张数少优先）
    if (myBombs > 0) {
      const bombGroups = myGroups.filter((_, i) => bombIdxs.has(i));
      bombGroups.sort((a, b) => bombStrength(a, this.level) - bombStrength(b, this.level));
      if (bombGroups.length > 0 && this.canPlay(bombGroups[0].cards)) {
        return bombGroups[0].cards;
      }
    }

    return null;
  }

  /** 验证一组牌是否都在当前手牌中 */
  private canPlay(cards: Card[]): boolean {
    const handIds = new Set(this.cards.map(c => c.id));
    return cards.every(c => handIds.has(c.id));
  }

  /** 找最小对子用于自由出牌（不拆4+组，value≤10优先） */
  private findSmallestPairForPlay(): Card[] | null {
    const groups = this.groupByRawRank();
    const pairs: Card[][] = [];
    for (const [, cs] of groups) {
      if (cs.length >= 2 && cs.length < 4 && cs[0].rank >= 2 && cs[0].rank <= Rank.Ace) {
        pairs.push(cs.slice(0, 2));
      }
    }
    if (pairs.length === 0) return null;
    pairs.sort((a, b) => getLogicValue(a[0].rank, this.level) - getLogicValue(b[0].rank, this.level));
    return pairs[0];
  }

  /** 找最小单张用于自由出牌（非万能牌，value≤10优先） */
  private findSmallestSingleForPlay(): Card[] | null {
    const sorted = [...this.cards].sort(
      (a, b) => getLogicValue(a.rank, this.level) - getLogicValue(b.rank, this.level)
    );
    for (const c of sorted) {
      if (c.isWild) continue;
      const groupSize = this.countSameRank(c.rank);
      if (groupSize >= 4) continue; // 不拆炸弹
      const val = getLogicValue(c.rank, this.level);
      if (val <= 10) return [c];
    }
    // 没有小单张，退而求其次
    for (const c of sorted) {
      if (c.isWild) continue;
      const groupSize = this.countSameRank(c.rank);
      if (groupSize >= 4) continue;
      return [c];
    }
    return null;
  }

  /** 找最小三带二 */
  private findSmallestTripsWithPair(): Card[] | null {
    const groups = this.groupByRawRank();
    const trips: Card[][] = [];
    for (const [, cs] of groups) {
      if (cs.length >= 3 && cs.length < 5 && cs[0].rank >= 2 && cs[0].rank <= Rank.Ace) {
        trips.push(cs.slice(0, 3));
      }
    }
    if (trips.length === 0) return null;
    trips.sort((a, b) => getLogicValue(a[0].rank, this.level) - getLogicValue(b[0].rank, this.level));
    for (const trip of trips) {
      const pair = this.findPairExcluding(trip);
      if (pair) return [...trip, ...pair];
    }
    return null;
  }

  /** 找最小顺子或连对 */
  private findSmallestSequence(): Card[] | null {
    const available = new Map<string, Card[]>();
    for (const c of this.cards) {
      const key = c.suit + ':' + c.rank;
      if (!available.has(key)) available.set(key, []);
      available.get(key)!.push(c);
    }
    // 从规划组中找最小的顺子/连对
    const sequences = this.handPlan.groups.filter(g => {
      const hand = getHandType(g.cards, this.level);
      return hand && (hand.type === HandType.Straight || hand.type === HandType.Tube);
    });
    if (sequences.length === 0) return null;
    sequences.sort((a, b) => {
      const ha = getHandType(a.cards, this.level);
      const hb = getHandType(b.cards, this.level);
      return (ha?.value || 0) - (hb?.value || 0);
    });
    // 验证牌是否可用
    for (const g of sequences) {
      const needed = new Map<string, number>();
      for (const c of g.cards) {
        const key = c.suit + ':' + c.rank;
        needed.set(key, (needed.get(key) || 0) + 1);
      }
      let ok = true;
      for (const [key, count] of needed) {
        if ((available.get(key)?.length || 0) < count) { ok = false; break; }
      }
      if (ok) {
        const result: Card[] = [];
        for (const [key, count] of needed) {
          for (let i = 0; i < count; i++) result.push(available.get(key)![i]);
        }
        return result;
      }
    }
    return null;
  }

  /** 找非单张的最优出牌 */
  private findBestNonSingle(): Card[] | null {
    // ★ 修复：原实现只用 groupByRawRank 重新数牌，会拆散 HandPlan 里的成型组合。
    //   实战事故：手牌 [2 3 4 5 6 6 9 9 J J]（下家只剩1张）时，它按点数升序找到
    //   第一个"恰好2张"的组 = 66，把属于顺子 2-3-4-5-6 的 6 抽出来打掉，
    //   剩下 2/3/4/5 四张互不相干的散单，手数从 4 手暴涨到 7 手直接末游。
    //   现在优先在 HandPlan 里挑"非单张"的组（天然不会拆成型组合），
    //   若有多个候选则挑"打完之后剩余手数最少"的那一手。
    const planNonSingle = this.handPlan.groups.filter(g => {
      const h = getHandType(g.cards, this.level);
      return !!h && h.type !== HandType.Single;
    });
    if (planNonSingle.length > 0) {
      let best: Card[] | null = null;
      let bestHands = Number.MAX_SAFE_INTEGER;
      for (const g of planNonSingle) {
        if (!this.canPlay(g.cards)) continue;
        const rest = this.cards.filter(c => !g.cards.some(gc => gc.id === c.id));
        const hands = (this.handPlan as any).estimateHands
          ? (this.handPlan as any).estimateHands(rest, this.level)
          : rest.length;
        if (hands < bestHands) { bestHands = hands; best = g.cards; }
      }
      if (best && best.length > 0) return [...best];
    }

    const groups = this.groupByRawRank();
    // 三带二（严格3张三条，不拆4+张炸弹）
    for (const [r, cs] of groups) {
      if (r < 2 || r > 14 || cs.length !== 3) continue;
      const trip = cs.slice(0, 3);
      const pair = this.findPairExcluding(trip);
      if (pair) return [...trip, ...pair];
    }
    // 三条（严格3张，不拆4+张炸弹）
    for (const [r, cs] of groups) {
      if (r >= 2 && r <= 14 && cs.length === 3) return cs.slice(0, 3);
    }
    // 对子（严格2张，不拆4+张炸弹）
    for (const [r, cs] of groups) {
      if (r >= 2 && r <= 14 && cs.length === 2) return cs.slice(0, 2);
    }
    return null;
  }

  /** 出最大单张（下家敌人剩1张时的保险方案） */
  private playBiggestSingle(): Card[] {
    let best = this.cards[0];
    for (const c of this.cards) {
      if (getLogicValue(c.rank, this.level) > getLogicValue(best.rank, this.level)) best = c;
    }
    return [best];
  }

  /** 倒数第二大对子（开局：出第二小的对子，不暴露最弱牌） */
  private findSecondSmallestPair(): Card[] | null {
    const groups = this.groupByRawRank();
    const pairs: Card[][] = [];
    for (const [, cs] of groups) {
      if (cs.length === 2 && cs[0].rank >= 2 && cs[0].rank <= 14) {
        pairs.push(cs.slice(0, 2));
      }
    }
    if (pairs.length === 0) return null;
    pairs.sort((a, b) => getLogicValue(a[0].rank, this.level) - getLogicValue(b[0].rank, this.level));
    if (pairs.length === 1) return pairs[0];
    return pairs[1]; // 顺数第二小 = 倒数第二大
  }

  /** 助攻角色出小牌（value≤10） */
  private findSmallPlanPlay(): Card[] | null {
    const available = new Map<string, Card[]>();
    for (const c of this.cards) {
      const key = c.suit + ':' + c.rank;
      if (!available.has(key)) available.set(key, []);
      available.get(key)!.push(c);
    }
    for (const g of this.handPlan.groups) {
      const hand = getHandType(g.cards, this.level);
      if (!hand) continue;
      if (hand.value > 10) continue;
      if (hand.type === HandType.Bomb || hand.type === HandType.StraightFlush || hand.type === HandType.FourKings) continue;
      const needed = new Map<string, number>();
      for (const c of g.cards) {
        const key = c.suit + ':' + c.rank;
        needed.set(key, (needed.get(key) || 0) + 1);
      }
      let ok = true;
      for (const [key, count] of needed) {
        if ((available.get(key)?.length || 0) < count) { ok = false; break; }
      }
      if (ok) {
        const result: Card[] = [];
        for (const [key, count] of needed) {
          for (let i = 0; i < count; i++) result.push(available.get(key)![i]);
        }
        return result;
      }
    }
    return null;
  }

  /** 找计划中最弱的可出牌 */
  private findWeakestPlanPlay(): Card[] | null {
    const available = new Map<string, Card[]>();
    for (const c of this.cards) {
      const key = c.suit + ':' + c.rank;
      if (!available.has(key)) available.set(key, []);
      available.get(key)!.push(c);
    }
    for (const g of this.handPlan.groups) {
      const hand = getHandType(g.cards, this.level);
      if (!hand) continue;
      if (hand.type === HandType.Bomb || hand.type === HandType.StraightFlush || hand.type === HandType.FourKings) continue;
      const needed = new Map<string, number>();
      for (const c of g.cards) {
        const key = c.suit + ':' + c.rank;
        needed.set(key, (needed.get(key) || 0) + 1);
      }
      let ok = true;
      for (const [key, count] of needed) {
        if ((available.get(key)?.length || 0) < count) { ok = false; break; }
      }
      if (ok) {
        const result: Card[] = [];
        for (const [key, count] of needed) {
          for (let i = 0; i < count; i++) result.push(available.get(key)![i]);
        }
        return result;
      }
    }
    return null;
  }

  private decideFreePlayFallback(): Card[] {
    const cards = this.cards;
    const phase = this.getPhase();
    const groups = this.groupByRawRank();

    // 终局阶段(≤10张)：优先出单张/对子，容易走完
    if (phase === 'endgame' || cards.length <= 10) {
      // 最小单张（严格1张，不拆对子+）
      const sorted = [...cards].sort((a, b) => getLogicValue(a.rank, this.level) - getLogicValue(b.rank, this.level));
      for (const c of sorted) {
        if (c.isWild) continue;
        const gs = this.countSameRank(c.rank);
        if (gs >= 2) continue; // 不拆对子+
        return [c];
      }
      // 最小对子（严格2张）
      for (const [r, cs] of groups) {
        if (r >= 2 && r <= 14 && cs.length === 2) return cs.slice(0, 2);
      }
    }

    // 非终局：优先三带二/三条（消耗手牌）
    // 试试最小的三带二（严格3张配严格2张）
    for (const [r, cs] of groups) {
      if (cs.length === 3) {
        const trip = cs.slice(0, 3);
        const pair = this.findPairExcluding(trip);
        if (pair) return [...trip, ...pair];
      }
    }
    // 试试最小的三条（严格3张）
    for (const [r, cs] of groups) {
      if (cs.length === 3) return cs.slice(0, 3);
    }
    // 最小对子（严格2张）
    for (const [r, cs] of groups) {
      if (cs.length === 2) return cs.slice(0, 2);
    }
    // 最小单张（严格1张）
    const sorted = [...cards].sort((a, b) => getLogicValue(a.rank, this.level) - getLogicValue(b.rank, this.level));
    for (const c of sorted) {
      const gs = this.countSameRank(c.rank);
      if (gs === 1 && !c.isWild) return [c];
    }
    return [sorted[0]];
  }

  // ==================== 跟牌决策 ====================

  private decideFollowPlay(target: Hand, lastPlayerIndex: number): Card[] | null {
    if (this.isAlly(lastPlayerIndex)) {
      return this.decideAllyFollow(target, lastPlayerIndex);
    }
    return this.decideEnemyFollow(target, lastPlayerIndex);
  }

  private decideAllyFollow(target: Hand, lastPlayerIndex: number): Card[] | null {
    const partner = this.partnerIdx();
    if (lastPlayerIndex === partner) {
      // 队友已出完走牌（剩0张）-> 不压
      if (this.handsInfo[partner] === 0) return null;

      // 队友出炸弹/同花顺/天王炸 -> 绝对不压（不能炸队友）
      const targetIsBomb = target.type === HandType.Bomb || target.type === HandType.StraightFlush || target.type === HandType.FourKings || target.type === HandType.ThreeKings;
      if (targetIsBomb) return null;

      // ★ 自己濒走(≤3张) -> 抢控制冲刺走完（用最小能压的牌，能走先走）
      if (this.cards.length <= 3) {
        const beats = this.findAllBeats(target);
        if (beats.length > 0) {
          return this.pickSmallestBeat(beats, target);
        }
      }

      // 队友快走牌(≤5张) -> 帮队友挡，减少对手接牌机会
      // ★ 修复：帮挡只用够用的普通牌——绝不用大王/小王/逢人配/级牌去挡队友的中小牌
      //   （那是把绝对控制牌砸到队友牌上、白送核心资源，BOT2 打联盟大牌事故：用大王
      //   压队友单6、用小王某压队友Q）。若最小能压的只剩控制牌，宁可不挡——王/级牌/
      //   逢人配留着后面自己控制/收尾。
      if (this.handsInfo[partner] <= 5) {
        const usable = (bs: Card[][]) => bs.filter(b => !b.some(c => c.isWild || c.rank === Rank.BigJoker || c.rank === Rank.SmallJoker || c.rank === this.level));
        const beats = usable(this.findAllBeatsPreservingPlan(target));
        if (beats.length > 0) {
          return this.pickSmallestBeat(beats, target);
        }
        // 拆牌也要压（同样不用控制牌）
        const allBeats = usable(this.findAllBeats(target));
        if (allBeats.length > 0) {
          return this.pickSmallestBeat(allBeats, target);
        }
      }

      // ★ 修复：队友牌多且自己也没濒走 -> 绝不跟队友的牌，让队友控制。
      //   原来队友出≤13就"顺牌过"用最小能压的跟，会把逢人配/大王/AAA 砸到队友的
      //   中小牌上：抢队友出牌权+浪费核心资源（BOT2 打联盟大牌事故：开局用 AAA22
      //   压队友三带二、用逢人配压队友K、用大王压队友4）。掼蛋大师原则——队友出的
      //   牌让队友自己控制，除非队友快走需帮挡、或自己濒走能冲刺。
      return null;
    }
    // 上家是队友（非对门），不压
    return null;
  }

  private decideEnemyFollow(target: Hand, lastPlayerIndex: number): Card[] | null {
    const nextSeat = (this.seatIndex + 1) % 4;
    const nextCards = this.handsInfo[nextSeat];
    const enemyCards = this.handsInfo[lastPlayerIndex];
    const myCards = this.cards.length;
    const isAllyNext = this.isAlly(nextSeat);
    // 上家出牌还是下家出牌？上家=(seatIndex+3)%4，下家=(seatIndex+1)%4
    const isUpperEnemy = lastPlayerIndex === (this.seatIndex + 3) % 4;
    const isLowerEnemy = lastPlayerIndex === (this.seatIndex + 1) % 4;

    // 下家敌人濒临走牌 -> 阻断优先级高
    const needBlock = !isAllyNext && nextCards <= 7;
    const blockUrgency = needBlock ? (nextCards <= 2 ? 3 : nextCards <= 5 ? 2 : 1) : 0;
    // 出牌者（target方）也是敌人且濒临走牌 -> 同样需要挡
    const targetEnemyNearFinish = !this.isAlly(lastPlayerIndex) && enemyCards > 0 && enemyCards <= 5;

    // ★ 一套走人保护：手牌可一把走完时，不要拆散它去跟小牌
    // 例: 只剩 999+22(一套三带二), 对手出对44 -> 平时不应拆99或22
    // 但若对手/下家濒临走牌必须挡时，三带二/三条这种"拆后仍成手"的组合就该拆开去挡
    const wholeHand = this.tryPlayAll();
    if (wholeHand) {
      // 手牌能一把走完（如一套三带二/顺子/钢板）
      // 如果对手出的牌型能用整套压（同类型且更大），可以整套跟；否则保留等机会
      const wholeType = getHandType(wholeHand, this.level)?.type;
      // ★ 修复：整套是炸弹(含逢人配炸弹)时，出掉=直接走头游，绝不能Pass保留
      //   炸弹可压任何非炸弹牌型，canWholeBeat 应视为 true
      const isWholeBomb = wholeType === HandType.Bomb || wholeType === HandType.StraightFlush || wholeType === HandType.FourKings;
      const targetIsBombType = target.type === HandType.Bomb || target.type === HandType.StraightFlush || target.type === HandType.FourKings || target.type === HandType.ThreeKings;
      const canWholeBeat = wholeType === target.type || (isWholeBomb && !targetIsBombType);
      if (!canWholeBeat) {
        // ★ 修复：三带二/三条拆开（拆对子压对子、拆三条压三条）后剩余仍是成手，
        //   在需要挡牌的紧要关头值得拆——否则"死保一套三带二"会让对手用一堆
        //   小牌一路走完。顺子/连对/钢板拆了只剩散牌，永远保留。
        const hand = getHandType(wholeHand, this.level)!;
        // ★ 修复：对子(Pair)也允许在紧要关头拆开去挡牌——如剩 AA 一套对子、
        //   对手濒走出一串单张小牌时，死守对子 = 看着对手一路走完自己末游。
        //   拆一张 A 压住单张、剩单 A 仍可收尾，比保一套走不完的对子强。
        //   普通情况(不濒走)仍保护对子不拆。
        const breakable = hand.type === HandType.TripsWithPair || hand.type === HandType.Trips || hand.type === HandType.Pair;
        const mustBlock = blockUrgency >= 2 || targetEnemyNearFinish;
        if (breakable && mustBlock) {
          // 放行：让下面逻辑拆开去挡牌
        } else {
          // 对手出不同牌型，拆了会破坏一套走人 -> 直接Pass保留
          return null;
        }
      }
    }

    // 枪不打四：对家剩4张，不是炸弹就不炸
    // 对家剩8张：不炸（三套牌炸不完）
    // 这些在 decideBomb 里处理，这里跳过

    // 上家出牌：后面是队友（对门），可以大胆跟
    // 下家出牌：后面是敌人，要考虑封锁
    // 逢五出对：下家敌人剩5张时，优先出对子封锁
    if (isLowerEnemy && nextCards === 5 && target.type !== HandType.Pair) {
      // 不接非对子，等下家出对子时再压
    }

    // ★ 主动炸弹（抢控制/断节奏/压大牌）：即使能跟牌，也值得炸
    // 放在 planBeat 之前，中前期也触发
    // 但先检查能否用规划牌便宜跟牌——能跟则优先跟，不浪费炸弹
    if (this.countMyBombs() > 0 && !isAllyNext && !(target.type === HandType.Bomb || target.type === HandType.StraightFlush || target.type === HandType.FourKings || target.type === HandType.ThreeKings)) {
      // 用最小/规划牌能跟的话，通常优先跟而非炸（节省炸弹）
      const canAffordBeat = this.findPlanBeat(target) || (this.findAllBeatsPreservingPlan(target).length > 0);
      // ★ 修复：原逻辑"能便宜跟牌就根本不进入炸弹决策"是"持炸不出"的头号原因——
      //   BOT2 握 4 个炸，对手出一张单牌，它就跟一张散牌，炸弹全程没被评估过。
      //   现在：即使能便宜跟牌，只要场面需要打断（对手在跑 / 下家濒走 / 我已残局
      //   且炸后仍能掌控牌路），仍然接管进炸弹决策。
      const considerBomb = !canAffordBeat || this.shouldBombOverCheapFollow(target, lastPlayerIndex);
      if (considerBomb) {
        const bomb = this.findBomb(target);
        if (bomb) {
          const bombPlay = this.decideBomb(target, lastPlayerIndex);
          if (bombPlay) {
            if (!canAffordBeat) {
              // 判定"该炸"后仍先找"便宜的普通跟牌"替代——压对手一张单/对，
              // 往往用一张普通牌就够，没必要烧掉炸弹或同花顺。
              const economyBeat = this.findEconomyBeat(target);
              if (economyBeat) return economyBeat;
            }
            return bombPlay; // decideBomb 判定该炸
          }
        }
      }
    }

    // 先看规划组
    const planBeat = this.findPlanBeat(target);
    if (planBeat) {
      // ★ 终局防护：下家敌人只剩1张且对手出单张时，规划组可能给出"最小单张"，
      //   会被下家那张牌直接压走送头游。改用"最高的、不拆规划的"单张来封牌（垫高）。
      if (this.nextEnemyHasOne() && target.type === HandType.Single) {
        const highBeat = this.findHighestPreservingSingleBeat(target.value);
        if (highBeat) return highBeat;
      }
      // ★ 修复：跟牌绝不浪费大牌。planBeat 可能是规划组里的"双大王"这类大牌，
      //   而 preservingBeats 里有更小的够用牌（如三带二附属对子 J★J★ 压 KK，
      //   或非王单张压王单张）。两者合并取"最小的够用牌"，把大牌/王留作控制。
      //   例: 对手 KK，我有 J★J★(19) 和 双大王(21) -> 用 J★J★。
      const preservingBeats = this.findAllBeatsPreservingPlan(target);
      if (preservingBeats.length > 0) {
        return this.pickSmallestBeat([...preservingBeats, planBeat], target);
      }
      return planBeat;
    }

    // ★ 终局冲刺（跟牌）：如果炸后剩余牌≤1手或很少，直接炸了冲头游
    // 与自由出牌的 findControllingPlay 对应，避免"剩炸弹+散牌却不炸"
    if (this.countMyBombs() > 0 && myCards <= 12) {
      const bomb = this.findBomb(target);
      if (bomb) {
        const remainingAfterBomb = myCards - bomb.length;
        // 炸了直接走完 -> 必炸（直接出炸弹，不走decideBomb保守逻辑）
        if (remainingAfterBomb === 0) {
          return bomb;
        }
        // 炸后剩余正好是一手合法牌型 -> 炸了冲（炸弹保底最后走）
        if (remainingAfterBomb > 0 && remainingAfterBomb <= 5) {
          const remainingCards = this.cards.filter(c => !bomb.some(bc => bc.id === c.id));
          const remainingHand = getHandType(remainingCards, this.level);
          if (remainingHand) {
            return bomb;
          }
        }
        // 炸后剩余 1-3 张：只有"剩余正好一手走完"或"全是高位控牌(级牌/大小王)"才值得炸。
        // ★ 修复：否则炸完留 2-3 手散牌（如 5,5,9 / 10,6,4）反而送出发牌权，
        //   是典型的乱炸浪费。
        if (remainingAfterBomb > 0 && remainingAfterBomb <= 3) {
          const remainingCards = this.cards.filter(c => !bomb.some(bc => bc.id === c.id));
          const remainingHand = getHandType(remainingCards, this.level);
          if (remainingHand) return bomb; // 炸后一手走完
          if (remainingCards.every(c => {
            const v = getLogicValue(c.rank, this.level);
            return v >= 17; // 级牌(19)/小王(20)/大王(21)：炸了拿控制后可一张张收尾
          })) return bomb;
        }
      }
    }

    // 再看规划感知跟牌（不拆规划组）
    const preservingBeats = this.findAllBeatsPreservingPlan(target);
    if (preservingBeats.length > 0) {
      // ★ 主动炸弹：即使有牌能跟，若决定该炸（抢控制/断节奏/压大牌），优先炸
      if (this.countMyBombs() > 0 && !isAllyNext) {
        const bomb = this.findBomb(target);
        if (bomb) {
          const bombPlay = this.decideBomb(target, lastPlayerIndex);
          if (bombPlay) return bombPlay; // decideBomb判定该炸
        }
      }
      if (blockUrgency > 0) {
        return this.pickBestFollowBeat(preservingBeats, target);
      }
      // 上家出牌+后面是队友 -> 大胆出最小牌跟
      if (isUpperEnemy && isAllyNext) {
        return this.pickSmallestBeat(preservingBeats, target);
      }
      return this.pickSmallestBeat(preservingBeats, target);
    }

    // ★ 修复：对手(非队友)濒临走牌(≤10张)时，必须抢控制——
    //   即使跟牌会拆掉规划里的顺子/钢板，也要压住。否则手握一堆能压的大单张
    //   （如 10,J★,Q,K,A 顺子里的 J★/A/K/Q）却因"防拆顺子"被过滤掉，只能干看
    //   对手一路跑光抢二游（BOT2 末游事故的根因）。拆一张大牌压住对手 > 保一手
    //   可能永远打不出去的顺子。
    //   ★ 修复：这条"破结构抢控制"只在自己也进残局(≤12张)或对手真的濒走(≤5张)时才动用。
    //   原逻辑"对手≤10张就允许拆成型牌型"过宽：自己还握着一大把牌时，对手领一张小单/小对，
    //   跟着拆顺子/钢板去换这次出牌权毫无收益——出牌权下一轮照样丢，自己的成型手却没了。
    //   （BOT2 事故：23 张时为跟 Bot1 的单 ♠7，先耗尽设置的后续选项，最后只能靠炸弹。）
    const worthBreakingStructure = myCards <= 12 || enemyCards <= 5;
    if (worthBreakingStructure && !this.isAlly(lastPlayerIndex) && enemyCards > 0 && enemyCards <= 10) {
      const urgentBeats = this.findAllBeats(target, true);
      if (urgentBeats.length > 0) {
        if (blockUrgency > 0) return this.pickBestFollowBeat(urgentBeats, target);
        return this.pickSmallestBeat(urgentBeats, target);
      }
    }

    // ★ 修复：对手出炸弹/同花顺/天王炸时，唯一能压的是炸弹——由 decideBomb 决定
    //   是否对炸：该炸就炸，判定不炸就 Pass。绝不能让下面的 allBeats 兜底把炸弹
    //   当"普通跟牌"打出去（无谓对炸浪费：如 #11 对手 6666、我方 13 张却用 J 炸弹压，
    //   拆了 JJJ22 三带二还送掉炸弹）。对手濒走"必须炸断"的场景由上方 urgent-break
    //   和 decideBomb 的 enemyThreat 判定处理。
    const targetIsBombType2 = target.type === HandType.Bomb || target.type === HandType.StraightFlush
      || target.type === HandType.FourKings || target.type === HandType.ThreeKings;
    if (targetIsBombType2) {
      if (this.countMyBombs() > 0 && !isAllyNext) {
        const bomb = this.findBomb(target);
        if (bomb) {
          const bombPlay = this.decideBomb(target, lastPlayerIndex);
          if (bombPlay) return bombPlay; // 该炸
        }
      }
      return null; // 不炸 → Pass（炸弹类目标没有非炸弹跟牌）
    }

    // 兜底：普通跟牌（允许拆）
    // 上家出牌+后面是队友 -> 更愿意拆牌跟（队友能接）
    const allBeats = this.findAllBeats(target);
    if (allBeats.length > 0) {
      if (blockUrgency > 0) {
        return this.pickBestFollowBeat(allBeats, target);
      }
      // 下家出牌+后面是敌人 -> 不轻易拆牌（除非阻断）
      if (isLowerEnemy && !isAllyNext && myCards > 10) {
        // 不拆牌，Pass
      } else {
        return this.pickSmallestBeat(allBeats, target);
      }
    }

    // 自己和队友都无法管上这个牌型 → 考虑用炸弹夺回控制权
    if (allBeats.length === 0 && preservingBeats.length === 0 && planBeat === null) {
      const canBomb = this.findBomb(target);
      if (canBomb) {
        // 对手濒临走牌 → 阻断性炸
        if (blockUrgency >= 1) return this.decideBomb(target, lastPlayerIndex);
        // 对手出大牌(A/K以上)或顺子 → 炸了换适合自己牌型
        if (target.value >= 14 || target.type === HandType.Straight) {
          return this.decideBomb(target, lastPlayerIndex);
        }
        // 自己牌少(≤12张)且对手牌不多 → 炸了收尾
        if (myCards <= 12 && enemyCards <= 8) {
          return this.decideBomb(target, lastPlayerIndex);
        }
      }
    }

    // 手牌全是炸弹时无条件炸
    if (this.areAllCardsBombs()) {
      if (this.findBomb(target)) return this.decideBomb(target, lastPlayerIndex);
    }

    // ★ 关键：除炸弹外没有能跟的牌型（只有炸弹+散牌且散牌跟不了当前牌型）
    // 手牌几乎全是炸弹（非炸弹牌≤2张）时，唯一能压的就是炸弹，应果断炸
    const nonBombCount = this.cards.filter(c => this.countSameRank(c.rank) < 4).length;
    const myBombCount = this.countMyBombs();
    if (myBombCount >= 2 && nonBombCount <= 2 && !isAllyNext) {
      // 两个以上炸弹，且非炸弹牌很少（≤2张）-> 用炸弹压制，避免放走对手
      const bomb = this.findBomb(target);
      if (bomb) return this.decideBomb(target, lastPlayerIndex);
    }

    // 最后才考虑炸弹
    if (blockUrgency >= 2) {
      return this.decideBomb(target, lastPlayerIndex);
    }

    // 自己快走牌(≤5张)且有炸弹 -> 炸了收尾
    if (myCards <= 5 && enemyCards <= 10) {
      return this.decideBomb(target, lastPlayerIndex);
    }

    return null;
  }

  private findWeakBeat(target: Hand): Card[] | null {
    const beats = this.findAllBeats(target);
    if (beats.length === 0) return null;
    return this.pickSmallestBeat(beats, target);
  }

  private pickSmallestBeat(beats: Card[][], target: Hand): Card[] | null {
    if (beats.length === 0) return null;
    const scored = beats.map(cards => {
      const hand = getHandType(cards, this.level);
      let score = 0;
      if (hand) {
        score += hand.value;
        if (hand.type === HandType.Bomb || hand.type === HandType.StraightFlush) score += 100;
        if (hand.type === HandType.FourKings) score += 500;
      }
      // ★ 惩罚：用了级牌/大牌(K,A,王)压牌 → 浪费控制牌，加分（更差）
      // 三带二/三条优先用小的三条，保留级牌和大牌控制
      for (const c of cards) {
        if (c.isWild || c.rank === this.level) score += 30;       // 级牌/万能牌是控制牌，尽量不用
        else if (c.rank === Rank.BigJoker || c.rank === Rank.SmallJoker) score += 40;
        else if (c.rank === Rank.Ace || c.rank === Rank.King) score += 10; // A/K也算大牌
      }
      const remaining = this.cardsAfter(cards);
      score -= remaining.length * 0.3;
      return { cards, score };
    });
    // ★ 终局防护：下家敌人只剩1张且对手出的是单张时，不能挑最小单张跟
    //   （小单会被下家那张牌直接压走送头游）。改挑"最高单张"来封牌（垫高）。
    if (this.nextEnemyHasOne() && target.type === HandType.Single) {
      scored.sort((a, b) => {
        const va = getLogicValue(a.cards[0].rank, this.level);
        const vb = getLogicValue(b.cards[0].rank, this.level);
        return vb - va;
      });
      return scored[0].cards;
    }
    scored.sort((a, b) => a.score - b.score);
    return scored[0].cards;
  }

  private pickBestFollowBeat(beats: Card[][], target: Hand): Card[] | null {
    if (beats.length === 0) return null;
    const scored = beats.map(cards => {
      const hand = getHandType(cards, this.level);
      let score = 0;
      if (hand) {
        score += hand.value;
        if (hand.type === HandType.Bomb || hand.type === HandType.StraightFlush) score += 100;
        if (hand.type === HandType.FourKings) score += 500;
      }
      // ★ 修复：挡牌也要"用最小的够用牌"，别一挡就把级牌/大牌/王全砸出去
      //   （原来按 value 降序挑最大的，残局会为挡一副对子把级牌对/大对子打光）。
      for (const c of cards) {
        if (c.isWild || c.rank === this.level) score += 30;       // 级牌/万能牌是控制牌，尽量省
        else if (c.rank === Rank.BigJoker || c.rank === Rank.SmallJoker) score += 40;
        else if (c.rank === Rank.Ace || c.rank === Rank.King) score += 10; // A/K也算大牌
      }
      const remaining = this.cardsAfter(cards);
      score -= remaining.length * 0.3;
      return { cards, score };
    });
    scored.sort((a, b) => a.score - b.score);
    return scored[0].cards;
  }

  /**
   * 找一张"便宜的普通跟牌"来替代炸弹/同花顺。
   * 用在"系统已判定该炸，但目标其实只是一张单/对"的场景——此时与其烧掉 4~5 张
   * 核心资源去换对手 1~2 张小牌的出牌权，不如用一张普通牌经济地跟住。
   *
   * 过滤条件（保证不会比出炸弹更亏）：
   *  - 不含大小王 / 逢人配 / 级牌（这些是绝对控制牌，砸在单/对上等于烧掉收尾资源）
   *  - 不拆同点 4 张（炸弹）
   *  - 不拆顺子/连对/钢板/同花顺（多 rank 组合拆完只剩散牌）
   * 只处理单张/对子目标；其他牌型（顺子/钢板等）的真炸弹决策由上层逻辑负责。
   * @returns 最小的够用跟牌，没有则返回 null（此时宁可 Pass 也不烧炸）
   */
  private findEconomyBeat(target: Hand): Card[] | null {
    if (target.type !== HandType.Single && target.type !== HandType.Pair) return null;
    const beats = this.findAllBeats(target);
    if (beats.length === 0) return null;
    const candidates = beats.filter(cards => {
      if (cards.some(c => c.rank === Rank.BigJoker || c.rank === Rank.SmallJoker || c.isWild || c.rank === this.level)) return false;
      if (cards.some(c => this.countSameRank(c.rank) >= 4)) return false;
      if (this.isMultiRankBreak(cards)) return false;
      return true;
    });
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const ha = getHandType(a, this.level);
      const hb = getHandType(b, this.level);
      return (ha?.value || 0) - (hb?.value || 0);
    });
    return candidates[0];
  }

  private findAllBeats(target: Hand, allowMultiRankBreak = false): Card[][] {
    const result: Card[][] = [];

    switch (target.type) {
      case HandType.Single: {
        for (let i = this.cards.length - 1; i >= 0; i--) {
          const val = getLogicValue(this.cards[i].rank, this.level);
          if (val > target.value) {
            const groupSize = this.countSameRank(this.cards[i].rank);
            if (groupSize >= 4) continue; // 炸弹绝对不拆出单张
            if (this.isPartOfStraightFlush(this.cards[i])) continue; // ★ 同花顺(炸弹级)绝不拆出单张
            result.push([this.cards[i]]);
          }
        }
        break;
      }
      case HandType.Pair: {
        const pairs = this.getGroups(2);
        for (const pair of pairs) {
          const val = getLogicValue(pair[0].rank, this.level);
          if (val > target.value) {
            const groupSize = this.countSameRank(pair[0].rank);
            if (groupSize >= 4) continue; // 炸弹绝对不拆出对子
            result.push(pair);
          }
        }
        break;
      }
      case HandType.Trips: {
        const trips = this.getGroups(3);
        for (const t of trips) {
          const val = getLogicValue(t[0].rank, this.level);
          if (val > target.value) {
            const groupSize = this.countSameRank(t[0].rank);
            if (groupSize >= 4) continue; // 炸弹绝对不拆出三条
            result.push(t);
          }
        }
        break;
      }
      case HandType.TripsWithPair: {
        const trips = this.getGroups(3);
        for (const t of trips) {
          const tVal = getLogicValue(t[0].rank, this.level);
          if (tVal > target.value) {
            const groupSize = this.countSameRank(t[0].rank);
            if (groupSize >= 4) continue; // 炸弹绝对不拆
            const pair = this.findPairExcluding(t);
            if (pair) result.push([...t, ...pair]);
          }
        }
        break;
      }
      case HandType.Straight: {
        const groups = this.groupByRawRank();
        const vals = Array.from(groups.keys()).filter(v => v >= 2 && v <= 14);
        for (let i = 0; i <= vals.length - 5; i++) {
          const w = vals.slice(i, i + 5);
          if (!isConsecutive(w)) continue;
          if (w[4] <= target.value) continue;
          // ★ 修复：炸弹rank(≥4张)绝不拆进顺子——4炸拆1张炸弹就没了，5炸拆1张也浪费
          if (w.some(v => (groups.get(v)?.length || 0) >= 4)) continue;
          const cards: Card[] = w.map(v => groups.get(v)![0]);
          const hand = getHandType(cards, this.level);
          if (hand && hand.type === HandType.Straight && hand.value > target.value) {
            result.push(cards);
          }
        }
        break;
      }
      case HandType.Tube: {
        const groups = this.groupByRawRank();
        const pairRanks = Array.from(groups.entries())
          // ★ 修复：严格只用2张的rank组连对——4+张是炸弹绝不拆（原来 cs.length>=2
          //   会把 JJJJJ/KKKK 炸弹各取2张组连对，白白拆掉两个炸弹）
          .filter(([r, cs]) => cs.length === 2 && r >= 2 && r <= 14)
          .map(([r]) => r).sort((a, b) => a - b);
        for (let i = 0; i <= pairRanks.length - 3; i++) {
          const w = pairRanks.slice(i, i + 3);
          if (!isConsecutive(w)) continue;
          if (w[2] <= target.value) continue;
          const cards: Card[] = [];
          for (const r of w) cards.push(groups.get(r)![0], groups.get(r)![1]);
          const hand = getHandType(cards, this.level);
          if (hand && hand.type === HandType.Tube && hand.value > target.value) {
            result.push(cards);
          }
        }
        break;
      }
      case HandType.Plate: {
        const groups = this.groupByRawRank();
        const tripRanks = Array.from(groups.entries())
          // ★ 修复：严格只用3张的rank组木板——4+张是炸弹绝不拆
          .filter(([r, cs]) => cs.length === 3 && r >= 2 && r <= 14)
          .map(([r]) => r).sort((a, b) => a - b);
        for (let i = 0; i <= tripRanks.length - 2; i++) {
          const w = tripRanks.slice(i, i + 2);
          if (w[1] !== w[0] + 1) continue;
          if (w[1] <= target.value) continue;
          const cards: Card[] = [];
          for (const r of w) cards.push(groups.get(r)![0], groups.get(r)![1], groups.get(r)![2]);
          const hand = getHandType(cards, this.level);
          if (hand && hand.type === HandType.Plate && hand.value > target.value) {
            result.push(cards);
          }
        }
        break;
      }
      default: {
        const bomb = this.findBomb(target);
        if (bomb) result.push(bomb);
      }
    }

    // ★ 修复：即使走"允许拆牌"的跟牌路径，拆顺子/连对/钢板/同花顺也是亏的
    //   （剩下的全是散牌）。三带二/三条/对子的合理拆分不受影响。
    //   allowMultiRankBreak=true（对手濒走必须抢控制时）则不过滤——拆一张大单张
    //   压住对手，比手握大单张却因"防拆顺子"干看对手跑光抢二游强得多。
    if (!allowMultiRankBreak && target.type !== HandType.Bomb && target.type !== HandType.StraightFlush && target.type !== HandType.FourKings && target.type !== HandType.ThreeKings) {
      return result.filter(beats => !this.isMultiRankBreak(beats));
    }
    return result;
  }

  // ---- 炸弹决策（完整矩阵） ----

  private decideBomb(target: Hand, lastPlayerIndex: number): Card[] | null {
    if (this.isAlly(lastPlayerIndex)) return null;

    const isBomb = target.type === HandType.Bomb || target.type === HandType.StraightFlush || target.type === HandType.FourKings || target.type === HandType.ThreeKings;
    const enemyCards = this.handsInfo[lastPlayerIndex];
    const myCards = this.cards.length;
    const partnerCards = this.handsInfo[this.partnerIdx()];

    // ★★★ 廉价目标（单张/对子）硬否决：用炸弹压单/对几乎永远净亏。
    //   成本 = 4~5 张核心资源；收益 = 只换回对手 1~2 张的出牌权。自己牌多时炸完照样
    //   走不完、出牌权下一轮就被抢走——炸弹白烧（本局 BOT2 事故：17 张时用 88888 炸
    //   单 A、又用 AAAAA 炸单 2，两个 5 炸烧光，头游拱手让给 Bot1）。
    //   仅两个例外允许炸单/对：
    //     a) 下家敌人只剩 1 张——必须炸断、再用非单张挡住，否则下家直接走完
    //     b) 自己 ≤5 张——炸完即冲刺收尾（走下方 myCards<=5 分支）
    //   其余情况（对手在跑、对手出大单/级牌、对手牌路崩坏、对手濒走）一律不炸单/对。
    //   ——对手出成型大牌(顺子/钢板/三带二)时 isCheapTarget=false，仍走下方各分支正常炸断。
    const nextSeatGuard = (this.seatIndex + 1) % 4;
    const nextEnemyGuard = this.isAlly(nextSeatGuard) ? 999 : this.handsInfo[nextSeatGuard];
    const isCheapTarget = !isBomb && (target.type === HandType.Single || target.type === HandType.Pair);
    if (isCheapTarget) {
      const mustBreakForNextOne = nextEnemyGuard === 1;
      if (!mustBreakForNextOne && myCards > 5) {
        return null;
      }
    }

    // 队友已头游走掉（剩0张）-> 我方已保头游，目标是抢二游/避免末游（仅4人模式有队友）
    // 只需快速出小牌抢二游/避免末游，炸弹留到濒临走牌时才用
    if (!this.isThreePlayer && partnerCards === 0) {
      // 自己濒临走牌（能靠炸收尾，≤5张且有炸）-> 炸了收尾
      if (myCards <= 5) {
        if (this.areAllCardsBombs()) return this.findBomb(target);
        if (this.countMyBombs() >= 1) return this.findBomb(target);
        return null;
      }
      // ★ 修复：对手（非队友）濒临走牌(≤10张)且我方无普通跟牌时，必须炸断！
      //   原逻辑"牌多(>5)一律不炸"太保守：队友头游后本应抢二游，却放任对手
      //   一路小牌跑光抢二游（手握多炸也只能干看）。现在对手濒走时直接炸断夺权。
      const enemyThreat = !this.isAlly(lastPlayerIndex) && enemyCards > 0 && enemyCards <= 10;
      if (!enemyThreat) return null;
      return this.findBomb(target);
    }

    // 枪不打四：对家剩4张，不是炸弹就不炸。
    //   ★ 修复（打4那局 #84 事故）：Bot3 剩 4 张打出 QQ，BOT2 手握 6666/8888/AAAA 三个
    //     全是炸弹却因这条规则 Pass，放 Bot3 下一手 KKKK 走完头游。"枪不打四"的本意是
    //     怕对家 4 张里藏着炸弹反压，但下面两种局面必须破例，否则等于送头游：
    //       a) 我剩下的全是炸弹——炸完接着领炸就能走完，且用【最大】的炸（AAAA），
    //          对家手里可能的 4 张炸（KKKK v13）也压不住；
    //       b) 我握有 5+ 张的大炸——对家那 4 张无论如何压不住，且炸完仍能掌控牌路。
    if (enemyCards === 4 && !isBomb) {
      const myBombsList = this.getBombs();
      const strongest = myBombsList.length > 0 ? myBombsList[myBombsList.length - 1] : null;
      if (this.areAllCardsBombs() && strongest) {
        return strongest.cards; // 全是炸弹 → 用最大的炸阻断，防对家 4 张反炸
      }
      if (strongest && strongest.cards.length >= 5 && this.canControlAfterBomb(target)) {
        return strongest.cards; // 5+ 张大炸，对家 4 张压不住
      }
      return null;
    }

    // 对家剩5张 -> 必须炸（可能是三带二或顺子），但联盟剩5张不炸
    if (enemyCards === 5 && !isBomb && !this.isAlly(lastPlayerIndex)) return this.findBomb(target);

    // 对家剩7张 -> 必须炸（可能是两套牌），但联盟剩7张不炸
    if (enemyCards === 7 && !isBomb && !this.isAlly(lastPlayerIndex)) return this.findBomb(target);

    // 对家剩8张 -> 默认不炸（三套牌炸不完），但若需抢控制/对手快走则炸
    if (enemyCards === 8 && !isBomb) {
      // 如果我方牌少(≤10)或对手出大牌(≥11)，值得炸
      if (!(myCards <= 10 || target.value >= 11)) return null;
    }

    // 对家剩≤3张 -> 必须炸（快走了），但联盟不炸
    if (enemyCards <= 3 && !this.isAlly(lastPlayerIndex)) return this.findBomb(target);

    // 自己剩≤5张 -> 炸了收尾
    if (myCards <= 5) {
      // 如果所有牌都是炸弹 -> 直接炸
      if (this.areAllCardsBombs()) {
        return this.findBomb(target);
      }
      // 如果有炸弹+散牌，且有炸弹可用 -> 炸了走人
      if (this.countMyBombs() >= 1) return this.findBomb(target);
    }

    // 自己剩>15张 → 中前期绝不用炸压普通牌，炸弹留底（压炸弹/阻断濒走/自己冲刺）
    //   ★ 修复：原来"对手出大牌(≥13)且有≥2炸仍可炸"会让 BOT2 剩25张时用 5555 炸
    //     对手的普通顺子，然后连续烧炸(666万/JJJJ/QQQQQ)、剩一堆散牌末游
    //     （BOT2 连炸4个事故）。炸弹是有限资源，中前期自己牌多时只该省不该烧；
    //     濒走对手的炸断已在上面(enemyCards≤5/7/≤3)处理，这里一律不炸普通牌。
    //   ★ 修复：这条"自己>15张就一律不炸"会把真正的危险局面也放过——
    //     BOT2 17 张、手握 3 个炸，对手只剩 6 张打出三带二，却因自己牌多而 Pass，
    //     一直拖到自己 13 张才想起用炸。而且它与上面"按对手牌数必炸"的规则自相矛盾：
    //     对手剩 6 张不在(4/5/7/8)名单里，于是落到这里被一刀切否决。
    //   → 改为按"对手是否构成威胁"判断：有人在跑 / 我已残局 → 允许用炸打断。
    const nextSeatThreat = (this.seatIndex + 1) % 4;
    const nextEnemyThreatCards = this.isAlly(nextSeatThreat) ? 999 : this.handsInfo[nextSeatThreat];
    const underThreat =
      (enemyCards > 0 && enemyCards <= 10) ||
      (nextEnemyThreatCards > 0 && nextEnemyThreatCards <= 8) ||
      myCards <= 12;
    if (myCards > 15 && !underThreat) {
      return null;
    }

    // ★★ 0. 对手"牌路崩坏" → 主动炸断夺权（不再只看"对手剩几张"）
    //   旧逻辑基本是"按对手剩余张数一刀切"(≤10 张才炸)，缺乏对对手手牌结构的判断。
    //   实际掼蛋/斗地主里，哪怕对手还剩 14 张，只要他的出牌套路已经崩了——
    //   成型组合打光、开始降级出散牌、拆结构凑牌、pass 过的牌型又自己领出——
    //   他手里就没有能抢回出牌权的牌了，这时是接管牌路的最佳窗口。
    //   安全约束：必须满足"炸完我还能掌控牌路"(canControlAfterBomb)，
    //   否则炸完只剩散牌 = 白送炸弹还送掉出牌权（典型乱炸事故）。
    if (!isBomb && !this.isAlly(lastPlayerIndex)) {
      const anomaly = this.opponentPatternAnomaly(lastPlayerIndex);
      const nextSeatP = (this.seatIndex + 1) % 4;
      const nextEnemyP = this.isAlly(nextSeatP) ? 999 : this.handsInfo[nextSeatP];
      const inRange = enemyCards <= 16 || nextEnemyP <= 12; // 放宽到 ≤16/≤12，不再要求 ≤10
      if (anomaly.score >= 4 && inRange && this.canControlAfterBomb(target)) {
        return this.findBomb(target);
      }
    }

    // ★ 手牌几乎全是炸弹（非炸弹≤2张）-> 果断炸，跳过保守逻辑
    const nonBombCnt = this.cards.filter(c => this.countSameRank(c.rank) < 4).length;
    if (this.countMyBombs() >= 2 && nonBombCnt <= 2 && !isBomb) {
      return this.findBomb(target); // 只有炸弹能压，直接炸
    }

    // ★ 修复：单张/对子属"廉价牌型"——用炸弹（尤其同花顺）压单/对是纯浪费：
    //   对手就多走1张，出牌权总会回来。只有真需要阻断（下家敌人濒走1-5张）才值得炸。
    //   出牌者濒走(enemyCards<=5/3)、自己濒走收尾(myCards<=5) 已在上面处理；
    //   这里把下面所有"抢控制/压大牌/主动炸"规则对单/对一律关闭。
    //   （0张=下家已走完不算威胁；对手剩大把牌时压一张单/对纯属烧炸）
    const nextSeatBlock = (this.seatIndex + 1) % 4;
    const nextEnemyCards = this.isAlly(nextSeatBlock) ? 999 : this.handsInfo[nextSeatBlock];
    const nextEnemyNear = nextEnemyCards > 0 && nextEnemyCards <= 5;
    if ((target.type === HandType.Single || target.type === HandType.Pair) && !nextEnemyNear) {
      return null;
    }

    // ★★ 掼蛋大师：主动抢控制权（中前期也炸）
    // 核心思想：炸弹是用来控制节奏、抢出牌权的，不是只有对手快走才用
    const myBombs = this.countMyBombs();
    const myStrength = this.assessHandStrength();
    const hasReadyPlay = this.handPlan.groups.some((g, i) => {
      // 手里有非炸弹的成型牌（顺子/连对/三带二/对子等）
      if (this.handPlan.getBombIndices().has(i)) return false;
      return true;
    });

    // 1. 抢回出牌权：我有能一手走掉的成型牌，对手压了我的牌型，炸了拿回控制
    //    判断：对手濒临走牌(≤8) 或 我方牌不多(≤10) 或 对手出大牌(≥13)且我有≥2炸
    if (myBombs >= 1 && !isBomb) {
      const playableGroups = this.handPlan.groups.length - this.handPlan.getBombIndices().size;
      // 关键时机：
      // a) 对手快走或我方牌少 -> 值得抢控制
      // b) 中前期对手出大牌(K/A/级牌/王≥13) 且我有≥2炸弹且牌力强 -> 主动炸压大牌
      const opponentBigPlay = target.value >= 13;
      const strongControl = (enemyCards <= 8 || myCards <= 10);
      const midGameBigCard = opponentBigPlay && myBombs >= 2 && myStrength >= 30;
      if ((strongControl || midGameBigCard) && playableGroups >= 2) {
        // 对手出中高牌(≥11)才炸，能用普通牌跟的用牌跟省炸
        if (target.value >= 11) {
          return this.findBomb(target);
        }
      }
    }

    // 2. 打断对手节奏：对手连续拿控制权（对手牌比我们少或快走），炸断
    //    判断：下家/出牌者濒临走牌(≤10张) 且 我方有机会反超
    //    且对手出中高牌(≥11)才炸——单5/小牌用普通牌跟省炸
    if (myBombs >= 1 && !isBomb) {
      if (enemyCards <= 10 && myCards <= enemyCards + 3 && myStrength >= 25 && target.value >= 11) {
        // 对手牌少且我方牌力尚可 → 用炸弹夺回控制，避免对手连续出
        return this.findBomb(target);
      }
    }

    // 3. 保护队友/阻止对手大牌：对手出A/K/级牌/王等大牌，炸了不让对手爽
    if (myBombs >= 2 && !isBomb) {
      if (target.value >= 14) { // A/K/级牌/王
        return this.findBomb(target); // 有两个炸弹，舍得炸一个压大牌
      }
    }

    // ★ 记忆增强：根据对手可能炸弹数调整是否值得炸
    if (this.tracker) {
      const oppBombThreat = this.countEnemyPotentialBombs();
      // 对手炸弹威胁大(≥3) -> 保守，避免炸完被反炸
      if (oppBombThreat >= 3 && myCards > 8 && !isBomb) return null;
      // 对手炸弹威胁小(0) -> 更敢炸（外面几乎没有炸弹能压我）
      // 但只在对手出大牌(≥11)时炸，小牌用普通牌跟省炸
      if (oppBombThreat === 0 && !isBomb && target.value >= 11) {
        // 对手没炸弹潜力了，用炸弹拿回控制权很划算
        if (this.countMyBombs() >= 1) return this.findBomb(target);
      }
    }

    // 对方打大牌(A/K+级别)且我有至少2个炸弹 → 可以炸一个
    if (target.value >= 14 && !isBomb) {
      if (this.countMyBombs() >= 2) return this.findBomb(target);
    }

    // 炸弹对炸弹：根据牌力判断是否对炸
    if (isBomb) {
      const myBombs = this.countMyBombs();
      const myStrength = this.assessHandStrength();
      
      // 自己牌多且对方牌也多 -> 不浪费对炸
      if (myCards > 10 && enemyCards > 5) return null;
      
      // 自己只剩1个炸弹且牌还多 -> 不对炸（保留控制力）
      if (myBombs <= 1 && myCards > 8) return null;
      
      // 牌力弱(<=20)且不是终局 -> 不对炸（留炸保命）
      if (myStrength <= 20 && myCards > 6) return null;
      
      // 对方出的是大炸弹(5炸+)且我只有4炸 -> 不对炸（炸不过）
      if (target.type === HandType.Bomb && (target.bombCount || 4) >= 5 && myBombs <= 1) return null;
      
      // 队友牌还多(>10)且我也多 -> 信任队友，不对炸
      const partnerCards = this.handsInfo[this.partnerIdx()];
      if (partnerCards > 10 && myCards > 10) return null;
      
      // 否则找更大的炸
      return this.findBomb(target);
    }

    return null;
  }

  private countMyBombs(): number {
    // ★ 用 handPlan 的权威炸弹识别（含逢人配炸弹：3张+红桃级牌=4炸）
    //    不能只用 groupByRawRank 数"4张纯同rank"，那会漏掉逢人配炸弹
    return this.handPlan.getBombIndices().size;
  }

  /**
   * 是否握着"能稳吃一手"的控制资产：王 / 级牌 / 逢人配 / 炸弹 / 同花顺 / 大成型组合。
   *
   * ★ 出牌顺序的总开关（"先小后大" vs "一次清最多"）：
   *  - 有控制资产：丢一次出牌权也能抢回来 → 可以放心先清小散牌，把大牌/大组合留作收尾；
   *  - 没有控制资产：这一手领出很可能就是最后一次 → 必须一次清掉最多的牌（出最长组合）。
   *
   * ★ 也是"压制意识"的基础：手里没有能控制场面的牌时，就不能随便把成型大牌拆散去
   *   出小牌（出了就再也抢不回主动权，只能被动挨打）。
   */
  private hasControlAsset(nonBombGroups: { cards: Card[]; type: HandType; value: number }[] = []): boolean {
    // 1) 王 / 级牌 / 逢人配：单张层面几乎无法被压的绝对控制牌
    if (this.cards.some(c =>
      c.rank === Rank.BigJoker || c.rank === Rank.SmallJoker || c.isWild || c.rank === this.level)) {
      return true;
    }
    // 2) 炸弹 / 同花顺（含 5 张、6 张逢人配大炸）
    if (this.countMyBombs() > 0) return true;
    // 3) 大成型组合：≥5 张的顺子/连对/钢板，或够强(v≥10)的三带二
    return nonBombGroups.some(g => {
      const h = getHandType(g.cards, this.level);
      if (!h || g.cards.length < 5) return false;
      if (h.type === HandType.TripsWithPair) return h.value >= 10;
      return h.type === HandType.Straight || h.type === HandType.Tube || h.type === HandType.Plate;
    });
  }

  // ---- 规划感知的跟牌查找 ----

  private findPlanBeat(target: Hand): Card[] | null {
    const available = new Map<string, Card[]>();
    for (const c of this.cards) {
      const key = c.suit + ':' + c.rank;
      if (!available.has(key)) available.set(key, []);
      available.get(key)!.push(c);
    }
    for (const g of this.handPlan.groups) {
      const hand = getHandType(g.cards, this.level);
      if (!hand) continue;
      if (hand.type === HandType.Bomb || hand.type === HandType.StraightFlush || hand.type === HandType.FourKings) continue;
      if (hand.type === target.type && hand.value > target.value) {
        const needed = new Map<string, number>();
        for (const c of g.cards) {
          const key = c.suit + ':' + c.rank;
          needed.set(key, (needed.get(key) || 0) + 1);
        }
        let ok = true;
        for (const [key, count] of needed) {
          if ((available.get(key)?.length || 0) < count) { ok = false; break; }
        }
        if (ok) {
          const result: Card[] = [];
          for (const [key, count] of needed) {
            for (let i = 0; i < count; i++) result.push(available.get(key)![i]);
          }
          return result;
        }
      }
    }
    return null;
  }

  /**
   * 下家敌人只剩1张时，找"最高的、不拆规划的"单张来压对手的单张（封牌/垫高）。
   * 用 findAllBeatsPreservingPlan 保证不拆散对子/三条/炸弹等规划结构。
   */
  private findHighestPreservingSingleBeat(targetVal: number): Card[] | null {
    const beats = this.findAllBeatsPreservingPlan({ type: HandType.Single, cards: [], value: targetVal });
    if (beats.length === 0) return null;
    // ★ 修复：阻断下家濒走(剩1张)时，用"最高的普通单张"封牌——Q/K/A 已能压过绝大多数
    //   单张，小王/大王/级牌/逢人配这些绝对控制牌要留作收尾/控场。
    //   原来直接取逻辑值最高(往往是王/级牌)，把绝对控制砸在对手的小单上
    //   （BOT2 有单5+Q却用小王压对手单4、白送小王事故）。
    //   若普通高牌不够用（只剩王/级牌能压），才退回用它们。
    const normalPool = beats.filter(b => {
      const c = b[0];
      return c.rank !== Rank.BigJoker && c.rank !== Rank.SmallJoker && !c.isLevelCard && !c.isWild;
    });
    const pool = normalPool.length > 0 ? normalPool : beats;
    let best: Card[] | null = null;
    let bestVal = -1;
    for (const b of pool) {
      const v = getLogicValue(b[0].rank, this.level);
      if (v > bestVal) { bestVal = v; best = b; }
    }
    return best;
  }

  /**
   * 这手跟牌是否"拆散"了某个顺子/连对/钢板规划组？
   * ★ 掼蛋大师视角：顺子/连对/钢板是多rank连续组合，拆出一张（或拆成对子/三条）后
   *   剩下的全是散牌（如 56789 拆一张出单 -> 剩 4 张散单），等于自废一手强牌。
   *   跟牌时几乎永远不该这么拆（除非炸弹封堵）。三带二/三条/对子不属于此类——
   *   拆对子压对子、拆三条压三条后剩余仍是成手，是合理的。
   */
  private isMultiRankBreak(cards: Card[]): boolean {
    // 这次跟牌拆掉了哪些 rank、用掉了哪些牌
    const removed = new Map<number, number>();
    const removeIds = new Set<string>();
    for (const c of cards) {
      removed.set(c.rank, (removed.get(c.rank) || 0) + 1);
      removeIds.add(c.id);
    }
    for (const g of this.handPlan.groups) {
      const h = getHandType(g.cards, this.level);
      if (!h) continue;
      // 顺子/连对/钢板/同花顺（含同花顺这种炸弹）都是多rank组合：
      // 拆出一张跟小牌 = 把一手强牌（甚至炸弹）拆成 4 张散牌。
      if (h.type !== HandType.Straight && h.type !== HandType.Tube &&
          h.type !== HandType.Plate && h.type !== HandType.StraightFlush) continue;
      // 整组牌都用掉了 = 是在"打出这个组合"（如出整顺子压顺子），不算拆
      if (g.cards.every(c => removeIds.has(c.id))) continue;
      // 组内各 rank 需要的张数
      const needed = new Map<number, number>();
      for (const c of g.cards) needed.set(c.rank, (needed.get(c.rank) || 0) + 1);
      // 按 rank 判断：跟完这手牌后，若该多rank组合已无法凑齐 -> 拆散了它
      // （用 rank 计数而非卡牌id，避免"手上有3张11，出一张11"被误判为拆顺子）
      let broken = false;
      for (const [rank, need] of needed) {
        const totalHave = this.cards.filter(c => c.rank === rank).length;
        const willRemove = removed.get(rank) || 0;
        if (totalHave - willRemove < need) { broken = true; break; }
      }
      if (broken) return true;
    }
    return false;
  }

  /**
   * 这张牌是否属于某个"同花顺"规划组。
   * ★ 同花顺是炸弹级资源（能压普通炸弹），拆出其中一张当单张 = 把一手能压炸的
   *   控制牌拆成散牌，比拆普通顺子/连对/钢板严重得多。所以"破结构抢控制"
   *   (allowMultiRankBreak=true) 可以拆普通顺子，但**绝不允许拆同花顺**。
   *   ——本局 BOT2 事故：#98/#105 对手濒走时，把黑桃同花顺 ♠3♠4♠5♠6♠7 的
   *   ♠5/♠6 一张张拆出去压小单张，最后 ♠4 卡底末游。
   */
  private isPartOfStraightFlush(card: Card): boolean {
    for (const g of this.handPlan.groups) {
      const h = getHandType(g.cards, this.level);
      if (h && h.type === HandType.StraightFlush && g.cards.some(c => c.id === card.id)) {
        return true;
      }
    }
    return false;
  }

  private findAllBeatsPreservingPlan(target: Hand): Card[][] {
    const result: Card[][] = [];

    const planGroups = new Map<string, Map<string, number>>();
    for (const g of this.handPlan.groups) {
      const needed = new Map<string, number>();
      for (const c of g.cards) {
        const key = c.suit + ':' + c.rank;
        needed.set(key, (needed.get(key) || 0) + 1);
      }
      planGroups.set(g.type + ':' + g.value, needed);
    }

    const available = new Map<string, Card[]>();
    for (const c of this.cards) {
      const key = c.suit + ':' + c.rank;
      if (!available.has(key)) available.set(key, []);
      available.get(key)!.push(c);
    }

    const matchesPlan = (cards: Card[]): boolean => {
      const needed = new Map<string, number>();
      for (const c of cards) {
        const key = c.suit + ':' + c.rank;
        needed.set(key, (needed.get(key) || 0) + 1);
      }
      // 宽松检查：只要这手牌不拆散某个 plan 组的"骨架"，就算匹配
      // 对子可取自三带二附属、三条可取自钢板附属等
      // 规则：如果 cards 完全由某个 plan 组的牌构成（子集），允许
      for (const [, planNeeded] of planGroups) {
        let subset = true;
        for (const [key, count] of needed) {
          if ((planNeeded.get(key) || 0) < count) { subset = false; break; }
        }
        if (subset) return true; // cards 是某个 plan 组的子集，不拆散该组
      }
      return false;
    };

    switch (target.type) {
      case HandType.Single:
        for (let i = this.cards.length - 1; i >= 0; i--) {
          const c = this.cards[i];
          const val = getLogicValue(c.rank, this.level);
          if (val > target.value) {
            const sameRankCount = this.countSameRank(c.rank);
            if (sameRankCount >= 4) continue; // 炸弹绝对不拆出单张
            if (sameRankCount <= 1) {
              result.push([c]);
            }
          }
        }
        break;
      case HandType.Pair: {
        const pairs = this.getGroups(2);
        for (const pair of pairs) {
          const val = getLogicValue(pair[0].rank, this.level);
          if (val > target.value) {
            const groupSize = this.countSameRank(pair[0].rank);
            if (groupSize >= 4) continue; // 炸弹绝对不拆
            const r = pair[0].rank;
            // ★ 修复：只有"独立对子"或"三带二的对子部分"可拆来压对子。
            //   顺子/连对/钢板的多rank组合绝不拆（拆了剩一堆散牌）。
            //   原来用 planGroups.has('TripsWithPair:' + val) 判断三带二附属对子
            //   是错的：三带二的plan键值取的是"三条部分"的value，对子永远匹配不上。
            const inIndependentPair = planGroups.has('Pair:' + val);
            const inTripsWithPairPair = this.tripsWithPairPairRanks.has(r);
            if (!inIndependentPair && !inTripsWithPairPair) continue;
            result.push(pair);
          }
        }
        break;
      }
      case HandType.Trips: {
        const trips = this.getGroups(3);
        for (const t of trips) {
          const val = getLogicValue(t[0].rank, this.level);
          if (val > target.value) {
            const groupSize = this.countSameRank(t[0].rank);
            if (groupSize >= 4) continue; // 炸弹绝对不拆
            const r = t[0].rank;
            // ★ 修复：只有"独立三条"或"三带二的三条部分"可拆来压三条。
            //   钢板(999888)里的三条绝不拆（拆了剩一堆散牌）。
            const inPlan = planGroups.has('Trips:' + val)
              || planGroups.has('TripsWithPair:' + val);
            if (inPlan) result.push(t);
          }
        }
        break;
      }
      case HandType.TripsWithPair: {
        const trips = this.getGroups(3);
        for (const t of trips) {
          const tVal = getLogicValue(t[0].rank, this.level);
          if (tVal > target.value) {
            const groupSize = this.countSameRank(t[0].rank);
            if (groupSize >= 4) continue; // 炸弹绝对不拆
            // 三条部分必须在 plan 中存在（独立三条 或 三带二/钢板的三条），避免拆散规划
            const tripInPlan = planGroups.has('TripsWithPair:' + tVal)
              || planGroups.has('Trips:' + tVal)
              || planGroups.has('Plate:' + tVal);
            if (!tripInPlan) continue;
            const pair = this.findPairExcluding(t);
            if (pair) {
              // 对子自由配最小非级牌对子（findPairExcluding已优先不拆散、级牌靠pickSmallest惩罚）
              result.push([...t, ...pair]);
            }
          }
        }
        break;
      }
      case HandType.Straight: {
        const groups = this.groupByRawRank();
        const vals = Array.from(groups.keys()).filter(v => v >= 2 && v <= 14);
        for (let i = 0; i <= vals.length - 5; i++) {
          const w = vals.slice(i, i + 5);
          if (!isConsecutive(w)) continue;
          const cards: Card[] = [];
          for (const v of w) cards.push(groups.get(v)![0]);
          const hand = getHandType(cards, this.level);
          if (hand && hand.type === HandType.Straight && hand.value > target.value && matchesPlan(cards)) {
            result.push(cards);
          }
        }
        break;
      }
      case HandType.Tube: {
        const groups = this.groupByRawRank();
        const pairRanks = Array.from(groups.entries())
          .filter(([r, cs]) => cs.length >= 2 && r >= 2 && r <= 14)
          .map(([r]) => r).sort((a, b) => a - b);
        for (let i = 0; i <= pairRanks.length - 3; i++) {
          const w = pairRanks.slice(i, i + 3);
          if (!isConsecutive(w)) continue;
          const cards: Card[] = [];
          for (const r of w) cards.push(groups.get(r)![0], groups.get(r)![1]);
          const hand = getHandType(cards, this.level);
          if (hand && hand.type === HandType.Tube && hand.value > target.value && matchesPlan(cards)) result.push(cards);
        }
        break;
      }
      case HandType.Plate: {
        const groups = this.groupByRawRank();
        const tripRanks = Array.from(groups.entries())
          .filter(([r, cs]) => cs.length >= 3 && r >= 2 && r <= 14)
          .map(([r]) => r).sort((a, b) => a - b);
        for (let i = 0; i <= tripRanks.length - 2; i++) {
          const w = tripRanks.slice(i, i + 2);
          if (w[1] !== w[0] + 1) continue;
          const cards: Card[] = [];
          for (const r of w) cards.push(groups.get(r)![0], groups.get(r)![1], groups.get(r)![2]);
          const hand = getHandType(cards, this.level);
          if (hand && hand.type === HandType.Plate && hand.value > target.value && matchesPlan(cards)) result.push(cards);
        }
        break;
      }
    }
    // ★ 修复：所有常规牌型跟牌时，绝不拆散顺子/连对/钢板/同花顺规划组
    //   （拆一张顺子出单张=把一手强牌拆成 4 张散牌；拆钢板的三条配三带二同理）。
    //   三带二/三条/对子本身的合理拆分（如拆KK配555压对子）不受影响；
    //   出整手同型组合（如整顺子压顺子）也不受影响。
    if (target.type !== HandType.Bomb && target.type !== HandType.StraightFlush && target.type !== HandType.FourKings && target.type !== HandType.ThreeKings) {
      return result.filter(beats => !this.isMultiRankBreak(beats));
    }
    return result;
  }

  // ---- 跟牌查找（非规划感知） ----

  private findBeat(target: Hand): Card[] | null {
    switch (target.type) {
      case HandType.Single: return this.beatSingle(target.value);
      case HandType.Pair: return this.beatPair(target.value);
      case HandType.Trips: return this.beatTrips(target.value);
      case HandType.TripsWithPair: return this.beatTripsWithPair(target.value);
      case HandType.Straight: return this.beatStraight(target.value);
      case HandType.Tube: return this.beatTube(target.value);
      case HandType.Plate: return this.beatPlate(target.value);
      default: return null;
    }
  }

  private beatSingle(targetVal: number): Card[] | null {
    for (let i = this.cards.length - 1; i >= 0; i--) {
      const val = getLogicValue(this.cards[i].rank, this.level);
      if (val > targetVal) {
        const groupSize = this.countSameRank(this.cards[i].rank);
        if (groupSize >= 4) continue; // 炸弹绝对不拆
        return [this.cards[i]];
      }
    }
    return null;
  }

  private beatPair(targetVal: number): Card[] | null {
    const pairs = this.getGroups(2);
    for (const pair of pairs) {
      const val = getLogicValue(pair[0].rank, this.level);
      if (val > targetVal) {
        const groupSize = this.countSameRank(pair[0].rank);
        if (groupSize >= 4) continue; // 炸弹绝对不拆
        return pair;
      }
    }
    return null;
  }

  private beatTrips(targetVal: number): Card[] | null {
    const trips = this.getGroups(3);
    for (const t of trips) {
      const val = getLogicValue(t[0].rank, this.level);
      if (val > targetVal) {
        const groupSize = this.countSameRank(t[0].rank);
        if (groupSize >= 4) continue; // 炸弹绝对不拆
        return t;
      }
    }
    return null;
  }

  private beatTripsWithPair(targetVal: number): Card[] | null {
    const trips = this.getGroups(3);
    for (const t of trips) {
      const tVal = getLogicValue(t[0].rank, this.level);
      if (tVal > targetVal) {
        const groupSize = this.countSameRank(t[0].rank);
        if (groupSize >= 4) continue; // 炸弹绝对不拆
        const pair = this.findPairExcluding(t);
        if (pair) return [...t, ...pair];
      }
    }
    return null;
  }

  private beatStraight(targetVal: number): Card[] | null {
    const groups = this.groupByRawRank();
    const vals = Array.from(groups.keys()).filter(v => v >= 2 && v <= 14);
    for (let i = 0; i <= vals.length - 5; i++) {
      const w = vals.slice(i, i + 5);
      if (!isConsecutive(w)) continue;
      if (w[4] <= targetVal) continue;
      const cards: Card[] = w.map(v => groups.get(v)![0]);
      const hand = getHandType(cards, this.level);
      if (hand && hand.type === HandType.Straight && hand.value > targetVal) {
        return cards;
      }
    }
    return null;
  }

  private beatTube(targetVal: number): Card[] | null {
    const groups = this.groupByRawRank();
    const pairRanks = Array.from(groups.entries())
      .filter(([r, cs]) => cs.length >= 2 && r >= 2 && r <= 14)
      .map(([r]) => r).sort((a, b) => a - b);
    for (let i = 0; i <= pairRanks.length - 3; i++) {
      const w = pairRanks.slice(i, i + 3);
      if (!isConsecutive(w)) continue;
      if (w[2] <= targetVal) continue;
      const cards: Card[] = [];
      for (const r of w) cards.push(groups.get(r)![0], groups.get(r)![1]);
      const hand = getHandType(cards, this.level);
      if (hand && hand.type === HandType.Tube && hand.value > targetVal) {
        return cards;
      }
    }
    return null;
  }

  private beatPlate(targetVal: number): Card[] | null {
    const groups = this.groupByRawRank();
    const tripRanks = Array.from(groups.entries())
      .filter(([r, cs]) => cs.length >= 3 && r >= 2 && r <= 14)
      .map(([r]) => r).sort((a, b) => a - b);
    for (let i = 0; i <= tripRanks.length - 2; i++) {
      const w = tripRanks.slice(i, i + 2);
      if (w[1] !== w[0] + 1) continue;
      if (w[1] <= targetVal) continue;
      const cards: Card[] = [];
      for (const r of w) cards.push(groups.get(r)![0], groups.get(r)![1], groups.get(r)![2]);
      const hand = getHandType(cards, this.level);
      if (hand && hand.type === HandType.Plate && hand.value > targetVal) {
        return cards;
      }
    }
    return null;
  }

  // ---- 对手牌路建模 / 炸后掌控力评估 ----

  /**
   * 评估某个对手的"牌路是否崩坏"——即他最近出的牌，是否还符合他手里应有的牌型套路。
   *
   * 原理：正常牌路下，玩家会按自己手牌结构出牌（有成型组合就甩组合清牌）。
   * 一旦出现下列"反常"，就说明他的成型牌已经打光、手里剩的是散牌堆，
   * 此后他基本只能靠小牌磨、抢不回出牌权 —— 这正是我方用炸弹夺权的窗口：
   *
   *  S1 降级  (+3)：出过 ≥5 张成型组合，最近一次自由领出却退回单张/对子
   *  S2 散牌堆(+3)：连续 3 次自由领出都是 ≤2 张的手，等于承认没有成型组合
   *  S3 递减  (+2)：最近 3 手价值一路下降，在倒废牌、手上没有控制牌
   *  S4 矛盾  (+3)：pass 过的牌型，后来自己又领出该牌型（说明是拆结构凑出来的）
   *  S5 低效  (+2)：出过 ≥4 手，平均每手只清掉 ≤1.5 张
   *
   * @returns score ≥4 视为可信的"牌路崩坏"信号；reasons 便于复盘定位
   */
  private opponentPatternAnomaly(seat: number): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    if (!this.tracker) return { score: 0, reasons };
    const log = this.tracker.getSeatLog(seat);
    const plays = (log && log.plays) || [];
    if (plays.length < 2) return { score: 0, reasons };

    let score = 0;
    const isSmall = (t: HandType) => t === HandType.Single || t === HandType.Pair;
    const leads = plays.filter(p => p.lead);

    // S1 降级
    const hadCombo = plays.some(p => p.len >= 5);
    if (hadCombo && leads.length >= 2 && isSmall(leads[leads.length - 1].type)) {
      score += 3; reasons.push('S1降级：出过成型组合后改出散单/对');
    }
    // S2 散牌堆
    if (leads.length >= 3 && leads.slice(-3).every(p => p.len <= 2)) {
      score += 3; reasons.push('S2散牌堆：连续3次领出都≤2张，无成型组合');
    }
    // S3 价值递减
    const last3 = plays.slice(-3);
    if (last3.length === 3 && last3[0].value > last3[1].value && last3[1].value > last3[2].value) {
      score += 2; reasons.push('S3递减：出牌价值连续下降（在清废牌）');
    }
    // S4 前后矛盾
    for (const t of (log.passedTypes || [])) {
      if (plays.some(p => p.lead && p.type === t)) {
        score += 3; reasons.push(`S4矛盾：pass 过 ${t} 却自己领出 ${t}（拆结构凑牌）`);
        break;
      }
    }
    // S5 低效
    const cleared = plays.reduce((s, p) => s + p.len, 0);
    if (plays.length >= 4 && cleared / plays.length <= 1.5) {
      score += 2; reasons.push('S5低效：平均每手只清 ≤1.5 张（手牌散）');
    }

    return { score, reasons };
  }

  /**
   * 能"便宜跟牌"时，是否仍该用炸弹接管？
   * 只在真正需要打断的局面才压过便宜跟牌，避免走回"乱炸"的老路：
   *   - 出牌者自己在冲刺(≤8张) 或 下家敌人濒走(≤5张)：不打断他就要一路走完
   *   - 我已进入残局(≤12张)：此时一次出牌权的价值远高于一张炸弹
   * 且必须满足"炸完我还能掌控牌路"(canControlAfterBomb)。
   */
  private shouldBombOverCheapFollow(target: Hand, lastPlayerIndex: number): boolean {
    if (this.isAlly(lastPlayerIndex)) return false;
    const enemyCards = this.handsInfo[lastPlayerIndex];
    const nextSeat = (this.seatIndex + 1) % 4;
    const nextEnemyCards = this.isAlly(nextSeat) ? 999 : this.handsInfo[nextSeat];
    const myCards = this.cards.length;
    const theyAreRunning = (enemyCards > 0 && enemyCards <= 8) || (nextEnemyCards > 0 && nextEnemyCards <= 5);
    const myEndgame = myCards <= 12;
    if (!theyAreRunning && !myEndgame) return false;
    return this.canControlAfterBomb(target);
  }

  /**
   * 炸掉这一手之后，我还能不能"掌控牌路"。
   * 要求炸完至少还能连走 ≥2 手（成型组合 + 控制牌 + 余下炸弹），
   * 否则就是"炸完只剩一堆散牌"，等于白送炸弹还把出牌权拱手让人（典型乱炸事故）。
   */
  private canControlAfterBomb(target?: Hand): boolean {
    const bomb = this.findBomb(target);
    if (!bomb) return false;
    const rest = this.cards.filter(c => !bomb.some(bc => bc.id === c.id));
    if (rest.length === 0) return true;               // 炸完直接走完
    if (getHandType(rest, this.level)) return true;   // 炸完剩一手成型牌

    let run = 0;
    // 成型组（≥2 张同点，可成对子/三条/炸弹）各算一手
    const byRank = new Map<number, number>();
    for (const c of rest) byRank.set(c.rank, (byRank.get(c.rank) || 0) + 1);
    for (const [, n] of byRank) if (n >= 2) run++;
    // 控制牌（王 / 逢人配 / 级牌）每张能抢回一次出牌权
    run += rest.filter(c =>
      c.rank === Rank.BigJoker || c.rank === Rank.SmallJoker || c.isWild || c.rank === this.level).length;
    // 手里剩下的其它炸弹
    run += Math.max(0, this.countMyBombs() - 1);
    return run >= 2;
  }

  // ---- 炸弹查找 ----

  findBomb(target?: Hand): Card[] | null {
    const sj = this.cards.filter(c => c.rank === Rank.SmallJoker);
    const bj = this.cards.filter(c => c.rank === Rank.BigJoker);
    let kings: Card[] | null = null;
    if (sj.length === 2 && bj.length === 2) kings = [...sj, ...bj];

    const sfs = this.findStraightFlushes();
    const bombs = this.getBombs();

    // ★ 修复：同花顺很可能与手里的 4 张炸弹共用牌张——一旦打出，那几个炸弹就被拆成残骸。
    //   实战事故：BOT2 用 ♣2♣3♣4♣5♣6 去压对手的 4 张炸，其中 ♣3/♣6 分别属于 3333/6666，
    //   一出手两个 4 张炸全废，此后"想炸也没得炸"。
    //   → 优先挑"不吃炸弹牌"的同花顺；只有在别无选择时才允许动用会拆炸的那张。
    const bombCardIds = new Set<string>();
    for (const b of bombs) for (const c of b.cards) bombCardIds.add(c.id);
    const safeSfs = sfs.filter(sf => !sf.cards.some(c => bombCardIds.has(c.id)));
    const sfsPrefer = safeSfs.length > 0 ? safeSfs : sfs;

    if (!target) {
      if (bombs.length > 0) return bombs[0].cards;
      if (sfsPrefer.length > 0) return sfsPrefer[0].cards;
      if (kings) return kings;
      return null;
    }

    const tBomb = target.type === HandType.Bomb;
    const tSF = target.type === HandType.StraightFlush;
    const tKings = target.type === HandType.FourKings;
    // ★ 修复：三王炸(ThreeKings)在 compareHands 里压过所有普通炸弹/同花顺，
    //   只有四大天王能压它。不能当普通非炸弹目标拿普通炸去压（会是非法跟牌）。
    const tThreeKings = target.type === HandType.ThreeKings;

    if (tThreeKings) {
      if (kings) return kings;
      return null;
    }

    if (!tBomb && !tSF && !tKings) {
      if (bombs.length > 0) return bombs[0].cards;
      if (sfsPrefer.length > 0) return sfsPrefer[0].cards;
      if (kings) return kings;
      return null;
    }

    if (tKings) return null;

    if (tSF) {
      const biggerSF = sfsPrefer.find(sf => sf.value > target.value);
      if (biggerSF) return biggerSF.cards;
      if (kings) return kings;
      const bigBomb = bombs.find(b => b.cards.length >= 6);
      if (bigBomb) return bigBomb.cards;
      return null;
    }

    if (tBomb) {
      const tCount = target.bombCount || 4;
      const tVal = target.value;
      // 优先找同张数且点数更大的（经济，不浪费大炸）
      // 例: 对手7777(4炸), 我有8888(4炸)和444444(6炸) -> 用8888省6炸
      for (const b of bombs) {
        if (b.cards.length === tCount && b.value > tVal) return b.cards;
      }
      // 同张数没有能压的，才找张数更多的
      for (const b of bombs) {
        if (b.cards.length > tCount) return b.cards;
      }
      // 张数更多也没有，用同花顺/天王炸
      // ★ 修复：同花顺强度=5.5，只压得过 ≤5 张的炸弹；面对 6+ 张炸弹
      //   出同花顺是非法跟牌（会被判"牌不够大"）。天王炸(四大天王)压一切。
      if (tCount <= 5 && sfsPrefer.length > 0) return sfsPrefer[0].cards;
      if (kings) return kings;
    }

    return null;
  }

  findStraightFlushes(): { cards: Card[], value: number }[] {
    const sfs: { cards: Card[], value: number }[] = [];
    const wilds = this.cards.filter(c => c.isWild);
    // 所有 5 张连续窗口（A-2-3-4-5 自行车 A 当 1）
    const windows: number[][] = [];
    for (let i = 2; i <= 10; i++) windows.push([i, i + 1, i + 2, i + 3, i + 4]);
    windows.push([14, 2, 3, 4, 5]);
    for (const s of [0, 1, 2, 3]) {
      const suitCards = this.cards.filter(c => c.suit === s && !c.isWild && c.rank <= Rank.Ace);
      const byRank = new Map<number, Card[]>();
      for (const c of suitCards) {
        if (!byRank.has(c.rank)) byRank.set(c.rank, []);
        byRank.get(c.rank)!.push(c);
      }
      for (const w of windows) {
        const have = w.filter(r => byRank.has(r));
        const missing = w.filter(r => !byRank.has(r));
        // ★ 修复：逢人配(万★)可补任意点数，参与同花顺——原来 !c.isWild 排除逢人配，
        //   BOT2 手牌 A★♣2♣3♣4♣+万★♥(逢人配配5) 是 A2345 同花顺，但 findStraightFlushes
        //   找不到 → BOT2 不知道自己有同花顺，把 A★/万★/2/3/4 拆散出（BOT2 有同花顺
        //   不出反而拆掉末游事故）。这里用逢人配补缺口识别出来。
        if (missing.length <= wilds.length) {
          const cards: Card[] = have.map(r => byRank.get(r)![0]);
          for (let k = 0; k < missing.length; k++) cards.push(wilds[k]);
          const hand = getHandType(cards, this.level);
          // ★ 修复：value 必须与 getHandType 出牌口径一致！用 getHandType 的 value
          //   （A-2-3-4-5 自行车 A 当低牌算 v5，不能按 A 高牌算 v14 去压 v7 同花顺）。
          // ★ 修复：只靠 getHandType 会放行"同一张万能牌被算两次"的假同花顺
          //   （如 level=3 时 ♥A♥2♥3♥4+♥3 被当成 A2345），必须再用
          //   isValidStraightFlushCombo 校验 5 张牌确实是 5 张独立牌张。
          if (hand && hand.type === HandType.StraightFlush && isValidStraightFlushCombo(cards, this.level)) {
            // 去重：同一组牌(id)只保留一次
            const key = [...cards].map(c => c.id).sort().join('|');
            if (!sfs.some(x => [...x.cards].map(c => c.id).sort().join('|') === key)) {
              sfs.push({ cards, value: hand.value });
            }
          }
        }
      }
    }
    sfs.sort((a, b) => a.value - b.value);
    return sfs;
  }

  // ---- 工具方法 ----

  private groupByRawRank(): Map<number, Card[]> {
    const map = new Map<number, Card[]>();
    for (const c of this.cards) {
      const r = c.rank;
      if (!map.has(r)) map.set(r, []);
      map.get(r)!.push(c);
    }
    return new Map([...map.entries()].sort((a, b) => a[0] - b[0]));
  }

  private cardsAfter(played: Card[]): Card[] {
    const ids = new Set(played.map(c => c.id));
    return this.cards.filter(c => !ids.has(c.id));
  }

  private countHandTypes(cards: Card[]): number {
    if (cards.length === 0) return 0;
    const hand = getHandType(cards, this.level);
    if (hand) return 1;

    const groups = new Map<number, number>();
    for (const c of cards) {
      const r = rawRank(c);
      groups.set(r, (groups.get(r) || 0) + 1);
    }

    let types = 0;
    const counts = Array.from(groups.values());
    for (const cnt of counts) {
      if (cnt >= 4) types += 1;
      else if (cnt === 3) types += 1;
      else if (cnt === 2) types += 1;
      else types += 1;
    }

    return Math.max(1, types);
  }

  private tryPlayAll(): Card[] | null {
    const hand = getHandType(this.cards, this.level);
    if (hand) return [...this.cards];
    return null;
  }

  /** 手牌是否全是炸弹？是则出牌只能出炸弹 */
  private areAllCardsBombs(): boolean {
    // ★ 用 handPlan 权威炸弹识别（含逢人配炸弹）
    if (this.cards.length === 0) return false;
    const bombIdxs = this.handPlan.getBombIndices();
    return this.handPlan.groups.every((_, i) => bombIdxs.has(i));
  }

  private countSameRank(rank: Rank): number {
    return this.cards.filter(c => c.rank === rank).length;
  }

  findPairExcluding(exclude: Card[]): Card[] | null {
    const excludeIds = new Set(exclude.map(c => c.id));
    const available = this.cards.filter(c => !excludeIds.has(c.id));
    const pairs: { cards: Card[], disruption: number }[] = [];
    let cur: Card[] = [];
    for (const c of available) {
      const val = getLogicValue(c.rank, this.level);
      if (cur.length === 0 || val === getLogicValue(cur[0].rank, this.level)) {
        cur.push(c);
      } else {
        if (cur.length >= 2) {
          const remaining = cur.length - 2;
          let disruption = 0;
          if (remaining === 1) disruption = 100;
          else if (remaining >= 2 && cur.length >= 4) disruption = 10;
          pairs.push({ cards: cur.slice(0, 2), disruption });
        }
        cur = [c];
      }
    }
    if (cur.length >= 2) {
      const remaining = cur.length - 2;
      let disruption = 0;
      if (remaining === 1) disruption = 100;
      else if (remaining >= 2 && cur.length >= 4) disruption = 10;
      pairs.push({ cards: cur.slice(0, 2), disruption });
    }
    if (pairs.length === 0) return null;
    // ★ 排除会拆炸弹的对子（4+张同rank的对子不能作为配对子，炸弹必须保留）
    const safePairs = pairs.filter(p => {
      const rank = p.cards[0].rank;
      const cnt = this.countSameRank(rank);
      if (rank > Rank.Ace) return false; // ★ 王不能配成三带二的对子（规则不允许，会产生非法跟牌）
      return cnt < 4; // 4+张是炸弹，不拆
    });
    // 回退路径也绝不能拆炸弹：没有安全对子就返回 null（宁可不出三带二也不破坏炸弹）
    if (safePairs.length === 0) return null;
    const candidates = safePairs;
    candidates.sort((a, b) => {
      if (a.disruption !== b.disruption) return a.disruption - b.disruption;
      return getLogicValue(a.cards[0].rank, this.level) - getLogicValue(b.cards[0].rank, this.level);
    });
    return candidates[0].cards;
  }

  private findPairExcludingByRank(exclude: Card[], groups: Map<number, Card[]>): Card[] | null {
    const excludeIds = new Set(exclude.map(c => c.id));
    const candidates: { cards: Card[], disruption: number }[] = [];
    for (const [r, cs] of groups) {
      if (r < 2 || r > 16) continue;
      const available = cs.filter(c => !excludeIds.has(c.id));
      if (available.length < 2) continue;
      const remaining = available.length - 2;
      let disruption = 0;
      if (remaining === 1) disruption = 100;
      else if (remaining >= 2 && cs.length >= 4) disruption = 10;
      candidates.push({ cards: available.slice(0, 2), disruption });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      if (a.disruption !== b.disruption) return a.disruption - b.disruption;
      return getLogicValue(a.cards[0].rank, this.level) - getLogicValue(b.cards[0].rank, this.level);
    });
    return candidates[0].cards;
  }

  getGroups(size: number): Card[][] {
    const groups: Card[][] = [];
    let current: Card[] = [];
    for (const card of this.cards) {
      const val = getLogicValue(card.rank, this.level);
      if (current.length === 0 || val === getLogicValue(current[0].rank, this.level)) {
        current.push(card);
      } else {
        if (current.length >= size) groups.push(current.slice(0, size));
        current = [card];
      }
    }
    if (current.length >= size) groups.push(current.slice(0, size));
    return groups.reverse();
  }

  getBombs(): { cards: Card[], value: number }[] {
    // ★ 纯炸弹 + 逢人配炸弹（不含同花顺，同花顺由 findStraightFlushes 单独处理）
    //    - 4+张纯同rank → 完整炸弹
    //    - 3张同rank + 1张万能牌(红桃级牌) → 逢人配炸弹
    const rankGroups = new Map<number, Card[]>();
    const wilds: Card[] = [];
    for (const c of this.cards) {
      if (c.isWild) { wilds.push(c); continue; }
      if (!rankGroups.has(c.rank)) rankGroups.set(c.rank, []);
      rankGroups.get(c.rank)!.push(c);
    }
    const bombs: { cards: Card[], value: number }[] = [];
    const usedWildIds = new Set<string>();
    // ★ 张数多的 rank 先处理：优先把"最像炸弹的那组"升成大炸
    const sortedRanks = Array.from(rankGroups.entries()).sort((a, b) => b[1].length - a[1].length);
    for (const [rank, cs] of sortedRanks) {
      if (cs.length >= 4) {
        // 基础 4 张炸
        bombs.push({ cards: [...cs], value: getLogicValue(rank, this.level) });
        // ★ 修复：4张同rank + 逢人配 = 5张/6张炸，旧实现完全没这条，
        //   手里 4444+级牌★ 只会出 4 张炸，被对面 5 炸/6 炸压死。
        //   基础炸与大炸都登记（共用同一张万能牌只是"二选一的打法"）：
        //   排序后基础炸在前(便宜)、大炸在后(强)，压小牌用便宜的，压大炸才用大的。
        const upgraded = [...cs];
        for (const w of wilds) {
          if (usedWildIds.has(w.id) || upgraded.length >= 6) break;
          const next = [...upgraded, w];
          const h = getHandType(next, this.level);
          if (!h || h.type !== HandType.Bomb) break;
          upgraded.push(w);
          usedWildIds.add(w.id);
          bombs.push({ cards: [...upgraded], value: getLogicValue(rank, this.level) });
        }
      } else if (cs.length === 3 && wilds.some(w => !usedWildIds.has(w.id))) {
        // 3张同rank + 万能牌 = 4张炸弹（逢人配）
        const w = wilds.find(ww => !usedWildIds.has(ww.id))!;
        const cards = [...cs, w];
        const h = getHandType(cards, this.level);
        if (h && h.type === HandType.Bomb) {
          usedWildIds.add(w.id);
          bombs.push({ cards, value: getLogicValue(rank, this.level) });
        }
      }
    }
    // ★ 不做"2张同rank + 2张万能牌 = 4炸"：两张逢人配换一个 4 炸太亏，
    //   逢人配留在手里补同花顺/凑顺子/压大牌的收益更高。
    // ★ 修复：按"炸弹强度"排序（张数优先、点数次要）——压非炸弹时应选最弱的炸
    //   （出小留大，留强炸收尾/反压）。原来按 rank 逻辑值排序，级牌炸(6★×4 value19)
    //   反被排到 5张10(value10) 之后，导致 BOT2 用 5张10 大炸压对子、4张6★ 小炸
    //   留最后（BOT2 先出5个10再出4个6 事故）。张数越多炸越强，应排在后面。
    bombs.sort((a, b) => (a.cards.length !== b.cards.length ? a.cards.length - b.cards.length : a.value - b.value));
    return bombs;
  }
}

interface Candidate {
  cards: Card[];
  remainingTypes: number;
  score: number;
  controlScore?: number;
}