---
date: 2026-06-05
created: 2026-06-05T22:58:52+0800
type: 概念
tags: [research, 物理AI, Physical-AI, 具身智能, NVIDIA, Cosmos, Isaac-GR00T, Newton, 人形机器人, 自动驾驶, 工业自动化]
related: ["[[机器人]]", "[[AI应用]]", "[[算力]]"]
source_count: 22
archive: "2026-06-05_physical-ai-overview/"
---

# 物理 AI（Physical AI）

## 一句话

NVIDIA 黄仁勋在 [[CES 2025]] 推出、被全球产业广泛采纳的"会动手的 AI"框架——把生成式 AI 从屏幕里搬进真实物理世界，让 AI 能感知、推理、规划并在物理世界**真正行动**。最紧密的三个落地行业是 [[机器人]]（尤其人形机器人）、自动驾驶/Robotaxi、工业仿真与流程工业 AI。

## 核心要点

- **演进框架**：感知 AI → 生成式 AI → Agentic AI → **物理 AI**（黄仁勋 [[CES 2025]] 主题演讲 2025/1/6）
- **与 [[具身智能]] 关系**：物理 AI ⊂ 具身智能（物理智能是"身体必须在真实物理世界"的严格子集）；中文媒体常混用
- **NVIDIA 三件套**：
  - **Cosmos**（脑子）：世界基础模型，2025/1 首发，2026/5/31 升级到 Cosmos 3（全模态架构）
  - **Isaac GR00T N1**（人形大脑）：2025/3/18 GTC 发布，双系统架构（快/慢思考）
  - **Newton**（仿真器）：NVIDIA + Google DeepMind + Disney 联合，Linux Foundation 托管，GPU 加速 + 70× 仿真速度
- **三大紧密相关行业**：
  1. **具身机器人**（最强，关联 [[机器人]] 板块）——人形机器人 + 协作机器人 + 服务机器人
  2. **自动驾驶 / Robotaxi**（强）——Tesla、小鹏、Waabi、Waymo、Uber
  3. **工业仿真与流程工业 AI**（强，关联 [[AI应用]]）——数字孪生、CAE、流程工业闭环控制
- **市场预测分歧巨大**：Morgan Stanley 2050 $5T（生态）vs Goldman 2035 $38B（仅人形本体）——差两个数量级；当前是"故事 → 兑现"过渡阶段

## 相关上市公司（按角色）

**最硬"卖铲人"**：
- NVIDIA（NVDA）——Cosmos + Isaac + Newton 全套自有，关联 [[算力]]

**端到端整合**：
- Tesla（TSLA）——Optimus + FSD + Cybercab
- 小鹏汽车（XPEV / 09868.HK）——Cosmos 早期伙伴 + 自研 Iron 人形机器人
- 比亚迪（002594 / 01211）——NOA + 代客泊车

**A 股执行器层**（关联 [[机器人]]）：
- 拓普集团（601689）——Optimus 执行器总成独家一级供应商（Tesla 业务占 35-40%）
- 三花智控（002050）——已有 [[2026-06-05_sanhua-zhikong-002050]] 单股调研
- 绿的谐波（688017）——谐波减速器国产龙头
- 双环传动（002472）——RV 减速器
- 北特科技（603009）——已有 [[2026-06-05_beite-technology-603009]] 单股调研

**A 股感知与仿真层**：
- 奥比中光（688322）——3D 视觉，已接入 NVIDIA Isaac Sim + Jetson Thor，NPN 合作伙伴
- 索辰科技（688507）——CAE + "天工·开物"物理 AI 平台，2025H1 物理 AI 收入仅 376 万（业务初期）
- 中控技术（688777）——流程工业"工业具身智能"，TPT 工业大模型 + UCS 控制系统

**A 股算力底座**（关联 [[算力]]）：
- 工业富联（601138）——NVIDIA AI 服务器代工核心，全球份额 >40%
- 汇川技术（300124）——伺服 + 逆变器 + 人形机器人执行器布局

**港股映射**：
- 地平线-W（09660.HK）——ADAS/AV 芯片
- 瑞声科技（02018.HK）——ADAS 相机模组
- 理想汽车（02015.HK）——Cosmos 3 应用方

## NVIDIA 早期合作伙伴名单（一手判断"谁踩中"）

- **人形机器人**：1X、Agility Robotics、Boston Dynamics、Mentee Robotics、NEURA Robotics、Figure AI、Fourier、Galbot、Hillbot、Skild AI
- **自动驾驶**：Waabi、Wayve、Foretellix、Uber、小鹏（仅整车合作）
- **工业**：Foxconn、Doosan Robotics、ABB、发那科、YASKAWA、库卡、Universal Robots
- **整车（Cosmos 3 应用方）**：Doosan Robotics、LG Electronics、Samsung Electronics、Li Auto

## 风险

- 市场预测跨度太大（$38B vs $5T），叙事强于兑现
- A 股"概念股"业务暴露度差异极大（如索辰物理 AI 业务 H1 仅 376 万、股价 3 天涨 64%）
- Sim-to-Real 在家庭场景的泛化与安全性远比工厂场景复杂
- 拓普集团 Tesla 业务占比 35-40%，客户集中度风险
- 物理 AI 是产业级营销词——同一只票常被同时贴 [[算力]] / [[AI应用]] / [[机器人]] / 物理 AI 四个标签，估值锚仍要回主营

## 下次看什么

1. Tesla Optimus V3 量产 / 外销进度（2026 Q3/Q4 财报）
2. NVIDIA Cosmos 3 商用兑现（Q2 FY2027 财报，约 2026/8 末）
3. 人形机器人首个万台量级商用订单出现的时点
4. A 股头部供应商 2026 年报里物理 AI / 机器人板块收入占比
5. CES 2027 与 GTC 2027 主题演讲，看 Cosmos 4 / GR00T N3 节奏
6. 监管：美国 NHTSA Robotaxi 商用批准、中国人形机器人安全国标

## 与 searchX 板块关联

- 强：[[机器人]]、[[AI应用]]、[[算力]]
- 弱：[[光模块]]（间接驱动数据中心需求）
- 几乎无：[[航天]]（仅低空经济/无人机有交叉）

## 完整版本

详见 [report.html](./report.html) · [sources.md](./sources.md)
