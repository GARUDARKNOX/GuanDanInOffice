import { Server, Socket } from 'socket.io';
import { createDeck, createThreePlayerDeck, shuffleDeck, updateCardProperties } from '../shared/deck';
import { getHandType, compareHands, sortCards, getLargestCard, getLogicValue } from '../shared/rules';
import { Card, Hand, HandType, GameMode, GameVariant, SkillCard, SkillCardType, Suit, Rank, HistoryEntry, HistoryEventType } from '../shared/types';
import { Bot, CardTracker } from '../shared/bot';
import { saveGameRecord } from './gameRecorder';

interface Player {
  id: string;
  name: string;
  socket?: Socket;
  seatIndex: number;
  isBot?: boolean;
}

enum GamePhase {
  Waiting = 'Waiting',
  Dealing = 'Dealing',
  Tribute = 'Tribute',
  ReturnTribute = 'ReturnTribute',
  Playing = 'Playing',
  Score = 'Score'
}

interface TributeState {
  pendingTributes: { from: number, to: number, card?: Card }[];
  pendingReturns: { from: number, to: number, card?: Card }[];
  nextStartPlayer?: number;
}

// ============ 彩蛋：名字为「牛来」的玩家每局获得 4 个炸弹 + 1 个同花顺 ============
// 炸弹样式（每次随机组合、且相邻局不重复）：
//   four  = 4 张同点纯炸
//   five  = 5 张同点炸
//   six   = 6 张同点炸
//   kings = 天王炸（2 小王 + 2 大王）
// 注：不使用 wild（逢人配炸弹），红桃级牌是万能牌会被 HandPlan 挪去补同花顺，导致炸弹被拆散。
type BombStyle = 'four' | 'five' | 'six' | 'kings';

// 跨局记忆：每个彩蛋座位最近一次使用的炸弹样式签名，用于保证每局样式不同
const lastEasterEggSignatures: { [seat: number]: string } = {};

function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 从 deck 就地取出 n 张指定 rank 的牌（按 rank 数值匹配，含王） */
function takeRank(deck: Card[], rank: number, n: number): Card[] {
  const taken: Card[] = [];
  for (let i = deck.length - 1; i >= 0 && taken.length < n; i--) {
    if (deck[i].rank === rank) {
      taken.push(deck[i]);
      deck.splice(i, 1);
    }
  }
  return taken;
}

/** 构造同花顺：5 张同花色连续（避开级牌，就地取牌） */
function buildStraightFlush(deck: Card[], level: number): { cards: Card[], rank: number } | null {
  // 起始 rank 3~8，保证 5 连且最大 rank ≤12（不含 A，规避 A2345 特殊），且区间内不含级牌
  const starts = [3, 4, 5, 6, 7, 8].filter(s => {
    for (let k = 0; k < 5; k++) if (s + k === level) return false;
    return true;
  });
  if (starts.length === 0) return null;
  const start = randomPick(starts);
  const suit = randomPick([0, 1, 2, 3]);
  const cards: Card[] = [];
  for (let k = 0; k < 5; k++) {
    const rank = start + k;
    const idx = deck.findIndex(c => c.suit === suit && c.rank === rank);
    if (idx < 0) return null;
    cards.push(deck.splice(idx, 1)[0]);
  }
  return { cards, rank: start };
}

/** 构造 4 个不同样式的炸弹（就地取牌） */
function buildNiLaiBombs(deck: Card[], level: number, excludeRanks: number[] = []): { bombs: Card[][], signature: string } | null {
  const allRanks = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  // 炸弹 rank 避开级牌 + 同花顺区间，避免 HandPlan 重分组时把同花顺的牌拆去凑炸弹
  const pool = allRanks.filter(r => r !== level && !excludeRanks.includes(r));

  // 根据 deck 实际资源筛掉不可用样式。不用 wild（逢人配炸弹）——红桃级牌是万能牌，
  // HandPlan 会把它挪去补同花顺导致炸弹被拆散（实测 wild 炸弹会被拆成三条+单张）。
  const smallJokers = deck.filter(c => c.rank === 15).length;
  const bigJokers = deck.filter(c => c.rank === 16).length;
  const available: BombStyle[] = ['four', 'five', 'six'];
  if (smallJokers >= 2 && bigJokers >= 2) available.push('kings');

  const styles: BombStyle[] = shuffleArray<BombStyle>(available).slice(0, 4);
  // 可用样式不足 4（第二个彩蛋座位无王时只有 four/five/six）用 four 变体补足，rank 不同
  while (styles.length < 4) styles.push('four');

  const bombs: Card[][] = [];
  const sigParts: string[] = [];
  const usedRanks = new Set<number>();

  for (const style of styles) {
    if (style === 'kings') {
      const small = takeRank(deck, 15, 2);
      const big = takeRank(deck, 16, 2);
      if (small.length < 2 || big.length < 2) return null;
      bombs.push([...small, ...big]);
      sigParts.push('kings');
    } else {
      const count = style === 'four' ? 4 : style === 'five' ? 5 : 6;
      const candidates = pool.filter(x => !usedRanks.has(x));
      if (candidates.length === 0) return null;
      const r = randomPick(candidates);
      const cards = takeRank(deck, r, count);
      if (cards.length < count) return null;
      usedRanks.add(r);
      bombs.push(cards);
      sigParts.push(`${style}:${r}`);
    }
  }
  return { bombs, signature: sigParts.sort().join('|') };
}

/** 构造「牛来」的整手 27 张：4 炸弹 + 1 同花顺 + 填充散牌（成功时才从原 deck 移除） */
function buildNiLaiHand(deck: Card[], level: number, previousSignature: string): { hand: Card[], signature: string } {
  for (let attempt = 0; attempt < 200; attempt++) {
    const working = [...deck];
    const sf = buildStraightFlush(working, level);
    if (!sf) continue;
    // 炸弹 rank 避开同花顺的 5 个 rank，防止 HandPlan 把同花顺里的牌拆去补炸弹
    const sfRanks = [sf.rank, sf.rank + 1, sf.rank + 2, sf.rank + 3, sf.rank + 4];
    const bombsResult = buildNiLaiBombs(working, level, sfRanks);
    if (!bombsResult) continue;

    const signature = bombsResult.signature + `|sf:${sf.rank}`;
    if (signature === previousSignature) continue;

    const assigned = bombsResult.bombs.flat().concat(sf.cards);
    if (assigned.length > 27) continue;
    const fillNeeded = 27 - assigned.length;
    // ★ 填充牌避开所有已用 rank（炸弹 rank + 同花顺 rank + 级牌/王）——
    //   否则填充牌会和同花顺/炸弹里的牌凑成对子、三条，HandPlan 会优先识别对子/三条
    //   而把同花顺拆散（实测 fill 抽到同花顺 rank 的牌会把同花顺拆成单张+对子）。
    const usedRanks = new Set<number>([level]);
    sfRanks.forEach(r => usedRanks.add(r));
    for (const b of bombsResult.bombs) if (b.length) usedRanks.add(b[0].rank);
    const fillPool = working.filter(c => !usedRanks.has(c.rank));
    const fill = shuffleArray(fillPool).slice(0, fillNeeded);
    if (fill.length < fillNeeded) continue;

    const hand = assigned.concat(fill);
    // 从原 deck 移除这 27 张（按 id）
    const handIds = new Set(hand.map(c => c.id));
    for (let i = deck.length - 1; i >= 0; i--) {
      if (handIds.has(deck[i].id)) deck.splice(i, 1);
    }
    return { hand, signature };
  }
  return { hand: [], signature: previousSignature };
}

export class Game {
  io: Server;
  roomId: string;
  players: Player[];
  
  level: number = 2; 
  currentPhase: GamePhase = GamePhase.Waiting;
  
  // Callback for when game ends (used by Match)
  onGameEnd?: (winners: number[]) => void;
  
  // Lifecycle management
  private isActive: boolean = true;
  private pendingTimeouts: NodeJS.Timeout[] = [];
  
