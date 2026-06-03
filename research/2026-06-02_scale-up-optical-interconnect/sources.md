# 来源清单 — scale-up 光互连（XPU 间）

> 调研日期：2026-06-02（北京时间）｜类型：概念（含产业链/板块色彩）｜按可信度优先级排序（披露 ＞ 媒体 ＞ 研究 ＞ 社区）
> 标注规则：`- [类型] 标题 — 链接 — 北京时间日期 — 一句话摘要`

## 披露 / 官方（公司公告、标准组织、IR、SEC）

- [披露] NVIDIA — NVLink Fusion for Semi-Custom AI Infrastructure — https://nvidianews.nvidia.com/news/nvidia-nvlink-fusion-semi-custom-ai-infrastructure-partner-ecosystem — 2025-05-18 — NVLink 开放第三方；NVLink5=1.8TB/s/GPU；联发科/Marvell/Alchip/Astera/富士通/高通。
- [披露] NVIDIA — Vera Rubin POD: Seven Chips, Five Rack-Scale Systems — https://developer.nvidia.com/blog/nvidia-vera-rubin-pod-seven-chips-five-rack-scale-systems-one-ai-supercomputer/ — 2026 — NVL576=8 柜×72 Rubin Ultra 一个 NVLink 域；柜内铜+跨柜光。
- [披露] NVIDIA — Scaling AI Inference with NVLink and NVLink Fusion — https://developer.nvidia.com/blog/scaling-ai-inference-performance-and-flexibility-with-nvidia-nvlink-and-nvlink-fusion/ — 2025 — 内存语义 scale-up 定义；NVL72 130 TB/s。
- [披露] Optical Scale-up Consortium（OCI MSA）成立 — https://www.businesswire.com/news/home/20260312254951/en/ — 2026-03-12 — AMD/博通/Meta/微软/英伟达/OpenAI；GEN1 4λ×50G NRZ 200G/向、GEN2 400G BiDi、目标 3.2Tbps、约30W→9W。
- [披露] UALink Consortium — 200G 1.0 Specification — https://ualinkconsortium.org/specifications/ — 2025-04-08 — 200G/lane、至 1,024 加速器、802.3 PHY、交换式。
- [披露] UALink — 发布四项规范（2.0 DL/PL + 网内计算/UCIe3.0 chiplet/可管理性）— https://www.businesswire.com/news/home/20260407620696/en/ — 2026-04-07 — UALink 规范扩展。
- [披露] OCP — Introducing ESUN: Ethernet for Scale-Up AI — https://www.opencompute.org/blog/introducing-esun-advancing-ethernet-for-scale-up-ai-infrastructure-at-ocp — 2025-10-13 — ESUN 工作组；SUE 改名 SUE-T；12 家发起含英伟达。
- [披露] Broadcom — Introducing Ethernet Scale-Up Networking（Ram Velaga）— https://www.broadcom.com/blog/introducing-ethernet-scale-up-networking-advancing-ethernet-for-scale-up-ai-infrastructure — 2025-10 — SUE/Tomahawk Ultra 定位。
- [披露] OCP — Scale-Up Ethernet (SUE) Spec v1.0.0 — https://www.opencompute.org/documents/ocp-sue-spec-final-pdf-1 — 2025-07-16 — SUE 1.0 投递。
- [披露] Ultra Ethernet Consortium — UEC Spec 1.0 — https://ultraethernet.org/ultra-ethernet-consortium-uec-launches-specification-1-0-transforming-ethernet-for-ai-and-hpc-at-scale/ — 2025-06-11 — 主打 scale-out；下一版瞄准 scale-up。
- [披露] Broadcom — Ships Tomahawk Ultra（scale-up 以太交换）— https://investors.broadcom.com/news-releases/news-release-details/broadcom-ships-tomahawk-ultra-reimagining-ethernet-switch-hpc — 2025-07-15 — 51.2T、250ns、SUE 下 XPU-to-XPU &lt;400ns。
- [披露] Broadcom — Industry's First 51.2T CPO（Bailly）— https://investors.broadcom.com/news-releases/news-release-details/broadcom-delivers-industrys-first-512-tbps-co-packaged-optics — 2024 — Bailly 8×6.4T 引擎；CPO 对 scale-up 网络的定位。
- [披露] Ayar Labs — World's First UCIe Optical Chiplet — https://ayarlabs.com/news/ayar-labs-unveils-worlds-first-ucie-optical-chiplet-for-ai-scale-up-architectures/ — 2025-03-31 — TeraPHY 8 Tbps、SuperNova 16 波长、UCIe。
- [披露] Ayar Labs — Closes $500M Series E — https://ayarlabs.com/news/ayar-labs-closes-500m-series-e-accelerates-volume-production-of-co-packaged-optics/ — 2026-03-03 — 估值 37.5 亿、英伟达+AMD 参投。
- [披露] Lightmatter — Passage M1000 Photonic Superchip — https://lightmatter.co/press-release/lightmatter-unveils-passage-m1000-photonic-superchip-worlds-fastest-ai-interconnect/ — 2025 — 114 Tbps、256 光纤、1,024 SerDes、固态 OCS。
- [披露] Marvell — To Acquire Celestial AI — https://investor.marvell.com/news-events/press-releases/detail/1000/ — 2025-12-02 — 预付约 32.5 亿；Photonic Fabric scale-up 光 I/O。
- [披露] Marvell 8-K（SEC）— Celestial AI 收购完成 — https://www.sec.gov/Archives/edgar/data/0001835632/000183563226000014/q127_8kx522026ex-991.htm — 2026-02-02 — 约 32.5 亿（10 亿现金+约 2,720 万股）。
- [披露] Marvell — Expands Custom Compute with UALink Scale-up Solution — https://investor.marvell.com/2025-06-11-Marvell-Expands-Custom-Compute-Platform-with-UALink-Scale-up-Solution — 2025-06-11 — UALink 控制器+定制交换；Trainium。
- [披露] Astera Labs — 320-Lane Scorpio X-Series Smart Fabric Switch — https://www.asteralabs.com/news/astera-labs-extends-leadership-in-open-ai-scale-up-networking-with-new-320-lane-scorpio-x-series-smart-fabric-switch/ — 2026-05-05 — PCIe6 scale-up 交换；光直连路线图。
- [披露] HPE — 首发 AMD Helios（博通以太 scale-up）— https://www.hpe.com/us/en/newsroom/press-release/2025/12/hpe-accelerates-ai-deployments-with-first-amd-helios-ai-rack-scale-architecture-with-open-scale-up-networking-built-with-broadcom.html — 2025-12 — Helios 先上以太网 scale-up。
- [披露] AMD Blog — Delivering Open Rack Scale AI Infrastructure — https://www.amd.com/en/blogs/2025/amd-delivering-open-rack-scale-ai-infrastructure-to-unlock-agentic-ai.html — 2025 — Helios/UALink 设计。
- [披露] Ciena — To Acquire Nubis Communications — https://www.ciena.com/about/newsroom/press-releases/ciena-to-acquire-nubis-communications — 2025-09-22 — 2.7 亿美元全现金；6.4 Tb/s CPO/NPO+ACC。
- [披露] Businesswire — Xscape $37M + 8 波长 ELSFP 激光 — https://www.businesswire.com/news/home/20260311692947/en/ — 2026-03-11 — FalconX、ChromX 多波长 fabric；英伟达投资人。
- [披露] Businesswire — Enfabrica Raises $115M Series C — https://www.businesswire.com/news/home/20241119607725/en/ — 2024-11-19 — ACF-S SuperNIC 3.2 Tbps、scale-up+out。
- [披露] Tower Semiconductor — Xscape 片上多波长激光 — https://towersemi.com/2025/08/25/08252025/ — 2025-08-25 — 首个光泵浦片上多波长激光、16 色 demo。
- [披露] Credo — ZeroFlap AEC 产品 — https://credosemi.com/products/zeroflapaec/ — 2025 — 224G/lane；可靠性 vs 光；scale-up 缆。
- [披露] ODCC — ETH-X 超节点原型/协议白皮书 V1.0 — https://www.odcc.org.cn/news/p-1910239076798013441.html — 2025-04-08 — 腾讯/ODCC 以太网 scale-up；东莞华勤原型。
- [披露] IT之家 — 徐直军发布灵衢协议、开放灵衢 2.0 技术规范 — https://www.ithome.com/0/883/849.htm — 2025-09-18 — 华为全联接大会；灵衢1.0 已在 Atlas 900、300+ 部署。

