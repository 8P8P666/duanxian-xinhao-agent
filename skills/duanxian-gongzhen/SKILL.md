---
name: duanxian-gongzhen
description: |
  短线共振信号判定。对指定币种与周期计算 MACD、RSI、KDJ、BOLL 四个技术指标的方向，
  做加权投票得到共振强度，再用六条规则对容易失效的单一指标信号做二次过滤，
  输出四档市场结构评级（强做多 / 谨慎做多 / 震荡 / 强做空）。
  数据来自币安官方公开资源：官方 binance 技能驱动的官方 CLI（binance-cli）、
  官方公开行情接口（data-api.binance.vision）、官方开源数据仓库（data.binance.vision）。
  指标计算与共振判定全部由本仓库自研的纯规则引擎完成（indicators.js + signal-engine.js），
  结果可复现、不依赖任何大模型。
  当用户问「这个币现在多空哪边占优」「四个指标是不是共振了」「这个信号是不是假信号」
  「现在该不该行动 / 有没有被过滤掉」「BTC 一小时级别的结构怎么样」时使用。
metadata:
  version: 1.0.0
  author: 8P8P666
  category: technical-analysis
  engine: indicators.js + signal-engine.js（自研规则引擎）
  official_resources:
    - name: binance-cli
      repo: https://github.com/binance/binance-cli
      role: 官方命令行工具，用 request 子命令调官方公开入口
    - name: data-api.binance.vision
      role: 币安官方公开行情接口（免密钥）
    - name: data.binance.vision
      role: 币安官方开源数据仓库（历史 K 线归档 ZIP）
  optional_skills:
    - name: binance
      reason: 本技能通过官方 binance 技能文档记载的 binance-cli request 用法取数
  license: MIT
---

# 短线共振信号

## 什么时候用

- 想知道**某个币当前多空哪一边占优**，而且要的是多个指标的一致结论而不是单个指标；
- 想判断**四个指标（MACD / RSI / KDJ / BOLL）是不是真的共振了**，共振强度是几个；
- 想识别**「看起来像信号、实际容易失效」的情况** —— 缩量、逆势、追高杀跌、波动压缩等；
- 想看**指定周期**（分钟级到 4 小时级）的结构，而不是只看日线；
- 需要一份**数据来源可核实**（全部走币安官方公开资源）、**结论可复现**的判定结果。

## 什么时候不要用

- 想要**买卖点、目标价、仓位建议** —— 本技能只做结构判定，不给交易指令；
- 想看**链上数据、资金流向、持仓分布** —— 不在本技能口径内；
- 想要**基本面或消息面判断** —— 本技能只用K线量价数据；
- 想要**保证盈利的信号** —— 技术指标天生滞后，本技能只降低噪音、不消除误差。

## 四个数据通道

| 通道 | 数据来源 | 口径与取舍 |
|---|---|---|
| 多平台实时（默认） | 综合交易平台与链上永续平台的公开行情接口 | 与网页版**同一份 `data-direct.js` 代码**，结论完全一致 |
| `--live` | 币安官方公开行情接口 `data-api.binance.vision` | 一次请求取回 K 线，最快；**现货口径** |
| `--official` | 币安官方开源数据仓库 `data.binance.vision` | 历史 K 线归档 ZIP，**可复现、可复核**；T+1 归档，最新一两天通常还没发布 |
| `--skill` | **官方技能 binance + 官方 CLI** | 请求由官方 CLI 发起，打同一个官方公开入口；未装 CLI 时如实回退并标注 |

四个通道共用同一个自研引擎（`indicators.js` + `signal-engine.js`），换的只是取数层。

## 命令示例

```bash
# 默认通道：多平台实时，BTC 1小时
node agent.mjs

# 指定币种与周期
node agent.mjs ETH 15m
node agent.mjs SOL 4h --limit 800

# 币安官方公开行情接口
node agent.mjs BTC --live

# 币安官方开源数据仓库（回溯天数自动算到约 140 根K线）
node agent.mjs BTC --official
node agent.mjs BTC --official --days 5 --spot

# 官方技能通道 + 纯 JSON
node agent.mjs BTC --skill --json

# 自然语言：直接说需求，自动选通道
node agent.mjs "看看 ETH 现在的共振信号"
node agent.mjs "用官方开源数据看看 BTC 一小时"
```

`--json` 时 stdout 是纯 JSON，所有进度与说明都走 stderr，方便被其他程序直接消费。
`--concurrency N` 可调整 `--official` 的并发下载数（默认 4，上限 32）。

**自然语言参数的规则**：只在「没有显式给通道参数」时才用来选通道 —— 显式参数永远优先；
识别不出通道就沿用默认通道，**不会根据一句话去猜币种以外的任何东西**。

> 本技能是**按K线即时计算**的横截面分析，每次运行都重新取数重算，
> **没有需要跨次保留的本地状态**，因此不提供 `--status` / `--reset` 这类状态管理参数。

## 输出字段

顶层：