  hands: Card[][] = [];
  currentTurn: number = 0;
  
  lastHand: { playerIndex: number, hand: Hand } | null = null;
  passCount: number = 0;

  /** 全局已出牌追踪 */
  private playedCards: Card[] = [];
  private cardTracker: CardTracker = new CardTracker();
  
  // Track each player's action in current round (for display)
  roundActions: { [seat: number]: { type: 'play' | 'pass', cards?: Card[], hand?: Hand } } = {};
  
  winners: number[] = [];
  tributeState: TributeState = { pendingTributes: [], pendingReturns: [] };
  
  // Track Team Levels
  teamLevels: { [key: number]: number } = { 0: 2, 1: 2 }; // Team 0 (0,2), Team 1 (1,3)
  activeTeam: number = 0; // Who is upgrading currently (Banker Team)
  prevWinners: number[] = [];
  
  // Game Variant (3-player mode)
  gameVariant: GameVariant = GameVariant.FourPlayer;
  numPlayers: number = 4;
  
  // Skill Mode
  gameMode: GameMode = GameMode.Normal;
  skillCards: SkillCard[][] = [];
  skipNextTurn: boolean[] = [];
  newCardIds: { [seat: number]: string[] } = {};
  
  // Game History
  history: HistoryEntry[] = [];
  private historyIdCounter: number = 0;
  currentRound: number = 0;
  
  // 每局落盘记录（复盘用）
  private recordWritten: boolean = false;
  initialHands: Card[][] = [];
  startedAt: string = '';
  resultType: string = '';

  constructor(io: Server, roomId: string, players: Player[], gameMode: GameMode = GameMode.Normal, gameVariant: GameVariant = GameVariant.FourPlayer) {
    this.io = io;
    this.roomId = roomId;
    this.players = players;
    this.gameMode = gameMode;
    this.gameVariant = gameVariant;
    this.numPlayers = gameVariant === GameVariant.ThreePlayer ? 3 : 4;
    
    // Initialize dynamically-sized arrays
    this.hands = Array.from({ length: this.numPlayers }, () => []);
    this.skillCards = Array.from({ length: this.numPlayers }, () => []);
    this.skipNextTurn = new Array(this.numPlayers).fill(false);
    this.newCardIds = {};
    
    // Setup listeners for human players
    this.players.forEach(p => {
        if (!p.isBot && p.socket) {
            this.bindPlayerListeners(p);
        }
    });
  }
  
  rebindPlayer(p: Player) {
      if (!p.isBot && p.socket) {
          // Remove old listeners? Socket is new, so no need to remove old ones from new socket.
          // Old socket is dead.
          this.bindPlayerListeners(p);
      }
  }
  
  bindPlayerListeners(p: Player) {
      if (!p.socket) return;
      const s = p.socket;
      s.on('playHand', (data: { cards: Card[], handType?: Hand } | Card[]) => {
          // Support both old format (Card[]) and new format ({ cards, handType })
          if (Array.isArray(data)) {
              this.handlePlayHand(p.seatIndex, data, undefined);
          } else {
              this.handlePlayHand(p.seatIndex, data.cards, data.handType);
          }
      });
      s.on('pass', () => this.handlePass(p.seatIndex));
      s.on('tribute', (cards: Card[]) => this.handleTribute(p.seatIndex, cards));
      s.on('returnTribute', (cards: Card[]) => this.handleReturnTribute(p.seatIndex, cards));
      s.on('useSkill', (data: { skillId: string, targetSeat?: number }) => 
          this.handleUseSkill(p.seatIndex, data.skillId, data.targetSeat));
  }
  
  // Lifecycle management methods
  private registerTimeout(timeout: NodeJS.Timeout) {
      this.pendingTimeouts.push(timeout);
  }
  
  private clearAllTimeouts() {
      this.pendingTimeouts.forEach(t => clearTimeout(t));
      this.pendingTimeouts = [];
  }
  
  destroy() {
      console.log(`[Game] Destroying game instance for room ${this.roomId}`);
      this.isActive = false;
      this.clearAllTimeouts();
      
      // 兜底：如果这局还没落盘但已经出过牌（强制结束/房间解散），也记录为 interrupted
      if (!this.recordWritten && this.history.some(e => e.type === HistoryEventType.Play || e.type === HistoryEventType.Pass)) {
          saveGameRecord(this, 'interrupted');
      }
      
      // Unbind all socket listeners
      this.players.forEach(p => {
          if (p.socket) {
              p.socket.removeAllListeners('playHand');
              p.socket.removeAllListeners('pass');
              p.socket.removeAllListeners('tribute');
              p.socket.removeAllListeners('returnTribute');
              p.socket.removeAllListeners('useSkill');
          }
      });
  }
  
  // History logging methods
  private addHistoryEntry(type: HistoryEventType, message: string, playerIndex?: number, details?: any) {
      const entry: HistoryEntry = {
          id: `history-${this.historyIdCounter++}`,
          timestamp: Date.now(),
          type,
          playerIndex,
          playerName: playerIndex !== undefined ? this.players[playerIndex]?.name : undefined,
          message,
          details
      };
      this.history.push(entry);
      
      // Broadcast to all players
      this.io.to(this.roomId).emit('historyUpdate', entry);
  }
  
  private getCardDescription(cards: Card[]): string {
      if (cards.length === 0) return '';
      if (cards.length === 1) {
          const c = cards[0];
          const suitName = ['♠', '♥', '♣', '♦', 'Joker'][c.suit];
          const rankName = c.rank === 15 ? '小王' : c.rank === 16 ? '大王' : 
                          c.rank === 11 ? 'J' : c.rank === 12 ? 'Q' : 
                          c.rank === 13 ? 'K' : c.rank === 14 ? 'A' : c.rank.toString();
          return c.rank >= 15 ? rankName : `${suitName}${rankName}`;
      }
      return `${cards.length}张牌`;
  }

  // Called by Room when restarting
  resetAndStart() {
      // Save winners
      if (this.winners.length === this.numPlayers) {
          this.prevWinners = [...this.winners];
          this.handleLevelUp();
      }
      this.winners = [];
      this.tributeState = { pendingTributes: [], pendingReturns: [] };
      
      this.start();
  }

