---
title: 微信主动推送 + 人工确认回环（HITL over WeChat）方案与决策
date created: 2026-10-26
date modified: 2026-10-26
tags:
  - openclaw
  - dsh
  - weixin
  - human-in-the-loop
  - design
---

# 微信主动推送 + 人工确认回环（HITL over WeChat）方案与决策

> 位置（2026-10-28 起）：唯一原件在 DSH 工作区 `D:/src/dsh/dsh-wechat-hitl`；原先放在 logseq 库 `70-WorkSpace/wechat-hitl-20261026`，迁移后该旧路径保留 junction 指向新目录，供在跑的 DSH Web 进程继续复用同一 `state/`，DSH Web 重启后可删。
>
> 一句话结论：**DSH 侧不要再自己发微信**。把「触发」做成 DSH 宿主内的 Cordis 插件（进程内事件），把「出站」收敛成 OpenClaw 网关唯一出口，把「答复回注」做成共享状态文件 + 双通道（Web 宿主直插 / 其余走 headless 续跑）。本方案当天跑通了真实手机往返。

## 0. 本次已落地（结论先行）

| 能力 | 状态 | 证据 |
|---|---|---|
| DSH 会话结束（回合终态）自动推微信 | 已实测（headless profile） | `hitl.log` 的 `turn-end-notify` → 发件箱 → 网关 `outbox-sent`，微信收到「✅ DSH 回合结束」 |
| DSH 提问（`ask_user_question`）自动推微信带选项 | 已实测 | `tool/call + ask_user_question` → 「❓ 需要回答 [xxxx]」，含编号选项 |
| 审批门禁（危险操作）推微信并阻塞等答复 | 已实现 + 单测通过 | `approval/request` waterfall：回 1 → `allowed-once`，回 2 → `rejected`，超时 → `next()` 交回 DSH 界面 |
| 微信回复 → 定位原会话 → 原会话继续 | **已实测（真实手机）** | 2026-10-26 10:15:48 手机回「继续处理」→ 匹配 `req-…-dae8` → 原会话 `session-dd7db5bb…` 于 10:15:59 被续写并回推结果 |
| 任意 DSH 会话可触发（含脚本/CLI） | 已实测 | `wx-hitl.mjs ask/notify`，会话 id 取 `$env:DSH_SESSION_ID` |
| Web GUI 会话触发推送 | 已挂载（`patchReload: live`），首条推送在本回合结束时产生 | web profile `cordis.patch.yml` 已 insert，宿主日志有 `plugin-loaded` |
| 自动推送三态开关（开启/暂停/关闭） | 已实现 + 实测 | `tools/switch-hitl.mjs`（软开关 control.json + 硬开关 patch 挂载）；paused 实测 `push-suppressed`、审批立即委派；20/20 单测 |
| 发件箱条目不再静默丢失（跨进程写锁） | 已实现 + 3 条单测；**待重启生效** | 见 §12：`mutate` 加独占锁文件 + 崩溃残留锁抢占；`test/lock.test.mjs` 三进程并发 15 条零丢失 |
| 长文本走公网文件链接 | 未实现（已给方案对比与推荐） | 见 §3 路线 C / §7 待办 |

## 1. 目标与验收口径

1. 触发点两类：会话结束推送摘要；需要人工确认（危险操作 / 方案选择 / 审批门禁）推送「问题 + 选项 + 上下文」。
2. 推送带上下文：短则纯文本，长则公网可访问链接（本机已有 Tailscale 与 `70-WorkSpace/dsh-tailscale` 历史项目）。
3. 回环：微信纯文本回复（`1 / 允许 / 改方案B`）→ 解析 → 定位原 DSH 会话 → 继续执行。
4. 不只服务微信入站会话：本机任意 DSH 会话（Web GUI、PTC 多代理、脚本）都能触发。

## 2. 关键问题 1–6 的答复（附源码/实测依据）

### Q1. DSH 侧如何主动触发推送？

**不要**让模型自己调 `openclaw message send`，也**不要**轮询会话文件。DSH 是 Cordis 插件宿主，直接在进程内监听事件即可：

- `ctx.on('session/event', (session, event))` —— `turn/start`、`user/message`、`assistant/message`、`tool/call`、`turn/end`、`approval/asked`、`tool/result`
- `ctx.on('approval/request', (req, next))` —— waterfall，**可以真的阻塞等人工裁决**
- `ctx.on('session/disposed')`、`ctx.on('agent/error')`

依据：`~/.dsh/profiles/web/node_modules/dsh-notify-bell/src/{events,turns,index}.js` 已用同一套事件做语义通知（完成/受阻/审批/提问/出错），它证明事件面稳定可用；`@deepseek-ai/dsh-user-approval/lib/index.js` 里 `decide()` 用 `ctx.waterfall('approval/request', req, fallback)`。

实现：`dsh-wechat-hitl` 插件（本次新增），挂在 profile 的 `cordis.patch.yml` 里 `- insert:` 一行即可，不改 DSH 本体。

### Q2. 人工确认的请求-响应协议（request_id ↔ 会话 ↔ 微信 ↔ 回复）

一张表就够：`state/pending.json`（权威、带 `seq`、原子替换写入）。

`"```"`
HitlRequest {
  id            "req-<UTC紧凑>-<4hex>"      # 幂等键，微信消息里带短号 #[4hex]
  sessionId     "session-…"                  # 原 DSH 会话
  mode          "approval" | "inject"        # approval=回合内裁决；inject=答复作为新回合
  kind          "approval"|"question"|"manual"
  question / title / context / options[{key,label}]
  createdAt / expiresAt                      # 默认 30 分钟 TTL
  status        "pending"|"answered"|"expired"|"cancelled"
  answer        {key,label,raw,via,at}
  deliveredAt / delivery                     # injected | in-turn | not-live | failed:…
}
`"```"`

