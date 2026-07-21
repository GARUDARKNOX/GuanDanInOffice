import { Server } from 'socket.io';
import { Game } from './game';
import { Player } from './room';
import { GameMode, GameVariant } from '../shared/types';

/**
 * Match represents a full game series (从2打到A)
 * Contains multiple Games until one team reaches A and wins twice consecutively
 */
export class Match {
    io: Server;
    roomId: string;
    players: Player[];
    gameMode: GameMode;
    gameVariant: GameVariant;

    currentGame: Game | null = null;
    teamLevels: { [key: number]: number } = { 0: 2, 1: 2 }; // Team 0 (seats 0,2) and Team 1 (seats 1,3)
    activeTeam: number = 0; // Which team is the banker (打庄)
    level: number = 2; // 三人模式用的等级
    
    // Match end tracking
    consecutiveWins: { [key: number]: number } = { 0: 0, 1: 0 }; // Track consecutive wins at level A
    matchWinner: number | null = null; // Team that won the match
    
    // Store last game's winners for tribute phase
    private lastWinners: number[] = [];
    
    constructor(io: Server, roomId: string, players: Player[], gameMode: GameMode, gameVariant: GameVariant = GameVariant.FourPlayer) {
        this.io = io;
        this.roomId = roomId;
        this.players = players;
        this.gameMode = gameMode;
        this.gameVariant = gameVariant;
    }
    
    /**
     * Start the first game in the match
     */
    startMatch() {
        console.log(`[Match ${this.roomId}] Starting new match. Mode: ${this.gameMode}`);
        this.teamLevels = { 0: 2, 1: 2 };
        this.activeTeam = 0;
        this.consecutiveWins = { 0: 0, 1: 0 };
        this.matchWinner = null;
        this.startNextGame();
    }
    
    /**
     * Start a new game within the match
     */
    startNextGame() {
        if (this.matchWinner !== null) {
            console.log(`[Match ${this.roomId}] Match already won by Team ${this.matchWinner}`);
            return;
        }
        
        console.log(`[Match ${this.roomId}] Starting new game. Team levels: ${JSON.stringify(this.teamLevels)}, Active team: ${this.activeTeam}`);
        
        // Destroy old game instance to clean up timeouts and listeners
        if (this.currentGame) {
            this.currentGame.destroy();
        }
        
        // Get previous winners from Match storage
        const prevWinners = this.lastWinners || [];
        
        // Deep copy players array to avoid reference conflicts
        const gamePlayers = this.players.map(p => ({ ...p }));
        
        // Create new game
        this.currentGame = new Game(this.io, this.roomId, gamePlayers, this.gameMode, this.gameVariant);
        this.currentGame.teamLevels = { ...this.teamLevels };
        this.currentGame.activeTeam = this.activeTeam;
        this.currentGame.level = this.level; // 三人模式用
        this.currentGame.prevWinners = prevWinners;
        
        // Listen for game end
        this.currentGame.onGameEnd = (winners: number[]) => this.handleGameEnd(winners);
        
        this.currentGame.start();
    }
    
