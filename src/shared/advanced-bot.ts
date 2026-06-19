import { Bot } from './bot';
import { Card, HandType, Rank, Hand } from './types';
import { getHandType, getLogicValue } from './rules';

// 严格的出牌验证函数
function validatePlay(cards: Card[], level: number): boolean {
  if (!cards || cards.length === 0) return false;
  const hand = getHandType(cards, level);
  return hand !== null;
}

// 增加缺少的接口
interface StrategyState {
  phase: 'opening' | 'mid' | 'endgame';
  nextEnemyNearFinish: boolean;
  allyNearFinish: boolean;
  selfNearFinish: boolean;
  partnerRemaining: number;
  role: 'attacker' | 'supporter';
  enemyBombPotential: number;
}

// 补上 Bot 高级策略方法
export class AdvancedBot extends Bot {
  private gamePhase: 'opening' | 'mid' | 'endgame';

  constructor(cards: Card[], level: number, seatIndex: number = 0, handsInfo: number[] = [0,0,0,0], tracker?: any) {
    super(cards, level, seatIndex, handsInfo, tracker);
    this.gamePhase = cards.length > 20 ? 'opening' : cards.length <= 10 ? 'endgame' : 'mid';
  }

  // === 概率计算 ===
  
  /** 某 rank 的牌在当前剩余牌中的排名百分位（越大越安全） */
  rankPercentile(rank: number): number {
    const logicVal = getLogicValue(rank, this.level);
    // 计算比这张牌大的牌还剩多少张
    let biggerRemaining = 0;
    let totalRemaining = 0;
    for (let r = 3; r <= 16; r++) {
      const rVal = getLogicValue(r as Rank, this.level);
      if (rVal <= 2) continue; // skip 2 (level card)
      const rem = this.tracker.getRemaining(r as Rank);
      if (rVal > logicVal) biggerRemaining += rem;
      totalRemaining += rem;
    }
    if (totalRemaining === 0) return 100;
    return Math.round((1 - biggerRemaining / totalRemaining) * 100);
  }

  // === 终局意识：检查下家是否只剩1张 ===
  
  private nextEnemyHasOneCard(): boolean {
    const nextSeat = (this.seatIndex + 1) % 4;
    if (this.isAlly(nextSeat)) return false;
    return this.handsInfo[nextSeat] === 1;
  }

  private nextEnemyNearFinish(): boolean {
    const nextSeat = (this.seatIndex + 1) % 4;
    if (this.isAlly(nextSeat)) return false;
    return this.handsInfo[nextSeat] <= 3;
  }

  private allyNearFinish(): boolean {
    const partner = this.partnerIdx();
    const pCards = this.handsInfo[partner];
    return pCards <= 0 || pCards <= 3; // 0 means already out
  }

  /** 获取下家剩余牌数 */
  private nextCards(): number {
    return this.handsInfo[(this.seatIndex + 1) % 4];
  }

  // === 改写自由出牌：阶段感知 + 终局意识 + 角色配合 ===

  private advancedDecideFreePlay(): Card[] | null {
    const allOut = this.tryPlayAll();
    if (allOut) return allOut;

    // 终局：下家敌人只剩1张 → 绝对不出单张
    if (this.nextEnemyHasOneCard() && this.cards.length > 1) {
      // 优先出对子、三带二、顺子（避免送下家走牌）
      const nonSingle = this.findBestNonSinglePlay();
      if (nonSingle) return nonSingle;
      // 如果只有单张可出，出最大的（让下家难接）
      return this.playHighestSingle();
    }

    // 开局（>20张）：对子先行，倒数第二大
    if (this.gamePhase === 'opening' && this.cards.length > 20) {
      const pair = this.findSecondSmallestPair();
      if (pair) return pair;
    }

    // 助攻角色：不出大牌抢控制权
    if (this.getRole() === 'supporter' && this.cards.length > 10) {
      return this.playSupporterFreePlay();
    }

    // 联盟快走完时：不出大牌压联盟
    if (this.allyNearFinish()) {
      const weakPlay = this.playWeakestSafe();
      if (weakPlay) return weakPlay;
    }

    // 默认：按规划出牌（从最小组开始）
    return this.playFromPlan();
  }