- 幂等：只对 `status==="pending"` 的请求接受答复（`markAnswered` 有前置判断）；重复回复不会二次注入。
- 并发：读-改-写 + `seq` + 重试；**并发正确性由跨进程锁文件保证**（2026-10-26 补：原先「不做锁」会丢更新，见 §12）；发件箱额外用 `claimedAt` 认领，防多实例重复推送。
- 超时：`expireStale()` 每 1.5 秒扫一次；审批超时 → `next()` 交回 DSH 原生界面（**不擅自放行**）。
- 生命周期：`session/disposed` 回收会话内状态。

### Q3. 纯文本回复如何映射回结构化答案

四级解析（`matchReply`）：

1. 显式定向：`#a1b2 1` → 只在短号命中的请求里选。
2. 裸数字：`1` / `１` / `1.` / `1）` → 若多个待确认请求都含该键，**报歧义**（返回候选清单，让用户带编号重发），不猜。
3. 关键词/别名：`允许` / `我允许这一次` → 标签与别名做去标点包含匹配，多命中即歧义。
4. 自由文本：**仅当**只有一个待确认请求且 `mode!=="approval"` 时，整段作为答复（审批类禁止，避免「随便说句话」被当放行）。

配套 9 条单测覆盖以上分支（`test/hitl-store.test.mjs`）。

### Q4. 会话结束检测（含 Web GUI 非 headless）

- headless/一次性进程：NDJSON 的 `{"type":"final"}` 就是回合终点。
- 常驻宿主（Web GUI / TUI）：`session/event` 的 `turn/end`（`reason.kind==="completed"`）+ 同一 turn 的**严格最终回答判定**：最后一次 `assistant/message` 必须含非空 text、不是 tool-call-only、其后无新 `tool/call`。空 no-op turn 与只调工具的 turn 不推送。
- 为什么不用「会话文件落盘」：会话持久化是 `session.v4.jsonl.zstd`（zstd 压缩），轮询要反复解压几 MB；而且落盘频率与回合边界没有一一对应关系。
- 主/子会话区分：`session.header.delegationDepth === 0`（或无该字段且 `origin!=="subagent"`）才算主会话，子代理不推送。

### Q5. 公网文件链接

| 方案 | 成本 | 与现有环境契合度 | 失效期 | 结论 |
|---|---|---|---|---|
| **Tailscale Funnel** | 0（已有 tailnet） | 高：本机已装 `tailscale 1.102.3`，DSH Web 的 `trustedHosts` 已含 `aero17.tail884325.ts.net`；但 `tailscaled` 当前**未运行**，funnel 还需管理员开服务 + 开 funnel + 证书签发 | 手动关 | **首选**（前提：先把 tailscaled 服务跑起来） |
| **Cloudflare quick tunnel** | 0，无需账号 | 中：`cloudflared` 未安装；一条 `cloudflared tunnel --url http://127.0.0.1:PORT` 即得 https 随机域名，随进程退出失效 | 进程存活期（天然短） | **低成本兜底**：临时文件服务 + 只暴露 outbox 目录 |
| 对象存储临时链接（OSS/S3 预签名） | 低（有配额） | 低：本机无已配置的 bucket/密钥 | 预签名 TTL | 备用 |
| OpenClaw `file-transfer` 插件 | ? | 未验证 | ? | 不入本轮范围 |
| 直接贴长文 | 0 | 高 | 即时 | 已有：文本截断到 900 字，够用时不需要公网 |

安全边界（任一方案都必须满足）：
1. 只暴露**临时 outbox 目录**（每文件随机名 + 30 分钟 TTL 自动删），绝不把 vault 根目录喂给隧道。
2. 链接一次性/短效；文件内容由 DSH 侧显式生成（不是自动同步笔记）。
3. 微信 `allowFrom` 保持锁定本人；隧道只 bind 到该临时目录的只读静态服务。

### Q6. 安全评估

- 公网链接 = 内容离开本机：仅推送「本次对话显式生成的摘要文件」，TTL ≤ 30 分钟，文件名随机，目录独立于 vault。
- 入站侧：`allowFrom` 单白名单；自由文本答复只在「单请求 + 非审批」时才被当作答案。
- 审批侧：微信批准是**真的放行**（`allowed-once`，仅本条），因此必须有超时（默认 5 分钟）+ 过期后回落 DSH 原生界面，且审批文案里必须带工具名与原因。
- 不要把审批放行接到「任何未匹配文本」上——已用 mode 区分 + 单测固定该行为。

## 3. 路线对比与风险矩阵

| # | 路线 | 触发机制 | 回环机制 | 公网文件 | 工作量 | 主要风险 |
|---|---|---|---|---|---|---|
| **A（推荐）** | DSH Cordis 插件 + 网关唯一出口 + 共享状态文件 | 进程内事件（turn/end、ask_user_question、approval/request） | Web 宿主 `sessionController.prompt` 直插；其余 headless `--session-id` 续跑 | 后续叠加隧道 | 中（插件 ~300 行 + 网关改造） | 插件跑在宿主内，出错可能影响宿主（已 try/catch + 事件即弃）；Web 宿主模块缓存需重启才生效 |
| B | 只用 CLI（模型/脚本主动调 `wx-hitl ask`） | 由 agent 或脚本显式调用 | 同 A | 同 A | 低（已可用） | 依赖模型「记得调用」；无法覆盖「会话结束时自动推送」 |
| C | 宿主机旁挂进程轮询会话文件 / 事件日志 | 轮询 `session.v4.jsonl.zstd` mtime + 解码 | headless 续跑 | 同 A | 中 | 解压开销大；回合边界识别不可靠；与 Web 宿主写锁冲突；**不推荐** |
| D | `openclaw mcp serve` 把通道以 MCP 暴露给 DSH | DSH 侧 MCP 调用 | MCP 回包 | 同 A | 中高 | 未验证；MCP 常驻 + 会话所有权问题；比 A 多一层，收益不明显 |
| E | acpx（ACP 桥） | — | — | — | — | **已排除**：上一会话六次对照实验确认激活即卡死网关事件循环，不再回头 |

