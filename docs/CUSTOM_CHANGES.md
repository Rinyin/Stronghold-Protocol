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

---

## #2 · 2026-11-23 · 调整商店刷新提权机制的解除保护判定

### 2.1 变更原因

调整 `#1` 的退出保护条件，区分「自己彻底守住不漏怪」与「自己漏怪但依靠队友联防兜住不扣血」两种情况，使保护解除更贴合真实战力恢复节奏。

### 2.2 新解除规则（替代 `#1` 中的 1.2 第 2 条）

开启保护（`active = true`）后，满足以下**任意一条**即立即解除保护（`active = false`，`noLossStreak = 0`）：

1. **单回合没漏怪（队友兜住不算）**：己方本回合战斗无有效漏怪且未扣血（`perfect === true && battleLoss === 0`，即 `counted === 0 && r.perfect !== false`），**1 个回合**立即解除保护。
2. **连续两回合不扣血（含队友联防兜住）**：即使己方有漏怪，但连续 `COMEBACK_NO_LOSS_STOP = 2` 个回合实际战斗扣血 `battleLoss === 0`（如队友联防将漏怪全部拦截），第 2 回合结算后解除保护；中途任一回合发生战斗扣血（`battleLoss > 0`）则 `noLossStreak` 清零重计。

其余触发条件（首次血量 `< 8` 或连续两回合总扣血 `≥ 15`）、提权对象与权重倍率（`×1.60` / `×1.35` / 未激活盟约 75% 折算）保持 `#1` 不变。

### 2.3 代码与常量变更

| 文件 | 变更说明 |
|---|---|
| `server/match/shopComeback.js` | 常量 `COMEBACK_PERFECT_STOP` 改为 `COMEBACK_NO_LOSS_STOP = 2`；状态字段 `perfectStreak` 改为 `noLossStreak`；`recordComebackRound()` 改为单回合 `perfect && battleLoss === 0` 立即关闭、否则 `battleLoss === 0` 累计至 2 回合关闭 |
| `test/match/shop-comeback.test.js` | 更新并扩充单测，验证单回合无漏怪秒解、队友兜住 1 回合保持 / 连续 2 回合解除、中途扣血打断计数及休整期自扣血后两种解除路径 |

---

## #3 · 2026-11-23 · 规程三奥术反隐与莱塔尼亚召唤物禁疗修复（同步 dev 与 master）

### 3.1 修复内容

1. **三奥术攻击范围内敌人隐匿失效 & 法抗削减按本场最大人数/层数（直接移植上游 `dev` 提交 `8e0fbaa3`）**
   - **根因**：旧实现仅在 `statusApplied('stealth')` 触发瞬间检查敌人是否在奥术干员攻击范围内并直接移除 `stealth`，对自带常驻隐匿或先隐匿后走进攻击范围的敌人不生效；法抗削减亦未按官方模板的本场最大人数/层数及无来源攻击口径计算。
   - **修复**（`server/sim/content/bonds/regulation.js`）：新增 `ARCANE_REVEAL`、`arcaneArea()` 与 `syncArcaneStealth()`，每 `0.2s` 及 `statusApplied('stealth')` 时复查，为处于 3 奥术玩家在场成员攻击范围内的隐匿敌人施加反隐标记（`reveal: true`）而非驱散隐匿，离开范围恢复；法抗削减改按本场最大奥术人数与最大层数计算，任意非元素/非生命流失伤害（含无来源）均可触发。
2. **莱塔尼亚“一个小节” / “一个乐部”持有禁疗（PRTS 规则，上游尚未修复）**
   - **根因**：`server/sim/content/bonds/lethania.js` 从敌方数据构造盟约召唤物 `enemy_9025_aclts`（“一个小节”）与 `enemy_9026_acltm`（“一个乐部”）时未附加 `禁疗` 异常效果，导致纯烬艾雅法拉等治疗干员可直接选中并治疗它们（并触发氤氲等治疗衍生效果）。
   - **修复**（`server/sim/content/bonds/lethania.js`）：为两者在 `def` 补充 `abnormal: ['healFree']`，并在 `summonKit.install()` 中挂载常驻 `trait:abnormal`（`flags: { noHeal: true, healFree: true }`）。直接治疗（含纯烬艾雅法拉普攻/S1/S2/S3/氤氲与其他治疗干员）均无法选中或治疗，生命回复速度（`hpRegen` / `regen` 通道）仍正常生效。

### 3.2 涉及文件

| 文件 | 变更说明 |
|---|---|
| `server/sim/content/bonds/regulation.js` | 移植上游 `8e0fbaa3`：三奥术 `ARCANE_REVEAL` 反隐轮询与本场最大人数/层数法抗削减 |
| `server/sim/content/bonds/lethania.js` | 为“一个小节”与“一个乐部”补充 `abnormal: ['healFree']` 及常驻 `noHeal` + `healFree` 禁疗标记 |
| `test/bonds/regulation.test.js` | 移植 `8e0fbaa3` 奥术用例（并补测常驻隐匿进出范围）；新增莱塔尼亚召唤物禁疗与 `hpRegen` 回复单测（覆盖纯烬艾雅法拉普攻/S2/氤氲） |
| `docs/design/engine.md`、`docs/SIM.md`、`docs/history/0.4.0.md` | 同步补充规则与变更记录 |
| `test/golden/act3autochess-v3_1/*.json` | 随玩法修复重生成规程黄金摘要（其余 4 个版本不变） |

