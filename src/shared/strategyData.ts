/**
 * 掼蛋策略参考数据（源自 guandan-mcp 3000 局样本）
 *
 * 用法: import { strategyData } from './strategyData';
 *       const bombProb = strategyData.handTypeProb('4张炸');
 *
 * 这些统计信息用于 Bot AI 辅助决策，运行时无须网络请求。
 */

import mcpStats from './mcp_stats.json';

// ---- 类型定义 ----

interface HandTypeStat {
  /** 排名 1-15 */
  排名: number;
  /** 中文名 */
  中文: string;
  /** 英文名 */
  英文: string;
  /** 出现概率 (0-1) */
  出现概率: number;
  /** 平均每手出现次数 */
  平均每手: number;
  /** 样本手数 */
  样本手数: number;
}

interface CorrelationPair {
  X: string;
  Y: string;
  pearson_r: number;
  strength?: string;
  interpretation?: string;
}

interface FrequencyMap {
  [key: string]: { [value: string]: number };
}

// ---- 导出数据 ----

const raw = mcpStats as any;

/** 15种牌型概率统计 */
export const topHandTypes: HandTypeStat[] = (raw.top_hand_types || []) as HandTypeStat[];

/** 最强负相关牌型对 */
export const topCorrelations: CorrelationPair[] = (raw.top_correlations || []) as CorrelationPair[];

/** 频率分布 */
export const frequencies: FrequencyMap = {
  has_rocket: (raw.freq_has_rocket || {}) as any,
  has_wild_card: (raw.freq_has_wild_card || {}) as any,
};

// ---- 查询函数 ----

/**
 * 查询某个牌型的出现概率
 * @param chineseName 牌型中文名，如 "4张炸"、"同花顺"、"顺子"
 */
export function handTypeProb(chineseName: string): number | undefined {
  return topHandTypes.find(h => h.中文 === chineseName)?.出现概率;
}

/**
 * 查询两个牌型的相关系数（负值 = 互斥，正值 = 同向）
 */
export function correlation(x: string, y: string): CorrelationPair | undefined {
  return topCorrelations.find(c => (c.X === x && c.Y === y) || (c.X === y && c.Y === x));
}

/**
 * 查询某个属性的频率分布
 */
export function frequency(query: string): { [value: string]: number } | undefined {
  return frequencies[query as keyof typeof frequencies];
}

/** 快捷：是否有火箭（大小王齐全）的概率 */
export const probRocket: number = (() => {
  const f = frequency('has_rocket');
  if (!f) return 0;
  const total = Object.values(f).reduce((a: number, b: any) => a + Number(b), 0);
  return total > 0 ? Number(f['True'] || 0) / total : 0;
})();

/** 快捷：持有逢人配的概率 */
export const probWildCard: number = (() => {
  const f = frequency('has_wild_card');
  if (!f) return 0;
  const total = Object.values(f).reduce((a: number, b: any) => a + Number(b), 0);
  return total > 0 ? Number(f['True'] || 0) / total : 0;
})();