## 媒体（行业 / 财经）

- [媒体] The Register — NVL72 120kW 机柜拆解 — https://www.theregister.com/2024/03/21/nvidia_dgx_gb200_nvk72/ — 2024-03-21 — NVL72 约 2 英里铜、盲插背板、5,000+ 缆。
- [媒体] The Register — Nvidia embraces optical scale-up as copper reaches limits — https://www.theregister.com/2026/04/05/nvidia_optical_scale_up/ — 2026-04-05 — NVL576、224G &lt;2m、scale-up CPO 2027–28（反爬，摘要佐证）。
- [媒体] The Register — Copackaged optics found their killer app — https://www.theregister.com/2025/11/22/cpo_ai_nvidia_broadcom — 2025-11-22 — Hock Tan/Jensen "copper as long as possible"；CPO 更可靠。
- [媒体] The Register — Nvidia extends NVLink to custom CPUs/ASICs — https://www.theregister.com/2025/05/19/nvidia_nvlink_fusion/ — 2025-05-19 — NVLink5=1.8TB/s；伙伴名单。
- [媒体] The Register — Lightmatter photonic interposers ship this summer — https://www.theregister.com/2025/04/01/lightmatter_photonics_passage/ — 2025-04-01 — Series D 4 亿/估值 44 亿；出货时间。
- [媒体] Tom's Hardware — 巨头组建光互连联盟（OCI MSA）— https://www.tomshardware.com/tech-industry/artificial-intelligence/tech-titans-team-up-to-form-optical-interconnect-alliance — 2026-03-12 — 协议无关光 PHY、3.2 Tb/s。
- [媒体] Tom's Hardware — AMD MI430X/MI440X/MI455X + Helios（CES 2026）— https://www.tomshardware.com/tech-industry/artificial-intelligence/amd-touts-instinct-mi430x-mi440x-and-mi455x-ai-accelerators-and-helios-rack-scale-ai-architecture-at-ces — 2026-01-06 — MI400 首批兼容 UALink；交换芯片 2H2026；Helios 规格。
- [媒体] Tom's Hardware — 华为 CloudMatrix 以"蛮力"超 GB200、4 倍功耗 — https://www.tomshardware.com/tech-industry/artificial-intelligence/huaweis-new-ai-cloudmatrix-cluster-beats-nvidias-gb200-by-brute-force-uses-4x-the-power — 2025-04 — CM384 约 559kW vs 约 145kW；全光、用光多于英伟达。
- [媒体] Tom's Hardware — NVIDIA 向 Marvell 投 $2B；NVLink Fusion 软锁定 — https://www.tomshardware.com/tech-industry/nvidia-invests-2-billion-in-marvell-whose-biggest-clients-are-trying-to-replace-nvidia-chips — 2025-05 — 锁定框架。
- [媒体] Tom's Hardware — NVIDIA Vera Rubin 平台详解 — https://www.tomshardware.com/pc-components/gpus/nvidias-vera-rubin-platform-in-depth — 2026 — NVLink 6/7、NVL144/576、14.4 Tbit/s/GPU。
- [媒体] HPCwire — Huang roadmap: NVL1152, scale-up CPO — https://www.hpcwire.com/2026/03/17/huang-shares-nvidia-roadmap-showing-more-chips-nvl1152-scale-up-cpo/ — 2026-03-17 — scale-up CPO 落 Feynman NVL1152（2028）。
- [媒体] SDxCentral — Nvidia backs copper amid CPO push — https://www.sdxcentral.com/news/nvidia-backs-copper-in-next-gen-interconnects-amid-push-into-co-packaged-optics/ — 2026-03 — 柜内铜 POR；Jensen 铜+光表态。
- [媒体] SDxCentral — Marvell completes $3.25B Celestial AI acquisition — https://www.sdxcentral.com/news/marvell-completes-325b-acquisition-of-photonic-startup-celestial-ai/ — 2026-02-02 — 交割；25× 带宽宣称。
- [媒体] optics.org — Marvell scale-up optical links, $5BN-plus Celestial deal — https://optics.org/news/16/11/47 — 2025-12 — 含对赌总额约 55 亿（vs 预付 32.5 亿）。
- [媒体] ServeTheHome — Ayar Labs UCIe Optical I/O Retimer at Hot Chips 2025 — https://www.servethehome.com/ayar-labs-ucie-optical-io-retimer-at-hot-chips-2025/ — 2025-08 — 光 I/O chiplet/retimer 细节。
- [媒体] ServeTheHome — Broadcom Tomahawk Ultra for Scale-up Ethernet — https://www.servethehome.com/broadcom-tomahawk-ultra-launch-for-scale-up-ethernet/ — 2025-07 — SUE/SUE-Lite、头部精简、LLR/CBFC。
- [媒体] ServeTheHome — Celestial AI Photonic Fabric Module at Hot Chips 2025 — https://www.servethehome.com/celestial-ai-photonic-fabric-module-at-hot-chips-2025/ — 2025-08 — Gen-1 16 Tbps、OMIB 任意点出光。
- [媒体] Converge Digest — Lightmatter 114 Tbps 超级芯片 + 64 Tbps CPO — https://convergedigest.com/lightmatter-shows-its-114-tbps-photonic-superchip-and-64-tbps-cpo/ — 2025 — 印证 114T interposer 与 64T CPO。
- [媒体] The Next Platform — Photonics to Make Celestial HBM3 Memory Fabric — https://www.nextplatform.com/2023/06/28/photonics-to-make-celestial-hbm3-memory-fabric/ — 2023-06-28 — OMIB、7.2 Tbps/mm²、内存解耦。
- [媒体] Phoronix — UALink 200G 1.0 Released — https://www.phoronix.com/news/UALink-200G-1.0-Released — 2025-04-08 — 至 1,024 加速器、开放 vs NVLink。
- [媒体] DCD — UALink releases 200G 1.0 spec — https://www.datacenterdynamics.com/en/news/ualink-consortium-releases-200g-10-specification-for-ai-accelerator-interconnects/ — 2025-04-08 — 75 成员；范围。
- [媒体] DCD — Rubin Ultra NVL576 600kW、2H2027 — https://www.datacenterdynamics.com/en/news/nvidias-rubin-ultra-nvl576-rack-expected-to-be-600kw-coming-second-half-of-2027/ — 2025 — Kyber 柜、576 die、铜 scale-up 背板。
- [媒体] DCD — Mission Apollo: Google OCS（Palomar）— https://www.datacenterdynamics.com/en/analysis/mission-apollo-behind-googles-optical-circuit-switching-revolution-mag/ — 2025 — 最大 OCS 部署；20–40% 省电。
- [媒体] QSFPTEK — CloudMatrix 384 光模块与 68.2% 故障来自光分析 — https://www.qsfptek.com/qt-news/400g-osfp-siph-lpos-in-huawei-ai-cloudmatrix384-super-node.html — 2025 — 6,912×400G SiPh LPO、3,168 纤；可靠性侧证。
- [媒体] Marvell Blog — Nine Things About the Future of Copper — https://www.marvell.com/blogs/nine-things-to-remember-about-the-future-of-copper-in-computing.html — 2024-10-29 — 铜 3m@5G→1m@200G；翻倍缩距 30–50%；AEC 3×。
- [媒体] SemiEngineering — All AI DC interconnects optical within 5 years — https://semiengineering.com/all-ai-data-center-interconnects-will-be-optical-within-5-years/ — 2026 — 大规模光 scale-up 不早于 2028。
- [媒体] 极客公园 — 上海仪电+曦智+壁仞+中兴发布光跃 LightSphere X — https://www.geekpark.net/news/352012 — 2025-07-28 — 中国首个光互连+光交换 GPU 超节点（dOCS）。
- [媒体] 新浪财经 — 华泰：超节点，26 年国产算力破局之道 — https://finance.sina.com.cn/roll/2026-04-13/doc-inhuihzn4853721.shtml — 2026-04-13 — ALink/UB/ETH-X 分立；阿里磐久 AL128/UPN512；渗透率 45%(2027)/72%(2028)。
- [媒体] 观察者网 — 华为海外展示 8,192 卡 Atlas 950 超节点 — https://www.guancha.cn/economy/2026_03_01_808398.shtml — 2026-03-01 — Atlas 950 公开演示。
- [媒体] Caixin Global — Lightelligence 港股 IPO 申报 — https://www.caixinglobal.com/2026-03-31/optical-interconnect-maker-lightelligence-files-for-hong-kong-ipo-102429646.html — 2026-03-31 — LightSphere X（壁仞/中兴）；中国 scale-up 光互连龙头。

