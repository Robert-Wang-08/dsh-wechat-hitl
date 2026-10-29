---
title: 微信通道审计（2026-10-28 23:00 → 10-29 10:15）
date created: 2026-10-29
date modified: 2026-10-29
tags:
  - wechat-hitl
  - audit
  - outbox
---

# 微信通道审计：重复推送与漏发核对

> 口径：本地时间 2026-10-28 23:00 → 2026-10-29 10:15。数据源 = `state/hitl.log`（13 834 行）、`state/gateway.log`（当前进程）、`~/.openclaw/state/dsh-bridge-debug.log`、`state/pending.json`。

## 1. 结论

1. **同一条消息被发两次：0 次。** 窗口内 17 个发件箱条目，每个 `outbox-sent` 恰好 1 次，`sent=17 / dropped=0 / failed=0`。
2. 你看到的「重复」是三类不同现象：**同一件事被重复申请审批**（3 + 2 次）、**同一正文重试了 160 次**（只成功一次）、**同一条答复被处理两遍**（`in-turn` + `not-live`）。
3. 有一条入站被吞（今天 10:03:57 的 sqlite 冲突），另有一条在重启窗口重试 3 次后放弃。

## 2. 重复的三个成因

### 2.1 同一件事被重复申请审批（你看到 3 条一样的「一次性完成本次提交与推送」）

窗口内 **12 个审批请求**，全部 `handle=1`，只落在两个会话上：

| 会话 | 请求时间 | 结果 |
|---|---|---|
| 267d7fbc（码 40） | 17:19:21 / 17:20:44 / 17:22:52 / 17:23:30 / 17:24:18 | 3 个「40 1」已答；17:20:44、17:24:18 无人答 → 5 分钟过期 |
| 267d7fbc（码 40） | 17:48:30 / 17:50:47 | 无答复记录 |
| 86318230（码 41） | 01:53:05 / 02:00:24 / 02:06:45 / 02:08:42 / 02:09:21 | 3 个「41 1」已答；前两个无人答 |

**根因**：批准之后那次 git 操作**仍然被沙箱边界挡住**（`index.lock: Permission denied`），模型在下一回合重试同一条命令 → 新的 `approval/request` → 新推送。也就是说重复的不是推送逻辑，而是**被反复重试的审批事务**。正文完全相同（3 条同文 / 2 条同文），但 id 不同。

### 2.2 同一正文重试 160 次（延迟，不是重复）

5 条积压条目从 17:32 一直重试到 02:00–02:05，每条 **158–163 次** `outbox-send`：

```
out-…998d91  attempts=163  17:32:10 → 02:00:34  gap median=181s
out-…3033d0  attempts=162  17:51:07 → 02:01:31  gap median=181s
```

**根因**：进程内出口（inproc）把「contextToken missing」判为不可重试、标记 `needsContext` + 60 秒冷却，但**没有释放 claim**，于是 3 分钟租约（`CLAIM_LEASE_MS`）到期被 `outbox-reclaim` 抢回再试，循环到 token 恢复。只有最后一次真的发出（`outbox-sent` 各 1 次）。代价：813 条 inproc 尝试、2.9k 条 reclaim/wait-context 日志、消息延迟数小时。

**已绕过**：10:00 起启动器写 `DSH_BRIDGE_EGRESS=cli`，之后 11 条一次性 `outbox-sent`（02:00–02:11 那批全部送达，`outboxQueued=0`）。

### 2.3 同一条答复被处理两遍

6 个已答请求都有两条投递记录：先 `in-turn`（阻塞中的审批通道消费成功），30 秒内轮询器又试一次进程内注入并记 `not-live`。用户侧无第二条 ack，属内部重复。

**根因**：`hasSessionController` 在 **95 次插件加载里从未为 true**，进程内注入通道根本不可用，插件只能靠 `in-turn`，轮询侧永远走到 `not-live`。

## 3. 该发的都发了吗

