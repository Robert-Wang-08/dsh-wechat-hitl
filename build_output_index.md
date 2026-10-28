---
title: dsh-wechat-hitl 成果物索引
date created: 2026-10-26
date modified: 2026-10-28
tags:
  - build-output-index
  - wechat-hitl
---

# dsh-wechat-hitl 成果物索引

微信主动推送 + 人工确认回环（DSH ↔ WeChat）的全部过程产物。

| 成果物 | 背景与要求摘要 |
|---|---|
| `MOVE-20261028-迁入DSH工作区.md` | 2026-10-28 从 logseq 库迁入 DSH 工作区的记录：改动清单、junction 兼容层与删除条件、验证证据、限制 | 2026-10-28 |
| @@B@@PLAN-wechat-hitl.md@@B@@ | 方案与决策主文档：关键问题 1–6 的源码级答复、5 条路线对比 + 风险矩阵、推荐架构、验证证据、限制与下一步 |
| @@B@@lib/hitl-store.js@@B@@ | 三端共享状态层：请求表、答复解析（编号/关键词/自由文本/歧义）、微信文案、发件箱、headless 续跑、NDJSON 解析 |
| @@B@@pkg/dsh-wechat-hitl/@@B@@ | DSH Cordis 插件包（index.js / package.json / cordis.patch.yml）：turn/end 推送、ask_user_question 推送、approval/request 阻塞式批准、答复注入 |
| @@B@@gateway/dsh-bridge-index-v0.4.0.js@@B@@ | OpenClaw 网关插件 v0.4.0：发件箱出站泵、入站答复拦截、headless 兜底、resolveTarget 修正 |
| @@B@@bin/wx-hitl.mjs@@B@@ | CLI：notify / ask / status / resolve / continue / cancel |
| @@B@@tools/restart-gateway.ps1@@B@@ | 网关重启脚本（含 stale cron-authority lock 修补） |
| `tools/switch-hitl.mjs` | 三态开关（running/paused/stopped）：软开关写 state/control.json，硬开关增删 profile patch 的 - insert: 块；--show 查看 |
| `tools/check-web-patch.mjs` | patch 体检：解析 BEGIN/END 标记块，确认挂载态 YAML 合法 |
| `test/switch.test.mjs` | 开关门禁 6 条单测：默认/切换/抑制/积压不丢/停止不介入/审批不阻塞 |
| @@B@@test/@@B@@ | 32 条单测：hitl-store.test.mjs（解析 9 条）+ plugin.test.mjs（插件 5 条）+ switch.test.mjs（15 条）+ lock.test.mjs（并发/残留锁/探活不阻塞 3 条） |
| @@B@@state/@@B@@ | 运行时状态（pending.json 请求表 + 发件箱、hitl.log 审计、gateway.log、各类验证日志） |
| @@B@@REQUIREMENTS-wechat-hitl.md@@B@@ | 需求登记：REQ-001 所有会话结果推送的一键总开关、REQ-002 微信侧输入切换该参数；含开放问题 Q1 与缺陷 ISSUE-001（needsContext 与 TTL 冲突） |
| @@B@@contract.json@@B@@ | PTC 任务契约（冻结的目标与验收口径） |
| @@B@@receipt-hitl-egress-durability.json@@B@@ | 发件箱「条目静默丢失」修复回执：根因、改动点、3 条新单测、待重启生效条件 |
| skill-pkg/wechat-hitl/SKILL.md | SkillHub 已登记技能本体（install-local 源）v0.1.1，registry id=wechat-hitl | 2026-10-26 |
| @@B@@tools/weixin-inbound-patcher.mjs@@B@@ | 入站游标补丁核心（幂等、锚点守卫、写前备份、node --check 失败回滚）：覆盖 src/monitor/monitor.ts 与 dist/src/monitor/monitor.js | 2026-10-28 |
| @@B@@tools/apply-weixin-inbound-fix.ps1@@B@@ | 入站补丁入口（-Check / 应用），委托上面的 node 核心 | 2026-10-28 |
| @@B@@tools/apply-outbound-inproc.mjs@@B@@ | 出站进程内补丁（dsh-bridge + hitl-store）：sendMessageWeixin 进程内发送，DSH_BRIDGE_EGRESS=cli 回退 | 2026-10-28 |
| @@B@@tools/apply-all-and-restart.ps1@@B@@ | 沙箱外一条命令：入站补丁 + 出站补丁 + 重启网关（含登录自启钩子） | 2026-10-28 |
| @@B@@state/verify/@@B@@ | 入站补丁故障注入装置：patchext（补丁后）与 before（补丁前基线）两套 stub + driver.mjs，四场景对照 | 2026-10-28 |
| @@B@@FIX-20261028-inbound-cursor-and-inproc-egress.md@@B@@ | 本次修复的改动点、接口位置、验证证据、下一步唯一动作 | 2026-10-28 |
| @@B@@state/verify/egress/@@B@@ | 出站进程内路径单测：stub dist + 临时 state 目录，验证 inproc / 不可用退回 CLI / 发送失败 / DSH_BRIDGE_EGRESS=cli 四分支 | 2026-10-28 |
