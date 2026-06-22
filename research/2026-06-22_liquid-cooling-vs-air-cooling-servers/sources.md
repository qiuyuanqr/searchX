# 来源清单 — 液冷与风冷在服务器散热方面的区别和各自优势

> 按可信度优先级排序：监管 ＞ 披露 ＞ 媒体 ＞ 研究 ＞ 社区。
> 所有时点为北京时间或来源页注明时间。

## 监管

- [监管] 国家市场监督管理总局 / 国家标准化管理委员会 — 国家标准《数据中心能效限定值及能效等级》GB 40879-2021 (2021 发布、2024 修订/实施口径见标准库页) — https://std.samr.gov.cn/gb/search/gbDetailed?id=2E4DD4D8E2E84A4BE06397BE0A0AE354 — 2024-11 实施口径 — 强制性国家标准，明确数据中心 PUE 不得超 1.5，新建大型 PUE ≤ 1.25。
- [监管] 武汉市数据局转发 — 《数据中心绿色低碳发展专项行动计划》强化"东数西算"规划布局刚性约束 — https://home.wuhan.gov.cn/zcfg/202408/t20240808_2439562.shtml — 2024-08-08 — 工信部 / 发改委等四部门联合印发，明确东部枢纽 PUE < 1.25、西部 < 1.2、可再生能源利用率与液冷推广要求。

## 披露

- [披露] 中国移动 · 中国电信 · 中国联通 联合发布 — 《电信运营商液冷技术白皮书 (2023)》 — http://www.cnmec.biz/danfoss/Liquid-Cooling-Technology-White-Paper-2023.htm — 2023-06-05 — 三大运营商联合发布的液冷三年规划（2023 试点 / 2024 新建 10% 液冷 / 2025 规模应用 50%+），冷板式与浸没式技术对比。
- [披露] 微软 Azure 官方博客 — "Azure Maia for the era of AI: From silicon to software to systems" — https://azure.microsoft.com/en-us/blog/azure-maia-for-the-era-of-ai-from-silicon-to-software-to-systems/ — 2023-11-15 — Maia 100 首次公布，机架级闭环液冷设计、热交换单元 (HXU) 架构由 Microsoft 一手描述。
- [披露] 微软官方博客 (The Official Microsoft Blog) — "Maia 200: The AI accelerator built for inference" — https://blogs.microsoft.com/blog/2026/01/26/maia-200-the-ai-accelerator-built-for-inference/ — 2026-01-26 — Maia 200 一手公告，二代闭环液冷 HXU、Mount Pleasant (Wisconsin) 与 Atlanta 数据中心部署。
- [披露] 微软新闻 (Source) — "AI chips are getting hotter. A microfluidics breakthrough goes straight to the silicon to cool up to three times better." — https://news.microsoft.com/source/features/innovation/microfluidics-liquid-cooling-ai-chips/ — 2025 — 微流控/芯片背面直冷研发进展（一手前沿研究）。
- [披露] 微软技术社区 — "Liquid Cooling in Air Cooled Data Centers on Microsoft Azure" — https://techcommunity.microsoft.com/blog/azureinfrastructureblog/liquid-cooling-in-air-cooled-data-centers-on-microsoft-azure/4268822 — 2024-09 — Azure 在既有风冷数据中心改造接入液冷的工程实践（HXU 接入既有 CRAC 体系）。
- [披露] 3M 公司公告 — "3M to exit PFAS manufacturing by the end of 2025" — https://news.3m.com/2022-12-20-3M-to-Exit-PFAS-Manufacturing-by-the-End-of-2025 — 2022-12-20 — 3M 一手宣布全面退出 PFAS（含 Novec 7100/649、Fluorinert FC-72 等两相浸没冷却关键介质）。

## 研究

- [研究] Dell'Oro Group 新闻稿 — "Data Center Liquid Cooling Market to Approach $7 Billion by 2029 as AI Deployments Accelerate" — https://www.delloro.com/news/data-center-liquid-cooling-market-to-approach-7-billion-by-2029-as-ai-deployments-accelerate/ — 2026-01-08 — 数据中心物理基础设施一手市场数据：液冷 2025 约 $3 B / 2029 约 $7 B；单相 DTC 主导；Vertiv 领跑 + CoolIT/nVent/Boyd/Aaon。
- [研究] Uptime Institute — "Global Data Center Survey Results 2025" — https://uptimeinstitute.com/about-ui/press-releases/uptimes-15th-annual-global-data-center-survey-results-shows-both-commitment-and-hesitancy — 2025-07-30 — 第 15 届年度调研（N>800 运营方），PUE 连续 6 年停滞、机柜功率 10–30 kW 区间扩张、对 NVIDIA 后续 GPU 系统的功率有顾虑。
- [研究] Uptime Institute — "Cooling Systems Survey 2025" PDF — https://intelligence.uptimeinstitute.com/sites/default/files/2025-07/UI%20Field%20181_Data%20center%20cooling.pdf — 2025-07 — 冷却系统专项调研。
- [研究] Goldman Sachs (汇总于 Lombard Odier 2026-01 短文) — "Why liquid cooling will dominate AI data centres in 2026" — https://www.lombardodier.com/insights/2026/january/ai-supercharges-the-race.html — 2026-01 — 高盛预测液冷服务器渗透率 2024 15% → 2025 54% → 2026 76%（卖方预期、置信度中）。
- [研究] IDC China 一手新闻稿 — 《中国液冷服务器市场加速扩张，头部聚势驱动应用深化》 — https://my.idc.com/getdoc.jsp?containerId=prCHC53302025 — IDC 报告页有订阅墙、不可匿名直读，但 URL 与 IDC 官方 PR 号一致；中国液冷服务器市场 2024 23.7 亿美元 (+67.0%) / 2025 33.9 亿美元 (+42.6%) / 2025-2029 CAGR ≈ 48% / 2028 约 162 亿美元（多家中文媒体转引数字一致）。