| 字段 | 含义 |
|---|---|
| `source` | 实际走的通道：`realtime` / `live` / `official` / `skill` |
| `sourceLabel` | 通道的中文说明（直接写进报告用） |
| `via` | 更细的实际路径：`direct` / `official-rest` / `official-archive` / `binance-cli` |
| `requestedSource` | 只在「请求了 `--skill` 但回退」时出现，标明原本请求的是哪个通道 |
| `symbol` / `display` | 交易对（币安命名 / 带斜杠的展示名） |
| `interval` / `intervalLabel` | K线周期 |
| `candleCount` | 本次参与计算的K线根数（**结论与这个数有关，见诚实边界**） |
| `lastCandleTime` / `lastCandleForming` | 最新一根K线的时间、是否仍在形成中 |
| `rating` | 四档评级：`{key, label, desc}` |
| `finalScore` | 过滤后的最终综合评分（-100 ~ +100） |
| `baseScore` / `totalPenalty` | 基础分 / 过滤总扣分（`finalScore ≈ baseScore + totalPenalty`，且扣分只降不升） |
| `agreeSide` / `agreeCount` | 与最终方向一致的指标数（共振强度） |
| `bullVotes` / `bearVotes` | 偏多 / 偏空指标个数 |
| `fullyFiltered` | 是否出现「原本有方向、被过滤到 0」的典型假信号 |
| `judges[]` | 四指标逐项：`{key, name, vote, state, zone, cross, momentum, value}` |
| `filters[]` | 六条过滤规则逐条：`{id, name, status, detail, penalty}`，status 为 `pass` / `trigger` / `ok` |
| `history[]` | 最近 48 根K线的评级轨迹（**只算基础分、不含过滤**，见诚实边界） |
| `archive` | 仅 `--official`：`{dateFrom, dateTo, daysUsed, usedFaceValue, missingDays}` |
| `honesty` | 本次结果必须一起交代的边界说明（**不准省略**） |

## 算法口径

指标计算在 `indicators.js`，共振判定与过滤在 `signal-engine.js`，**全部纯规则、可复现**：

**四个指标与权重**

| 指标 | 参数 | 权重 | 方向判定 |
|---|---|---|---|
| MACD | 12 / 26 / 9 | 1.2 | DIF 在 DEA 上方偏多；识别金叉 / 死叉与柱状动能 |
| RSI | 14（Wilder 平滑） | 0.9 | ≥55 偏多、≤45 偏空，中间中性；标注超买 / 超卖 |
| KDJ | 9 / 3 / 3 | 1.0 | K 在 D 上方偏多；识别金叉 / 死叉；J 值判断极端区 |
| BOLL | 20 周期 / 2 倍标准差 | 1.0 | 收盘价在中轨上方偏多；给出通道位置 %B 与带宽 |

**评分与四档评级**

1. 基础分 = `Σ(权重 × 方向票) ÷ 权重总和 × 100`，区间 -100 ~ +100；
2. 方向门槛：基础分 > +12 视为偏多、< -12 视为偏空，中间视为中性（不参与过滤判定）；
3. 过滤只做**降级**：`最终强度 = max(0, |基础分| + 过滤扣分)`，方向保持不变 ——
   不会出现「触发了降级规则，评级反而变强」这种自相矛盾的结果；
4. 四档映射：≥ +55 强做多 / ≥ +25 谨慎做多 / > -25 震荡 / ≤ -25 强做空。

**六条假信号过滤规则**

| 规则 | 触发条件 | 扣分 |
|---|---|---|
| 孤立信号检查 | 四个指标中只有 1 个给出方向 | -22 |
| 量能确认 | 已收线K线成交量低于 20 根均量的 80% | -14 |
| 趋势一致性 | 信号方向与 EMA20 / EMA50 中期趋势相反 | -16 |
| 极端值风险 | 偏多时 RSI ≥ 75 或价格超出布林上轨；偏空时反向同理 | -20 |
| 通道收窄检查 | 布林带宽处于近 60 根的偏低水平（30 分位以下） | -12 |
| K线方向确认 | 最新K线收盘方向与信号方向不一致 | -8 |

量能比较**只使用已经收线的K线** —— 正在形成中的K线成交量天然不完整，用它比较会把每根K线都误判成缩量。

## 诚实边界

- **结论与K线根数口径有关**：EMA / MACD / RSI 的取值依赖整段窗口，所以 `--limit` 不同、
  或不同通道取到的根数不同，结论数值会有差异。**跨通道比较请保持根数一致**，
  这不是数据出错。
- **「评级变化轨迹」只算基础分、不含过滤降级**（引擎原有口径），所以轨迹里的分数与
  「共振评级」的最终分不是同一个口径；轨迹用于看方向是否稳定，**不能替代最终结论**。
- **官方开源数据仓库是 T+1 归档**，最新一两天通常还没发布。`--official` 会从昨天往前探测，
  实际用了哪几天会在 `archive` 与 `honesty` 里如实标注，缺失的日期不补齐、不猜数。
- **官方归档存在「面值币」代码**：例如 PEPE 在官方文件里是 `1000PEPEUSDT`。
  `--official` 会自动尝试倍数前缀，命中后在 `archive.usedFaceValue` 与 `honesty` 里如实标注。
- **`--live` / `--skill` 是现货口径**：快照不含合约持仓量与资金费率，这两项如实留空，不估算。
- **最新一根K线可能仍在形成中**，方向会随价格变化；量能比较已避开这根未收线K线，
  输出里用 `lastCandleForming` 如实标注。
- **K线不足 60 根时直接如实报错**，不硬算 —— EMA50 与 MACD 需要足够的起步长度。
- 本技能输出的是**结构判定**，不是交易指令，不构成投资建议。
