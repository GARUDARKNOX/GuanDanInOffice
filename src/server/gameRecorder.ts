import * as fs from 'fs';
import * as path from 'path';
import type { Game } from './game';
import type { Card } from '../shared/types';

/**
 * 每局牌完整记录器
 * ----------------------------------------
 * 目的：把每一局（一"局"=从发牌到打完一轮，即一次 Game 实例的生命周期）的完整过程
 * 落盘成 JSON，方便之后复盘（尤其是回看 BOT 的配牌/出牌决策）。
 *
 * 记录内容：
 *  - 元信息：房间、开局/结束时间、局数、等级、模式、玩家、结果
 *  - initialHands：发牌时每家 27 张的原始手牌（含级牌/万能牌标记）——用来核对"对手牌
 *    是否真的更好"，以及判断 BOT 的配牌是否合理
 *  - events：整局所有事件（出牌/过牌/进贡/技能等），出牌事件里带该玩家出完后的剩余手牌，
 *    可据此还原任意时刻的牌局状态
 *
 * 存储位置：默认 <项目根>/game-records/，可用环境变量 GUANDAN_RECORDS_DIR 覆盖。
 * 每局一个 <roomId>-<时间戳>.json；latest.json 永远指向最近一局，方便"复盘上一局"。
 */

const RECORDS_DIR = process.env.GUANDAN_RECORDS_DIR
  || path.join(__dirname, '..', '..', 'game-records');

function ensureDir() {
  if (!fs.existsSync(RECORDS_DIR)) {
    fs.mkdirSync(RECORDS_DIR, { recursive: true });
  }
}

function serializeCard(c: Card) {
  return { suit: c.suit, rank: c.rank, id: c.id, isLevelCard: c.isLevelCard, isWild: c.isWild };
}

export function saveGameRecord(game: Game, status: 'finished' | 'interrupted') {
  try {
    ensureDir();
    const id = `${game.roomId}-${Date.now()}`;
    const startedAt = (game as any).startedAt as string | undefined;
    const initialHands = ((game as any).initialHands as Card[][] | undefined) || [];
    const record = {
      id,
      roomId: game.roomId,
      startedAt: startedAt || null,
      endedAt: new Date().toISOString(),
      status,
      level: game.level,
      round: game.currentRound,
      mode: game.gameMode,
      variant: game.gameVariant,
      players: game.players.map(p => ({ seatIndex: p.seatIndex, name: p.name, isBot: !!p.isBot })),
      winners: [...game.winners],
      resultType: (game as any).resultType || '',
      initialHands: initialHands.map(h => h.map(serializeCard)),
      events: game.history.map(e => ({
        ...e,
        details: e.details ? JSON.parse(JSON.stringify(e.details)) : undefined
      }))
    };
    const filename = `${id}.json`;
    fs.writeFileSync(path.join(RECORDS_DIR, filename), JSON.stringify(record, null, 1));
    fs.writeFileSync(
      path.join(RECORDS_DIR, 'latest.json'),
      JSON.stringify({ id, filename, roomId: game.roomId, endedAt: record.endedAt, status, level: game.level, round: game.currentRound }, null, 1)
    );
    (game as any).recordWritten = true;
    console.log(`[Recorder] 对局已记录 -> ${filename}`);
  } catch (err) {
    console.error('[Recorder] 记录对局失败:', err);
  }
}