  start() {
    this.currentPhase = GamePhase.Dealing;
    
    // First time start logic
    if (this.prevWinners.length === 0 && this.winners.length === 0) {
        // Fresh game
        this.activeTeam = 0;
        this.teamLevels = { 0: 2, 1: 2 };
        this.currentRound = 1;
        this.history = []; // Clear history for new match
        this.historyIdCounter = 0;
    } else {
        this.currentRound++;
    }

    // Use Active Team Level
    this.level = this.teamLevels[this.activeTeam];
    
    // Add history entry for game start
    const teamName = this.activeTeam === 0 ? 'Team 0 (Seat 0, 2)' : 'Team 1 (Seat 1, 3)';
    this.addHistoryEntry(
        HistoryEventType.GameStart,
        `第${this.currentRound}局开始 - 当前等级: ${this.level} - 庄家: ${teamName}`,
        undefined,
        { level: this.level, activeTeam: this.activeTeam, round: this.currentRound }
    );

    let deck: Card[];
    const totalCards = this.numPlayers * 27;
    if (this.gameVariant === GameVariant.ThreePlayer) {
      deck = createThreePlayerDeck();
    } else {
      deck = createDeck();
    }
    deck = shuffleDeck(deck);
    
    this.hands = Array.from({ length: this.numPlayers }, () => [] as Card[]);

    // ★ 彩蛋：名字为「牛来」的玩家、以及 BOT2（座位2的Bot）每局获得 4 炸弹 + 1 同花顺（样式每局不同）
    const easterEggSeats = [...new Set(this.players
      .filter(p => p && (p.name === '牛来' || (p.isBot && p.seatIndex === 2)))
      .map(p => p.seatIndex))];
    if (easterEggSeats.length > 0 && this.numPlayers === 4) {
      let allOk = true;
      for (const seat of easterEggSeats) {
        const prevSig = lastEasterEggSignatures[seat] || '';
        const result = buildNiLaiHand(deck, this.level, prevSig);
        if (result.hand.length === 27) {
          this.hands[seat] = result.hand;
          lastEasterEggSignatures[seat] = result.signature;
          console.log(`[彩蛋] ${this.players[seat]?.name}(座${seat})本局获得 4 炸弹 + 1 同花顺，签名=${result.signature}`);
        } else {
          allOk = false;
          break;
        }
      }
      if (allOk) {
        // 剩余 deck 牌按座位顺序发给非彩蛋玩家（每人 27 张）
        const eggSet = new Set(easterEggSeats);
        let idx = 0;
        for (let s = 0; s < this.numPlayers; s++) {
          if (eggSet.has(s)) continue;
          for (let k = 0; k < 27; k++) {
            this.hands[s].push(deck[idx++]);
          }
        }
      } else {
        // 构造失败则重新正常发牌
        let freshDeck = this.gameVariant === GameVariant.ThreePlayer ? createThreePlayerDeck() : createDeck();
        freshDeck = shuffleDeck(freshDeck);
        this.hands = Array.from({ length: this.numPlayers }, () => [] as Card[]);
        for (let i = 0; i < totalCards; i++) {
          this.hands[i % this.numPlayers].push(freshDeck[i]);
        }
      }
    } else {
      for (let i = 0; i < totalCards; i++) {
          this.hands[i % this.numPlayers].push(deck[i]);
      }
    }
    
    // Process hands
    this.hands = this.hands.map(h => updateCardProperties(h, this.level));
    this.hands = this.hands.map(h => sortCards(h, this.level));
    
    // 记录发牌后的原始手牌 + 开局时间（供每局落盘复盘用）
    this.initialHands = this.hands.map(h => [...h]);
    // 每局重新观察各家的"出牌套路"（上一局的套路对本局无意义）
    this.cardTracker.resetSeatLogs();
    this.startedAt = new Date().toISOString();
    this.recordWritten = false;
    
    // Reset skip flags
    this.skipNextTurn = [false, false, false, false];
    
    // Deal skill cards if in Skill mode
    if (this.gameMode === GameMode.Skill) {
        this.dealSkillCards();
    } else {
        this.skillCards = [[], [], [], []];
    }

    // If it's a restart (not fresh)
    if (this.prevWinners.length > 0) {
         this.initTributePhase();
    } else {
         this.currentTurn = 0;
         this.currentPhase = GamePhase.Playing;
         this.passCount = 0;
         this.lastHand = null;
    }
    
    this.broadcastGameState();
  }
  
  handleLevelUp() {
      if (this.prevWinners.length === 0) return;
      
      if (this.gameVariant === GameVariant.ThreePlayer) {
          // 三人模式：头游+3，二游+1，末游不变
          // level 是头游的个人等级，不是队伍等级
          const first = this.prevWinners[0];
          const second = this.prevWinners[1];
          const third = this.prevWinners[2];
          // 头游升级最多，二游也升一点
          // 三人模式用 level 字段，每次头游升3级
          this.level += 3;
          if (this.level > 14) this.level = 14;
          return;
      }
      
      // 四人模式（原有逻辑）
      const p1 = this.prevWinners[0];
      const p2 = this.prevWinners[1];
      const isSameTeam = (a: number, b: number) => (a % 2) === (b % 2);
      
      // Determine Winning Team (First Winner's Team)
      const winningTeam = p1 % 2;
      
      // Determine Step
      let step = 0;
      if (isSameTeam(p1, p2)) step = 3; // Double Up (1st, 2nd same team) -> +3
      else if (isSameTeam(p1, this.prevWinners[2])) step = 2; // 1st, 3rd -> +2 
      else step = 1; 

      if (winningTeam !== this.activeTeam) {
          // Switch Banker
          this.activeTeam = winningTeam;
          this.teamLevels[this.activeTeam] += step; 
      } else {
          // Keep Banker
          this.teamLevels[this.activeTeam] += step;
      }
      
      if (this.teamLevels[this.activeTeam] > 14) this.teamLevels[this.activeTeam] = 14; 
  }
  
  initTributePhase() {
      if (this.gameVariant === GameVariant.ThreePlayer) {
          // 三人模式：末游向头游进贡
          if (this.prevWinners.length < 3) {
              this.currentPhase = GamePhase.Playing;
              this.currentTurn = this.prevWinners[0] || 0;
              return;
          }
          const first = this.prevWinners[0];
          const last = this.prevWinners[2];
          
          this.tributeState = { pendingTributes: [], pendingReturns: [] };
          
          // 末游向头游进贡
          this.tributeState.pendingTributes.push({
              from: last,
              to: first,
          });
          this.tributeState.nextStartPlayer = last; // 末游先出牌
          this.currentPhase = GamePhase.Tribute;
          
          // 自动处理Bot进贡
          this.processAutoTribute();
          this.broadcastGameState();
          return;
      }
      
      // 四人模式（原有逻辑）
      if (this.prevWinners.length < 4) {
          // First game or error, no tribute
          this.currentPhase = GamePhase.Playing;
          this.currentTurn = this.activeTeam; // Banker starts first game? Or Random? Usually Banker.
          // In GuanDan, first game usually starts from Host or Random. 
          // Let's assume ActiveTeam's P1 starts.
          return;
      }

      const p1 = this.prevWinners[0];
      const p2 = this.prevWinners[1];
      const p3 = this.prevWinners[2];
      const p4 = this.prevWinners[3];
      const isSameTeam = (a: number, b: number) => (a % 2) === (b % 2);

      this.tributeState = { pendingTributes: [], pendingReturns: [] };
      
      // Anti-Tribute Logic (Resistance)
      // Check for 2 Big Jokers in losing team's hands
      // Losing Team:
      let losingTeam: number[] = [];
      let isDouble = false;
      
      if (isSameTeam(p1, p2)) {
          // Double Win
          isDouble = true;
          losingTeam = [p3, p4];
      } else {
          // Single Win (1,3 or 1,4)
          losingTeam = [p4]; // Only last place pays in Single Win? 
          // Rule: Single Win (1,3 same team) -> 4 pays 1.
      }
      // Standard: 
      // Double Win: 4->1, 3->2.
      // Single Win (1,3): 4->1.
      // Tie (1,4): No tribute.
      if (isSameTeam(p1, p4)) {
         // Tie (1,4 same team) -> No tribute
         this.currentPhase = GamePhase.Playing;
         this.currentTurn = p1;
         return;
      }
      
      // Count Big Jokers in Losing Team Hands
      let bigJokerCount = 0;
      losingTeam.forEach(seat => {
          bigJokerCount += this.hands[seat].filter(c => c.rank === 16).length; // Rank.BigJoker = 16
      });
      
      if (bigJokerCount === 2) {
          // Resistance Successful!
          // No Tribute
          // Who starts? P1 (Winner) starts.
          this.currentPhase = GamePhase.Playing;
          this.currentTurn = p1;
          // Notify? Ideally send message.
          this.io.to(this.roomId).emit('error', '抗贡成功！双大王在手，免除进贡！');
          return;
      }
      
      // Tribute Rules
      if (isDouble) {
          // Double: 4->1, 3->2
          this.tributeState.pendingTributes.push({ from: p4, to: p1 }); 
          this.tributeState.pendingTributes.push({ from: p3, to: p2 }); 
      } else {
          // Single: 4->1
          this.tributeState.pendingTributes.push({ from: p4, to: p1 });
      }
      
      if (this.tributeState.pendingTributes.length > 0) {
          this.currentPhase = GamePhase.Tribute;
          this.processAutoTribute();
      } else {
          this.currentPhase = GamePhase.Playing;
          this.currentTurn = p1; 
      }
  }
  
