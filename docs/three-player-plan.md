# 三人掼蛋改造方案

## 规则摘要（网络搜索整理）

| 项目 | 规则 |
|------|------|
| 牌数 | 两副108张，**去掉一种花色(梅花)全部26张 + 去掉1张大王 = 81张**，每人27张 |
| 座位 | 3人三角形排列，无对家 |
| 队友 | 各打各的，无队友 |
| 升级 | 头游升3级，二游升1级，末游不升级 |
| 进贡 | 末游向头游进贡最大牌，头游还牌≤10 |
| 接风 | 无（无队友，走完即停） |
| 三王炸 | 3张王组成最大炸弹（>同花顺） |
| 逢人配 | 保留（红桃级牌万能配） |

## 需修改文件清单

### 1. src/shared/types.ts
- 添加 `GameMode.ThreePlayer` 或新增 `GameVariant`

### 2. src/server/room.ts
- `Room` 类：`players` 数组长度改为根据游戏模式动态
- `maxPlayers: 4` → 根据 room.gameMode 返回 3 或 4
- Bot 填充逻辑：3人模式只填充2个Bot

### 3. src/server/match.ts
- Match 类：选手数量和座位逻辑适配3人

### 4. src/server/game.ts （改动最大）
- `createDeck()` 调用前判断模式，3人时调用 `createThreePlayerDeck()`
- `this.hands = [[], [], [], []]` → 改为动态长度
- `i % 4` → 改为 `i % numPlayers`
- `winners` 收集逻辑：只取第1名，无队友配合
- 炸弹检测：兼容3张王炸
- 进贡/还贡：3人版简化
- 升级逻辑：头游+3级，二游+1级
- 接风规则：无对家，玩家走完即停

### 5. src/shared/deck.ts
- 新增 `createThreePlayerDeck()`：去掉梅花花色(2-A全部) + 去掉1张大王 = 81张

### 6. src/shared/rules.ts
- 添加三王炸检测（3张王 = 最大炸弹）

### 7. src/shared/bot.ts
- Bot 适配3人模式：无 `isAlly`，无队友配合策略
- `decideAllyFollow` 在3人模式下放回
- `decideBomb` / `decideEnemyFollow` 简化

### 8. src/client/useGame.ts
- 传递 `gameMode` 到服务端创建请求

### 9. src/client/components/Lobby.tsx
- 新增模式选择器（三人掼蛋 / 四人掼蛋）
- 房间创建时携带模式选项

### 10. src/client/components/GameTable.tsx （改动较大）
- 3人三角形座位布局（上/左/右，无对家）
- 游戏模式指示器
- 不同模式下的操作提示

## 预估工作量

| 文件 | 改动量 | 复杂度 |
|------|--------|--------|
| src/shared/types.ts | +5行 | 低 |
| src/shared/deck.ts | +20行 | 中 |
| src/shared/rules.ts | +10行 | 低 |
| src/shared/bot.ts | +30行 | 中 |
| src/server/room.ts | +20行 | 中 |
| src/server/match.ts | +30行 | 中 |
| src/server/game.ts | +150行 | 高 |
| src/client/useGame.ts | +10行 | 低 |
| client/Lobby.tsx | +40行 | 低 |
| client/GameTable.tsx | +100行 | 高 |

**总计：约400-500行，覆盖10个文件，大约需要2-3轮部署**

## 风险点

1. **发牌逻辑耦合度极高** — current code has many hardcoded `4` patterns
2. **Bot 策略简化** — 3人模式 Bot 变弱（无配合），但 AI 简化后逻辑更容易
3. **UI 布局** — 3人圆形布局需要重新设计，但可以复用现有组件
4. **现有游戏兼容** — 已有进行中的4人游戏不受影响

是否需要我开始实施？可以先从核心逻辑（server/game.ts + deck.ts）开始，再改前端。
