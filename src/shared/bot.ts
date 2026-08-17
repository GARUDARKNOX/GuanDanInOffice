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
    const sfGroups = this.extractPureStraightFlushes(remaining);
    for (const g of sfGroups) {
      bombGroups.push(g);
    }

    // 1.6 万能牌优先配同花顺和炸弹（逢人配不浪费在散牌上）
    const wildGroups = this.extractWildCardBombs(remaining, level);
    for (const g of wildGroups) {
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

    // 5. 后处理：评估拆炸弹能否减少手数
    this.optimizeByUnbombing(level);

    // 6. 后处理：交换优化（尝试交换相邻组的牌看手数是否减少）
    this.optimizeBySwapping(level);
  }

  /**
   * 交换优化：尝试把两个非炸弹组的牌互换，看总手数是否减少。
   * 只尝试同张数或相近的组，避免组合爆炸。
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
          // 只尝试5张组之间或3张组之间的交换
          if (ga.cards.length !== gb.cards.length) continue;
          if (ga.cards.length > 5) continue;
          // 合并两组牌重新分组
          const combined = [...ga.cards, ...gb.cards];
          const newGroups = this.regroupSubsets(combined, level);
          if (newGroups.length < 2) continue;
          // 只有新手数更少才采用
          if (newGroups.length < 2) continue;
          const oldHandCount = 2; // 原来就是2组
          if (newGroups.length < oldHandCount) {
            // 检查新方案不能把级牌配进连对/顺子
            let badPlan = false;
            for (const ng of newGroups) {
              const h = getHandType(ng.cards, level);
              if (!h) continue;
              if (h.type === HandType.Tube || h.type === HandType.Straight) {
                if (ng.cards.some(c => c.rank === level)) {
                  badPlan = true;
                  break;
                }
              }
            }
            if (badPlan) continue;
            // 用新组替换
            this.groups.splice(ib, 1);
            this.groups.splice(ia, 1);
            for (const ng of newGroups.reverse()) {
              this.groups.splice(ia, 0, ng);
            }
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
  }

  /** 对一组牌尝试找最优2组拆分 */
  private regroupSubsets(cards: Card[], level: number): { cards: Card[]; type: HandType; value: number }[] {
    // 尝试所有可能的同类型拆分
    const result = this.findBestTwoGroups(cards, level);
    return result;
  }

  /** 尝试把牌分成2组，返回最优方案 */
  private findBestTwoGroups(cards: Card[], level: number): { cards: Card[]; type: HandType; value: number }[] {
    // 简化：直接用 generateCandidates 找最大的两组
    const candidates = this.generateCandidates(cards, level);
    if (candidates.length === 0) return [{ cards, type: HandType.Single, value: 0 }];

    // 找评分最高的候选
    let bestFirst = candidates[0];
    let bestScore = -999;
    for (const c of candidates) {
      const s = this.scoreGroup(c, cards, level);
      if (s > bestScore) { bestScore = s; bestFirst = c; }
    }

    // 剩余牌
    const remaining = cards.filter(c => !bestFirst.cards.some(bc => bc.id === c.id));
    if (remaining.length === 0) return [bestFirst];

    // 对剩余牌再找一组
    const subCandidates = this.generateCandidates(remaining, level);
    if (subCandidates.length === 0) {
      // 剩余全当单张
      return [bestFirst, ...remaining.map(c => ({ cards: [c], type: HandType.Single, value: getLogicValue(c.rank, level) }))];
    }
    let bestSecond = subCandidates[0];
    let bestScore2 = -999;
    for (const c of subCandidates) {
      const s = this.scoreGroup(c, remaining, level);
      if (s > bestScore2) { bestScore2 = s; bestSecond = c; }
    }
    const remaining2 = remaining.filter(c => !bestSecond.cards.some(bc => bc.id === c.id));
    const result = [bestFirst, bestSecond];
    for (const c of remaining2) {
      result.push({ cards: [c], type: HandType.Single, value: getLogicValue(c.rank, level) });
    }
    return result;
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
        // 拆一个炸后炸弹数-1是可以接受的，但不能-2以上
        if (oldBombCount - newBombCount <= 1) {
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
    const sfGroups = this.extractPureStraightFlushes(remaining);
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
  private extractPureStraightFlushes(remaining: Card[]): { cards: Card[]; type: HandType; value: number }[] {
    const result: { cards: Card[]; type: HandType; value: number }[] = [];
    const usedIds = new Set<string>();

    for (const s of [Suit.Spades, Suit.Hearts, Suit.Clubs, Suit.Diamonds]) {
      // 取该花色未使用的非万能牌，按rank降序
      const suitCards = remaining
        .filter(c => c.suit === s && !c.isWild && c.rank <= Rank.Ace && !usedIds.has(c.id))
        .sort((a, b) => b.rank - a.rank);

      // 滑动窗口找连续5张
      for (let i = 0; i <= suitCards.length - 5; i++) {
        const window = suitCards.slice(i, i + 5);
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
      const ace = remaining.find(c => c.suit === s && c.rank === 14 && !usedIds.has(c.id));
      if (ace) {
        const low = [2, 3, 4, 5].map(r =>
          remaining.find(c => c.suit === s && c.rank === r && !usedIds.has(c.id))
        );
        if (low.every(c => c)) {
          const wheel = [ace, ...low] as Card[];
          result.push({ cards: wheel, type: HandType.StraightFlush, value: 5 });
          wheel.forEach(c => usedIds.add(c.id));
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

        // 尝试在前后补一张万能牌组成5张同花顺
        const wCard = wilds()[0];
        const candidates = [wCard, wCard]; // 只试一个万能牌
        for (const wc of candidates) {
          const five = [...w, wc];
          const hand = getHandType(five, level);
          if (hand && hand.type === HandType.StraightFlush) {
            result.push({ cards: five, type: HandType.StraightFlush, value: hand.value });
            five.forEach(c => usedIds.add(c.id));
            break;
          }
        }
      }

      // 也试 A-2-3-4 + 万能牌
      if (wilds().length > 0) {
        const lowRanks = [2, 3, 4];
        const lowCards = lowRanks.map(r =>
          remaining.find(c => c.suit === s && c.rank === r && !usedIds.has(c.id))
        );
        const ace = remaining.find(c => c.suit === s && c.rank === 14 && !usedIds.has(c.id));
        if (lowCards.every(c => c) && ace && wilds().length > 0) {
          const five = [ace, ...lowCards, wilds()[0]] as Card[];
          const hand = getHandType(five, level);
          if (hand && hand.type === HandType.StraightFlush) {
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

    // 三条：只从严格3张的rank取
    for (const [r, cs] of g) {
      if (r < 2 || r > 14 || cs.length !== 3) continue; // 严格3张
      const trip = cs.slice(0, 3);
      const hand = getHandType(trip, level);
      if (hand && hand.type === HandType.Trips) {
        result.push({ cards: trip, type: HandType.Trips, value: hand.value });
      }
    }

    // 对子：只从严格2张的rank取（不拆3张的三条、不拆4+炸）
    for (const [r, cs] of g) {
      if (r < 2 || r > 14 || cs.length !== 2) continue;
      const pair = cs.slice(0, 2);
      result.push({ cards: pair, type: HandType.Pair, value: getLogicValue(pair[0].rank, level) });
    }

    // 单张：只从严格1张的rank取（不拆对子/三条/炸弹）
    for (const c of cards) {
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

    // 连对/钢板（Tube）：3个连续对子，排除级牌（级牌留作控制牌）
    const tubeStarts = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]; // 不含2(级牌)和14(A-2-3轮子)
    for (const start of tubeStarts) {
      const ranks = [start, start + 1, start + 2];
      // 跳过包含级牌的窗口
      if (ranks.includes(level)) continue;
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

  /** 评分函数：分值=牌数×10 + 类型分 + 价值/5 + 剩余整合度奖励 - 剩余手数惩罚 */
  private scoreGroup(grp: { cards: Card[]; type: HandType; value: number; bombCount?: number }, remaining: Card[], level: number): number {
    let score = grp.cards.length * 10;
    switch (grp.type) {
      case HandType.TripsWithPair: score += 25; break;
      case HandType.Trips:         score += 12; break;
      case HandType.Tube:          score += 15; break;
      case HandType.Straight:      score += 28; break; // 顺子优先级最高，5张变1轮
      case HandType.Plate:         score += 20; break;
      case HandType.Pair:          score += 5;  break;
      case HandType.Single:        score += 0;  break;
      case HandType.Bomb:          score += 0;  break;
    }
    score += grp.value / 5;
    // 三带二：对子价值高于三条价值时扣分（大的对子不该拿来配三带二）
    if (grp.type === HandType.TripsWithPair) {
      const pairRank = grp.cards[3].rank;
      const pairVal = getLogicValue(pairRank, level);
      const tripVal = grp.value;
      // 大对子配小三张扣分，小三张配大对子更扣分
      if (pairVal > tripVal) score -= 15; // 大对子配小三张
      // 级牌不当对子已在候选生成时跳过
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
    const estimatedHands = this.estimateHands(after);
    score -= estimatedHands * 3;
    return score;
  }

  /** 粗略估计剩余牌需要几手出完 */
  private estimateHands(cards: Card[]): number {
    if (cards.length === 0) return 0;
    const g = this.groupCards(cards);
    let hands = 0;
    for (const [, cs] of g) {
      if (cs.length >= 4) { hands++; continue; } // 炸弹
      if (cs.length === 3) { hands++; continue; } // 三条
      if (cs.length === 2) { hands++; continue; } // 对子
      if (cs.length === 1) { hands++; continue; } // 单张
    }
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
  }

  private isAlly(idx: number): boolean {
    if (this.isThreePlayer) return false;
    return idx >= 0 && idx % 2 === this.seatIndex % 2;
  }

  private partnerIdx(): number {
    return (this.seatIndex + 2) % 4;
  }

  /** 对手（非我、非队友）可能持有的某rank剩余数 = 总剩余 - 我手里的 - 队友手里的 */
  private getEnemyRemaining(rank: number): number {
    if (!this.tracker) return 0;
    let mine = this.cards.filter(c => c.rank === rank).length;
    let totalRem = this.tracker.getRemaining(rank);
    return Math.max(0, totalRem - mine);
  }

  /** 对手可能持有的炸弹数（已减掉我手里的牌） */
  private countEnemyPotentialBombs(): number {
    if (!this.tracker) return 0;
    let count = 0;
    for (let r = 2; r <= 16; r++) {
      const rem = this.getEnemyRemaining(r);
      if (rem >= 6) count += 2;
      else if (rem >= 4) count += 1;
    }
    return count;
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

  // ==================== 自由出牌（控制发牌权） ====================

  private decideFreePlay(): Card[] {
    // 能一把走完
    const allOut = this.tryPlayAll();
    if (allOut) return allOut;

    // === 终局保护：下家敌人剩1张 -> 绝对不出单张 ===
    if (this.nextEnemyHasOne() && this.cards.length > 1) {
      const nonSingle = this.findBestNonSingle();
      if (nonSingle) return nonSingle;
      return this.playBiggestSingle();
    }

    // === 队友快走牌(≤5张) -> 送队友需要的牌型 ===
    if (this.allyNearOut()) {
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
            return remainingCards; // 先出非炸弹手牌，炸弹保底
          }
          // 剩余牌不是一手（多张散牌）-> 更不该先出炸弹，交给下面的散牌逻辑
        }
      }
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
    // 对手某个rank出完了，出这个rank的单张/对子绝对安全
    if (this.tracker) {
      // 找"绝对控制牌"：某个rank已出完，且它上面所有rank也基本出完 -> 这手牌无人能压（除炸弹）
      // 例：外面K、A、级牌、王都出完了，我的K就是单张/对子霸王
      for (const g of nonBombGroups) {
        const hand = getHandType(g.cards, this.level);
        if (!hand) continue;
        if (hand.type === HandType.Single || hand.type === HandType.Pair) {
          const cardRank = g.cards[0].rank;
          if (this.tracker.isRankExhausted(cardRank)) {
            if (this.canPlay(g.cards)) return g.cards;
          }
        }
      }
      // 扩展：三条/三带二的"张"部分如果rank已出完也安全
      for (const g of nonBombGroups) {
        const hand = getHandType(g.cards, this.level);
        if (!hand) continue;
        if (hand.type === HandType.Trips || hand.type === HandType.TripsWithPair) {
          const cardRank = g.cards[0].rank;
          if (this.tracker.isRankExhausted(cardRank)) {
            if (this.canPlay(g.cards)) return g.cards;
          }
        }
      }
    }

    // 1. 找有大小两组的同类型 -> 出小的，大的留着收回
    for (const [type, groups] of typeMap) {
      if (groups.length >= 2) {
        groups.sort((a, b) => a.value - b.value);
        const small = groups[0];
        if (this.canPlay(small.cards)) return small.cards;
      }
    }

    // 2. 单张：大牌留着收回，出小牌探路
    // 大小王不轻易出，留着控制；2张王时保持成对（天王炸潜力）
    const mySingles = nonBombGroups.filter(g => {
      const h = getHandType(g.cards, this.level);
      return h && h.type === HandType.Single;
    });

    // tracker驱动：对手双大王/大小王都有 → 避免出单张送控制权
    if (this.tracker) {
      const bjRem = this.getEnemyRemaining(Rank.BigJoker);
      const sjRem = this.getEnemyRemaining(Rank.SmallJoker);
      // 对手还有双大王，或一大一小 → 出单张会被对手拿控制权
      if (bjRem >= 2 || (bjRem >= 1 && sjRem >= 1)) {
        const nonSingle = this.findBestNonSingle();
        if (nonSingle) return nonSingle;
      }
      // 对手大王小王都出完了 → 单张不再有王能压，正常走小牌优先逻辑即可
    }

    if (mySingles.length > 0) {
      // 统计大小王数量，如果有2+张王，保持成对不拆
      const jokerCount = this.cards.filter(c => c.rank === Rank.SmallJoker || c.rank === Rank.BigJoker).length;
      const keepJokers = jokerCount >= 2; // 2张王保持成对

      // ★ 按从小到大排序：先出小牌探路，大牌留着控制
      const sortedSingles = mySingles.sort((a, b) => {
        const va = getLogicValue(a.cards[0].rank, this.level);
        const vb = getLogicValue(b.cards[0].rank, this.level);
        return va - vb; // 升序：小到大
      });
      // 第一轮：出小牌探路（跳过大小王等控制牌）
      for (const s of sortedSingles) {
        const c = s.cards[0];
        const val = getLogicValue(c.rank, this.level);
        // 大小王是控制牌，留着
        if (c.rank === Rank.BigJoker || c.rank === Rank.SmallJoker) {
          if (myCards > 3 && (keepJokers || myCards > 4)) continue;
        }
        // 只剩2张单张时A留着控制
        if (val >= 14 && mySingles.length <= 2) continue;
        if (this.canPlay(s.cards)) return s.cards;
      }
      // 第二轮：实在没有小牌了，出最小的非王
      for (const s of sortedSingles) {
        const c = s.cards[0];
        if (c.rank === Rank.BigJoker || c.rank === Rank.SmallJoker) {
          if (myCards <= 3 && !keepJokers) return s.cards;
          continue;
        }
        if (this.canPlay(s.cards)) return s.cards;
      }
      // 最后才出王（极小牌数兜底）
      return sortedSingles[0].cards;
    }

    // 3. 对子：出最小的
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

    // 4. 三带二：小的三张配小的对子
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

    // 5. 顺子/连对
    const mySequences = nonBombGroups.filter(g => {
      const h = getHandType(g.cards, this.level);
      return h && (h.type === HandType.Straight || h.type === HandType.Tube);
    });
    if (mySequences.length > 0) {
      mySequences.sort((a, b) => {
        const ha = getHandType(a.cards, this.level);
        const hb = getHandType(b.cards, this.level);
        return (ha?.value || 0) - (hb?.value || 0);
      });
      if (this.canPlay(mySequences[0].cards)) return mySequences[0].cards;
    }

    // 6. 最后出最小单张（排除大小王）
    for (const g of nonBombGroups) {
      const h = getHandType(g.cards, this.level);
      if (h && h.type === HandType.Single && this.canPlay(g.cards)) {
        const c = g.cards[0];
        if (c.rank === Rank.BigJoker || c.rank === Rank.SmallJoker) {
          if (myCards > 3) continue; // 留着控制
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
      // 队友出最后一手走牌 -> 不压
      if (this.handsInfo[partner] <= target.cards.length) return null;

      // 队友出炸弹/同花顺/天王炸 -> 绝对不压（不能炸队友）
      const targetIsBomb = target.type === HandType.Bomb || target.type === HandType.StraightFlush || target.type === HandType.FourKings;
      if (targetIsBomb) return null;

      // 队友出中小牌(value≤13) -> 顺牌过，帮队友抬牌
      if (target.value <= 13) {
        const beats = this.findAllBeatsPreservingPlan(target);
        if (beats.length > 0) {
          return this.pickSmallestBeat(beats, target);
        }
      }

      // 队友快走牌(≤5张) -> 用最小牌压，减少对手接牌机会
      if (this.handsInfo[partner] <= 5) {
        const beats = this.findAllBeatsPreservingPlan(target);
        if (beats.length > 0) {
          return this.pickSmallestBeat(beats, target);
        }
        // 拆牌也要压
        const allBeats = this.findAllBeats(target);
        if (allBeats.length > 0) {
          return this.pickSmallestBeat(allBeats, target);
        }
      }

      // 队友牌多且打大牌(value>13) -> 不压，让队友继续出
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

    // 枪不打四：对家剩4张，不是炸弹就不炸
    // 对家剩8张：不炸（三套牌炸不完）
    // 这些在 decideBomb 里处理，这里跳过

    // 下家敌人濒临走牌 -> 阻断优先级高
    const needBlock = !isAllyNext && nextCards <= 7;
    const blockUrgency = needBlock ? (nextCards <= 2 ? 3 : nextCards <= 5 ? 2 : 1) : 0;

    // 上家出牌：后面是队友（对门），可以大胆跟
    // 下家出牌：后面是敌人，要考虑封锁
    // 逢五出对：下家敌人剩5张时，优先出对子封锁
    if (isLowerEnemy && nextCards === 5 && target.type !== HandType.Pair) {
      // 不接非对子，等下家出对子时再压
    }

    // 先看规划组
    const planBeat = this.findPlanBeat(target);
    if (planBeat) return planBeat;

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
        // 炸后剩余≤3张散牌 -> 也值得炸
        if (remainingAfterBomb > 0 && remainingAfterBomb <= 3) {
          return bomb;
        }
      }
    }

    // 再看规划感知跟牌（不拆规划组）
    const preservingBeats = this.findAllBeatsPreservingPlan(target);
    if (preservingBeats.length > 0) {
      if (blockUrgency > 0) {
        return this.pickBestFollowBeat(preservingBeats, target);
      }
      // 上家出牌+后面是队友 -> 大胆出最小牌跟
      if (isUpperEnemy && isAllyNext) {
        return this.pickSmallestBeat(preservingBeats, target);
      }
      return this.pickSmallestBeat(preservingBeats, target);
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
            if (groupSize >= 4) continue; // 炸弹绝对不拆出单张
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
    const partnerCards = this.handsInfo[this.partnerIdx()];

    // 队友已头游走掉（剩0张）-> 我方已保头游，不轻易浪费炸弹（仅4人模式有队友）
    // 只需快速出小牌抢二游/避免末游，炸弹留到濒临走牌时才用
    if (!this.isThreePlayer && partnerCards === 0) {
      // 只有自己濒临走牌（能靠炸收尾，≤5张且有炸）才炸，否则省炸
      if (myCards > 5) return null;
      if (this.areAllCardsBombs()) return this.findBomb(target);
      if (this.countMyBombs() >= 1) return this.findBomb(target);
      return null;
    }

    // 枪不打四：对家剩4张，不是炸弹就不炸
    if (enemyCards === 4 && !isBomb) return null;

    // 对家剩5张 -> 必须炸（可能是三带二或顺子），但联盟剩5张不炸
    if (enemyCards === 5 && !isBomb && !this.isAlly(lastPlayerIndex)) return this.findBomb(target);

    // 对家剩7张 -> 必须炸（可能是两套牌），但联盟剩7张不炸
    if (enemyCards === 7 && !isBomb && !this.isAlly(lastPlayerIndex)) return this.findBomb(target);

    // 对家剩8张 -> 不炸（三套牌炸不完）
    if (enemyCards === 8 && !isBomb) return null;

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

    // 自己剩>15张 → 不浪费炸弹
    if (myCards > 15) return null;

    // ★ 记忆增强：根据对手可能炸弹数调整是否值得炸
    if (this.tracker) {
      const oppBombThreat = this.countEnemyPotentialBombs();
      // 对手炸弹威胁大(≥3) -> 保守，避免炸完被反炸
      if (oppBombThreat >= 3 && myCards > 8 && !isBomb) return null;
      // 对手炸弹威胁小(0) -> 更敢炸（外面几乎没有炸弹能压我）
      if (oppBombThreat === 0 && !isBomb) {
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
            if (groupSize >= 4) continue; // 炸弹绝对不拆
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
            if (groupSize >= 4) continue; // 炸弹绝对不拆
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

  /** 手牌是否全是炸弹？是则出牌只能出炸弹 */
  private areAllCardsBombs(): boolean {
    const groups = this.groupByRawRank();
    for (const [, cs] of groups) {
      if (cs.length < 4) return false;
    }
    return this.cards.length > 0;
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
    // 按 rank 分组，取全部4+张作为完整炸弹（不拆5+为4+1）
    const rankGroups = new Map<number, Card[]>();
    for (const c of this.cards) {
      if (!rankGroups.has(c.rank)) rankGroups.set(c.rank, []);
      rankGroups.get(c.rank)!.push(c);
    }
    const bombs: { cards: Card[], value: number }[] = [];
    for (const [rank, cs] of rankGroups) {
      if (cs.length >= 4) {
        bombs.push({ cards: [...cs], value: getLogicValue(rank, this.level) });
      }
    }
    bombs.sort((a, b) => a.value - b.value);
    return bombs;
  }
}

interface Candidate {
  cards: Card[];
  remainingTypes: number;
  score: number;
  controlScore?: number;
}