## 研究（深度分析 / 机构 / 学术）

- [研究] SemiAnalysis — Co-Packaged Optics: Scaling with Light — https://newsletter.semianalysis.com/p/co-packaged-optics-cpo-book-scaling — 2026-01-01 — 铜 2m 极限、shoreline、pJ/bit、scale-up vs scale-out CPO 时序、MTBF、NVLink 11× 增长。
- [研究] arXiv — The Ghost in the Datacenter（链路 flap 尺度，2603.03736）— https://arxiv.org/html/2603.03736v1 — 2026-03 — 300 万 GPU 每约 48 秒一次 flap；光 MTTF 3×10⁵ 小时；Meta LLaMA3 419 次中断。
- [研究] SemiAnalysis — NVIDIA's Optical Boogeyman（NVL72 铜）— https://newsletter.semianalysis.com/p/nvidias-optical-boogeyman-nvl72-infiniband — 2024 — 5,184 根铜缆、换光约+20kW/柜、224G &lt;2m。
- [研究] SemiAnalysis — Google Apollo OCS: $3B Game-Changer — https://newsletter.semianalysis.com/p/google-apollo-the-3-billion-game — 2025 — Palomar MEMS OCS 重构 ICI（scale-up）。
- [研究] SemiAnalysis — AMD Advancing AI: MI400 UALoE72, MI500 UAL256 — https://newsletter.semianalysis.com/p/amd-advancing-ai-mi350x-and-mi400-ualoe72-mi500-ual256 — 2025 — UALink-over-Ethernet scale-up 路线。
- [研究] SemiAnalysis — NVIDIA GTC 2026: The Inference Kingdom Expands — https://newsletter.semianalysis.com/p/nvidia-the-inference-kingdom-expands — 2026-03 — NVL576 跨柜 CPO、柜内铜；Feynman NVL1152 CPO ~2028。
- [研究] arXiv — Mission Apollo: OCS at Datacenter Scale（2208.10041）— https://arxiv.org/pdf/2208.10041 — 2022 — Palomar 176 镜 MEMS、136×136 OCS、TPU v4 pod。
- [研究] LightCounting — Scale-up: a New Market for Optical Interconnects — https://www.lightcounting.com/newsletter/en/july-2025-cloud-data-center-optics-330 — 2025-07 — scale-up 光 TAM 远超 scale-out；$5B(2024)→$10B(2026)。
- [研究] LightCounting — March 2026 OFC: Bringing Order to AI's Scaling Challenges — https://www.lightcounting.com/research-note/march-2026-ofc-bringing-order-to-ais-scaling-challenges-442 — 2026-03 — OCI/Open CPX MSA；"英伟达 vs 其他所有人"。
- [研究] 650 Group — Ethernet to Surge in Scale-out, Ramp in Scale-up — https://650group.com/blog/in-the-ai-era-ethernet-set-to-surge-in-scale-out-and-ramp-in-scale-up/ — 2025 — 2030 scale-up：NVLink &gt;$25B、以太 &gt;$8B、PCIe/UALink &gt;$3B。
- [研究] HyperFRAME Research — OCI MSA 通用光基座 — https://hyperframeresearch.com/2026/03/16/the-oci-msa-building-the-universal-optical-foundation-for-next-generation-ai-clusters/ — 2026-03-16 — 链路功耗约 30W→9W；NVLink+UALink 共用 PHY。
- [研究] MDPI Future Internet — Survey of Intra-Node GPU Interconnection in Scale-Up Network — https://www.mdpi.com/1999-5903/17/12/537 — 2025 — scale-up 互连学术综述。
- [研究] Credo — The Path to Zero Flap — https://credosemi.com/blogs/the-path-to-zero-flap-reinventing-optical-reliability-for-scalable-ai-clusters/ — 2025 — 可插拔光 FIT 高达约 3 万；scale-up 无丢包容忍；100× 可靠性差；32k GPU 小时/坏链。

