---
name: wechat-hitl
description: 通过微信做「人工确认回环」与「跨会话驱动」。当任务需要在危险/不可逆操作前取得用户确认、需要把长任务结果推送到用户微信、或需要用微信消息驱动本机某个 DSH 会话时使用。提供 wx-hitl CLI（ask/notify/status/sessions/bind/relay/switch）、DSH 插件 dsh-wechat-hitl 与网关插件 dsh-bridge v0.4.0 的完整用法、回复语法规约与排障顺序（contextToken / prepare failed）。触发词：微信审批、微信确认、微信推送结果、微信驱动会话、wx-hitl、人工确认回环。
origin: self
author: wang
created: 2026-10-26
updated: 2026-10-26
version: 0.1.1
managed-by: skillhub
source: skillhub
asset-type: skill
asset-id: wechat-hitl
---

# 微信人工确认回环（wechat-hitl）

## 什么时候用

| 场景 | 用哪个命令 | 说明 |
|---|---|---|
| 危险/不可逆操作前要用户拍板（删除、发布、对外发送、改生产配置） | ask | 推微信带选项，用户回复后作为新回合续跑；配合 PTC「前置确认」使用 |
| 长任务结束/阶段性结果要给用户 | notify | 单向推送，不等回复 |
| 让别的会话执行一句话（远程遥控） | relay 或微信里 <回复id> <内容> | 进程内注入优先，headless 续跑兜底 |
| 看有哪些待确认 / 有哪些会话可驱动 | status / sessions | 清单是字符表格，左列即回复 id |
| 临时不想被打扰 / 彻底停用 | switch --state paused 或 stopped | 三态开关，见下 |

不要自己拼 openclaw message send：DSH 沙箱内会 EPERM，出站必须走网关（本工具已封装）。

## 命令行（本机路径固定）

```text
$cli = 'D:\nutstore\1.logseq\70-WorkSpace\wechat-hitl-20261026\bin\wx-hitl.mjs'

node $cli ask --title "删除确认" --question "要删 _INBOX/tmp 吗？" --options "允许|拒绝" --ttl-min 30
node $cli notify --title "构建完成" --text "3 个包已发布"
node $cli status
node $cli sessions                    # 回复id / 会话名 / 工作区 / 活跃
node $cli relay --session <回复id或session-id> --text "跑一遍回归"
node $cli bind --session 3 | bind --auto
node $cli switch --state running|paused|stopped
```

会话 id 默认取 $env:DSH_SESSION_ID，无需手填。

## 四条硬规矩

1. 发起 ask 后立即结束本回合，不要 sleep/轮询等待：用户答复会作为新一回合注入本会话。
2. 审批类（mode=approval）只认编号/关键词，自由文本不会被当成放行——这是防误批的安全设计。
3. 文案必须是纯文本：不用 Markdown；层级用全角缩进；需要表格时由 drawTable 生成字符表格。模型正文的 Markdown 会在出口被 toWechatText 清洗。
4. 一条消息一个回复 id（1–99 稳定数字），用户回复 <会话码> <选项号或内容>；没带码时只有「单请求 + 非审批」才把自由文本当答复。

## 纳入 PTC（多代理）前置确认流程

主控在派发或执行危险操作前，用这条链把确认权交给用户，再把结论写进账本：

```text
1) node $cli ask --title "<操作>" --question "<做什么+影响范围>" --options "允许|拒绝" --context "PTC task <task_id> / subtask <subtask_id>"
2) 立即结束回合（不要等）
3) 收到答复后登记决策（--ledger 必须指向工作区账本，否则会在子目录新建空账本）
4) 用户拒绝：按 contract 的 objective_guard 停止该子任务，登记 kind=risk
```

「什么算危险操作」沿用工作区 AGENTS.md 全局红线 + PTC contract 的授权写入范围。

## 状态与排障（按此顺序）

1. node $cli status → switch / outboxQueued / pendingCount。
2. 推送「发了但没收到」或日志 sendMessage ret=-2 errmsg=prepare failed →
   插件日志 C:/Users/<USER>/AppData/Local/Temp/openclaw/openclaw-<date>.log 搜 contextToken。
   根因：微信 bot 主动发消息依赖 contextToken（由用户最近一次入站消息刷新）。让用户在微信给 bot 发一句话即可，不要重新扫码。
   自愈：缺 token 的消息不丢弃（标记 needsContext 保留 24h），用户下一次入站时自动补发。
3. 网关异常：pwsh -File 70-WorkSpace/wechat-hitl-20261026/tools/restart-gateway.ps1 200（会清理强杀残留的 openclaw.sqlite.cron-authority.lock）。
4. 改了插件代码必须重启对应进程：DSH 侧插件在 Web 宿主是模块缓存，patchReload: live 不重载模块 → 需重启 DSH Web。

## 三态开关

| 状态 | 检测 | 推送 | 审批 |
|---|---|---|---|
| running | 是 | 是 | 阻塞等微信答复 |
| paused | 记账 | 否（抑制+审计） | 立即 next() 交回界面，不卡回合 |
| stopped | 不介入 | 否 | next() |

## 关键路径

- 状态与审计：70-WorkSpace/wechat-hitl-20261026/state/{pending.json,control.json,sessions.json,hitl.log}
- 共享模块：lib/hitl-store.js（插件 / 网关 / CLI 三端唯一实现）
- 网关插件：C:/openclaw-runtime/plugins/dsh-bridge/index.js
- DSH 插件：~/.dsh/profiles/{web,headless}/node_modules/dsh-wechat-hitl/
- 方案与 runbook：70-WorkSpace/wechat-hitl-20261026/PLAN-wechat-hitl.md、70-WorkSpace/微信主动推送与人工确认回环说明.md