风险矩阵（A 路线）：

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| DSH 插件抛错拖累宿主 | 低 | 高 | 全部 handler try/catch；轮询 `unref()`；`ctx.effect` 清理；先在 headless profile 验证再挂 web |
| 网关重启误杀导致启动失败 | 中 | 高（微信断线） | 用 `tools/restart-gateway.ps1`：优雅停 + **仅在 pid 已死时**清理 `openclaw.sqlite.cron-authority.lock`（本次踩到并修复） |
| 活着的 Web 会话被 headless 抢写 | 中 | 中 | 会话文件有跨进程写锁（`session.lock` / Windows 命名信号量），抢写会失败而不是损坏；失败文案提示「会话正在界面里运行」 |
| 多网关实例重复推送 | 中 | 低 | 发件箱 `claimedAt` 认领（本次实测到重复发送后修复） |
| 审批被误放行 | 低 | 高 | 审批类只认编号/关键词；超时回落 `next()`；单测固定 |
| 沙箱内 spawn openclaw 失败 | 已发生 | 中 | 改为「DSH 只写发件箱，网关唯一出口」 |
| 自动化测试污染真实微信 | 已发生（2 条测试消息真的发出） | 低 | `DSH_WECHAT_HITL_STATE` 隔离测试状态目录；入口固定为 `test/run-tests.ps1` |

## 4. 推荐架构

`"```"`
                       ┌──────────────────────────── DSH 宿主（web / headless profile）──────┐
  approval/request ───►│ dsh-wechat-hitl 插件                                              │
  session/event    ───►│  · turn/end（严格最终回答）─┐                                      │
  (turn/end,           │  · tool/call ask_user_question ─┼─► 写 pending.json + 发件箱        │
   ask_user_question,  │  · approval/request（阻塞轮询答复）                              │
   ...)                │  · 轮询 answered(inject) ─► sessionController.prompt(req, signal) │
                       └───────────────────────────────┬───────────────────────────────────┘
                                                       │ 共享状态文件（文件总线，无网络无鉴权面）
                                                       ▼
                       D:/src/dsh/dsh-wechat-hitl/state/
                         pending.json（请求表 + 发件箱）  hitl.log（审计）
                                                       ▲
                       ┌───────────────────────────────┴───────────────────────────────────┐
                       │ OpenClaw 网关进程 dsh-bridge v0.4.0                                │
                       │  · 出站泵：每 2s 取发件箱 → openclaw message send（唯一出口）        │
                       │  · 入站拦截：before_agent_reply 先匹配待确认表                     │
                       │      命中 → markAnswered → 等注入(12s) → 失败则 headless 续跑      │
                       └───────────────────────────────┬───────────────────────────────────┘
                                                       ▼
                                              微信（本人，allowFrom 白名单）
`"```"`

三条不变量：

1. **微信出站唯一出口 = 网关进程**。DSH 侧受沙箱限制（`spawn` 管道 EPERM、`~/.openclaw/tmp` 写入 EPERM），一律只写发件箱。
2. **状态只有一个事实源**（`pending.json`）。三端（插件/网关/CLI）共用同一模块 `lib/hitl-store.js`，不各写一份。
3. **答复注入优先进程内，兜底进程外**。活的 Web 宿主用 `sessionController.prompt`（同一会话继续，不新建进程）；其余用 `dsh --profile headless --session-id <原会话>`。

## 5. 原型组成

| 文件 | 作用 |
|---|---|
| `lib/hitl-store.js` | 共享状态层：请求表、答复解析、微信文案、发件箱（`pushWechat`/`drainOutbox`）、headless 续跑、NDJSON 解析 |
| `pkg/dsh-wechat-hitl/index.js` | DSH Cordis 插件：turn/end 推送、`ask_user_question` 推送、`approval/request` 阻塞式批准、答复注入 |
| `pkg/dsh-wechat-hitl/cordis.patch.yml` | 挂载补丁（`- insert:`），web 与 headless 两个 profile 各一份 |
| `gateway/dsh-bridge-index-v0.4.0.js` | 网关插件 v0.4.0：出站泵 + 入站答复拦截 + headless 兜底 + `resolveTarget` 修正 |
| `bin/wx-hitl.mjs` | CLI：`notify` / `ask` / `status` / `resolve` / `continue` / `cancel`（任意脚本/任意会话可用） |
| `tools/restart-gateway.ps1` | 网关重启（含 stale cron-lock 修补） |
| `test/hitl-store.test.mjs`、`test/plugin.test.mjs` | 14 条单测（解析 9 + 插件 5） |
| `test/run-tests.ps1` | 单测入口：把状态目录隔离到 `state-test`，避免测试推送真的发到微信 |
| `tools/switch-hitl.mjs` | 三态开关：软开关（`control.json`）+ 硬开关（增删 profile patch 的 `- insert:` 块），`--show` 看状态 |
| `tools/check-web-patch.mjs` | patch 体检：解析 `BEGIN/END` 标记块，确认挂载态 YAML 合法 |
| `test/switch.test.mjs` | 开关门禁 6 条：默认/切换/抑制/积压不丢/停止不介入/审批不阻塞 |

安装位置：
- 插件：`~/.dsh/profiles/{web,headless}/node_modules/dsh-wechat-hitl/`，profile `cordis.patch.yml` 加 `- insert:`
- 网关插件：`C:/openclaw-runtime/plugins/dsh-bridge/index.js`（v0.3.0 已备份为 `index.js.bak-v0.3.0-*`）

## 6. 验证证据（真实微信往返，2026-10-26）