  /** 找最小非单张的出牌 */
  private findBestNonSinglePlay(): Card[] | null {
    // 按计划取非单张组
    const groups = (this as any).handPlan.groups as any[];
    const bombIndices = (this as any).handPlan.bombIndices as Set<number>;
    const available = new Map<string, Card[]>();
    for (const c of this.cards) {
      const key = c.suit + ':' + c.rank;
      if (!available.has(key)) available.set(key, []);
      available.get(key)!.push(c);
    }
    
    // 优先：三带二、连对、顺子、对子
    const priority = [HandType.TripsWithPair, HandType.Tube, HandType.Straight, HandType.Pair];
    for (const type of priority) {
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        if (bombIndices.has(i)) continue;
        const h = getHandType(g.cards, this.level);
        if (!h || h.type !== type) continue;
        // Check if all cards available
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
            for (let i2 = 0; i2 < count; i2++) result.push(available.get(key)![i2]);
          }
          return result;
        }
      }
    }
    return null;
  }

  /** 出最大单张（下家敌人1张时用） */
  private playHighestSingle(): Card[] {
    const cards = [...this.cards].sort((a, b) => 
      getLogicValue(b.rank, this.level) - getLogicValue(a.rank, this.level));
    return [cards[0]];
  }

  /** 倒数第二大对子（开局） */
  private findSecondSmallestPair(): Card[] | null {
    const groupsMap = new Map<number, Card[]>();
    for (const c of this.cards) {
      const r = c.rank;
      if (r < 2 || r > 14) continue; // skip jokers
      if (!groupsMap.has(r)) groupsMap.set(r, []);
      groupsMap.get(r)!.push(c);
    }
    const pairs: Card[][] = [];
    for (const [, cs] of groupsMap) {
      if (cs.length >= 2) pairs.push(cs.slice(0, 2));
    }
    if (pairs.length === 0) return null;
    pairs.sort((a, b) => getLogicValue(a[0].rank, this.level) - getLogicValue(b[0].rank, this.level));
    // 倒数第二大：如果只有1个对子就出最小的
    if (pairs.length === 1) return pairs[0];
    return pairs[pairs.length - 2]; // 倒数第二
  }

  /** 助攻角色出牌：只出小牌（≤10） */
  private playSupporterFreePlay(): Card[] | null {
    const plan = (this as any).handPlan;
    const groups = plan.groups as any[];
    const bombIndices = plan.bombIndices as Set<number>;
    const available = new Map<string, Card[]>();
    for (const c of this.cards) {
      const key = c.suit + ':' + c.rank;
      if (!available.has(key)) available.set(key, []);
      available.get(key)!.push(c);
    }
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (bombIndices.has(i)) continue;
      const h = getHandType(g.cards, this.level);
      if (!h) continue;
      // 助攻只出 value ≤ 10 的牌（小牌）
      if (h.value > 10) continue;
      if (h.type === HandType.Bomb || h.type === HandType.StraightFlush || h.type === HandType.FourKings) continue;
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
          for (let i2 = 0; i2 < count; i2++) result.push(available.get(key)![i2]);
        }
        // 验证牌型合法
        if (validatePlay(result, this.level)) return result;
      }
    }
    return null;
  }

  /** 出最安全的弱牌 */
  private playWeakestSafe(): Card[] | null {
    const plan = (this as any).handPlan;
    const groups = plan.groups as any[];
    const bombIndices = plan.bombIndices as Set<number>;
    const available = new Map<string, Card[]>();
    for (const c of this.cards) {
      const key = c.suit + ':' + c.rank;
      if (!available.has(key)) available.set(key, []);
      available.get(key)!.push(c);
    }
    // 从最弱的非炸弹组开始找
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (bombIndices.has(i)) continue;
      const h = getHandType(g.cards, this.level);
      if (!h) continue;
      if (h.type === HandType.Bomb || h.type === HandType.StraightFlush || h.type === HandType.FourKings) continue;
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
          for (let i2 = 0; i2 < count; i2++) result.push(available.get(key)![i2]);
        }
        if (validatePlay(result, this.level)) return result;
      }
    }
    return null;
  }

  private playFromPlan(): Card[] | null {
    const planned = (this as any).handPlan.getNextFreePlay(this.cards);
    if (planned && validatePlay(planned, this.level)) return planned;
    return null;
  }
}