## 媒体

- [媒体] Data Center Dynamics (DCD) — "Two-phase cooling will be hit by EPA rules and 3M's exit from PFAS 'forever chemicals'" — https://www.datacenterdynamics.com/en/news/two-phase-cooling-will-be-hit-by-epa-rules-and-3ms-exit-from-pfas-forever-chemicals/ — 2023 — 两相浸没冷却供应链遭受 PFAS 监管 + 3M 退出双重冲击的深度新闻。
- [媒体] DCD — "ASHRAE publishes liquid cooling guidelines as chip power moves into 'uncharted territory'" — https://www.datacenterdynamics.com/en/news/ashrae-publishes-liquid-cooling-guidelines-as-chip-power-moves-into-uncharted-territory/ — 2024 — ASHRAE TC 9.9 液冷指南更新报道与原文摘要。
- [媒体] ServeTheHome — "2-Phase Immersion Cooling Halted Over Multi-Billion Dollar Health Hazard Lawsuits" — https://www.servethehome.com/2-phase-immersion-cooling-halted-over-multi-billion-dollar-health-hazard-lawsuits/ — 2023 — 两相浸没冷却暂停的产业新闻，超大规模运营商 (anonymous hyperscaler) 自陈关闭项目转向 DLC。
- [媒体] Introl (集成商博客 / 二手汇总) — "Liquid Cooling vs Air Cooling for AI Data Centers" — https://introl.com/blog/liquid-vs-air-cooling-ai-data-centers — 2025-2026 — 风冷 / 液冷物理对比数据（换热系数 / 比热 / W/m²·K）、各路线 PUE 与功率密度阈值（**集成商口径，部分具体数值未独立核实**，作交叉印证用）。
- [媒体] IEEE Spectrum — "Data Center Liquid Cooling: The AI Heat Solution" — https://spectrum.ieee.org/data-center-liquid-cooling — 2025 — IEEE 旗下技术媒体的液冷专题（含 Microsoft 沸腾液冷案例的非营销视角解读）。
- [媒体] 21 经济报道 — "液冷赛道的产业奇点，要来了？" — https://www.21jingji.com/article/20251210/herald/e4c09d1535b0737cb2b8dd1ede65b7b6.html — 2025-12-10 — A 股液冷三强（英维克 / 申菱 / 高澜）梳理与产业拐点。
- [媒体] 第一财经 — "150 倍 PE 下的隐忧：三季度业绩环比转跌，英维克遭陆股通减持" — https://www.yicai.com/news/102862628.html — 2025-10-14 — 英维克 2025Q3 营收、归母、陆股通减持等数据（财经媒体口径）。
- [媒体] 新浪财经 — "英维克 | 深度：温控系统龙头，AI算力服务器液冷构筑新增长极" — https://finance.sina.com.cn/roll/2025-12-17/doc-inhcaqyr7358836.shtml — 2025-12-17 — 英维克液冷业务深度（含累计交付 1.2GW、订单口径，部分为机构研报口径）。
- [媒体] 新浪财经 — "市占率国内第一，液冷寡头，撞开AI的大门！" — https://finance.sina.cn/2025-08-02/detail-infiqxcs3655627.d.html — 2025-08-02 — A 股液冷三强财报与订单梳理（含申菱、高澜口径）。
- [媒体] 21 经济报道 — "AI 风口液冷沸腾 英维克市值突破千亿" — https://www.21jingji.com/article/20251226/herald/4bf1a7446458b47bb6c05f3425ef9ff8.html — 2025-12-26 — 英维克市值 / 液冷渗透率 / 海外订单。

## 来源使用边界

- Dell'Oro 一手新闻稿 + Uptime Institute 调研 + 微软官方博客 + 三大运营商白皮书 + 3M 公告 是承重数据的硬来源（数字与时间点）；
- Introl 博文给的 "Air cooling runs out of physics at exactly 41.3 kW per rack" 等过度精确的论断不直接采用，正文用"约 30–50 kW/rack 的舒适区"等保守表述；
- 高盛 76% 渗透率预测、IDC China 33.9 亿美元、英维克 GB300 1200 台订单等均为卖方研究 / 媒体口径，正文就地标注"卖方预期 / 未独立核实"；
- 不在本清单出现的具体硬数字，正文一律降级为定性或加 "（未独立核实）"。