  /**
   * ★ 规则校验：这张牌是否真实在该玩家手里（按 card.id 匹配）。
   *   进贡/还贡必须用"手里真实持有的牌"，否则会出现凭空造牌
   *   （旧代码直接信任客户端传来的 card 对象：filter 按 id 删不掉，
   *   却又 push 给了对方，牌堆总数凭空 +1，产生幽灵牌）。
   */
  private ownsCard(seatIndex: number, card: Card | undefined): boolean {
      if (!card || !card.id) return false;
      return (this.hands[seatIndex] || []).some(c => c.id === card.id);
  }

  /** 红桃级牌（逢人配）——规则禁止用于进贡 */
  private isWildLevelCard(card: Card | undefined): boolean {
      return !!card && card.isWild === true;
  }

  /** 该玩家手里"可进贡"的最大牌（排除红桃级牌；红桃级牌不可进贡，不参与比较） */
  private getTributableLargestCard(seatIndex: number): Card | undefined {
      const hand = (this.hands[seatIndex] || []).filter(c => !this.isWildLevelCard(c));
      if (hand.length === 0) return undefined;
      return getLargestCard(hand, this.level);
  }

  /**
   * BOT 自动进贡：取手里最大且非红桃级牌的一张。
   * ★ 关键点：转移的是"从 hands 数组里真实取出的那个对象"（而不是任何外部构造的牌），
   *   保证 BOT 绝不会进贡/还贡出自己手里没有的牌。
   */
  private botAutoTribute(t: { from: number, to: number, card?: Card }) {
      if (t.card) return;
      const player = this.players[t.from];
      if (!player.isBot) return;
      const largest = this.getTributableLargestCard(t.from);
      if (!largest) return;
      const real = (this.hands[t.from] || []).find(c => c.id === largest.id);
      if (!real) return;
      t.card = real;
      this.hands[t.from] = this.hands[t.from].filter(c => c.id !== real.id);
      this.hands[t.to].push(real);
      this.hands[t.to] = sortCards(this.hands[t.to], this.level);
      this.addHistoryEntry(
          HistoryEventType.Tribute,
          `${this.players[t.from].name} 向 ${this.players[t.to].name} 进贡: ${this.getCardDescription([real])}`,
          t.from,
          { card: real, to: t.to }
      );
  }

  /**
   * BOT 自动还贡：从自己手牌里挑最小的一张（hands 已按逻辑值降序，末位即最小）。
   * ★ 同样只转移"手牌里真实存在的对象"，杜绝还出手里没有的牌。
   */
  private botAutoReturn(r: { from: number, to: number, card?: Card }) {
      if (r.card) return;
      const player = this.players[r.from];
      if (!player.isBot) return;
      // ★ 修复：还贡同样禁止用红桃级牌（逢人配）——它是万能牌，进贡时已禁止
      //   （isWildLevelCard），还贡也绝不能把逢人配白送出去。取"最小且非逢人配"的牌。
      const hand = (this.hands[r.from] || []).filter(c => !this.isWildLevelCard(c));
      if (hand.length === 0) return;
      const smallest = hand[hand.length - 1];
      const real = (this.hands[r.from] || []).find(c => c.id === smallest.id);
      if (!real) return;
      r.card = real;
      this.hands[r.from] = this.hands[r.from].filter(c => c.id !== real.id);
      this.hands[r.to].push(real);
      this.hands[r.to] = sortCards(this.hands[r.to], this.level);
      this.addHistoryEntry(
          HistoryEventType.ReturnTribute,
          `${this.players[r.from].name} 向 ${this.players[r.to].name} 还贡: ${this.getCardDescription([real])}`,
          r.from,
          { card: real, to: r.to }
      );
  }

  processAutoTribute() {
      this.tributeState.pendingTributes.forEach(t => this.botAutoTribute(t));
      
      const allDone = this.tributeState.pendingTributes.every(t => t.card);
      if (allDone) {
          this.currentPhase = GamePhase.ReturnTribute;
          this.tributeState.pendingReturns = this.tributeState.pendingTributes.map(t => ({
              from: t.to,
              to: t.from
          }));
          this.tributeState.pendingTributes = []; 
          
          this.tributeState.pendingReturns.forEach(r => this.botAutoReturn(r));
          
          this.checkReturnDone();
      }
  }

  handleTribute(seatIndex: number, cards: Card[]) {
      if (this.currentPhase !== GamePhase.Tribute) return;
      if (cards.length !== 1) return;
      
      const tribute = this.tributeState.pendingTributes.find(t => t.from === seatIndex && !t.card);
      if (!tribute) return;
      
      // ★ 规则1：不能进贡手里没有的牌（服务端强校验，防止客户端传出不存在的牌造成"凭空造牌"）
      if (!this.ownsCard(seatIndex, cards[0])) {
           this.emitError(seatIndex, '进贡的牌不在你的手牌中');
           return;
      }
      
      // ★ 规则2：红桃级牌(逢人配)不能进贡
      if (this.isWildLevelCard(cards[0])) {
           this.emitError(seatIndex, '红桃级牌(逢人配)不能进贡，请改贡其他最大牌');
           return;
      }
      
      // Verify largest（红桃级牌不可进贡，因此不参与"最大牌"的比较）
      const largest = this.getTributableLargestCard(seatIndex);
      const valPlay = getLogicValue(cards[0].rank, this.level);
      const valMax = largest ? getLogicValue(largest.rank, this.level) : -1;
      
      if (valPlay < valMax) {
           this.emitError(seatIndex, '必须进贡手中最大的牌');
           return;
      }
      
      // 用"手牌里真实存在的对象"转移，而不是信任客户端传来的对象
      const realCard = this.hands[seatIndex].find(c => c.id === cards[0].id)!;
      tribute.card = realCard;
      this.hands[seatIndex] = this.hands[seatIndex].filter(c => c.id !== realCard.id);
      this.hands[tribute.to].push(realCard);
      this.hands[tribute.to] = sortCards(this.hands[tribute.to], this.level);
      
      // Add history entry for tribute
      this.addHistoryEntry(
          HistoryEventType.Tribute,
          `${this.players[seatIndex].name} 向 ${this.players[tribute.to].name} 进贡: ${this.getCardDescription([realCard])}`,
          seatIndex,
          { card: realCard, to: tribute.to }
      );
      
      const allDone = this.tributeState.pendingTributes.every(t => t.card);
      if (allDone) {
          // Determine who goes first in next round (Playing Phase)
          // Rule: "The one who paid the largest tribute goes first"
          // If equal? (e.g. both paid Heart 5?) -> Usually the one who paid to First Place? Or downstream order?
          // Rule: If single tribute, payer goes first.
          // If double tribute: Compare tribute cards. Largest payer goes first.
          // If equal max tribute cards? Payer to P1 goes first? Or P4 (Last place) goes first?
          // Common Rule: Payer of largest card. If equal, Last Place (p4) goes first.
          
          let nextTurn = -1;
          
          // Logic for next turn needs to be stored for after Return Tribute
          // Actually, currentTurn updates when entering Playing phase.
          // We can calculate it now and store it? 
          // Wait, Return Tribute phase happens next. We shouldn't set currentTurn for Playing yet.
          // But we need to know who starts.
          
          // Compare tribute cards
          let maxVal = -1;
          let maxPayer = -1;
          
          this.tributeState.pendingTributes.forEach(t => {
              if (t.card) {
                  const val = getLogicValue(t.card.rank, this.level);
                  if (val > maxVal) {
                      maxVal = val;
                      maxPayer = t.from;
                  } else if (val === maxVal) {
                      // Tie breaker: Usually Last Place (p4) has priority if ties with 3rd place?
                      // Or 3rd place?
                      // Let's stick to: If tie, the one who paid to First Winner (P1) gets priority? 
                      // Actually rules say: "If tribute cards are equal, the tributer to the first winner goes first" (Some rules)
                      // OR "Last place goes first"
                      // Let's assume maxPayer updates only if STRICTLY greater, so first one found keeps it.
                      // Order is p4->p1, p3->p2. So p4 is checked first.
                      // If p3 pays same value, maxVal is same, maxPayer stays p4.
                      // So p4 (Last place) wins tie.
                  }
              }
          });
          
          // Store this for later use in checkReturnDone
          this.tributeState.nextStartPlayer = maxPayer;

          this.currentPhase = GamePhase.ReturnTribute;
          this.tributeState.pendingReturns = this.tributeState.pendingTributes.map(t => ({
              from: t.to,
              to: t.from
          }));
          this.tributeState.pendingTributes = [];
          
          // Auto-process bot return tributes（与 processAutoTribute 同一套实现：
          // 只从 BOT 自己的手牌里取牌，保证不会还出手里没有的牌）
          this.tributeState.pendingReturns.forEach(r => this.botAutoReturn(r));
          
          this.checkReturnDone();
          this.broadcastGameState();
      } else {
          this.broadcastGameState();
      }
  }

