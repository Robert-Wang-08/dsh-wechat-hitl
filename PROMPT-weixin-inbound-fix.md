---
title: 交给 DSH 执行：微信入站丢消息修复 + 出站改进程内
date created: 2026-10-28
date modified: 2026-10-28
tags:
  - wechat-hitl
  - openclaw
  - patch
  - prompt
---

# 任务

修两件事，都有实机证据，不是一个笼统的"优化"。

## 背景（已证实，不要重新论证）

2026-10-28 13:24:06 创建了一条微信审批请求（会话码 37，session-41b9f735），13:25:10 用户在微信里回复，13:29:06 请求仍被判超时。查日志得到：

- 13:25:10.186 入站到达（`inbound: bodyLen=11`）
- 13:25:10.643 `getUpdates error (1/3): SqliteSessionMutationConflictError: SQLite session state changed while preparing session-entry.patch`
- 此后桥接插件**从未** `hook fire`，这条回复再没出现

根因在 `openclaw-weixin` 的轮询循环：**先保存 `get_updates_buf` 游标，再处理消息**。处理消息时抛异常（这里是 SQLite 会话状态写冲突）会被外层 catch 当成"轮询失败"，2 秒后按**已推进的游标**重拉；服务端认为该消息已投递，不会重发 → 消息永久丢失，日志只留一行 error。

## 环境事实

- 扩展目录：`C:\Users\wwm_1\.openclaw\extensions\openclaw-weixin`（官方包 `@tencent-weixin/openclaw-weixin@2.4.10`，Tencent 发布）
- 轮询循环：`src/monitor/monitor.ts`，第 89–210 行；重试常量在第 14–16 行（3 次失败 / 30s 退避 / 2s 重试）
- 状态目录：`D:\nutstore\1.logseq\70-WorkSpace\wechat-hitl-20261026\state`
- 桥接插件：`C:\openclaw-runtime\plugins\dsh-bridge\index.js`
- 共享模块：`D:\nutstore\1.logseq\70-WorkSpace\wechat-hitl-20261026\lib\hitl-store.js`（`pushWechat` / `drainOutbox`）
- 网关端口 18789；重启脚本 `...\wechat-hitl-20261026\tools\restart-gateway.ps1`
- 日志：网关 `...\state\gateway.log`；openclaw 主日志 `C:\Users\wwm_1\AppData\Local\Temp\openclaw\openclaw-<date>.log`；桥接 `C:\Users\wwm_1\.openclaw\state\dsh-bridge-debug.log`；HITL `...\state\hitl.log`

## 任务 A：修复入站丢消息（必做）

目标：**处理失败不能导致消息丢失**，且修复在重启和官方包升级后仍然自动生效。

1. 修改 `monitor.ts`：把保存 `get_updates_buf` 的三行从 "消息处理前" 移到 "本批消息全部处理成功之后"。即在 `for (const full of list) { ... }` 循环结束后再 `saveGetUpdatesBuf(...)`。
2. 防死循环：单条消息处理失败时重试 2 次（指数或线性均可），仍失败则**跳过该条**并写 `inbound-dropped` 级别日志（含 sessionId、错误类型），避免一条坏消息卡住整个队列。
3. 稳定性要求（这是验收重点）：
   - 做成**幂等脚本来打补丁**，不要手工改一次就算完；
   - 脚本要在重启路径上自动执行。现有 `tools\restart-gateway.ps1` 已接入 `tools\apply-weixin-inbound-fix.ps1`（干跑已通过），如你改用别的启动方式（计划任务/开机自启），必须把补丁挂到那条真实路径上；
   - 官方包升级覆盖源码后，下一次启动要能自动重新注入。
4. 验收：
   - `apply-weixin-inbound-fix.ps1 -Check` 输出"可以打补丁"；
   - 实打一次后 `monitor.ts` 含标记 `cursor-advanced-after-processing`，`node --check` 通过；
   - 重启网关，`hitl.log` 与主日志无新增 `getUpdates error` 导致的静默丢弃；
   - 再造一次冲突（可用两条并发写或手动制造）验证：消息要么被处理，要么在日志里有明确的 `inbound-dropped`，**不允许既没处理也没日志**。

## 任务 B：出站改进程内（尽力做，做不了要如实回报）

现状：`drainOutbox()` 用 `runToFile(openclaw message send ...)` 起独立 CLI 进程发消息，这个进程会自己打开 `openclaw-agent.sqlite`，与网关的 `getUpdates` 写同一个库 → 制造上面那种冲突。

目标：出站不再起第二个进程。

约束与已查明事实（不要重复踩）：
- `openclaw message send` **没有** `--gateway/--url/--remote` 之类"发给运行中网关"的选项，所以 CLI 一定自己开库；
- 插件 SDK 的进程内发送能力在 `channel-outbound`（`OutboundSendDeps` / `MessageReceipt` / `defineChannelMessageAdapter` 那一套），属于**注册信道**的插件；`dsh-bridge` 是普通 `definePluginEntry` 插件，`register(api)` 拿不到这条依赖。它唯一能让宿主代发的是 `before_agent_reply` 返回 `reply`，只能回合内回复，不能主动推送。

要求：
1. 先在 SDK 里找到一条真正可用的进程内发送路径（例如把 dsh-bridge 改造成持有 outbound 依赖的插件，或复用宿主已有的发送服务）。给出文件与行号证据。
2. 如果可行：实现并在**真实网关**上验证一次发送成功（不是 dry-run），保留原 CLI 路径作为可回退开关（例如环境变量 `DSH_BRIDGE_EGRESS=inproc|cli`）。
3. 如果不可行：不要硬改到"看起来像进程内"。直接判定受阻，写清缺哪个接口、证据在哪一行、需要上游做什么。**不许为了完成任务而把出站改成不可验证的写法。**

## 通用约束

- 不改生产任务数据、不删日志、不动 `pending.json` 里的历史请求。
- 每次写文件前备份；改动要能回滚（脚本失败自动还原）。
- 不 git 提交、不推送。
- 重启网关会短暂中断微信通道，重启后必须验证一次真实收发（发一条、收一条）。
- 无法验证的结论一律标"未验证"，不要把"改完了"说成"修好了"。

## 交付格式

```
## A 入站丢消息
- 改动：文件:行号，改了什么
- 稳定性：脚本路径 + 挂在哪个启动路径 + 升级后如何自动恢复
- 验证：命令与输出（含重启后的一次真实收发）
- 状态：已验收 | 已改未验证 | 受阻

## B 出站进程内
- 找到的接口：文件:行号
- 结论：已改为进程内 | 受阻（缺什么）
- 若已改：开关方式、回退方式、真实发送验证结果
- 状态：已验收 | 已改未验证 | 受阻

## 遗留
- 仍需人决定/仍需外部条件的事项
```