---

## #4 · 2026-11-25 · 回流 master 自研改动并同步上游 `upstream/dev`（`c7cea5a9`）

### 4.1 从 `master` 回流至 `dev` 的自研功能与独有修复

1. **客户端原生运营回放功能**（`master` 提交 `e6d1c414` → `dev` `781d7e3a`）
   - 新增 `public/js/replay.js`、`public/css/screens/replay.css`、`public/dev/recordings/demo_ops/`，更新 `public/dev/recordings/index.json`；
   - 在 `public/index.html`、`public/js/main.js`、`public/js/net.js`、`public/js/battle/runner.js`、`public/js/store.js`、`public/js/ui/connBanner.js`、`public/js/screens/{game,lobby,settle,title}.js` 接入只读本地回放（并在 `main.js` 同步隔离上游新增的 `m.peek` 消息）；
   - 在 `public/i18n/{en,ja,ko,zh-TW}.json` 补充 81 条回放界面多语言词条。
2. **Service Worker 游玩期素材自动缓存**（`master` 提交 `da670d3b` → `dev` `6ce09ef7`）
   - 更新 `public/sw.js` 与 `test/ui/asset-import.test.js`，在线加载哈希路径素材时自动写入 `sp-imported-assets-v1` 缓存并批量维护 `/sp-imported-index.json` 索引。
3. **规程玩法独有修复（上游尚未合入部分）**（`master` 提交 `b3497a68` → `dev` `0f81fd5f`，并在合并时保留/增强）
   - **莱塔尼亚「一个乐部」3 攻二连击**（`server/sim/content/bonds/lethania.js`）：每攻击 3 次后下次攻击二连击，采用 `chorusDoubleIds` `Set`、存活与活目标校验及 `priority: -1000` 防止高攻速飞行物重叠覆盖；
   - **维多利亚_2（洛洛）借装取消 5 阶上限**（`server/sim/content/bonds/regulation.js`）：`maxTier = num(bb.filter_item_level, 99)`，允许共享 6 阶红装；
   - **乌萨斯 6 人税后独立生命流失流血**（`server/sim/content/bonds/regulation.js`）：在 `hpDamage` 税后拆分 10 秒独立 `dealHPLose` 流血计时器，仅作用于物/法伤，后击不覆盖前击，来源死亡或离场停止；
   - **叙拉古异常计数补齐**（`server/sim/content/bonds/regulation.js`）：`abnormalCount()` 覆盖 `freeze`/`sleep`/`levitate`/`bind`/`tremble`，并避免冻结/浮空重复计入 `stun`；
   - **伊比利亚持续伤害改为法术生命流失**（`server/sim/content/bonds/regulation.js`）：DoT 使用 `dealHPLose`（绕过闪避与护盾），并在减速超时后归零叠层；
   - **聚合 3 人「庇护」限定物/法伤与实时同步**（`server/sim/content/bonds/regulation.js`）：在保留上游 `§37.298` 官方生命回复速度光环的前提下，庇护按 PRTS 仅降低物理与法术伤害（`physTakenMul`/`artsTakenMul`）并随部署/死亡实时同步；
   - **规程领袖 3 处修复**（`server/sim/content/regulation-bosses.js`）：假想敌：械与巨兽减伤限定仅对物/法伤生效；蜘蛛 `refreshEvade` 记录 `a.evadeSteps` 防止同血量档每帧无限续杯闪避。

### 4.2 同步上游 `upstream/dev`（`55f528e9..c7cea5a9`，247 个提交，`§37.241`–`§37.348`）

- 完整合入上游 round 83–84 全部更新（含同盟盟约速查浮窗 PR #922、作战中查看队友 PR #971、跨时期名片 #877、设置分类搜索 PR #982、规程英文文本 PR #990、大厅预选插件 PR #949、干员攻击转向 PR #730、时装语音 PR #734、本地提取时装/图库 PR #776、全版本「攻击力提升至」减防前结算 `§37.293`、规程全面排查修复及 3D 场景/特效/盟约卡片大改版等）。
- 与上游重合的改动统一采用上游权威官方模板实现：
  - `#3` 的规程三奥术反隐（`§37.287`）与莱塔尼亚召唤物禁疗（PR #997，`§37.345`）均已进入上游主线；
  - 临时盟约层数机制（PR #923，`§37.258`）、萨尔贡单格流沙（`§37.292`）、谢拉格不眠雪山走动追击（`§37.249`）、叙拉古命中后进入 `0.2s` 冷却（`§37.281`）、伊比利亚半径 `1` 单目标弹射（`§37.281`）、莱塔尼亚乐部光环与掉坑召唤（`§37.257`/`§37.304`）、聚合生命回复速度光环（`§37.298`）均采用上游完整实现。
- 保留 `#1`/`#2` 商店刷新动态提权机制（与 `PlayerState.js`、`bossRounds.js`、`settle.js`、`pool.js`、`player/economy.js` 无缝兼容），并随自定义玩法修复同步核验/更新规程黄金数据。