    /**
     * Handle end of a single game
     */
    handleGameEnd(winners: number[]) {
        const expectedWinners = this.gameVariant === GameVariant.ThreePlayer ? 3 : 4;
        if (winners.length !== expectedWinners) {
            console.error(`[Match ${this.roomId}] Invalid winners array:`, winners);
            return;
        }
        
        console.log(`[Match ${this.roomId}] Game ended. Winners order: ${winners}`);
        
        // 三人模式：头游+3级，直接用level字段
        if (this.gameVariant === GameVariant.ThreePlayer) {
            const firstWinner = winners[0];
            const oldLevel = this.level;
            this.level += 3;
            if (this.level > 14) this.level = 14;
            
            console.log(`[Match ${this.roomId}] Player ${firstWinner} (头游) level: ${oldLevel} -> ${this.level} (+3)`);
            
            // 检查是否打过A
            if (this.level >= 14) {
                console.log(`[Match ${this.roomId}] Level A reached! Match continues until someone finishes at A.`);
                // 三人模式打过A就赢
                this.matchWinner = firstWinner;
                this.broadcastMatchEnd(firstWinner);
                return;
            }
            
            // Store winners for next game's tribute phase
            this.lastWinners = winners;
            
            // Auto-start next game
            const timeout = setTimeout(() => {
                try {
                    console.log(`[Match ${this.roomId}] Auto-starting next game (3-player)...`);
                    this.startNextGame();
                } catch (e) {
                    console.error(`[Match ${this.roomId}] Error auto-starting:`, e);
                }
            }, 3000);
            return;
        }
        
        // 四人模式（原有逻辑）
        // Calculate level up
        const { winningTeam, levelIncrease } = this.calculateLevelUp(winners);
        
        // Update team levels
        const oldLevel = this.teamLevels[winningTeam];
        this.teamLevels[winningTeam] += levelIncrease;
        
        // Cap at A (14)
        if (this.teamLevels[winningTeam] > 14) {
            this.teamLevels[winningTeam] = 14;
        }
        
        const newLevel = this.teamLevels[winningTeam];
        console.log(`[Match ${this.roomId}] Team ${winningTeam} level: ${oldLevel} -> ${newLevel} (+${levelIncrease})`);
        
        // Update active team (banker)
        if (winningTeam !== this.activeTeam) {
            // Banker changes
            this.activeTeam = winningTeam;
            console.log(`[Match ${this.roomId}] Banker changed to Team ${this.activeTeam}`);
        }
        
        // Check for match end condition
        if (this.teamLevels[winningTeam] === 14) {
            // Team reached A
            this.consecutiveWins[winningTeam]++;
            const otherTeam = 1 - winningTeam;
            this.consecutiveWins[otherTeam] = 0; // Reset other team's consecutive wins
            
            console.log(`[Match ${this.roomId}] Team ${winningTeam} at level A. Consecutive wins: ${this.consecutiveWins[winningTeam]}`);
            
            if (this.consecutiveWins[winningTeam] >= 2) {
                // Match won!
                this.matchWinner = winningTeam;
                console.log(`[Match ${this.roomId}] MATCH WON by Team ${winningTeam}!`);
                this.broadcastMatchEnd(winningTeam);
                return;
            }
        } else {
            // Not at A yet, reset consecutive wins
            this.consecutiveWins[0] = 0;
            this.consecutiveWins[1] = 0;
        }
        
        // Store winners in Match for next game's tribute phase
        this.lastWinners = winners;
        
        // Auto-start next game after a short delay
        const timeout = setTimeout(() => {
            try {
                console.log(`[Match ${this.roomId}] Auto-starting next game...`);
                this.startNextGame();
            } catch (err) {
                console.error(`[Match ${this.roomId}] Failed to start next game:`, err);
            }
        }, 3000);
        
        // Store timeout reference for cleanup (Match doesn't have cleanup yet, but good practice)
        if (this.currentGame) {
            (this.currentGame as any)._nextGameTimeout = timeout;
        } // 3 second delay before next game
    }
    
    /**
     * Calculate level increase based on winners
     */
    calculateLevelUp(winners: number[]): { winningTeam: number, levelIncrease: number } {
        const p1 = winners[0];
        const p2 = winners[1];
        const p3 = winners[2];
        
        const isSameTeam = (a: number, b: number) => (a % 2) === (b % 2);
        const winningTeam = p1 % 2;
        
        let levelIncrease = 0;
        if (isSameTeam(p1, p2)) {
            // Double win (1st and 2nd same team) -> +3
            levelIncrease = 3;
        } else if (isSameTeam(p1, p3)) {
            // 1st and 3rd same team -> +2
            levelIncrease = 2;
        } else {
            // Only 1st place -> +1
            levelIncrease = 1;
        }
        
        return { winningTeam, levelIncrease };
    }
    
    /**
     * Broadcast match end to all players
     */
    broadcastMatchEnd(winningTeam: number) {
        const teamPlayers = this.players.filter(p => p.seatIndex % 2 === winningTeam);
        this.io.to(this.roomId).emit('matchOver', {
            winningTeam,
            winners: teamPlayers.map(p => ({ name: p.name, seatIndex: p.seatIndex })),
            finalLevels: this.teamLevels
        });
    }
    
    /**
     * Get current match state for clients
     */
    getMatchState() {
        return {
            teamLevels: this.teamLevels,
            activeTeam: this.activeTeam,
            consecutiveWins: this.consecutiveWins,
            matchWinner: this.matchWinner,
            inProgress: this.currentGame !== null && this.matchWinner === null
        };
    }
    
    /**
     * Force end the current match
     */
    forceEndMatch() {
        console.log(`[Match ${this.roomId}] Force ending match`);
        if (this.currentGame) {
            this.currentGame.destroy();
        }
        this.currentGame = null;
        this.matchWinner = null;
        this.consecutiveWins = { 0: 0, 1: 0 };
    }
}
