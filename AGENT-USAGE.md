---
title: 给其他会话的微信对接指引（任意 DSH 会话可用）
date created: 2026-10-26
date modified: 2026-10-26
tags:
  - openclaw
  - dsh
  - weixin
  - agent-usage
---

# 给其他会话的微信对接指引

> 用途：让你（用户）在**任意一个** DSH 会话里贴一段话，就让它「把处理结果发到你微信、并接受你微信端的反馈」。
> 原理与限制见 [../../70-WorkSpace/微信主动推送与人工确认回环说明.md](../../70-WorkSpace/微信主动推送与人工确认回环说明.md)。

## 0. 先看清：哪些是自动的，哪些要指引

| 场景 | 是否需要贴指引 | 说明 |
|---|---|---|
| 会话回合正常结束 → 推结果摘要 | **不用** | DSH 插件已在 web/headless 两个 profile 里，任意宿主会话回合结束自动推（`minTurnMs`、`wx-` 前缀、`DSH_WECHAT_HITL_SKIP=1` 三种情况除外） |
| 需要审批 / `ask_user_question` → 推微信并等回复 | **不用** | 同上，插件自动接管 |
| 想把**自定义摘要**发微信（不是自动摘要） | 要 | 用下文的 `notify` |
| 想在**任务中途**问用户一个选择题并等微信答复 | 要 | 用下文的 `ask` |

## 1. 直接贴给目标会话的一段话（推荐）

`"`@T`"`
本次任务请与我的微信对接，约定如下（工具已在本机装好，不要再自己拼 openclaw 命令）：

A. 阶段性/最终结果推送（单向，不用等回复）：
   node D:\nutstore\1.logseq\70-WorkSpace\wechat-hitl-20261026\bin\wx-hitl.mjs notify --title "一句话主题" --text "结果摘要，900 字以内"

B. 需要我拍板时（双向，我的微信回复会让本会话继续）：
   node D:\nutstore\1.logseq\70-WorkSpace\wechat-hitl-20261026\bin\wx-hitl.mjs ask --title "主题" --question "问题" --options "选项A|选项B"
   发出后**立即结束本回合**，不要 sleep/轮询等待——我的答复会作为新一回合注入本会话。

C. 注意：
   - 会话 id 自动取 $env:DSH_SESSION_ID，不要手填。
   - 不要直接调用 openclaw（沙箱会 EPERM）；出站由网关统一发送。
   - 查当前有哪些待确认：node ...\bin\wx-hitl.mjs status
   - 如果 notify/ask 返回 suppressed，说明用户把自动推送暂停/关闭了，直接按原流程在界面里问。
`"`@T`"`

## 2. 我在微信端怎么回

| 你收到 | 你回 | 效果 |
|---|---|---|
| 只有一个待确认 | `1` / `2` | 选第 1/2 项 |
| 有多个待确认 | `2` + 选项（如 `21`） | 码 2 的第 1 项 |
| 想补充文字 | 直接发一段话（单请求、非审批） | 整段作为答复转达给会话 |

识别码是 1–2 位纯数字，首行行首显示（如 `2｜🚦 需要确认`）。

## 3. 其它会话能不能真的收到我的微信反馈？

分两种宿主，行为不同（都已实测）：

| 会话宿主 | 反馈怎么回到会话 | 条件 |
|---|---|---|
| **常驻宿主**（Web GUI 里打开的会话、`new_session` 建的会话） | 进程内注入 `sessionController.prompt(req, signal)` → 作为新用户回合继续 | 需要 DSH Web 已重启加载当前插件代码（本机 2026-10-26 已重启，实测 `delivery:"injected"`） |
| **一次性进程**（`dsh --profile headless`、微信入站的 `wx-` 会话） | 网关兜底：`dsh --profile headless --session-id <原会话>` 续跑 | 会话文件写锁空闲（该会话没有正在运行的宿主） |

两种都会在 `<HITL>/state/hitl.log` 留 `delivery` 记录：`injected` / `in-turn` / `not-live`（附原因）。

## 4. 一条容易踩的边界：contextToken

微信 bot 的「主动发消息」需要 contextToken（由用户最近一次给 bot 的消息产生，缓存在 ~/.openclaw/state/openclaw.sqlite）。
若推送看起来成功但用户收不到，或日志出现 prepare failed / contextToken missing：

1. 让用户在微信里给 bot 随便发一句话（刷新 token）；
2. 再重试一次推送即可，**不需要重新扫码登录**。

排查入口：C:/Users/<USER>/AppData/Local/Temp/openclaw/openclaw-<date>.log 搜 contextToken。

## 5. 自检命令

`"`@T`"`
cd D:\nutstore\1.logseq\70-WorkSpace\wechat-hitl-20261026
node bin\wx-hitl.mjs status          # 开关 + 队列 + 待确认（含识别码）
node bin\wx-hitl.mjs notify --text "自检"   # 单向推送自检
node tools\switch-hitl.mjs --show    # 三态开关与挂载状态
`"`@T`"`


## 6. 用微信「驱动」任意会话（遥控器）

微信不只是收结果，也能当输入通道驱动某个会话：

| 微信里发 | 作用 |
|---|---|
| /l 或 列表 | 列出本工作区可驱动的会话（按最近活跃排序，带编号） |
| /s 3 或 切 3 | 绑定第 3 个会话，之后你的**普通消息**都会转发给它 |
| /a 或 自动 | 取消绑定（回到默认 wx- 会话） |
| 任意普通文本 | 已绑定时：转发进绑定会话并跑一轮；未绑定时：走默认 wx- 会话 |

命令行等价：node binwx-hitl.mjs sessions | bind --session 3 | bind --auto | relay --text "..."

投递方式：活着的会话走进程内注入（sessionController.prompt，回答会作为新回合）；
不在活宿主里的会话走 dsh --profile headless --session-id 续跑。两种都在 hitl.log 留 delivery 记录。

边界：绑定到「正被别的宿主占用写锁」的会话时，headless 兜底会失败并如实回报；
活着的 Web 会话要能进程内注入，需 DSH Web 已重启加载当前插件代码。