  handleReturnTribute(seatIndex: number, cards: Card[]) {
      if (this.currentPhase !== GamePhase.ReturnTribute) return;
      if (cards.length !== 1) return;
      
      const ret = this.tributeState.pendingReturns.find(r => r.from === seatIndex && !r.card);
      if (!ret) return;
      
      // ★ 规则：不能还贡手里没有的牌（服务端强校验，防止凭空造牌/幽灵牌）
      if (!this.ownsCard(seatIndex, cards[0])) {
          this.emitError(seatIndex, '还贡的牌不在你的手牌中');
          return;
      }
      
      // ★ 修复：红桃级牌（逢人配）不能还贡（与进贡的 isWildLevelCard 检测对齐）
      if (this.isWildLevelCard(cards[0])) {
          this.emitError(seatIndex, '红桃级牌(逢人配)不能还贡');
          return;
      }
      
      // 用"手牌里真实存在的对象"转移
      const realCard = this.hands[seatIndex].find(c => c.id === cards[0].id)!;
      ret.card = realCard;
      this.hands[seatIndex] = this.hands[seatIndex].filter(c => c.id !== realCard.id);
      this.hands[ret.to].push(realCard);
      this.hands[ret.to] = sortCards(this.hands[ret.to], this.level);
      
      // Add history entry for return tribute
      this.addHistoryEntry(
          HistoryEventType.ReturnTribute,
          `${this.players[seatIndex].name} 向 ${this.players[ret.to].name} 还贡: ${this.getCardDescription([realCard])}`,
          seatIndex,
          { card: realCard, to: ret.to }
      );
      
      this.checkReturnDone();
      this.broadcastGameState();
  }
  
  checkReturnDone() {
      const allDone = this.tributeState.pendingReturns.every(r => r.card);
      if (allDone) {
          this.currentPhase = GamePhase.Playing;
          // Set start player based on tribute result
          if (this.tributeState.nextStartPlayer !== undefined) {
              this.currentTurn = this.tributeState.nextStartPlayer;
          } else {
              // Fallback (Shouldn't happen if tribute occurred)
              this.currentTurn = this.prevWinners[0];
          }
          this.tributeState = { pendingTributes: [], pendingReturns: [] }; // Clear
          this.broadcastGameState();
      }
  }

  handlePlayHand(seatIndex: number, cards: Card[], providedHandType?: Hand) {
      if (this.currentPhase !== GamePhase.Playing) return;
      if (this.currentTurn !== seatIndex) return;
      
      // Use provided hand type if available, otherwise infer it
      let hand: Hand | null;
      if (providedHandType) {
          // Validate that the provided hand type is actually valid for these cards
          const inferredHand = getHandType(cards, this.level);
          if (!inferredHand) {
              this.emitError(seatIndex, 'Invalid hand');
              return;
          }
          // Use the provided interpretation
          hand = providedHandType;
      } else {
          hand = getHandType(cards, this.level);
          if (!hand) {
              this.emitError(seatIndex, 'Invalid hand');
              return;
          }
      }
      
      // Debug Log
      console.log(`Player ${seatIndex} plays. Level: ${this.level}. Hand: ${hand.type} (Val: ${hand.value}). LastHand: ${this.lastHand ? `${this.lastHand.hand.type} (Val: ${this.lastHand.hand.value})` : 'None'}`);

      if (this.lastHand && this.lastHand.playerIndex !== seatIndex) {
          // Compare
          const result = compareHands(hand, this.lastHand.hand);
          if (result <= 0) {
               console.log(`Compare failed: ${result}`);
               this.emitError(seatIndex, 'Hand not big enough');
               return;
          }
      }
      
      const playerHand = this.hands[seatIndex];
      // Check if cards exist in hand (by ID)
      const validCards = cards.every(c => playerHand.some(ph => ph.id === c.id));
      if (!validCards) {
           this.emitError(seatIndex, 'You do not have these cards');
           return;
      }

      // Remove cards
      const newHand = playerHand.filter(c => !cards.some(played => played.id === c.id));
      this.hands[seatIndex] = newHand;
      
      // 记录全局已出牌 + 该座位的"出牌套路"（是否自由领出，用于判断他手里还剩什么结构）
      this.playedCards.push(...cards);
      const isLead = !this.lastHand || this.lastHand.playerIndex === seatIndex;
      this.cardTracker.recordPlay(cards, seatIndex, hand, isLead);
      
      this.lastHand = { playerIndex: seatIndex, hand };
      this.passCount = 0;
      
      // Reset round actions when someone plays (new round starts)
      this.roundActions = {};
      this.roundActions[seatIndex] = { type: 'play', cards: cards, hand: hand };
      
      // Add history entry
      const handTypeName = {
          'Single': '单牌', 'Pair': '对子', 'Trips': '三张', 'TripsWithPair': '三带二',
          'Straight': '顺子', 'Tube': '钢板', 'Plate': '连对', 
          'Bomb': '炸弹', 'StraightFlush': '同花顺', 'FourKings': '四大天王'
      }[hand.type] || hand.type;
      this.addHistoryEntry(
          HistoryEventType.Play,
          `${this.players[seatIndex].name} 出牌: ${handTypeName} (${this.getCardDescription(cards)})`,
          seatIndex,
          { cards, handType: hand.type, cardsCount: cards.length, remainingHand: this.hands[seatIndex] }
      );
      
      if (this.hands[seatIndex].length === 0) {
          this.winners.push(seatIndex);
          
          // Add history entry for player finish
          const placeNames = ['第一名', '第二名', '第三名', '第四名'];
          const position = placeNames[Math.min(this.winners.length - 1, placeNames.length - 1)];
          this.addHistoryEntry(
              HistoryEventType.PlayerFinish,
              `${this.players[seatIndex].name} 出完所有牌，获得${position}！`,
              seatIndex,
              { position: this.winners.length }
          );
          
          // Check Double Win (First two winners are same team) — only for 4-player
          if (this.numPlayers === 4 && this.winners.length === 2) {
              const p1 = this.winners[0];
              const p2 = this.winners[1];
              if ((p1 % 2) === (p2 % 2)) {
                  // Double Win!
                  const allIndices = Array.from({ length: this.numPlayers }, (_, i) => i);
                  const losers = allIndices.filter(i => !this.winners.includes(i));
                  this.winners.push(...losers); 
                  this.endGame();
                  return;
              }
          }
          
          // 3-player mode: when 2 players finish, game ends (no teams)
          if (this.numPlayers === 3 && this.winners.length === 2) {
              const allIndices = Array.from({ length: this.numPlayers }, (_, i) => i);
              const last = allIndices.find(i => !this.winners.includes(i))!;
              this.winners.push(last);
              this.endGame();
              return;
          }
          
          // General Rule: If numPlayers-1 players have finished, game MUST end.
          if (this.winners.length === this.numPlayers - 1) {
              const allIndices = Array.from({ length: this.numPlayers }, (_, i) => i);
              const last = allIndices.find(i => !this.winners.includes(i))!;
              this.winners.push(last);
              this.endGame();
              return;
          }
      }
      
      this.advanceTurn();
  }
  