| 时间（本地） | 事件 | 证据 |
|---|---|---|
| 10:09:48 | 直接推送真实到达微信 | `Sent via openclaw-weixin. Message ID: openclaw-weixin:1792978831241-2ef0d347` |
| 10:12:41 | 发件箱泵在网关内工作 | `dsh-bridge-debug.log`：`{"outbox":{"sent":1,"failed":0}}` |
| 10:16:53 | headless 回合结束自动推送入队 | `turn-end-received` → `turn-end-eval`(hasText:true) → `turn-end-notify` → `push-queued` |
| **10:15:48** | **用户手机回复「继续处理」** | `{"hook":"fire","sample":"继续处理"}` → `{"hitl":"match","pending":1,"ok":true}` |
| 10:15:59 | 原会话被续写 | `session-dd7db5bb-…/session.v4.jsonl.zstd` mtime = 10:15:59；请求 `delivery:"injected"` |
| 10:16:00 | 续跑结果回推微信 | `outbox-sent id=out-…` |
| 全量单测 | **20/20** 通过 | `pwsh -NoProfile -File test/run-tests.ps1`（9 解析 + 5 插件 + 6 开关；状态隔离到 `state-test`） |
| 开关实测（running→paused） | 推送被抑制、不进队列 | `{"ok":false,"output":"suppressed:paused"}`；`hitl.log` `op:"push-suppressed"`；outbox 条数不变 |
| 开关实测（paused 下 ask） | 拒绝建请求，不留悬空 | `{"ok":false,"suppressed":true,"state":"paused"}` |
| 开关实测（硬开关卸载/挂载） | patch 块增删 + YAML 合法 | `check-web-patch.mjs`：`block=absent(未挂载)` → `mounted/OK` |
| Web 会话推送（真实） | 本会话 + 另外两个真实会话回合结束都有推送 | `turn-end-notify` 记录含 `session-4c0dcb1b`（本会话）、`session-61c0711f`、`session-8a888f73` |

## 7. 已知限制

1. **Web 宿主内的答复直插需要一次 DSH Web 重启**。插件已挂载（事件与推送可用），但 `sessionController.prompt(request, signal)` 的 `signal` 修正发生在模块已加载之后；`patchReload: live` 只重放 patch 不重载模块代码（实测日志仍为旧格式）。重启后生效；重启前 Web 会话的答复走 headless 兜底（若该会话正被 GUI 持有写锁则失败并提示）。
2. `dsh --profile headless` 进程在回合结束后**可能长时间不退出**（残余句柄，实测 >90s），因此所有消费方都以 NDJSON `{"type":"final"}` 为回合终点，看到即收工并 kill 子进程。
3. 长文本公网链接未实现（方案见 Q5）；当前长文本截断到 900 字。
4. 审批放行粒度只有「允许一次 / 拒绝」——`allowed-once` 是唯一合法的放行结果，不支持「永久允许」。
5. 状态文件在 DSH 工作区内（`D:/src/dsh/dsh-wechat-hitl/state/`），2026-10-28 迁出笔记库后**不再随坚果云同步**；只含请求元数据与消息正文，敏感内容勿走微信。
6. 网关 CPU 饥饿（`dsh --profile web` pid 25588 长期约 4.5 核）会让推送与重启明显变慢，属既有问题。

## 8. 下一步（按优先级）

1. 择机重启 DSH Web，验证 Web GUI 会话的「微信答复直插」不再返回 `controller-failed`。
2. 长文本走公网链接：优先 Tailscale Funnel（先把 `tailscaled` 服务跑起来）；否则 Cloudflare quick tunnel + 只读临时目录 + 30 分钟 TTL。
3. 把 `wx-hitl` 固化成 skill（`approval-gate` 语义），让 PTC 多代理在「危险操作/方案选择」处默认调用。
4. 收敛噪音：`notifyOnTurnEnd` 增加「只推有实质产出的回合」条件（本轮有 tool/call，或耗时 > N 秒）。


## 9. 增量：自动推送的三态开关（2026-10-26 追加）

需求：自动推送不能只有“开”，要有 **启动 / 暂停发送 / 关闭服务** 三个可操作状态。

| 状态 | 事件检测 | 推送发送 | 审批（approval/request） | 请求表 |
|---|---|---|---|---|
| `running` 🟢 | 是 | 是 | 推微信并阻塞等答复 | 正常建 |
| `paused` 🟡 | 是（记账） | 否（`push-suppressed` 审计） | **立即** `next()`，不阻塞回合 | 不建（`SWITCH_NOT_RUNNING`） |
| `stopped` 🔴 | 否（不介入） | 否 | `next()` | 不建 |

实现（两层，缺一不可）：

1. **软开关** `state/control.json`：`getControl()/setControl()`，所有发送前必读；环境变量 `DSH_WECHAT_HITL_SWITCH` 覆盖（单测用）。切换即在 `hitl.log` 留 `op:"switch"` 审计。
2. **硬开关** profile `cordis.patch.yml` 的 `# >>> dsh-wechat-hitl BEGIN … END` 块：`stopped` 摘除挂载、`running` 恢复挂载。**为什么必须保留这层**：宿主上可能仍跑着旧模块（ESM 模块缓存不随 patch 重放刷新，本次实测卸载→重挂后日志仍是旧格式），软开关对它无效，只有摘挂载能真正停住。

工具：`tools/switch-hitl.mjs`（`--state` + `--soft` + `--show`）、`tools/check-web-patch.mjs`（patch 块体检）、CLI `wx-hitl.mjs on|pause|off|status`。

验证（20/20 单测 + 实机）：

