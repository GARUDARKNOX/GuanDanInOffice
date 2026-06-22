import { getHandType, getAllPossibleHandTypes, compareHands, sortCards, getLogicValue, isConsecutive } from './rules';
import { Rank, Card, Hand, HandType, Suit } from './types';

// ---- 全局牌追踪器（108张牌，两副标准扑克） ----

/* ... CardTracker class ... */
const TOTAL_PER_RANK: { [rank: number]: number } = {};
for (let r = 2; r <= 14; r++) TOTAL_PER_RANK[r] = 8;
TOTAL_PER_RANK[15] = 4;
TOTAL_PER_RANK[16] = 4;

export class CardTracker {
  private playedByRank: Map<number, number> = new Map();
  private totalPlayed: number = 0;

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

  recordPlay(cards: Card[]) {
    for (const c of cards) this.record(c);
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

  constructor(cards: Card[], level: number) {
    this.build(cards, level);
  }

  private build(cards: Card[], level: number) {
    const remaining = [...cards];
    this.groups = [];
    this.bombIndices.clear();

    // 1. 提取4+同rank真炸弹（排除级牌，级牌留给plan做配牌）
    const groups = this.groupCards(remaining);
    const bombGroups: { cards: Card[]; type: HandType; value: number }[] = [];
    for (const [r, cs] of groups) {
      if (r === level || r === Rank.SmallJoker || r === Rank.BigJoker) continue;
      if (cs.length >= 4) {
        const bombCards = cs.slice(0, 4);
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

    // 1.5 万能牌优先配同花顺和炸弹（逢人配不浪费在散牌上）
    const wildBombGroups = this.extractWildBombsAndSFs(remaining, level);
    for (const g of wildBombGroups) {
      bombGroups.push(g);
    }

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
   * 万能牌优先配同花顺和炸弹。
   * 同花顺 > 炸弹（掼蛋中同花顺压炸弹），所以先配同花顺，再配炸弹。
   * 提取后从 remaining 移除，防止万能牌被散顺子/连对消耗。
   */
  private extractWildBombsAndSFs(remaining: Card[], level: number): { cards: Card[]; type: HandType; value: number }[] {
    const result: { cards: Card[]; type: HandType; value: number }[] = [];
    const usedCardIds = new Set<string>();
    const availWilds = () => remaining.filter(c => c.isWild && !usedCardIds.has(c.id));

    // 1. 同花顺优先（纯同花顺 + 万能牌补缺）
    for (const s of [Suit.Spades, Suit.Hearts, Suit.Clubs, Suit.Diamonds]) {
      const starts = [2, 3, 4, 5, 6, 7, 8, 9, 10, 14]; // 14 = A-2-3-4-5 轮子
      for (const start of starts) {
        const ranks = start === 14 ? [14, 2, 3, 4, 5] : [start, start + 1, start + 2, start + 3, start + 4];
        const found: Card[] = [];
        const missing: number[] = [];
        for (const r of ranks) {
          const c = remaining.find(card =>
            card.suit === s && !card.isWild && card.rank === r && !usedCardIds.has(card.id)
          );
          if (c) found.push(c);
          else missing.push(r);
        }
        if (missing.length === 0) {
          // 纯同花顺
          const hand = getHandType(found, level);
          if (hand && hand.type === HandType.StraightFlush) {
            result.push({ cards: found, type: HandType.StraightFlush, value: hand.value });
            found.forEach(c => usedCardIds.add(c.id));
          }
        } else if (missing.length <= availWilds().length) {
          // 万能牌补缺
          const ws = availWilds().slice(0, missing.length);
          const cards = [...found, ...ws];
          const hand = getHandType(cards, level);
          if (hand && hand.type === HandType.StraightFlush) {
            result.push({ cards, type: HandType.StraightFlush, value: hand.value });
            cards.forEach(c => usedCardIds.add(c.id));
          }
        }
      }
    }

    // 2. 炸弹：3张同rank（非万能）+ 万能牌
    const g = this.groupCards(remaining.filter(c => !usedCardIds.has(c.id)));
    for (const [r, cs] of g) {
      if (r === level || r === Rank.SmallJoker || r === Rank.BigJoker) continue;
      if (r < 2 || r > 14) continue;
      const normals = cs.filter(c => !c.isWild);
      if (normals.length >= 3 && availWilds().length > 0) {
        const bombCards = [...normals.slice(0, 3), availWilds()[0]];
        const hand = getHandType(bombCards, level);
        if (hand && hand.type === HandType.Bomb) {
          result.push({ cards: bombCards, type: HandType.Bomb, value: hand.value });
          bombCards.forEach(c => usedCardIds.add(c.id));
        }
      }
    }

    this.removeCards(remaining, Array.from(usedCardIds));
    return result;
  }

  private findBestGroup(cards: Card[], level: number): { cards: Card[]; type: HandType; value: number } | null {
    if (cards.length === 0) return null;
    const candidates = this.generateCandidates(cards, level);
    if (candidates.length === 0) return null;

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

    // 三带二：每条三条配每个可用纯对子（评分选最优，避免拆三条组）
    for (const [r, cs] of g) {
      if (r < 2 || r > 14 || cs.length < 3) continue;
      const trip = cs.slice(0, 3);
      for (const [pr, pcs] of g) {
        if (pr === r || pr < 2 || pr > 14 || pcs.length < 2) continue;
        const pair = pcs.slice(0, 2);
        const combined = [...trip, ...pair];
        const hand = getHandType(combined, level);
        if (hand && hand.type === HandType.TripsWithPair) {
          result.push({ cards: combined, type: HandType.TripsWithPair, value: hand.value });
        }
      }
    }

    // 三条
    for (const [r, cs] of g) {
      if (r < 2 || r > 14 || cs.length < 3) continue;
      const trip = cs.slice(0, 3);
      const hand = getHandType(trip, level);
      if (hand && hand.type === HandType.Trips) {
        result.push({ cards: trip, type: HandType.Trips, value: hand.value });
      }
    }

    // 对子
    for (const [r, cs] of g) {
      if (r < 2 || r > 14 || cs.length < 2) continue;
      const pair = cs.slice(0, 2);
      result.push({ cards: pair, type: HandType.Pair, value: getLogicValue(pair[0].rank, level) });
    }

    // 单张
    for (const c of cards) {
      if (c.rank >= 2 && c.rank <= 16) {
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

    // 连对/钢板（Tube）：3个连续对子，支持逢人配补对子
    const tubeStarts = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14];
    for (const start of tubeStarts) {
      const ranks = start === 14 ? [14, 2, 3] : [start, start + 1, start + 2];
      const tubeCards: Card[] = [];
      let wildUsed = 0;
      let valid = true;
      for (const r of ranks) {
        const normals = (g.get(r) || []).filter(c => !c.isWild).slice(0, 2);
        tubeCards.push(...normals);
        const need = 2 - normals.length;
        if (wildUsed + need > wilds.length) { valid = false; break; }
        for (let i = 0; i < need; i++) tubeCards.push(wilds[wildUsed++]);
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

  /** 评分函数：分值=牌数×10 + 类型分 + 价值/5 + 剩余整合度奖励 */
  private scoreGroup(grp: { cards: Card[]; type: HandType; value: number; bombCount?: number }, remaining: Card[], level: number): number {
    let score = grp.cards.length * 10;
    switch (grp.type) {
      case HandType.TripsWithPair: score += 25; break;
      case HandType.Trips:         score += 15; break;
      case HandType.Tube:          score += 18; break;
      case HandType.Straight:      score += 12; break;
      case HandType.Pair:          score += 5;  break;
      case HandType.Single:        score += 0;  break;
      case HandType.Bomb:          score += 0;  break; // 炸弹靠value和卡牌数量自然排在后面
    }
    // 大牌优先（自由出牌时强组更适合开局）
    score += grp.value / 5;
    // 惩罚：三带二若对子来源于三条组（拆了三条），扣分减少散牌
    if (grp.type === HandType.TripsWithPair) {
      const pairRank = grp.cards[3].rank;
      const pairCnt = remaining.filter(c => c.rank === pairRank).length;
      if (pairCnt === 3) score -= 12;
    }
    // 出完这组后剩余牌还能组更多三条 => 加分
    const after = remaining.filter(c => !grp.cards.some(gc => gc.id === c.id));
    const ag = this.groupCards(after);
    let tripsLeft = 0;
    for (const [, cs] of ag) if (cs.length >= 3) tripsLeft++;
    score += tripsLeft * 2;
    return score;
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
    bombGroups.sort((a, b) => b.value - a.value);

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

  constructor(cards: Card[], level: number, seatIndex: number = 0, handsInfo: number[] = [0,0,0,0], tracker?: CardTracker) {
    this.cards = sortCards(cards, level);
    this.level = level;
    this.seatIndex = seatIndex;
    this.handsInfo = handsInfo;
    this.tracker = tracker || new CardTracker();
    this.handPlan = new HandPlan(this.cards, this.level);
  }

  private isAlly(idx: number): boolean {
    return idx >= 0 && idx % 2 === this.seatIndex % 2;
  }

  private partnerIdx(): number {
    return (this.seatIndex + 2) % 4;
  }

  /** 当前游戏阶段 */
  private getPhase(): 'opening' | 'mid' | 'endgame' {
    if (this.cards.length > 20) return 'opening';
    if (this.cards.length <= 10) return 'endgame';
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

  /** 联盟是否濒临走牌（≤3张或已走） */
  private allyNearOut(): boolean {
    const p = this.partnerIdx();
    return this.handsInfo[p] <= 3;
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
    return Math.min(100, Math.max(0, score));
  }

  private getRole(): 'attacker' | 'supporter' {
    const strength = this.assessHandStrength();
    const partnerCards = this.handsInfo[this.partnerIdx()];
    if (strength >= 40) return 'attacker';
    if (strength <= 20) return 'supporter';
    return partnerCards <= 8 ? 'supporter' : 'attacker';
  }

  // ==================== 自由出牌（按规划） ====================

  private decideFreePlay(): Card[] {
    const allOut = this.tryPlayAll();
    if (allOut) return allOut;

    // === 终局保护：下家敌人剩1张 → 绝对不出单张 ===
    if (this.nextEnemyHasOne() && this.cards.length > 1) {
      const nonSingle = this.findBestNonSingle();
      if (nonSingle) return nonSingle;
      return this.playBiggestSingle();
    }

    // === 开局策略（>20张）：情况不明对子先行 ===
    if (this.getPhase() === 'opening' && this.cards.length > 20) {
      const pair = this.findSecondSmallestPair();
      if (pair) return pair;
    }

    // === 助攻角色：主动压小牌，不抢控制权 ===
    if (this.getRole() === 'supporter' && this.cards.length > 10) {
      const smallPlay = this.findSmallPlanPlay();
      if (smallPlay) return smallPlay;
    }

    // === 联盟濒临走牌：出最小安全牌 ===
    if (this.allyNearOut()) {
      const weak = this.findWeakestPlanPlay();
      if (weak) return weak;
    }

    // === 默认：按规划出最小组 ===
    const planned = this.handPlan.getNextFreePlay(this.cards);
    if (planned) return planned;

    return this.decideFreePlayFallback();
  }

  /** 找非单张的最优出牌 */
  private findBestNonSingle(): Card[] | null {
    const groups = this.groupByRawRank();
    // 三带二
    for (const [r, cs] of groups) {
      if (r < 2 || r > 14 || cs.length < 3) continue;
      const trip = cs.slice(0, 3);
      const pair = this.findPairExcluding(trip);
      if (pair) return [...trip, ...pair];
    }
    // 三条
    for (const [r, cs] of groups) {
      if (r < 2 || r > 14 || cs.length >= 3) return cs.slice(0, 3);
    }
    // 对子
    for (const [r, cs] of groups) {
      if (r >= 2 && r <= 14 && cs.length >= 2) return cs.slice(0, 2);
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
      if (cs.length >= 2 && cs[0].rank >= 2 && cs[0].rank <= 14) {
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
    // 试试最小的三带二
    const groups = this.groupByRawRank();
    for (const [r, cs] of groups) {
      if (cs.length >= 3) {
        const trip = cs.slice(0, 3);
        const pair = this.findPairExcluding(trip);
        if (pair) return [...trip, ...pair];
      }
    }
    // 试试最小的三条
    for (const [r, cs] of groups) {
      if (cs.length >= 3) return cs.slice(0, 3);
    }
    // 最小对子
    for (const [r, cs] of groups) {
      if (cs.length >= 2) return cs.slice(0, 2);
    }
    // 最小单张
    return [cards[0]];
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
      // 如果队友出最后一张/一把走牌（头游），不压
      if (this.handsInfo[partner] <= target.cards.length) return null;
      // 送队友：用最小牌压过，让对手更难接
      if (this.handsInfo[partner] <= 2 && this.handsInfo[this.seatIndex] > 2) {
        return this.findWeakBeat(target);
      }
    }
    return null;
  }

  private decideEnemyFollow(target: Hand, lastPlayerIndex: number): Card[] | null {
    const nextSeat = (this.seatIndex + 1) % 4;
    const nextCards = this.handsInfo[nextSeat];
    const needBlock = this.isAlly(nextSeat) ? false : (nextCards > 7 ? false : true);
    const blockUrgency = needBlock ? (nextCards <= 2 ? 3 : nextCards <= 5 ? 2 : 1) : 0;

    // 先看规划组
    const planBeat = this.findPlanBeat(target);
    if (planBeat) return planBeat;

    // 再看规划感知跟牌（不拆规划组）
    const preservingBeats = this.findAllBeatsPreservingPlan(target);
    if (preservingBeats.length > 0) {
      if (blockUrgency > 0) {
        return this.pickBestFollowBeat(preservingBeats, target);
      }
      return this.pickSmallestBeat(preservingBeats, target);
    }

    // 兜底：普通跟牌（允许拆）
    const allBeats = this.findAllBeats(target);
    if (allBeats.length > 0) {
      if (blockUrgency > 0) {
        return this.pickBestFollowBeat(allBeats, target);
      }
      return this.pickSmallestBeat(allBeats, target);
    }

    // 最后才考虑炸弹
    if (blockUrgency >= 2) {
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
      const remaining = this.cardsAfter(cards);
      score -= remaining.length * 0.3;
      return { cards, score };
    });
    scored.sort((a, b) => a.score - b.score);
    return scored[0].cards;
  }

  private pickBestFollowBeat(beats: Card[][], target: Hand): Card[] | null {
    if (beats.length === 0) return null;
    const scored = beats.map(cards => {
      const hand = getHandType(cards, this.level);
      let score = hand ? hand.value : 999;
      const remaining = this.cardsAfter(cards);
      score += remaining.length * 0.3;
      return { cards, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].cards;
  }

  private findAllBeats(target: Hand): Card[][] {
    const result: Card[][] = [];

    switch (target.type) {
      case HandType.Single: {
        for (let i = this.cards.length - 1; i >= 0; i--) {
          const val = getLogicValue(this.cards[i].rank, this.level);
          if (val > target.value) {
            const groupSize = this.countSameRank(this.cards[i].rank);
            if (groupSize >= 4 && this.cards.length > 6) continue;
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
            if (groupSize >= 4 && this.cards.length > 8) continue;
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
            if (groupSize >= 4 && this.cards.length > 10) continue;
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
            if (groupSize >= 4 && this.cards.length > 10) continue;
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
          .filter(([r, cs]) => cs.length >= 2 && r >= 2 && r <= 14)
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
          .filter(([r, cs]) => cs.length >= 3 && r >= 2 && r <= 14)
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

    return result;
  }

  // ---- 炸弹决策（完整矩阵） ----

  private decideBomb(target: Hand, lastPlayerIndex: number): Card[] | null {
    if (this.isAlly(lastPlayerIndex)) return null;

    const isBomb = target.type === HandType.Bomb || target.type === HandType.StraightFlush || target.type === HandType.FourKings;
    const enemyCards = this.handsInfo[lastPlayerIndex];
    const myCards = this.cards.length;

    // 枪不打四：对家剩4张，不是炸弹就不炸
    if (enemyCards === 4 && !isBomb) return null;

    // 对家剩5张 → 必须炸（可能是三带二或顺子）
    if (enemyCards === 5 && !isBomb) return this.findBomb(target);

    // 对家剩7张 → 必须炸（可能是两套牌）
    if (enemyCards === 7 && !isBomb) return this.findBomb(target);

    // 对家剩8张 → 不炸（可能是三套牌，炸不完）
    if (enemyCards === 8 && !isBomb) return null;

    // 对家剩≤3张 → 必须炸（快走了）
    if (enemyCards <= 3) return this.findBomb(target);

    // 自己剩≤5张 → 炸了收尾
    if (myCards <= 5) return this.findBomb(target);

    // 自己剩>15张 → 不浪费炸弹
    if (myCards > 15) return null;

    // 对方打大牌(A/K+级别)且我有至少2个炸弹 → 可以炸一个
    if (target.value >= 14 && !isBomb) {
      if (this.countMyBombs() >= 2) return this.findBomb(target);
    }

    // 炸弹对炸弹：炸回去
    if (isBomb) {
      // 自己牌多且对方牌也多 → 不浪费对炸
      if (myCards > 10 && enemyCards > 5) return null;
      // 否则找更大的炸
      return this.findBomb(target);
    }

    return null;
  }

  private countMyBombs(): number {
    let count = 0;
    const groups = this.groupByRawRank();
    for (const [r, cs] of groups) {
      if (cs.length >= 4) count++;
    }
    const sfs = this.findStraightFlushes();
    count += sfs.length;
    const sj = this.cards.filter(c => c.rank === Rank.SmallJoker);
    const bj = this.cards.filter(c => c.rank === Rank.BigJoker);
    if (sj.length === 2 && bj.length === 2) count++;
    return count;
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
      for (const [, planNeeded] of planGroups) {
        let match = true;
        if (planNeeded.size !== needed.size) continue;
        for (const [key, count] of needed) {
          if (planNeeded.get(key) !== count) { match = false; break; }
        }
        if (match) return true;
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
            if (sameRankCount >= 4 && this.cards.length > 6) continue;
            if (sameRankCount <= 1 || sameRankCount >= 4) {
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
            if (groupSize >= 4 && this.cards.length > 8) continue;
            if (matchesPlan(pair)) result.push(pair);
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
            if (groupSize >= 4 && this.cards.length > 10) continue;
            if (matchesPlan(t)) result.push(t);
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
            if (groupSize >= 4 && this.cards.length > 10) continue;
            const pair = this.findPairExcluding(t);
            if (pair) {
              const combined = [...t, ...pair];
              if (matchesPlan(combined)) result.push(combined);
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
        if (groupSize >= 4 && this.cards.length > 6) continue;
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
        if (groupSize >= 4 && this.cards.length > 8) continue;
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
        if (groupSize >= 4 && this.cards.length > 10) continue;
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
        if (groupSize >= 4 && this.cards.length > 10) continue;
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

  // ---- 炸弹查找 ----

  findBomb(target?: Hand): Card[] | null {
    const sj = this.cards.filter(c => c.rank === Rank.SmallJoker);
    const bj = this.cards.filter(c => c.rank === Rank.BigJoker);
    let kings: Card[] | null = null;
    if (sj.length === 2 && bj.length === 2) kings = [...sj, ...bj];

    const sfs = this.findStraightFlushes();
    const bombs = this.getBombs();

    if (!target) {
      if (bombs.length > 0) return bombs[0].cards;
      if (sfs.length > 0) return sfs[0].cards;
      if (kings) return kings;
      return null;
    }

    const tBomb = target.type === HandType.Bomb;
    const tSF = target.type === HandType.StraightFlush;
    const tKings = target.type === HandType.FourKings;

    if (!tBomb && !tSF && !tKings) {
      if (bombs.length > 0) return bombs[0].cards;
      if (sfs.length > 0) return sfs[0].cards;
      if (kings) return kings;
      return null;
    }

    if (tKings) return null;

    if (tSF) {
      const biggerSF = sfs.find(sf => sf.value > target.value);
      if (biggerSF) return biggerSF.cards;
      if (kings) return kings;
      const bigBomb = bombs.find(b => b.cards.length >= 6);
      if (bigBomb) return bigBomb.cards;
      return null;
    }

    if (tBomb) {
      const tCount = target.bombCount || 4;
      const tVal = target.value;
      for (const b of bombs) {
        if (b.cards.length > tCount) return b.cards;
        if (b.cards.length === tCount && b.value > tVal) return b.cards;
      }
      if (tCount <= 5 && sfs.length > 0) return sfs[0].cards;
      if (kings) return kings;
    }

    return null;
  }

  findStraightFlushes(): { cards: Card[], value: number }[] {
    const sfs: { cards: Card[], value: number }[] = [];
    for (const s of [0, 1, 2, 3]) {
      const suitCards = this.cards.filter(c => c.suit === s && !c.isWild && c.rank <= Rank.Ace);
      suitCards.sort((a, b) => a.rank - b.rank);
      for (let i = 0; i <= suitCards.length - 5; i++) {
        const window = suitCards.slice(i, i + 5);
        if (isConsecutive(window.map(c => c.rank))) {
          sfs.push({ cards: window, value: window[4].rank });
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
    pairs.sort((a, b) => {
      if (a.disruption !== b.disruption) return a.disruption - b.disruption;
      return getLogicValue(a.cards[0].rank, this.level) - getLogicValue(b.cards[0].rank, this.level);
    });
    return pairs[0].cards;
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
    const groups = this.getGroups(4);
    return groups.map(g => ({ cards: g, value: getLogicValue(g[0].rank, this.level) }));
  }
}

interface Candidate {
  cards: Card[];
  remainingTypes: number;
  score: number;
  controlScore?: number;
}