  // Helper to end current round and find next start player
  endRoundAndFindNext(winner: number) {
      console.log(`[endRound] Round ended. Winner: ${winner}`);
      const num = this.numPlayers;
      
      // JieFeng Logic: 4人模式 - 如果winner走完了, 队友接风
      // 3人模式 - 无队友, 直接找下家有牌的人
      if (this.gameVariant === GameVariant.FourPlayer) {
          if (this.hands[winner].length === 0) {
              console.log(`[endRound] Winner ${winner} has no cards. Partner接风.`);
              winner = (winner + 2) % num;
          }
      } else {
          // 3人模式: winner走完了直接找下家有牌的
          if (this.hands[winner].length === 0) {
              console.log(`[endRound] Winner ${winner} has no cards (3-player). Finding next.`);
          }
      }
      
      this.lastHand = null;
      this.passCount = 0;
      this.roundActions = {}; 

      // Find next player with cards
      const order: number[] = [];
      for (let i = 0; i < num; i++) {
          order.push((winner + i) % num);
      }
      let found = false;
      for (const seat of order) {
          if (this.hands[seat] && this.hands[seat].length > 0) {
              this.currentTurn = seat;
              found = true;
              console.log(`[endRound] Next turn goes to seat ${seat}`);
              break;
          }
      }
      
      if (!found) {
          console.log('[endRound] All players finished, ending game');
          this.endGame();
          return;
      }
      
      this.broadcastGameState();
  }

  handlePass(seatIndex: number) {
      if (this.currentPhase !== GamePhase.Playing) return;
      if (this.currentTurn !== seatIndex) return;
      
      if (!this.lastHand || this.lastHand.playerIndex === seatIndex) {
          this.emitError(seatIndex, 'Cannot pass on free turn');
          return;
      }
      
      this.roundActions[seatIndex] = { type: 'pass' };
      // 记录"他对哪种牌型选择了过牌"——pass 过某牌型通常说明他手里没有该类牌
      this.cardTracker.recordPass(seatIndex, this.lastHand?.hand.type);
      console.log(`[handlePass] Player ${seatIndex} passed.`);
      
      // Add history entry
      this.addHistoryEntry(
          HistoryEventType.Pass,
          `${this.players[seatIndex].name} 选择过牌`,
          seatIndex
      );
      
      this.advanceTurn();
  }
  
  advanceTurn() {
      const prevTurn = this.currentTurn;
      const num = this.numPlayers;
      let next = (this.currentTurn + 1) % num;
      
      // Look ahead up to num times to find next valid player
      for (let i = 0; i < num; i++) {
          // Check if we cycled back to the round winner (or their seat)
          if (this.lastHand && next === this.lastHand.playerIndex) {
               console.log(`[advanceTurn] Cycled back to last player ${next}. Round End.`);
               this.endRoundAndFindNext(next);
               return;
          }

          const isFinished = this.hands[next].length === 0;
          const isSkipped = this.skipNextTurn[next];
          
          if (isFinished) {
              console.log(`[advanceTurn] Skipping seat ${next} (no cards)`);
              next = (next + 1) % num;
              continue;
          }
          
          if (isSkipped) {
              console.log(`[advanceTurn] Skipping seat ${next} (乐不思蜀 effect)`);
              this.skipNextTurn[next] = false;
              this.io.to(this.roomId).emit('error', `${this.players[next].name} 被【乐不思蜀】跳过了回合！`);
              this.roundActions[next] = { type: 'pass' };
              
              next = (next + 1) % num;
              continue;
          }
          
          // If we cycled back to the same player who just passed, all others are finished/skipped
          if (next === prevTurn) {
              console.log(`[advanceTurn] All other players finished, round ends for ${next}`);
              this.endRoundAndFindNext(next);
              return;
          }
          
          // Found valid player
          this.currentTurn = next;
          console.log(`[advanceTurn] Turn changed: ${prevTurn} -> ${next}.`);
          this.broadcastGameState();
          return;
      }
      
      // If we exit loop, everyone is finished?
      this.endGame();
  }
  
  // ==================== SKILL CARD METHODS ====================
  
  dealSkillCards() {
      // Create skill pool: 2 of each type = 10 cards
      const pool: SkillCard[] = [];
      const types = [SkillCardType.DrawTwo, SkillCardType.Steal, SkillCardType.Discard, 
                     SkillCardType.Skip, SkillCardType.Harvest];
      types.forEach(type => {
          pool.push({ id: `skill-${type}-1`, type });
          pool.push({ id: `skill-${type}-2`, type });
      });
      
      // Shuffle pool
      for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      
      // Deal 2 cards to each player
      this.skillCards = Array.from({ length: this.numPlayers }, () => []);
      const cardsPerPlayer = Math.min(2, Math.floor(pool.length / this.numPlayers));
      for (let i = 0; i < this.numPlayers; i++) {
          this.skillCards[i] = [];
          for (let j = 0; j < cardsPerPlayer; j++) {
              this.skillCards[i].push(pool[i * cardsPerPlayer + j]);
          }
      }
      
      console.log(`[Skill] Dealt skill cards in Skill mode (${this.numPlayers} players)`);
  }
  
