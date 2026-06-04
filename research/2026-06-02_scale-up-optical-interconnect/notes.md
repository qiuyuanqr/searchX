---
date: 2026-06-02
created: 2026-06-03T15:08:53+08:00
type: 概念
tags: [research, scale-up, 光互连, XPU, NVLink, UALink, CPO, 光交换, 超节点]
related: ["[[光模块]]", "[[算力]]", "[[AI应用]]", "[[CPO 共封装光学]]"]
source_count: 34
archive: "research/2026-06-02_scale-up-optical-interconnect/"
---

# scale-up 光互连（XPU 间）

> 一句话：把"一柜 XPU 当一颗超大 GPU 用"的紧耦合、内存语义互连，从铜升级到光的过程。光互连皇冠上"**最大但最晚**"的明珠——当下仍是铜主导，只有 scale-up 域要跨出单机柜、铜约 2 米够不着时光才被迫进场（英伟达 2027 跨柜、2028 全光）。

## 先分清（必做前提）

- **scale-up**：一柜 XPU 焊成"一颗大 GPU"，走**内存语义 load/store**、超低时延、**不容丢包**（无重传）。NVLink/Infinity Fabric/UALink/TPU ICI。
- **scale-out**：跨节点以太网/IB，走包、可重传。
- 比喻：scale-up = 同楼面对面递文件（丢一份就乱）；scale-out = 跨城寄快递（丢了重寄）。scale-up 域多大（world size）决定张量并行/MoE all-to-all/KV-cache 能铺多开，是 [[算力]] 命门。
- **关键前提**：今天 scale-up 仍是**铜**——NVL72 整柜 5,184 根无源铜缆连 72 GPU、130 TB/s。别误以为光已主导。

## 为什么铜、什么时候逼出光

- 铜四优势：省电（换光约+20kW/柜）、近零时延、更可靠、更便宜。
- 铜死穴：距离随速率坍缩，**224G 下无源铜<2 米** → 把高带宽 scale-up 域卡在约一个机柜。
- 逼光的是"够不着"**不是省电**：NVL576（8 柜 576 GPU，2027H2）跨柜上 CPO、柜内仍铜；NVL1152（2028）才基本全 CPO。黄仁勋："能用铜就用铜，必须用光才用光"。

## scale-up 是"最后才上光"的地方

- **可靠性是头号门槛**：无重传，一次 flap 拖垮上千 GPU 训练。约 300 万 GPU 规模下每约 48 秒一次 flap；可插拔光模块 FIT 高达约 3 万。scale-up 对光可靠性要求比可插拔高约 **100 倍**。
- 还要：纳秒时延、Tb/s/mm 带宽密度、<约1 pJ/bit、低成本。
- 反叙事：scale-out 里网络只占约 9% 功耗，CPO 全集群只省约 2–4% 电——**scale-up 上光是为距离/带宽/可靠性，不是省电**。

## 四条技术路线

1. **封装内光 I/O**（UCIe 光 chiplet，每颗 XPU 直接出光）— Ayar Labs TeraPHY 8T；终局、通用。
2. **光 interposer / 光 fabric**（芯片下/间铺有源光层，送光到裸片任意点）— Lightmatter Passage 114T、Celestial Photonic Fabric（→Marvell）；可做内存解耦。
3. **光交换 OCS**（MEMS/固态镜面重构光路）— 谷歌 Apollo/Palomar（重构 TPU ICI=scale-up）、Lightmatter 固态 OCS。
4. **AEC/线性桥接**（主动铜缆撑近期）— Credo ZeroFlap、Astera；2026–27 过渡主力。

## 协议标准之战（Bechtolsheim：英伟达 vs 其他所有人）

- **NVLink/NVLink Fusion**（在位者，2025-05 开放第三方）
- **UALink**（AMD/博通/谷歌/英特尔/微软，无英伟达；1.0 规范 2025-04-08，至 1,024 加速器；**交换芯片 2026H2 才到**）
- **Scale-Up Ethernet（SUE→SUE-T）/ OCP ESUN**（博通牵头，2025-10 ESUN 含英伟达）
- **OCI MSA**（2026-03-12，六巨头含英伟达/AMD/博通；**协议无关光 PHY**，让 NVLink 与 UALink 共用一束光；目标 3.2 Tbps、约 30W→9W）— 唯一统一力量。

## 关键玩家

- **英伟达**：NVLink 5→8；scale-up CPO 落点 2028 NVL1152（别与已出货的 scale-out CPO Quantum-X/Spectrum-X 混淆）。
- **Marvell×Celestial AI**：2025-12 收购（预付约 32.5 亿/含对赌约 55 亿，2026-02 交割），Photonic Fabric 任意点出光+内存解耦；Trainium 主力。
- **AMD**：MI400/Helios，首批兼容 UALink 但先上以太网（HPE 首发、Oracle 旗舰）。
- **博通**：SUE + Tomahawk Ultra（51.2T/250ns，XPU-to-XPU <400ns）。
- **Ayar Labs**（$500M E、估值 37.5 亿）、**Lightmatter**（Passage M1000、估值 44 亿）、**Astera**（Scorpio）、**Credo**（AEC 桥接）、**Nubis→Ciena**、**Xscape**。

## 中国生态：被迫先走全光

- **华为 CloudMatrix 384**：全光 mesh（[[灵衢]] UnifiedBus）、6,912 光模块、卡间 2.8 Tbps/<1µs；代价约 559kW（GB200 NVL72 的约 3.9 倍）、**约 68% 故障来自光**。灵衢 2.0 规范 2025-09 开放；Atlas 950 8,192 卡(2026Q4)、Atlas 960 15,488 卡(2027Q4)。
- **[[光模块]]龙头 scale-up 卡位**：天孚通信（光引擎全球 >60%，最受益）、中际旭创（800G CPO 试产→1.6T→3.2T 原型）、新易盛（与英伟达 115.2T CPO）、光迅。
- **国产超节点**：光跃 LightSphere X（仪电+曦智+壁仞+中兴，曦智 dOCS 光交换）；曦智科技港股 2026-04 上市首日 +380%。协议分立：华为 UB / 阿里 ALink / 腾讯 ETH-X。

## 风险与争议

- 可靠性/FIT（头号，job-killing flap）；"能用铜就用铜"主动延后光；时延/功耗；成本/良率/不可热插拔；标准碎片化与锁定（NVLink 围墙 vs UALink vs 以太）；中国以约 4 倍功耗换规模的取舍。

## 节奏与市场

- 共识：西方高量级光 scale-up **不早于 2028**；华为已先全光。
- 市场预测分歧巨大：650 Group（2030 scale-up：NVLink>$25B/以太>$8B/PCIe-UALink>$3B）、LightCounting（scale-up 光 TAM 远超 scale-out）、中国口径最猛（57 亿→1,805 亿、CAGR 约 99.6%）；聚合类仅 10–15%——差异源于"铜在柜内撑到几时"。

---
*局限：概念类技术调研，非个股建议。路线/标准/时间表未定型，数据定格 2026-06-02（北京时间）。完整正文与来源见 archive 的 report.html / sources.md。延伸阅读：[[CPO 共封装光学]]。*
