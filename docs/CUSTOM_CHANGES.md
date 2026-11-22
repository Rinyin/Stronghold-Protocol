# 自定义修改记录（Rinyin Fork）

本文档持续记录本仓库相对于上游 `sganggs/Stronghold-Protocol` 的所有定制修改，便于后续迭代、参数微调、合并上游更新与问题排查。

## 开发与发布约定

- **开发目录与分支**：`/www/Stronghold-Protocol-dev`（`dev` 分支，Git worktree）。所有代码修改、文档记录、回归测试与 `git push origin dev` 均在此完成。
- **线上目录与分支**：`/www/Stronghold-Protocol`（`master` 分支），由 `stronghold-protocol.service` 托管对外提供 `https://sp.rinyin.top`。
- **上线门禁**：每次修改必须同步更新本文档并推送到 `origin/dev`；**未经明确许可，严禁将改动合并到 `master` 或重启线上服务**。

---

## #1 · 2026-11-23 · 商店刷新动态提权机制（低血量 / 连续高扣血保护）

### 1.1 背景与目标

原版商店干员刷新采用纯「剩余拷贝数加权（copy-weighted）」机制，不存在按阵容、盟约或血量的动态倾斜。当玩家陷入低血量危机或连续两回合大幅失血时，在保持原有卡池剩余拷贝数约束的前提下，略微提升其场上已有干员与核心高叠层盟约干员的刷新权重，使玩家在约 1–2 个休整回合的刷新内可明显感知到搜卡更顺手，并在战力稳住（连续两回合完美作战）后自动退出提权。

### 1.2 规则细则

1. **触发条件**（满足任一即开启 `active = true`，并将激活后完美连胜计数 `perfectStreak` 清零）：
   - **条件 A（首次低血量）**：玩家存活（`lp > 0`）且血量**首次**低于 `8`（`lp < 8`）。该条件整局只消耗一次（`lowHpTriggered = true`），后续若已通过完美作战关闭提权，即使血量仍低于 `8` 也不会再次触发。
   - **条件 B（连续两回合高扣血）**：任意连续两回合的总扣血量达到 `15`（`prevRoundLoss + totalRoundLoss >= 15`，且当回合有实际扣血）。休整期通过策略指令主动扣血（如 `skill_drop_hp_to_low_gain_coin`）同样计入并可即时触发。
2. **关闭条件**：
   - 激活后，接下来**任意连续 2 回合完美作战**（无扣血、无己方漏怪且 `r.perfect !== false`，与游戏内完美连胜口径一致；己方漏怪但被队友联防全部拦下不算完美作战），立即关闭提权（`active = false`）；中间出现非完美回合则计数归零重计。
   - 玩家被淘汰（`lp <= 0`）时立即关闭。
3. **提权对象与权重倍率**（乘在候选干员当前的剩余拷贝数 `left` 上；`left <= 0` 的干员仍不可刷出）：
   - **场上已有干员**（`boardBaseIds`）：当前部署在 `ps.board` 上的所有干员（含精锐，按 `gd.baseIdOf(piece.id)` 匹配商店基础干员，兼容自选干员），权重 **`×1.60`**。
   - **层数最高的 3 个盟约的干员**（`topComebackBonds`）：
     - 仅统计当前层数 `> 0`、未被模式静态禁用、且本局卡池/自选池中存在成员干员的盟约（自动跳过无成员干员的计数型盟约如「绝技」`suntShip`）；
     - 比较得分：已激活盟约按 `原始层数 × 1.0`，**未激活盟约按 `原始层数 × 0.75`** 参与排序（同分时依次按：已激活优先 → 原始层数降序 → 数据表顺序）；
     - 取前 3 个盟约，任一匹配这些盟约的干员权重 **`×1.35`**。
   - **叠乘规则**：同时既在场上又属于前 3 盟约的核心干员，两项倍率叠乘为 **`×2.16`**。