  generateRandomCard(): Card {
      // Generate a random card (can create "extra" cards beyond 2 decks)
      const suits = [Suit.Spades, Suit.Hearts, Suit.Clubs, Suit.Diamonds];
      const ranks = [Rank.Two, Rank.Three, Rank.Four, Rank.Five, Rank.Six, Rank.Seven,
                     Rank.Eight, Rank.Nine, Rank.Ten, Rank.Jack, Rank.Queen, Rank.King, Rank.Ace];
      
      // Small chance for joker
      if (Math.random() < 0.05) {
          const isSmall = Math.random() < 0.5;
          return {
              id: `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              suit: Suit.Joker,
              rank: isSmall ? Rank.SmallJoker : Rank.BigJoker
          };
      }
      
      const suit = suits[Math.floor(Math.random() * suits.length)];
      const rank = ranks[Math.floor(Math.random() * ranks.length)];
      
      const card: Card = {
          id: `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          suit,
          rank
      };
      
      // Update properties based on current level
      if (rank === this.level) {
          card.isLevelCard = true;
          if (suit === Suit.Hearts) {
              card.isWild = true;
          }
      }
      
      return card;
  }
  
  handleUseSkill(seatIndex: number, skillId: string, targetSeat?: number) {
      // Check if game is still active
      if (!this.isActive) {
          console.log(`[Skill] Game is no longer active, ignoring skill use`);
          return;
      }
      
      // Check if game has ended
      if (this.winners.length >= 3) {
          this.emitError(seatIndex, '游戏已结束，无法使用技能');
          return;
      }
      
      if (this.gameMode !== GameMode.Skill) {
          this.emitError(seatIndex, '当前不是技能模式');
          return;
      }
      if (this.currentPhase !== GamePhase.Playing) {
          this.emitError(seatIndex, '只能在出牌阶段使用技能');
          return;
      }
      if (this.currentTurn !== seatIndex) {
          this.emitError(seatIndex, '不是你的回合');
          return;
      }
      
      const skillIndex = this.skillCards[seatIndex].findIndex(s => s.id === skillId);
      if (skillIndex === -1) {
          this.emitError(seatIndex, '你没有这张技能卡');
          return;
      }
      
      const skill = this.skillCards[seatIndex][skillIndex];
      
      // Validate target for skills that need it
      const needsTarget = [SkillCardType.Steal, SkillCardType.Discard, SkillCardType.Skip];
      if (needsTarget.includes(skill.type)) {
          if (targetSeat === undefined || targetSeat === seatIndex) {
              this.emitError(seatIndex, '请选择一个目标玩家');
              return;
          }
          // Target must be active (have cards)
          if (this.hands[targetSeat].length === 0) {
              this.emitError(seatIndex, '目标玩家已出完牌');
              return;
          }
      }
      
      // Apply the skill effect first
      const success = this.applySkillEffect(skill.type, seatIndex, targetSeat);
      
      if (success) {
          // Only remove the skill card after successful application
          this.skillCards[seatIndex].splice(skillIndex, 1);
          console.log(`[Skill] Player ${seatIndex} used ${skill.type}${targetSeat !== undefined ? ` on Player ${targetSeat}` : ''}`);
          
          // Add history entry for skill use
          const skillNames = {
              [SkillCardType.DrawTwo]: '无中生有',
              [SkillCardType.Steal]: '顺手牵羊',
              [SkillCardType.Discard]: '过河拆桥',
              [SkillCardType.Skip]: '乐不思蜀',
              [SkillCardType.Harvest]: '五谷丰登'
          };
          const skillName = skillNames[skill.type];
          const targetName = targetSeat !== undefined ? this.players[targetSeat].name : '';
          const message = targetSeat !== undefined 
              ? `${this.players[seatIndex].name} 对 ${targetName} 使用了 ${skillName}`
              : `${this.players[seatIndex].name} 使用了 ${skillName}`;
          this.addHistoryEntry(
              HistoryEventType.SkillUse,
              message,
              seatIndex,
              { skillType: skill.type, targetSeat }
          );
          
          this.broadcastGameState();
      }
  }
  
  applySkillEffect(type: SkillCardType, user: number, target?: number): boolean {
      // Check if game is still active
      if (!this.isActive || this.winners.length >= 3) {
          console.log(`[Skill] Cannot apply skill effect, game is ending/ended`);
          return false;
      }
      
      const playerName = this.players[user].name;
      const targetName = target !== undefined ? this.players[target].name : '';
      
      // Helper to track new cards
      const trackNewCard = (seat: number, cardId: string) => {
          if (!this.newCardIds[seat]) {
              this.newCardIds[seat] = [];
          }
          this.newCardIds[seat].push(cardId);
      };
      
      switch (type) {
          case SkillCardType.DrawTwo: {
              // 无中生有: Get 2 random cards
              const card1 = this.generateRandomCard();
              const card2 = this.generateRandomCard();
              this.hands[user].push(card1, card2);
              this.hands[user] = sortCards(this.hands[user], this.level);
              trackNewCard(user, card1.id);
              trackNewCard(user, card2.id);
              this.io.to(this.roomId).emit('error', `${playerName} 使用了【无中生有】，获得2张牌！`);
              return true;
          }
          
          case SkillCardType.Steal: {
              // 顺手牵羊: Steal 1 random card from target
              if (target === undefined || this.hands[target].length === 0) return false;
              const targetHand = this.hands[target];
              const randIdx = Math.floor(Math.random() * targetHand.length);
              const stolenCard = targetHand.splice(randIdx, 1)[0];
              this.hands[user].push(stolenCard);
              this.hands[user] = sortCards(this.hands[user], this.level);
              trackNewCard(user, stolenCard.id);
              this.io.to(this.roomId).emit('error', `${playerName} 对 ${targetName} 使用了【顺手牵羊】！`);
              return true;
          }
          
          case SkillCardType.Discard: {
              // 过河拆桥: Target discards 1 random card
              if (target === undefined || this.hands[target].length === 0) return false;
              const targetHand = this.hands[target];
              const randIdx = Math.floor(Math.random() * targetHand.length);
              targetHand.splice(randIdx, 1);
              this.io.to(this.roomId).emit('error', `${playerName} 对 ${targetName} 使用了【过河拆桥】！`);
              return true;
          }
          
          case SkillCardType.Skip: {
              // 乐不思蜀: Target skips next turn
              if (target === undefined) return false;
              this.skipNextTurn[target] = true;
              this.io.to(this.roomId).emit('error', `${playerName} 对 ${targetName} 使用了【乐不思蜀】！下回合将被跳过！`);
              return true;
          }
          
          case SkillCardType.Harvest: {
              // 五谷丰登: All active players get 1 random card
              // Explicitly filter out players who have finished
              const activePlayers = [0, 1, 2, 3].filter(i => 
                  this.hands[i].length > 0 && !this.winners.includes(i)
              );
              activePlayers.forEach(seat => {
                  const card = this.generateRandomCard();
                  this.hands[seat].push(card);
                  this.hands[seat] = sortCards(this.hands[seat], this.level);
                  trackNewCard(seat, card.id);
              });
              this.io.to(this.roomId).emit('error', `${playerName} 使用了【五谷丰登】，每人获得1张牌！`);
              return true;
          }
          
          default:
              return false;
      }
  }
  
  // ==================== END SKILL CARD METHODS ====================
  
  endGame() {
      console.log(`[endGame] Game ended. Winners: ${this.winners.join(', ')}`);
      this.currentPhase = GamePhase.Score;
      
      // Add history entry for game end
      const winnerNames = this.winners.map(w => this.players[w].name).join(', ');
      const team0 = this.winners.filter(w => w % 2 === 0);
      const team1 = this.winners.filter(w => w % 2 === 1);
      
      let resultType = '';
      if (team0.length === 2 && this.winners[0] % 2 === 0 && this.winners[1] % 2 === 0) {
          resultType = 'Team 0 双扣！';
      } else if (team1.length === 2 && this.winners[0] % 2 === 1 && this.winners[1] % 2 === 1) {
          resultType = 'Team 1 双扣！';
      } else if (this.winners[0] % 2 === this.winners[2] % 2) {
          resultType = `Team ${this.winners[0] % 2} 单扣`;
      } else {
          resultType = `Team ${this.winners[0] % 2} 保级`;
      }
      
      this.resultType = resultType;
      this.addHistoryEntry(
          HistoryEventType.GameEnd,
          `游戏结束！${resultType} - 排名: ${winnerNames}`,
          undefined,
          { winners: this.winners, resultType }
      );
      
      // 每局落盘完整记录（复盘用），在广播/回调之前写盘保证数据完整
      saveGameRecord(this, 'finished');
      
      // Broadcast final game state FIRST so clients see the last hand
      this.broadcastGameState();
      
      // Then send gameOver event
      this.io.to(this.roomId).emit('gameOver', { winners: this.winners });
      
      // Call onGameEnd callback if set (used by Match)
      if (this.onGameEnd) {
          this.onGameEnd(this.winners);
      }
  }

  emitError(seatIndex: number, msg: string) {
      const p = this.players[seatIndex];
      if (!p.isBot && p.socket) {
          p.socket.emit('error', msg);
      }
  }

  broadcastGameState() {
    this.players.forEach((p, idx) => {
        if (!p.isBot && p.socket) {
            const myNewCardIds = this.newCardIds[idx] || [];
            // 诊断用：发送队友BOT的完整手牌（3人模式无队友，或队友是真人时不发）
            let allyHand: Card[] | undefined;
            if (this.players.length === 4) {
                const partnerIdx = (idx + 2) % 4;
                const partner = this.players[partnerIdx];
                if (partner && partner.isBot) {
                    allyHand = this.hands[partnerIdx] || [];
                }
            }
            p.socket.emit('gameState', {
                phase: this.currentPhase,
                level: this.level,
                currentTurn: this.currentTurn,
                hands: this.hands.map((h, i) => i === idx ? h : h.length),
                allyHand, // 队友BOT的完整手牌（诊断用）
                lastHand: this.lastHand,
                roundActions: this.roundActions,
                winners: this.winners,
                tributeState: this.currentPhase === GamePhase.Tribute || this.currentPhase === GamePhase.ReturnTribute ? this.tributeState : undefined,
                teamLevels: this.teamLevels,
                activeTeam: this.activeTeam,
                // Skill mode data
                gameMode: this.gameMode,
                mySkillCards: this.skillCards[idx],  // Only send player's own skill cards
                skipNextTurn: this.skipNextTurn,
                // New cards highlight
                newCardIds: myNewCardIds,
                // Game history
                history: this.history,
                currentRound: this.currentRound
            });
            
            // Delay clearing newCardIds to give client time to display highlight
            if (myNewCardIds.length > 0) {
                const timeout = setTimeout(() => {
                    if (this.isActive) {
                        this.newCardIds[idx] = [];
                    }
                }, 2000); // Clear after 2 seconds
                this.registerTimeout(timeout);
            }
        }
    });
    
    // Don't globally clear newCardIds anymore
    // this.newCardIds = {};
    
    // Bot Turn Logic
    const currentPlayer = this.players[this.currentTurn];
    if (currentPlayer && currentPlayer.isBot && this.currentPhase === GamePhase.Playing && this.winners.length < 3) {
        // Capture the current seat to avoid race conditions
        const botSeat = this.currentTurn;
        console.log(`[Bot] Scheduling Bot ${botSeat} to play in 1.5s...`);
        const timeout = setTimeout(() => {
            if (!this.isActive) {
                console.log(`[Bot] Game no longer active, aborting bot turn for seat ${botSeat}`);
                return;
            }
            this.handleBotTurn(botSeat);
        }, 1500);
        this.registerTimeout(timeout);
    } else {
        // Human's turn or game over
        console.log(`[Turn] Now waiting for Player ${this.currentTurn} (Human) to play. Phase: ${this.currentPhase}`);
    }
  }
  
  // Bot emoji/chat messages
  botEmojis = {
      play: ['😎', '✨', '💪', '🔥', '👍', '😏', '🎯', '⚡'],
      bomb: ['💣', '🔥🔥🔥', '💥', '😈', '🚀', '☄️', '🤯'],
      win: ['🎉', '🥳', '😎👍', '✌️', '💯', '🏆'],
      pass: ['😅', '🤔', '😢', '💭', '🙈', '😬'],
      taunt: ['😂', '🤣', '😜', '👀', '🤭', '😁'],
  };
  
  botSendChat(seatIndex: number, category: 'play' | 'bomb' | 'win' | 'pass' | 'taunt') {
      // 30% chance to send emoji
      if (Math.random() > 0.3) return;
      
      const emojis = this.botEmojis[category];
      const emoji = emojis[Math.floor(Math.random() * emojis.length)];
      const botName = this.players[seatIndex].name;
      
      this.io.to(this.roomId).emit('chatMessage', {
          sender: botName,
          text: emoji,
          time: new Date().toLocaleTimeString(),
          seatIndex: seatIndex
      });
  }

  handleBotTurn(seatIndex: number) {
      // Check if game is still active
      if (!this.isActive) {
          console.log(`[Bot] Game is no longer active, aborting bot turn`);
          return;
      }
      
      console.log(`[Bot] handleBotTurn called for seat ${seatIndex}. currentTurn=${this.currentTurn}, phase=${this.currentPhase}`);
      
      if (this.currentPhase !== GamePhase.Playing) {
          console.log(`[Bot] Abort: Phase is ${this.currentPhase}, not Playing`);
          return;
      }
      if (this.currentTurn !== seatIndex) {
          console.log(`[Bot] Abort: currentTurn is ${this.currentTurn}, not ${seatIndex}`);
          return;
      }
      
      const hand = this.hands[seatIndex];
      if (hand.length === 0) {
          console.log(`[Bot] Seat ${seatIndex} has no cards left, skipping...`);
          this.advanceTurn();
          return;
      }
      
      // In Skill mode, bot may use a skill first
      if (this.gameMode === GameMode.Skill && this.skillCards[seatIndex].length > 0) {
          const skillDecision = this.decideBotSkillUse(seatIndex);
          if (skillDecision) {
              console.log(`[Bot] Seat ${seatIndex} decides to use skill: ${skillDecision.skill.type}`);
              this.handleUseSkill(seatIndex, skillDecision.skill.id, skillDecision.target);
              // After using skill, schedule another bot turn for playing cards
              const timeout = setTimeout(() => {
                  if (!this.isActive) {
                      console.log(`[Bot] Game no longer active, aborting bot turn for seat ${seatIndex}`);
                      return;
                  }
                  this.handleBotTurn(seatIndex);
              }, 1000);
              this.registerTimeout(timeout);
              return;
          }
      }
      
      const handsInfo = this.hands.map(h => h.length);
      const is3p = this.gameVariant === GameVariant.ThreePlayer;
      const bot = new Bot(hand, this.level, seatIndex, handsInfo, this.cardTracker, is3p);
      const lastPlayerIdx = this.lastHand ? this.lastHand.playerIndex : -1;
      const move = bot.decideMove(this.lastHand ? this.lastHand.hand : null, lastPlayerIdx);
      
      console.log(`[Bot] Seat ${seatIndex} decides: ${move ? `Play ${move.length} cards` : 'Pass'}`);
      
      if (move) {
          // Check if it's a bomb (4+ same cards or straight flush)
          const handType = getHandType(move, this.level);
          const isBomb = handType && (handType.type === HandType.Bomb || handType.type === HandType.StraightFlush || handType.type === HandType.FourKings);
          
          this.handlePlayHand(seatIndex, move);
          
          // Bot sends emoji based on action
          if (isBomb) {
              this.botSendChat(seatIndex, 'bomb');
          } else if (this.hands[seatIndex].length === 0) {
              // Bot just finished all cards
              this.botSendChat(seatIndex, 'win');
          } else {
              this.botSendChat(seatIndex, 'play');
          }
      } else {
          this.handlePass(seatIndex);
          this.botSendChat(seatIndex, 'pass');
      }
  }
  
  decideBotSkillUse(seatIndex: number): { skill: SkillCard, target?: number } | null {
      const mySkills = this.skillCards[seatIndex];
      if (mySkills.length === 0) return null;
      
      const myTeam = seatIndex % 2;
      const teammates = [0, 1, 2, 3].filter(i => i % 2 === myTeam && i !== seatIndex && this.hands[i].length > 0);
      const opponents = [0, 1, 2, 3].filter(i => i % 2 !== myTeam && this.hands[i].length > 0);
      const activePlayers = [0, 1, 2, 3].filter(i => this.hands[i].length > 0);
      
      const myHandSize = this.hands[seatIndex].length;
      
      // Strategy: Use skills based on situation
      for (const skill of mySkills) {
          switch (skill.type) {
              case SkillCardType.DrawTwo:
                  // Use if I have few cards (< 10)
                  if (myHandSize < 10) {
                      return { skill };
                  }
                  break;
                  
              case SkillCardType.Steal:
                  // Steal from opponent with most cards
                  if (opponents.length > 0) {
                      const target = opponents.reduce((a, b) => 
                          this.hands[a].length > this.hands[b].length ? a : b);
                      if (this.hands[target].length > 5) {
                          return { skill, target };
                      }
                  }
                  break;
                  
              case SkillCardType.Discard:
                  // Discard from opponent with few cards (close to winning)
                  if (opponents.length > 0) {
                      const target = opponents.find(o => this.hands[o].length <= 5 && this.hands[o].length > 0);
                      if (target !== undefined) {
                          return { skill, target };
                      }
                  }
                  break;
                  
              case SkillCardType.Skip:
                  // Skip opponent who is about to win
                  if (opponents.length > 0) {
                      const target = opponents.find(o => this.hands[o].length <= 3);
                      if (target !== undefined) {
                          return { skill, target };
                      }
                  }
                  break;
                  
              case SkillCardType.Harvest:
                  // Use if hand sizes are relatively balanced
                  if (myHandSize < 15 && activePlayers.length >= 3) {
                      return { skill };
                  }
                  break;
          }
      }
      
      // Randomly use a skill 20% of the time if we have one
      if (Math.random() < 0.2 && mySkills.length > 0) {
          const skill = mySkills[0];
          if ([SkillCardType.DrawTwo, SkillCardType.Harvest].includes(skill.type)) {
              return { skill };
          }
          if ([SkillCardType.Steal, SkillCardType.Discard, SkillCardType.Skip].includes(skill.type)) {
              if (opponents.length > 0) {
                  return { skill, target: opponents[0] };
              }
          }
      }
      
      return null;
  }
}
