---
title: 微信入站丢消息修复 + 出站进程内改造（2026-10-28）
date created: 2026-10-28
date modified: 2026-10-28
tags:
  - openclaw
  - weixin
  - hitl
  - fix
---

# 微信入站丢消息修复 + 出站进程内改造

根任务 task-20261028T055112103276Z-d3e4ec4747a0（PTC 账本 `.ptc/registry.jsonl`）。
当前状态：**代码全部落地且单元级验证通过；运行中的网关仍是 12:11 启动的旧进程，需在 DSH 沙箱外重启一次才生效。**

## 一、入站（文件已改 + 故障注入已验证）

| 文件 | 改了什么 |
| --- | --- |
| `~/.openclaw/extensions/openclaw-weixin/src/monitor/monitor.ts` | 游标保存块移到本批处理之后（202-209 行，marker `cursor-advanced-after-processing`）；for 循环改为重试包装 + 丢弃留痕（154-201 行）；常量 `INBOUND_MAX_ATTEMPTS=3` / `INBOUND_RETRY_DELAY_MS=2000` |
| `~/.openclaw/extensions/openclaw-weixin/dist/src/monitor/monitor.js` | 同一改造的运行时副本（网关真正加载的是这份：`openclaw/dist/bundled-dir-BeWxNo9f.mjs:78` 优先 `openclaw.runtimeExtensions`） |
| `tools/weixin-inbound-patcher.mjs` | 幂等补丁核心：锚点校验、写前备份、写完 `node --check`、失败回滚、子进程用文件描述符（沙箱禁管道） |
| `tools/apply-weixin-inbound-fix.ps1` | 入口，保留 `-Check` |
| `tools/restart-gateway.ps1` | 启动前重注入（56 行）+ 非 0 退出码告警；登录自启 `OpenClaw-Gateway.cmd` 钩子（70-88 行） |
| `tools/apply-all-and-restart.ps1` | 沙箱外一条命令：入站 + 出站 + 重启 |

行为：游标只在本批处理完成（成功，或重试后已记录丢弃）后推进；单条最多 3 次（1 原始 + 2 重试，间隔 2s）；跳过必写
`inbound-dropped: sessionId=… seq=… msgId=… from=… type=… attempts=3 err=…`（errLog + aLog.error 双写）。

## 二、出站进程内（已实现于 hitl-store，无需改 dsh-bridge）

**找到的接口**（openclaw-weixin 官方包自身导出，网关加载的就是这份 dist）：

| 位置 | 导出 |
| --- | --- |
| `src/messaging/send.ts:103` | `sendMessageWeixin({ to, text, opts })` — 只依赖 api/logger/random/types/inbound/quote-store，**不需要 channelRuntime、不开 openclaw-agent.sqlite** |
| `src/auth/accounts.ts:164` | `loadWeixinAccount(accountId)` → `{ token, baseUrl, userId }` |
| `src/messaging/inbound.ts:109` | `getContextToken(accountId, userId)` |

**落点选择**：`lib/hitl-store.js` 由网关插件 dsh-bridge 在**网关进程内**加载，所以在这里 `import("file:///…/dist/src/messaging/send.js")` 与网关同进程同解析规则；而该文件在工作区内，可正常维护。因此**不需要改 C:\openclaw-runtime\plugins\dsh-bridge\index.js**（那里在沙箱外，写不进去）。

实现（`lib/hitl-store.js`）：
- `setOutboxSender()`（插件可注入）、`getOutboxEgressMode()`（`DSH_BRIDGE_EGRESS=inproc|cli`）
- `loadInprocEgress()`：懒加载三个导出，成功记 `inproc-egress state=ready`，失败记 `state=unavailable` 并永久退回 CLI（网关外调用就是这个分支）
- `inprocSend()`：读账号 token + contextToken，调 `sendMessageWeixin`；缺 token 返回 `contextToken missing` 以便上层走「等 token」逻辑
- `drainOutbox()` 三级出口：① 插件注入的发送器 ② 本模块进程内 ③ 子进程 CLI（兜底）
- 可用环境变量覆盖：`DSH_WEIXIN_EXT_DIST` / `DSH_WEIXIN_ACCOUNT_ID`

## 三、验证证据

入站：
- `apply-weixin-inbound-fix.ps1 -Check` → 退出码 0；两目标 `present=2`
- 两文件：`marker=1`、`inbound-dropped` 3 处、`node --check=0`；二次运行 `already-patched`
- `state/verify/` 故障注入（stub 替换网关依赖，直接跑补丁后的 monitor.js）：
  - 修前：`order=[save-cursor, process,…]`，permanent-conflict 无重试无 inbound-dropped → 静默丢失复现
  - 修后：plain `[process, process-ok, save-cursor]`；transient 3 次后成功；permanent 3 次后 1 条 `inbound-dropped`（sessionId=wx-session-41b9f735, type=SqliteSessionMutationConflictError）；getUpdates 抛错不推进游标

出站（`state/verify/egress/`，stub dist + 临时 state 目录）：
- A 进程内：`sent=1`、队列清空、调用参数 `{baseUrl, token, contextToken, accountId}`、`outbox-egress mode=inproc` + `outbox-sent`
- B dist 不可解析：`inproc-egress state=unavailable` → `mode=cli` 兜底（不炸）
- C 进程内抛错：`inproc-error` → `outbox-failed attempts=1`，条目保留、不计 sent
- D `DSH_BRIDGE_EGRESS=cli`：强制 `mode=cli`

真实代码路径验证（`state/verify/real-send/`，不是 stub）：用 `registerHooks` 只把 `openclaw/plugin-sdk/temp-path`（该链路上唯一的 SDK 依赖）替换掉，直接加载**真实的** `dist/src/messaging/send.js` 打到本地假 ilink 服务：

- 导出 6 个函数，含 `sendMessageWeixin`
- 实际请求：`POST /ilink/bot/sendmessage`，`content-type: application/json`，授权头存在
- body：`{msg:{to_user_id, context_token:"ctx-xyz", message_type:2, item_list:[{text_item:{text}}]}, base_info:{…}}`
- 返回值：`messageId` + `serverMessageId="srv-msg-12345"`

即：只要拿到账号 token + contextToken（hitl-store 里都读到了），这个函数本身在进程内可用。

未验证：真实网关重启后的真实微信收发；网关进程内能否解析 `openclaw/plugin-sdk/*`（由 `openclaw/dist/plugin-module-loader-cache-BaIx7n11.mjs:169-208` 按父 root 决定，失败会自动退回 CLI 并在 hitl.log 留 `inproc-egress unavailable`）。

## 四、下一步唯一动作（必须在 DSH 沙箱外）

DSH 沙箱只允许写工作区；`Get-CimInstance`、`Set-Content .openclaw\state`、WMI `Win32_Process.Create`、explorer 拉起均被拒，所以重启只能由你执行：

```powershell
pwsh -NoProfile -File "D:\src\dsh\dsh-wechat-hitl\tools\restart-gateway.ps1" -TimeoutSeconds 240
```

跑完自查：
```powershell
netstat -ano | Select-String ':18789.*LISTENING'          # pid 应不再是 36892
Get-Content D:\src\dsh\dsh-wechat-hitl\state\gateway.log -Tail 20
Select-String 'C:\Users\wwm_1\.openclaw\state\dsh-bridge-debug.log' -Pattern 'egress|inproc' | Select-Object -Last 5
Select-String D:\src\dsh\dsh-wechat-hitl\state\hitl.log -Pattern 'inproc-egress|outbox-egress' | Select-Object -Last 5
```