## 社区

- [社区] 雪球/HKEX — 曦智科技(01879) 招股 + 弗若斯特沙利文数据 — https://xueqiu.com/1036711465/385027404 — 2026-04 — 中国 scale-up 光互连 57 亿(2025)→1,805 亿(2030)、CAGR 约 99.6%；曦智约 88% 份额；首日 +380%。
- [社区] 知乎 — 华为 CloudMatrix 384 vs 英伟达 GB200 NVL72/576 架构 — https://zhuanlan.zhihu.com/p/1919101924445254162 — 2025 — UB/灵衢 全光 mesh；7×400G/芯、6,912 模块、2.8 Tbps、<1µs。
- [社区] 智源社区/BAAI — 华为 Atlas 950/960 超节点 roadmap — https://hub.baai.ac.cn/view/49054 — 2025-09 — Atlas 950 8,192 卡(Q4 2026)、Atlas 960 15,488 卡(Q4 2027)。
- [社区] 知乎 — 光模块龙头 scale-up/CPO 出货预测（旭创/新易盛/天孚/光迅）— https://zhuanlan.zhihu.com/p/1976346892628693754 — 2026 — 1.6T/800G 出货预测；天孚光引擎 >60% 份额；旭创 3.2T CPO 原型。

---

## 检索说明与局限

- 本主题为概念/技术类，X/Twitter 时间线局限不适用。
- The Register（2026-04-05）、部分 EE Times / The Next Platform 页面有反爬/超时，相关数据以检索摘要佐证，并与 SemiAnalysis / arXiv / Marvell / Tom's Hardware 等可直取来源交叉核对。
- 已在正文并列标注的来源冲突：①英伟达"已把 CPO 提前五年"vs"能用铜就用铜"——实为 scale-out CPO 已出货、scale-up CPO 留到约 2028 两件事；②Marvell 收购 Celestial"32.5 亿（预付）"vs"约 55 亿（含对赌总额）"；③谷歌 OCS 属 scale-up 还是 scale-out（其重构 ICr/ICI 拓扑，跨越边界）；④市场规模 CAGR 各机构差异极大（聚合类 10–15% vs 专业机构 30–100%），取决于"铜在柜内撑到几时"；⑤华为以约 4 倍功耗、光主导故障率换规模的取舍评价。
- 中国部分含券商研报与社区整理口径，已按"社区"层级标注，财务/份额数以公司正式披露与招股书为准。
