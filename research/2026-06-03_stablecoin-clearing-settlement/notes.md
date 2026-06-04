---
date: 2026-06-03
created: 2026-06-03T23:51:17+08:00
type: 概念
tags: [research, 稳定币, 清结算, USDC, USDT, CCTP, GENIUS-Act, MiCA, BIS]
related: ["[[AI应用]]", "[[算力]]"]
source_count: 30
archive: "research/2026-06-03_stablecoin-clearing-settlement/"
---

# 稳定币的清结算机制

> 一句话：链上"原子结算"把传统金融"清算+结算"两步压成秒级一步，但底层仍由发行人在传统银行体系里的法币储备担保——稳定币改的是**结算速度与对手方风险**，不是清结算这件事本身。

## 1. 先区分清楚两件 TradFi 事情

- **清算（Clearing）**：对账、轧差、净额化（"谁该给谁多少"）。
- **结算（Settlement）**：净额上的资金真转走、所有权真变更。
- TradFi 因为账本分散在多机构、多系统，两步必然分开做，中间出现对手方风险。

## 2. 稳定币的核心范式 = 原子结算

链上一次有效转账等于同时完成对账+所有权转移+最终性认定，由共识机制兜底。

但需要时间限定词——**finality**：
- Ethereum 经济最终性 ~13 分钟（2 epoch）→ 适合大额机构款。
- Solana ~15 秒 → 适合消费/微支付。PayPal PYUSD 上 Solana 后单笔成本降到 1 美分以下。

## 3. 三层流水线（最关键的脑图）

### ① 发行人层（一级市场）
- **Circle Mint**：机构客户电汇 USD → Circle 银行记账 → 链上 mint USDC；赎回反向。仅机构。
- **Tether**：授权交易对手模式，赎回最低 10 万美元。Coinbase/Bitfinex/Kraken/OTC 桌持账户，散户用 USDT 时实际跟这些"二级中介"打交道。
- 储备本质 = "**窄银行**"（cash-in-advance constraint，不放贷不期限错配）。Tether 2025 Q3 储备 1812 亿美元（1350 亿美债、129 亿黄金、99 亿 BTC）。

### ② 链上转账层（二级市场）
- 散户在交易所/DEX/钱包间转，不接触发行人。
- 锚定靠**套利**——能直接 mint/redeem 的客户扮演"稳定币界 ETF AP"。一级赎回通道堵塞时锚定即崩（SVB 教训）。
- Curve 3pool（DAI/USDC/USDT）是链下最大稳定币流动池。
- **发行人保留 freeze() 权**：Tether 累计冻结 28 亿美元+4500 地址；2025-09 起承诺实时披露每次冻结。USDT 严格来说是**可冻结的私人 IOU**，不是数字现金。

### ③ 跨链层
- **CCTP（Circle）**：burn at A → Iris attestation → mint at B。**没有 wrapped 代币**，issuer guarantee 始终有效。
- **CCTP V2**（2025-03 上线）：① Fast Transfer 8–20 秒（Circle 自担保 reorg 损失）；② Programmable hooks；③ 新消息格式。已覆盖 13+ 主网。

## 4. 边界以外：法币入口 + 编排网络（2024–2025 大爆发）

- **合作银行**：Cross River、Lead Bank、Customers Bank 是关键节点；SVB 倒闭那个周末 Circle 33 亿储备被困，瞬间脱锚到 0.87 美元 → "稳定币原子结算"无法切断对银行的依赖。
- **CPN（Circle Payments Network）**：Circle 自己不托管资金，做的是**跨境付款编排层**——折叠 SWIFT + 代理行 + 头寸管理几层。
- **Stripe + Bridge**（2025-02 以 $1.1B 收购）：Stablecoin Financial Accounts 上线 101 国，企业感觉不到底层是 USDC——"**invisible stablecoin**"范式。
- **Visa USDC 结算**：2025-12 美国本土启动（Solana 链），年化跑率 35 亿美元。把 Visa 的发卡—收单结算层换底为 24/7 链上轨道。

## 5. 跟传统结算资产对比（BIS 三测试）