4. **作用范围**：
   - 作用于常规商店刷新（`PlayerEconomy.rollShop` → `_rollChessSlot` 与同次刷新内的 `_applyBondRefresh`），涵盖回合开始自动刷新、手动/免费刷新以及公共池 + 个人自选池（`diyRollEntries`），全 5 个官方版本（含默认「规程·序列Ⅰ」）同步生效。
   - 未开启时 `weightMul` 为 `null`，与原版抽卡逻辑与 RNG 消耗完全一致。
   - 装备槽刷新（`rollItem`）、三合一晋升 3 选 1 奖励（`pushRewardOffer`）及机变/特质随机发卡不受影响。

### 1.3 参数与可感知临界点测算

全部可调参数集中定义在 `server/match/shopComeback.js` 顶部常量中：

| 常量名 | 当前值 | 含义 |
|---|---:|---|
| `COMEBACK_LOW_HP` | `8` | 首次低血量触发阈值（严格小于） |
| `COMEBACK_TWO_ROUND_LOSS` | `15` | 连续两回合累计扣血触发阈值（大于等于） |
| `COMEBACK_PERFECT_STOP` | `2` | 激活后连续完美作战关闭回合数 |
| `COMEBACK_TOP_BONDS` | `3` | 参与提权的最高层数盟约数量 |
| `COMEBACK_INACTIVE_BOND_RATIO` | `0.75` | 未激活盟约参与层数比较的折算系数 |
| `COMEBACK_BOARD_WEIGHT_MUL` | `1.6` | 场上已有干员的剩余拷贝权重倍率 |
| `COMEBACK_BOND_WEIGHT_MUL` | `1.35` | 前 3 盟约干员的剩余拷贝权重倍率 |

以默认「规程·序列Ⅰ」Lv5（典型 7 场上干员 + 前 3 盟约，5 格干员商店）实测卡池为例：
- 每 5 格刷新至少刷出 1 个场上干员的概率：**33.4% → 51.5%**（跨过 50% 直观感知临界点，由约每 3 刷见 1 次变为约每 2 刷见 1 次）；
- 前 3 盟约干员期望：**1.49 → 1.93 张/刷**；
- 归一化后单卡相对概率：同时命中约 **+85%**，仅场上约 **+37%**，仅前 3 盟约约 **+15%**；非目标卡仍占约 **58.5%**，保留原有随机性与转阵空间。

### 1.4 涉及文件与接入点

| 文件 | 变更说明 |
|---|---|
| `server/match/shopComeback.js`（新增） | 状态结构 `createComebackState`、结算更新 `recordComebackRound`、休整扣血 `recordComebackPrepLpLoss`、前 3 盟约排序 `topComebackBonds`、权重构造 `shopComebackWeightMul` 与全部参数常量 |
| `server/match/pool.js` | `SharedPool._eligible()` / `SharedPool.roll()` 新增可选参数 `weightMul` |
| `server/match/PlayerState.js` | 在 `PlayerState` 构造函数中初始化 `this.shopComeback` |
| `server/match/player/economy.js` | `rollShop()` 单次刷新构建一次 `weightMul`，传入 `_rollChessSlot()` 与 `_applyBondRefresh()` |
| `server/match/match/settle.js` | 常规回合结算扣血与判定完美作战后调用 `recordComebackRound()` |
| `server/match/match/bossRounds.js` | 最终攻势 `_finishFinal()` 同步血量后调用 `recordComebackRound()`，确保进入第 15 回合隐秘核心整备前状态准确 |
| `server/match/bandCommandEffects.js` | 休整期自扣血指令 `skill_drop_hp_to_low_gain_coin` 处调用 `recordComebackPrepLpLoss()` |
| `test/match/shop-comeback.test.js`（新增） | 覆盖全部触发/退出/连胜打断/休整扣血/75% 折算排序/排除绝技/7,500 格蒙特卡洛抽样测试 |

### 1.5 验证命令

```bash
node --test test/match/shop-comeback.test.js test/match/pool.test.js test/match/economy.test.js test/match/diy-shop.test.js test/match/rules.test.js test/docs-paths.test.js test/docs-consistency.test.js
npx eslint server/match/shopComeback.js server/match/pool.js server/match/PlayerState.js server/match/player/economy.js server/match/match/settle.js server/match/match/bossRounds.js server/match/bandCommandEffects.js test/match/shop-comeback.test.js
npm run typecheck
```
