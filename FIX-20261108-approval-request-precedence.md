# FIX-20261108：审批 / 提升权限请求到不了飞书

- 状态：已修复（待本机重启 DSH Web 生效）
- 影响：所有需要人工批准的 `approval/request`（含 `sandbox_permissions` 升权）
- 通道：微信 / 飞书共用同一段审批门禁，问题与运输层无关

## 现象

用户在飞书通道里收不到「提升权限 / 需要批准」请求，但回合结束摘要、`ask_user_question` 推送正常。
微信时代同一功能是能推送的。

## 根因：瀑布事件注册顺序

DSH 的审批是一条 `approval/request` waterfall：

1. `@deepseek-ai/dsh-user-approval` 的 `ApprovalService.decide()` 调用
   `ctx.waterfall(scopeTarget(agent, agent), 'approval/request', req, () => 'unavailable')`，
   **监听器按注册顺序从外到内包裹**，第一个不调用 `next()` 的监听器直接决定结果。
2. Web profile 的 `@deepseek-ai/dsh-api-remotes` 会注册一个浏览器转发器，把请求通过
   Remote 事件送到 Web 前端，等浏览器审批面板答复。
3. `dsh-wechat-hitl` 插件用默认 `ctx.on()` 注册审批门禁。

`dsh --profile web --dump-config` 的顺序证明插件排在浏览器转发器之后：

```
line 909  - id: api-remotes   name: '@deepseek-ai/dsh-api-remotes'
line 960  - id: ui-approval   name: '@deepseek-ai/dsh-client-ui-approval'
line 2458 - id: wechat-hitl   name: dsh-wechat-hitl
```

于是浏览器面板先接管请求并把结果返回，通道监听器**根本没有被调用**。

### 实证

2026-11-08 的一次真实升权（会话 `af71bbe5-cbec-4b08-b12c-b591d31c2a09`）：

- DSH 会话日志有 `approval/asked`（seq 224，reason
  `escalate sandbox to danger-full-access: DSH 沙箱运行器临时目录被系统清理删除…`），
  93 秒后 `approval/decided` = `allowed-once`；
- 同一时刻 `state/hitl.log` 没有任何 `approval-ask` / `approval-decided` 记录；
- `plugin-loaded` 显示该 web 进程（pid 8076）已加载插件且 `approval: true`。

即：事件发生了、插件在跑，但监听器没有拿到请求。

## 修复

`pkg/dsh-wechat-hitl/index.js`：

- 审批监听器改为具名 `approvalHandler`，用
  `ctx.on('approval/request', approvalHandler, { prepend: priority === 'channel-first' })` 注册；
- 默认 `approval.priority = 'channel-first'`（通道优先）；`ui-first` 保持浏览器优先；
- `paused` / `stopped` 仍然立即 `next()`，交回 DSH 前端。

因为 `prepend` 把通道放到瀑布最外层，即使 `api-remotes` 后来才注册（有客户端连接时才注册），
通道也总是先拿到请求。

## 文案

同一处把沙箱升权的英文 reason 翻译成人话，并给摘要一句准确的 recap：

```
待定：提升权限 → 完全访问（danger-full-access）。
────────────
【提升权限】会话码 100 · 识别码 5 · R123456
──────────────
会话 af71bbe5
背景：D:\nutstore\1.logseq

工具：pwsh
请求权限：完全访问（danger-full-access）
原因：DSH 沙箱运行器临时目录被系统清理删除，所有工具调用均报 sandbox-unavailable…

　1) 允许一次
　2) 拒绝
```

`lib/hitl-store.js` 的 `inferNotificationKind()` 同步识别 `【提升权限】`，
让它仍按 `approval` 类通知做压缩与开关判断；`applyOneLineRecap()` 新增可选
`recap` 参数，审批交给调用方给准确摘要（旧实现从正文猜，猜出来常是「会话 af71bbe5」）。

## 优先级 / 开关

| 配置 | 值 | 行为 |
|---|---|---|
| `approval.priority` | `channel-first`（默认） | 通道先接审批；推不出去或超时才 `next()` 回前端 |
| `approval.priority` | `ui-first` | DSH 前端先接；前端没有客户端时通道兜底 |
| `control.json` 的 `state` | `running` | 通道接审批并阻塞等回复 |
| `control.json` 的 `state` | `paused` / `stopped` | 立即 `next()`，前端处理，回合不卡死 |
| `control.json` 的 `decisionPush` | `true`（默认） | 权限提升审批、逐个询问、失败通知都发通道 |
| `control.json` 的 `decisionPush` | `false` | 这三类都不发；DSH 前端照常处理；回合摘要走 `resultPush`，不受影响 |

改 `priority` 需要重启加载插件的 DSH Web 进程；三态开关与 `decisionPush` 是热更新
（插件每次事件重新读 `state/control.json`）。飞书里发「权限推送关 / 权限推送开 /
审批推送状态」即可切换；命令行等价 `node bin\\wx-hitl.mjs decision off|on|status`。

## 验证

- `pkg/dsh-wechat-hitl` 新增回归用例（`test/plugin.test.mjs`）：
  - `channel-first` 时后注册的通道监听器带 `prepend`，浏览器转发器不被调用；
  - `ui-first` 时浏览器先接管，通道不建请求；
  - `escalate sandbox to danger-full-access: …` 生成标题「提升权限」和目标档位文案；
  - `decisionPush` 关闭时审批/逐个询问/失败通知都不建请求、不推送，打开时失败通知会推送。
- `test/run-tests.ps1` 全套 72 条通过。
- 未在本机重启 DSH Web 做真人点击验证（会打断正在跑的会话）；重启后可在任意会话触发一次
  `sandbox_permissions` 升权复核。

## 与工作区里未提交改动的关系

本修复基于 `3101112`（当前 HEAD）。本机工作区另有 2026-11-08 14:57–15:23 的未提交改动
（会话级推送控制 `/push` 与 `PUSH-CONTROLS.md`），不属于本修复范围；`decisionPush` 与
失败通知已在本 PR 内实现。