| 类别 | 数量 | 结论 |
|---|---|---|
| 发件箱条目 | 17 | **17 送达、0 丢弃、0 失败**（每条 1 次） |
| 回合结束摘要 | 292 次触发 | **0 条发出**，全部 `suppressed: result-push-off`（10-27 你把结果推送关了）——不是故障，是开关 |
| 审批通知 | 12 | 12 条都送达微信（含 6 条无人答复后过期） |
| 过期通知 | 会话码 40/41 各 1 条 | 送达（其中 40 那条被重试 160 次才落地） |
| 入站消息 | — | 吞 1 条：`10:03:57 SqliteSessionMutationConflictError`；另有重启窗口 `seq=101` 重试 3 次后放弃（`AgentDatabaseAdmissionError`） |
| 遥控/relay 回复 | 6 组 | 全部 `relayed` 成功（`delivery=injected` 3 次） |

## 4. 其他异常

1. **「有效期 30 分钟」与实际不符**：推送文案写 30 分钟，审批门禁实际 5 分钟（`approval.timeoutMs=300000`）。你按 30 分钟去回，就会撞上「已过期」。
2. **会话码可复用，且「码+选项」会粘连**：`session-demo-1` 与真会话 `4c0dcb1b` 都拿到过码 1。那条提醒写「选项：11=允许一次 … 例：11」，你回 `11` 后被当成**会话码 11**（`session-3dd68e2c`），于是回你「当前没有待确认」。证据：`{"hook":"fire","sample":"11"}`。
3. **重启后 `profile` 探测变空**：`plugin-loaded` 的 `profile` 由 `web` 变成空值（仅影响日志可读性）。
4. **每答一次就 spawn 一个 headless dsh**：`plugin-loaded` 出现 `profile=""` 的 pid 3376 / 26896 / 21436 / 26620，属 `not-live` 兜底，成本不低。
5. **gateway.log 每次启动被覆盖**（`>` 重定向），历史入站失败已不可追溯；跨天排查只能靠 `hitl.log`。

## 5. 修复状态（2026-10-29：落 4 项，第 4 项仅定位）

| # | 项 | 状态 | 落点 |
|---|---|---|---|
| 1 | 释放发件箱租约 + 入站即解锁 | ✅ 已改，网关侧已生效 | `lib/hitl-store.js`：失败分支 `claimedAt = 0`；冷却 60s → **30 分钟兜底**；新增 `releaseContextHold()`，网关入站钩子先解锁再补发 |
| 2 | 「有效期」文案与门禁对齐 | ✅ 已改，待 DSH Web 重启生效 | `pkg/dsh-wechat-hitl/index.js`：审批请求 TTL = `approval.timeoutMs`，文案由 `req.expiresAt` 推导，不再写死 30 分钟 |
| 3 | 防「码+选项」粘连 | ✅ 已改，网关侧已生效 | 提示统一改「识别码 空格 选项」；`resolveByCode` 新增粘连消歧，新增 `matchConcatenatedAnswer()` |
| 4 | `sessionController` 探测 | ⚠️ 仅定位 | DSH 里没有 `ctx.sessionController` 这个服务（全仓无该引用）；实际是 Typert 远程接口包 `dsh-api-session-controller`，改造属设计变更，单独一轮 |
| 5 | gateway.log 追加模式 | ✅ 已改 | launcher 改 `>>`；重启后日志 37 KB 保留历史 |

验证：测试套件全绿（17 / 5 / 16 / 4，exit 0）；`resolveByCode("11")` 现返回 `kind=answer`（识别码 1 + 选项 1）；网关打包副本已含 `releaseContextHold` / 30 分钟冷却 / 租约释放；`pump-ready` 回显 `outboxLen=0`。

**生效边界**：网关已重启，出口侧全部生效；审批门禁与文案跑在 DSH Web 宿主，**需再重启一次 DSH Web** 才加载新插件副本。

## 5b. 原始待办（保留原始建议以便对照）

1. **释放 claim**：`needsContext` 分支里补一次 claim 释放，重试间隔交给 `nextAttemptAt`（否则永远 3 分钟一撞）。
2. **文案与门禁对齐**：把推送里的「有效期 30 分钟」改成实际值，或把 `approval.timeoutMs` 提到 30 分钟。
3. **防粘连**：会话码避开 1–2 位数字与选项号重叠区间（例如码从 100 起），或规定「必须空格分隔」并拒绝歧义组合。
4. **修 `sessionController` 探测**：`hasSessionController` 恒为 false，值得单独查一次 DSH 侧服务名/获取方式。
5. **gateway.log 追加模式**：`>>` 或按日轮转，保留入站失败证据。