| 用例 | 结果 |
|---|---|
| paused 下 `notify` | `{"ok":false,"output":"suppressed:paused"}`，outbox 条数不变 |
| paused 下 `ask` | `{"ok":false,"suppressed":true,"state":"paused"}`，不留悬空请求 |
| paused 下 `drainOutbox` | @@B@{sent:0, skipped:"paused"}`，积压保留不丢 |
| stopped 下插件 | 不建请求、不推回合结束（单测断言 outbox/requests 均不变） |
| 非 running 下审批 | 立即 `next()` 返回 `unavailable`，实测 <2s，不阻塞回合 |
| 硬开关 | patch 块 `absent(未挂载)` ⇄ `mounted/OK`，YAML 解析通过 |
| Web 会话推送（真实） | `turn-end-notify` 命中本会话 `session-4c0dcb1b` 与另外两个真实会话 |


## 10. 增量：识别码改为短纯数字（2026-10-26 追加）

反馈：`[#1fca]` 这种 4 位十六进制在手机键盘上难打、复制也不顺手，而且和选项分成两段“太分离”。

改法：

| 项 | 之前 | 现在 |
|---|---|---|
| 识别码 | `[#1fca]`（4 位 hex，嵌在方括号里） | `7` / `21`（1–2 位纯数字，放首行行首 `7｜🚦 需要确认`） |
| 分配 | request id 末段 | 单调递增（1..99），跳过未完成请求占用的号，避免回串 |
| 单请求 | 仍要求 `#1fca 1` | **完全不用码**，直接 `回 1 或 2` |
| 多请求 | `#a1b2 1`（两段） | `21` 连写（也可 `2 1` / `2-1` / `2:1`） |
| 复制粘贴 | 方括号+hex 易被带走 | 首尾括号/引号/全角一律自动剥掉：`【2】1`、`"2" 1` 都认 |
| 只回码 | 当成答非所问 | 回「码 2 是「…」，请连写选项：21 / 22」 |
| 歧义 | 直接列候选 | 仍不猜，明确给「码+选项」写法示例 |

实现要点：新增 `allocateHandle()` / `handleText()`，`createRequest` 落盘时分配 `handle`；`matchReply` 增加「码+选项」分支（连写/空格/短横/全角/括号）与 `need-option` 原因码；`normalizeReply` 全局剥离括号；网关 `handleHumanReply` 增加 `need-option` 回话。旧 hex 短号仍兼容。

验证：单测 25/25（新增 5 条识别码用例）；实测推送与解析：

| 输入 | 结果 |
|---|---|
| `1`（单请求） | 选第 1 项 |
| `11` | 码 1 → 第 1 项 |
| `【1】2` | 码 1 → 第 2 项（括号剥离） |
| `2 1` / `21` | 码 2 → 第 1 项 |
| `2 稍后` | 码 2 → 标签匹配 |
| `2` | need-option：提示「21 / 22」 |


## 11. 增量：主动推送的真实边界（contextToken）

现象：某天起所有主动推送返回 `sendMessage ret=-2 errmsg=prepare failed`，而 `channels status` 仍显示 `running`。

定位（插件自身日志 `C:/Users/<USER>/AppData/Local/Temp/openclaw/openclaw-<date>.log`）：

`"`@T`"`
sendWeixinOutbound: contextToken missing for to=o9cq…@im.wechat, sending without context
sendMessageWeixin: failed … err=Error: sendMessage ret=-2 errmsg=prepare failed
`"`@T`"`

结论：**微信 bot 的“主动发消息”依赖 `contextToken`**（缓存在 `~/.openclaw/state/openclaw.sqlite`，由用户最近一次入站消息产生/刷新）。token 缺失时插件仍会尝试发送，但服务端拒绝。

| 场景 | 能否主动推送 | 对策 |
|---|---|---|
| 用户最近给 bot 发过消息（token 有效） | 能 | 正常使用 |
| 长时间静默 / token 过期 / DB 被清 | 不能（fail fast，不静默丢） | 先在微信发一句话刷新 token；插件侧可后续做 token 持久化/预热刷新 |
| 需要真正无人值守的长延时推送 | 受此限制 | 可选：定时巡检 token，或改用支持订阅/模板消息的通道 |

工程行为：**发送失败**会被 `drainOutbox` 记为 `failed`、重试 5 次后丢弃并写日志，因此「没收到」能查到原因；但「条目在队列里被覆盖消失」这一类当时没有留痕，已由 §12 修复。

排障顺序：先看插件日志的 `contextToken` / `prepare failed` → 再考虑 `channels login`。本次实测**不需要扫码**，用户回一句话即恢复。

## 12. 增量：出站条目静默丢失的修复（2026-10-26 追加）

现象：14:42 网关重启窗口，`out-1792996945520-4f5afe` 在 `hitl.log` 里只有 `push-queued`（gatewayUp=false），既无 `outbox-sent` 也无 `outbox-failed` 就消失了；微信没收到，`status` 显示 outboxQueued 归零，日志也不报错。

根因：`pending.json` 有三个写入者（DSH 宿主插件、OpenClaw 网关出站泵、CLI），而 `mutate()` 是无锁的「读-改-写 + 重试」。后写者若持有旧快照，会整体覆盖前者在快照之后插入的条目 —— 条目被抹掉，任何一方都没有“删除”记录，所以既不算 sent 也不算 failed。租约（claimedAt）只能防重复发送，防不了这种丢更新。

改动（`lib/hitl-store.js`）：

1. `mutate()` 外面加跨进程锁：`pending.json.lock` 用 `openSync(..., "wx")` 独占创建；超过 staleMs(15s) 的残留锁（持有者崩溃）可抢占；拿不到锁超过 5s 时降级写入并记 `state-lock-timeout`（宁可偶发丢更新，也不能完全不写）。
2. `pushWechat()` 的网关探活改成异步：入队即返回 `queued`，探测结果只写日志。原来同步等 6s 探测，CPU 饥饿/网关重启时会返回 `queued(gateway-probe-timeout)`，让调用方把“已入队”误判成失败（实测 06:42、06:49 两次都误报，45 秒后照常发出）。
3. `drainOutbox()` 在租约过期被重新认领时记 `outbox-reclaim`，便于区分“晚到”与“真丢”。

验证（2026-10-26 15:0x，`test/run-tests.ps1`）：

| 用例 | 断言 | 结果 |
|---|---|---|
| 三进程各推 5 条 | outbox 恰好 15 条、id 不重复、锁已释放 | 通过 |
| 残留锁 60s（模拟崩溃） | 可抢占、写入成功、不发生长时间阻塞 | 通过 |
| 入队返回 | output=queued、gatewayUp=null、耗时 < 1.5s | 通过 |
| 全量回归 | 9 + 5 + 15 + 3 = 32 条全绿 | 通过 |

测试入口同时改造：原来用 `node --test`，它会为每个文件 spawn 子进程并经管道收输出，在 DSH 沙箱里直接 EPERM；改为逐文件 `node <file>`（测试在本进程内执行），沙箱内外都成立。

生效条件（关键）：插件与网关都通过 `file:///D:/…/lib/hitl-store.js` 加载本文件，但进程内已缓存模块，**必须重启才生效**：网关重启 70s 级（`tools/restart-gateway.ps1`）；DSH 宿主重启会结束当前会话。本机沙箱内 `Get-CimInstance` 拒绝访问，无法从会话里可靠定位并停止网关进程，因此这一步要放在重启窗口里执行。

残余风险：只要 DSH 宿主没重启，它的写入仍是旧的无锁版本，丢更新窗口只是收窄不是消除；两边都重启后才算闭环。


### 12.1 上线与验收（2026-10-27 00:25–01:33 实测）

1. **DSH 宿主重启**：00:25:14 写入 `plugin-loaded pid=42836`，新代码在宿主侧加载。
2. **网关曾整机 DOWN**：23:42:41 网关退出（日志停在 `remote model catalog applied`），此后端口 18789 不可达；启动被 `~/.openclaw/state/openclaw.sqlite.cron-authority.lock` 里已死进程 pid 42032 卡在 `gateway-run-bootstrap ... failed`。`tools/restart-gateway.ps1` 清理后 `gateway UP after ~60s: HTTP 200`。
3. **丢消息回归（关键验收）**：连续入队 3 条 → 立即 `Stop-Process` 杀网关（模拟重启窗口）→ 3 条在 `pending.json` 全部存活（queued=3）→ 重启网关后日志依次 `outbox-sent 280ce7`、`outbox-sent 66054b`、`outbox-reclaim 670d87 (previousClaimAt=…717153)` → `outbox-sent 670d87`；最终 queued=0、sent 84→87、failed 不变（74）。
   最后一条正是旧实现的「静默消失」场景：认领它的进程被杀，租约到期后被新代码重新认领并补发 —— 这就是 §12 修复的直接证据。
4. **一致性**：全程 `state/` 无残留 `pending.json.lock`；32/32 单测复跑仍全绿。

### 12.2 追加修正：入队日志必须同步写

问题：把探活改异步后，CLI（`wx-hitl.mjs`）拿到返回值立刻 `process.exit()`，异步回调里的 `push-queued` 日志被丢弃 —— 17:28 那三条回归推送在日志里完全没有入队记录。

修正：`pushWechat()` 先同步写 `push-queued`（gatewayUp=null），探活结果另写 `push-probe`。注意 `push-probe` 只对长驻调用方（插件）可见，CLI 进程退出后不会写。验证：17:32:53 `push-queued` → 17:33:32 `outbox-sent`。

### 12.3 TTL 丢弃留痕（2026-10-27 补）

问题：超过 30 分钟的积压条目在 `drainOutbox()` 里被静默移除 —— 不记 sent、不记 failed、什么都不写。00:37 与 00:39 那两条就是这样无痕消失，用户侧只能看到「没收到」。

改动：`drainOutbox()` 丢弃前写 `outbox-dropped`（含 `reason/ageMs/ttlMs/createdAt/sessionId/preview`），并把 `dropped` 计入返回值；TTL 改用常量 `DEFAULT_TTL_MS`。

验证：

| 层次 | 证据 |
|---|---|
| 单测 | `test/lock.test.mjs` 第 4 条「超过 TTL 的积压被丢弃时必须留痕」；全量 33/33 通过 |
| 生产实测 | 向真实 outbox 注入一条 31 分钟前的条目 `out-ttl-prod-ca7baa` → 网关泵 01:59:28 写 `"op":"outbox-dropped","reason":"ttl","ageMs":1953028,"ttlMs":1800000`，队列随即归零 |

至此「没收到」的三种成因都有痕可查：发送失败（outbox-failed）、进程中断后补发（outbox-reclaim）、超时丢弃（outbox-dropped）。


## 13. 增量：微信通知里的 Markdown 泄漏（2026-10-27 追加）

现象：2026-10-26 22:54 的回合结束推送里，`## 标题`、`| 表格 |`、`**加粗**`、`---` 全部原样进了微信。微信不渲染 Markdown，用户看到的是一段符号噪声。

根因（两个叠加）：

1. **出口没清洗**：`formatTurnEnd()` 直接取模型最终回答的前 6 行，原样塞进队列。
2. **运行进程早于代码**：清洗函数 `toWechatText()/outboxTag()` 是 15:00 之后才加进 `lib/hitl-store.js` 的，而 22:54 时在跑的网关是 14:43 启动的那个进程 —— ESM 模块已缓存，看不到新代码。

修复：

1. 出口统一清洗：两条发送路径（direct 与 drainOutbox）都走 `outboxTag(entry)` → `toWechatText()`，标题转 `■`、表格竖线转全角、粗体/行内代码/引用/分割线全部剥掉、链接保留文字。
2. 先清洗再截行：`formatTurnEnd()` 原来按原始前 6 行截断，Markdown 密集型回答会截成「标题 + 空行」的噪声；改为先 `toWechatText()` 再取前 8 个非空行，正文摘要（`input.summary`）同样走清洗并压成单行。
3. 顺手修掉工作区里被写坏的两行（表格 `filter((cell) => …` 被截断、以及误删的 `const pending = listPending()`）。

验证：

| 层次 | 证据 |
|---|---|
| 预览 | `outboxTag()` 对含标题/表格/粗体/引用/围栏/链接的样本输出：标题→■、表格→全角分隔、无 `##`/`**`/`|`/`---` 残留 |
| 单测 | 新增 2 条（`toWechatText` 去噪、`formatTurnEnd` 先清洗再截行）；全量 35/35 |
| 生产 | 02:07:51 `outbox-sent out-1793066784883-301b08`（故意带 Markdown 的验收样本已发出） |

生效边界：出口清洗在**网关**进程里执行，重启网关即对全部出站生效；但「先清洗再截行」属于宿主侧 `formatTurnEnd()`，要等 DSH 宿主重启才生效（不重启也不会漏 Markdown，只是摘要仍可能截到标题行）。

### 13.1 漏点二：全角缩进让清洗规则失效（2026-10-27 追加）

现象：网关已换新代码后，会话码 14 / 8 的回合结束推送**仍然**带 `## 一、srs处理`、`| 二级 | … |`、`　---`。

根因：`formatTurnEnd()` 给正文每一行加了全角缩进前缀 `　`，而出口清洗的正则都是「行首」锚定（`^#`、`^[ \t]*\|`、`^#`），被这个 U+3000 挡在门外 —— 标题、表格、引用、分割线整段逃过清洗。列表之所以被清掉，是因为 `s` 在 JS 里包含 U+3000，而标题/表格的字符类只写了 `[ \t]`。

复现（修复前）：

```
输入（带全角缩进）        清洗后
　## 一、srs处理      →   ## 一、srs处理      ← 漏
　| 二级 | 覆盖 |     →   　| 二级 | 覆盖 |   ← 漏
　- 列表项            →   ・列表项            ← 已清
```

修复：把四处行首判定统一改为 `[ \t\u3000]*`（标题 / 表格 / 引用 / 分割线），表格改写时保留原缩进。修复后同一输入输出：`■ 一、srs处理`、`　二级　覆盖原事项　状态`（分隔行已丢弃）、`・列表项`。

验证：

| 层次 | 证据 |
|---|---|
| 复现 | 修复前对带 `　` 的样本调用 `toWechatText()`，标题与表格原样吐出 |
| 单测 | 新增「全角缩进行（formatTurnEnd 前缀「　」）下的标题/表格也必须清洗」；全量 36/36 |
| 生产 | 验收样本 `out-1793070033006-04ffef` 已入队；因 contextToken 过期进入 `outbox-wait-context` 等待（不是丢弃），用户发一条微信后自动补发 |

顺带确认的边界：微信主动推送依赖 contextToken（见 §11），token 失效时条目**挂起等待**而不是失败丢弃 —— `outbox-wait-context` 是正确行为，排障时不要误判为丢消息。

### 13.2 同一根因的第三个表现：列表符号 "- " 未被转换（2026-10-27 追加）

用户回传的会话码 8 回合结束里，标题与表格已变成 `■`/全角，但 `- 项目改为可折叠卡片。` 仍是半角连字符。

定位：那一版的列表规则是 `^[-*+]\s+`（只认「行首无缩进」），而 `formatTurnEnd()` 给正文每行加了 U+3000 前缀，于是 `　- 项目…` 不匹配。我早期那条自测样本的列表项恰好**没有缩进**，所以当时看起来「列表已清」——属于样本选取造成的假阴性。

现状：当前实现已改为 `^\s*[-*+]\s+`（`\s` 含 U+3000），并在标题/表格/引用/分割线四处补了 `[ \t\u3000]*`。用用户回传的**原文**实测 `outboxTag()`：半角连字符残留数 = 0，输出为 `・项目改为可折叠卡片。`。

教训（已写进测试）：清洗相关的回归样本必须带「全角缩进前缀」，否则会漏掉 formatTurnEnd 这条唯一生产路径的形态。

### 13.3 发送审计：outbox-send

每次真正调用微信发送前写一条 `outbox-send`，含 `chars` 与实际 payload 前 180 字。用途：

- 事后可直接回答「他到底收到了什么」，不必让用户回贴；
- 与 `outbox-sent`（成功）/ `outbox-wait-context`（token 失效挂起）/ `outbox-failed` 组成完整证据链。

### 13.4 第三种形态：正文被压成一行（扁平化）

现象：会话码 5 的 `out-…33db0f`，整段正文挤在一行里，只有第一个 `##` 命中行首规则，后面的 `## 但现在…`、 `| 表格 |` 全部按行内字符逃过清洗。

根因：微信侧复制/转发会把换行压成空格，清洗规则全部按「行首」设计，于是只剩第一段被处理。

修复（三处兜底）：

1. 换行还原：把「空白 + ?/##/### 」先还原成换行，再走行首规则；
2. 分隔单元格整段删除：压成一行后 `|---|---|` 会变成更难看的 `｜ --- ｜ --- ｜`，先整段抹掉；
3. 残留竖线转全角：` | a | b | ` → ` ｜ a ｜ b ｜ `，并把连续分隔符收敛成一个。

验证：单测新增「扁平化文本（换行被压成空格）里的标题与表格也要清洗」；生产样本 `out-1793072013225-601e64` 的 `outbox-send` 审计显示实际 payload 为 `■ 一、srs处理 ｜ 二级 ｜ 覆盖原事项 ｜ 状态 …`、第二段 `■ 但现在有个更紧急的问题`，03:36:53 `outbox-sent`。

已知残留（不再投入）：

- 行内 `- ` 项目符号不转换（无法与正文里的连字符区分，宁可不误伤）；
- 分隔单元格被删后可能留下 `｜  ｜` 这种空槽。

### 13.5 测试稳定性：switch.test 的抖动

现象：全量跑偶尔挂 1–2 条（每次不同，均在 `test/switch.test.mjs`），单跑该文件恒 15/15。

定位：该文件的用例共用同一份单例状态与真实计时器，缺用例级 teardown；已加 `beforeEach` 复位（control→running、清空发件箱），并把 `run-tests.ps1` 改为**每个文件开跑前清空** `state-test`。抖动明显收窄但未根除，根因在测试设计（应改为每条用例独立 ctx + 假计时器），留作单独任务。

教训：命令退出码为 0 之前不要宣称「全绿」；本项目已出现「单跑通过、全量随机挂」的假绿。

## 14. 微信版式规范（2026-10-27 定稿）

用户反馈「换行不友好」后，按微信实际渲染能力重写 `formatTurnEnd()`。

### 14.1 微信文本消息的渲染事实

| 写法 | 微信表现 |
|---|---|
| 单个 `\n` | 正常换行，可靠 |
| 连续空行 | 被压成最多 1 个空行 |
| 行首空格 / 全角空格 | 各端 trim 不一致，且手机气泡仅 ~17 汉字宽，缩进直接吃掉宽度 |
| 多个全角空格对齐成列 | 非等宽字体，窄屏折行错位 |
| 超宽长行 | 硬折行，从字中间断开 |
| 用 ─ 画的分隔线 | 可以，但长度要 ≤ 12，否则自己会折成两行 |

### 14.2 规范

1. 分行只用 `\n`；空行只在末段提示前留 1 处；
2. 不用行首缩进表达层级，改用 `・`（并列）/ `：`（键值）/ `①②`（步骤）；
3. 每行显示宽度 ≤ 34（约 17 汉字），按 CJK=2 / 其它=1 计算；
4. 分隔线固定 12 个 `─`；
5. 表格类内容不要画表，改为 `・键　值　值` 的分段打包；
6. 排版实现： `wrapCjk()`（按显示宽度折行，优先断在 `　，。、；：`）+ `packSegments()`（按 `　` 分段打包，末行过短时从前一行挪一段下来）。

### 14.3 定稿版式

```
【回合结束】40 秒
码 5 · 会话 24a3d4b5
────────────
任务：按五个一级任务归类，
并把不属于任何一项的单独列出给建议
结果：
■ 归类结果
・一级任务　覆盖事项　状态
・srs处理
5 条方向 + ACC-063　待裁定
・词根词典　549 条差异　等 6 项答复
・结论：归类完成，
有 2 项需你裁定。

回复 5 <内容> 可继续驱动
```

验证：单测「回合结束版式符合微信渲染：单换行、无行首缩进、宽度受控」（hitl-store.test 14/14）；样本 `out-1793072851503-98f9d8` 待 `outbox-sent` 确认。

## 15. ISSUE-001 修复：等 token 的条目不再被 TTL 误删（2026-10-27）

现象（实证）：新格式验收样本 `out-…98f9d8` —— `04:15:20 outbox-wait-context`（按设计应保留 24h），`04:17:58 outbox-dropped reason=ttl ageMs=1827458`（30 分钟 TTL 先判死），用户最终没收到。

根因：两个保留策略互相打架 —— `drainOutbox()` 开头的 30 分钟 TTL 判定**先于** needsContext 分支执行，把「等 token」的条目当普通积压删掉。

修复：

1. 抽出纯函数 `outboxEntryDisposition(entry, now)` → `send | hold-context | drop-ttl | drop-context-expired`；判定只在一处。
2. `needsContext === true` 的条目**豁免 30 分钟 TTL**，改由 `CONTEXT_HOLD_MS`（24h，从 `contextMissingAt` 起算）管理；
3. 丢弃原因区分记：`outbox-dropped reason=ttl` / `reason=context-expired`，不再混为一谈；
4. 等待期间发送节流 `CONTEXT_RETRY_COOLDOWN_MS`（60s，写 `nextAttemptAt`），避免每 2 秒一次 `prepare failed` 刷日志（04:15 段实测就是这个形态）。

验证：

| 层次 | 证据 |
|---|---|
| 单测 | 新增「ISSUE-001：等 token 的条目豁免 30 分钟 TTL，超 24h 才丢弃」，hitl-store 15/15 |
| 生产 | 注入 31 分钟前的 `out-hold-probe-9acc6e`（needsContext=true，nextAttemptAt 未来）→ 90 秒后仍在队列（age_min=33）、无任何 outbox-dropped；旧逻辑在 30 分钟即删。验证后已手动清除 |

生效条件：丢弃判定在网关进程内执行，已通过重启网关生效。

## 16. 微信侧压缩：只留「已处理 / 需决策 / 进度」（2026-10-27）

用户反馈：回合结束通知太长、细节太多；要求剔除数字与技术细节，只述已处理、当前进度、需决策，总字数进一步压缩。

实现：

1. `stripWechatNoise()`：去 URL、Windows 路径、`ACC-012` 这类编号、代码标识符（`lifecycle_state`）、长英文词；数量词改写成「若干」而不是整段删掉（否则读成「已定稿 ，待裁定 。」）。
2. `distillForWechat()`：三桶抽取——已处理 / 需决策 / 进度（顺序即优先级，避免「仍待确认」被「进度」抢走）；每桶取**最短的匹配句**；单条压到 40 字；标题行与正文合并，且去重与标签重复的前缀。
3. `formatTurnEnd()`：正文改为最多 4 行三段式；压缩后若一条不剩，退回原始前两行，避免「结果」空着；提示语折行且改为「回复 N <内容> 可继续，细节在本会话」。

效果（同一段 600 字的真实回合输出）：

```
【回合结束】166 秒
码 12 · 会话 8a888f73
────────────
任务：继续处理
结果：
・已处理：校验器新增四条硬检查，全部通过。
・需决策：计息分母、递延期限仍待确认。

回复 12 <内容> 可继续，细节在本会话
```

验证：hitl-store 15/15；样本 out-1793078032868-5cfe98 已入队。

未解：桌面版微信是否渲染 `\n` 无法从本机验证；若确实不渲染，唯一缓解是继续压字数（无法用排版解决）。


## 17. REQ-001 / REQ-002 实现（2026-10-27）

- 状态层新增 `resultPush` 维度（`getResultPush/setResultPush/isResultPushEnabled/describeResultPush/parsePushCommand`），`setControl()` 重写 control.json 时保留该字段。
- DSH 插件在回合结束推送前加门禁：关闭时记 `turn-end-suppressed`，审批与提问不受影响。
- 网关入站前置解析「推送 开/关/状态」，整条严格匹配，不抢会话码路由；回执带前后值。
- CLI 新增 `wx-hitl.mjs push status|on|off`。
- 部署：pkg 插件已复制到 web/headless profile；网关插件已复制到 C:\openclaw-runtime\plugins\dsh-bridge 并重启网关（哈希与源一致）。
- 验证：hitl-store 17/17；CLI 开→关→开 实测通过。
- 待生效：DSH 宿主重启后插件门禁才作用于真实回合结束。