[[BIS 2025 ARP]] 给的三大测试：
- **Singleness**（所有"1 美元"必须无条件等价）→ 稳定币不同发行人有信用差，二级有 bp 级价差，不及格。
- **Elasticity**（高峰时能先垫付后清算）→ 稳定币 cash-in-advance 约束，无法扩表，不及格。
- **Integrity**（反洗钱/反规避制裁）→ 公链匿名性 + 事后冻结 ≠ 体系级合规，不及格。

BIS 给的替代：**unified ledger** = tokenized commercial bank deposits + wholesale CBDC。[[Project Agorá]] 在 7 央行 + 40 多家机构原型测试。

## 6. 三次震荡复盘

- **UST 崩盘**（2022-05）：算法稳定币的死亡螺旋。450 亿美元一周蒸发，证明无外部锚定的纯反身性结构在挤兑面前没有数学均衡。
- **USDC SVB 脱锚**（2023-03）：储备银行风险直通链上。USDC 跌到 0.87 美元，靠美联储 BTFP 兜底银行体系才止血。教训：储备分散 ≠ 储备安全。
- **USDe 闪崩**（2025-10-11）：合成型稳定币在极端流动性下暴露。部分场所跌到 0.65 美元，主流流动池守住 ~1 美元。"链上对冲组合 ≠ 现金等价物"。

## 7. 监管三大法域成型（2025–2026）

| 法域 | 立法 | 关键日期 | 核心要求 |
|---|---|---|---|
| 🇺🇸 美国 | GENIUS Act | 2025-07-18 签署，2027-01-18 生效 | 100% 储备、月度披露、禁止再抵押、储备资产白名单 |
| 🇪🇺 欧盟 | MiCA | 2024-06/12 分阶段生效 | EMT/ART 分类；USDT 因未授权 2024-12 起被欧洲交易所大面积下架 |
| 🇭🇰 香港 | 稳定币条例 | 2025-08-01 生效 | HK$2500 万实缴资本 + 100% 储备隔离 + 面值赎回权；2026-04 首批两张牌照（HSBC + Anchorpoint） |

共同特征：**100% 法币储备 + 强制可赎回 + 限制资产类别 + KYC 内嵌**。算法/合成稳定币基本被排除在合规清单外。

## 8. 规模与现状（2025）

- **结算量**：上链 ~33 万亿美元 vs Visa+Mastercard 合计 ~25.5 万亿（Morph）。注意口径——链上数据含 MEV/自我流转，应理解为量级而非严格同口径比较。
- **B2B 占比 ~60%**（跨境付款、供应商付款、资金管理）。
- **新兴市场**：土耳其 2024 单年跨境稳定币流量 >630 亿美元；阿根廷把稳定币当作事实上的数字美元账户。
- **主流支付**：Visa USDC（$3.5B 年化跑率）、Stripe Bridge（$1.1B 收购）、PayPal PYUSD 双链。

## 9. 下次看什么（监控信号）

- **GENIUS Act 配套细则发布时点** → 决定 Tether 是否设美国合规实体（OCC/Fed/FDIC 联合 rulemaking）。
- **HKMA 第二/三批稳定币牌照** → 是否出现离岸人民币（CNH）锚定品种，这是中国唯一可能的"准主权数字货币"试验场。
- **CPN 接入银行数 + 月结算量** → Circle 上市后下一增长曲线，验证"稳定币 Visa"叙事。
- **CCTP V2 新链覆盖** → zkSync、StarkNet、Movement 等新公链上线时点，机构资金跟 CCTP 走。
- **合成稳定币（USDe）下一次系统性测试** → 决定它能否进入"机构可用"清单。
- **Project Agorá 政策建议**（预计 2026 下半年）→ 央行体系的统一账本方案获 G7 共识与否，决定私人稳定币范式天花板。

## 关联

- 跟 [[AI应用]] / [[算力]] 关联较弱，但 GENIUS Act 等监管框架内嵌的"美债储备"机制意味着**稳定币扩张 = 短期美债需求扩张**，这是宏观层面与所有美元资产（含 AI 公司估值）的隐性连接。
- [[BIS 2025 ARP]]、[[Project Agorá]] 是央行视角对应概念。
- [[Circle]]、[[Tether]]、[[Stripe]]、[[Visa USDC 结算]] 等具体玩家可单独建笔记延伸。

## 资产

- HTML 完整报告 + sources.md 见仓库 `research/2026-06-03_stablecoin-clearing-settlement/`。
