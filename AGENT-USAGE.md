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
> 原理与限制见 [runbook：微信主动推送与人工确认回环说明](file:///D:/nutstore/1.logseq/70-WorkSpace/%E5%BE%AE%E4%BF%A1%E4%B8%BB%E5%8A%A8%E6%8E%A8%E9%80%81%E4%B8%8E%E4%BA%BA%E5%B7%A5%E7%A1%AE%E8%AE%A4%E5%9B%9E%E7%8E%AF%E8%AF%B4%E6%98%8E.md)。

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
   node D:\src\dsh\dsh-wechat-hitl\bin\wx-hitl.mjs notify --title "一句话主题" --text "结果摘要，900 字以内"

B. 需要我拍板时（双向，我的微信回复会让本会话继续）：
   node D:\src\dsh\dsh-wechat-hitl\bin\wx-hitl.mjs ask --title "主题" --question "问题" --options "选项A|选项B"
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
cd D:\src\dsh\dsh-wechat-hitl
node bin\wx-hitl.mjs status          # 开关 + 队列 + 待确认（含识别码）
node bin\wx-hitl.mjs notify --text "自检"   # 单向推送自检
node tools\switch-hitl.mjs --show    # 三态开关与挂载状态
`"`@T`"`


## 6. 用微信「驱动」任意会话（遥控器）

微信不只是收结果，也能当输入通道驱动某个会话：

| 渠道里发 | 作用 |
|---|---|
| /l 或 列表 | 列出**跨工作区**可驱动会话，左列就是会话码（微信与飞书同一实现） |
| /s 50 或 切 50 | 按**会话码**绑定（码来自 /l 左列；也接受标题前缀唯一命中）。之后不带码的普通消息都进这条会话 |
| /a 或 自动 | 取消绑定 |
| /name 87 翻译r34 | 给某条会话起名，之后可 `/s 翻译r34` |
| /who | 看当前通道、总闸、结果/决策两个子开关、当前落点 |
| /new 远程日报 | **在已绑定的会话里新建一个会话**并自动绑定（方案 A：该会话调 `new_session`，用 `[[new_session:<id>]]` 回写） |
| <码> 内容 | 定向驱动任意已登记会话（码 1–999） |
| 任意普通文本 | 已绑定时：转发进绑定会话并跑一轮；未绑定时：提示先 /s |

会话码空间 **1–999**，用满后回收最老的一条复用，并在回执里提示「码 X 已从『旧会话』回收」。
飞书侧由 `feishu-daemon.mjs` 处理同一套指令（2026-11-06 补齐，此前只有文案没有实现）。

命令行等价：node binwx-hitl.mjs sessions | bind --session 3 | bind --auto | relay --text "..."

投递方式：活着的会话走进程内注入（sessionController.prompt，回答会作为新回合）；
不在活宿主里的会话走 dsh --profile headless --session-id 续跑。两种都在 hitl.log 留 delivery 记录。

边界：绑定到「正被别的宿主占用写锁」的会话时，headless 兜底会失败并如实回报；
活着的 Web 会话要能进程内注入，需 DSH Web 已重启加载当前插件代码。

## 部署拓扑与跨设备安装（2026-11-02 起）

| 部件 | 唯一源（本仓库） | 部署位（挂载/副本） |
|---|---|---|
| DSH 侧插件入口 | pkg/dsh-wechat-hitl/ | junction：profiles/web、headless 两处 node_modules/dsh-wechat-hitl |
| 网关插件 dsh-bridge | gateway/dsh-bridge/（index.js + 两个 manifest） | junction：C:/openclaw-runtime/plugins/dsh-bridge |
| 共享状态层 lib | lib/hitl-store.js | 两侧入口按相对路径 import（junction realpath 指回仓库），不再硬编码 D 盘路径 |
| 运行状态 | state/（gitignore） | 不部署；随 dsh-backup 的 openclaw 段备份四个有效文件 |
| OpenClaw 模型钉死/插件开关 | tools/set-openclaw-model.mjs 写 ~/.openclaw/openclaw.json | 随 dsh-backup private 段备份/恢复 |

- 跨设备/重装一键：pwsh -NoProfile -File tools/install-channel.ps1（重建 junction → 钉模型 → 重启网关；前置条件见脚本头注释）。
- OpenClaw runtime 本体（node.exe、openclaw 包、微信通道插件）不搬进仓库：它是设备级基础设施，由 OpenClaw 自更新管理；仓库里维护的是我们写的插件与配置脚本。
- dsh 一键备份已含 openclaw 配置面（2026-11-02 起）：openclaw/ 段（启动器、自启钩子、通道状态四文件、部署 junction 清单）+ private/openclaw/ 段（openclaw.json、微信账号绑定）；恢复时写回并提示执行 install-channel.ps1 与 restart-gateway.ps1。

## 回合结束摘要（2026-11-05 调整）

- **放宽截断**（2026-11-06 再调）：飞书 22 行 / 每条 120 字 / 正文预算 1800 字，**长句不再整条丢弃**，按 `。！？；` → `，、` → 空格 边界截断并只补一个「…」；微信通道保持保守（4 行 / 40 字 / 1500 字），因为手机气泡窄。
- **技术内容保留**（2026-11-06）：飞书侧不再删 env 变量名/路径/标识符（`stripWechatNoise(..., { keepTechnical: true })`）——此前把 `LARKSUITE_CLI_CONFIG_DIR` 删掉，句子被掏空成「设的是 ，而只认 ，」。微信侧维持原口径。
- **断行**：ASCII token（路径、变量名、`x.ps1`）内部不设断点；行首不允许出现 `，。；：` 等收尾标点（避头尾）。
- **尾巴提示**（2026-11-06）：旧文案「回复 100 <内容> 可继续，细节在本会话」有歧义（"本会话"在飞书里既可指聊天也可指 DSH 会话），改为 `turnEndHint()`：飞书两行「回「100 你的话」继续 → DSH 会话 <sid>」+「本条是摘要，全文在 DSH 里」；微信一行「回 100 内容 可继续（摘要，全文在 DSH）」。旧宿主（未重启的 DSH Web 插件）产出的旧措辞由 `upgradeLegacyHint()` 在出口改写，不必重启 3080。
- **one-line-recap 风格**：caveman 风格但说人话——只留结论与动作，不解释过程、不堆术语；**「❗要你定」永远排最前**（最多两条），其后才是「已做」「进度」。
- **清洗规则**：不再删除普通英文产品名（superagent / feishu 等），只删 camelCase、snake_case 和长 hex；`【已完成】` 这类小标题会被剥掉，避免「【风险】…」直接糊到脸上。
- 实现：`distillForChannel(input, {channel, lineWidth})`（微信）、`trimForFeishu(input)`（飞书保结构）；`formatTurnEnd` 按 `currentChannel()` 选择宽度与上限；出口统一走 `outboxTag()`。

## 飞书应用清单（2026-11-06 定稿）

同一台机器上并存多个 lark-cli 配置目录，**每个应用一个目录**，靠环境变量 `LARKSUITE_CLI_CONFIG_DIR`（或 `DSH_HITL_LARK_CONFIG_DIR`）切换；`hitl-store` 的解析顺序是 `DSH_HITL_LARK_CONFIG_DIR → LARKSUITE_CLI_CONFIG_DIR → ~/.lark-cli-dsh-superagent-feishu2 → ~/.lark-cli-dsh-superagent`。

| 用途 | appId | 配置目录 | 机器人名 | 落点 | 状态 |
|---|---|---|---|---|---|
| **HITL**（会话状态 / 审批交互） | `cli_aa66f315697adc03` | `~/.lark-cli-dsh-superagent-feishu2` | robert的飞书 CLI | `oc_3c60d05ec9fdcde385c6a54a9b465084`（私聊） | ✅ 在用（feishu-daemon） |
| **superagent**（工单） | `cli_aa67e4041a381c02` | `~/.lark-cli-hitl-aa67e4041a381c02` | superagent-飞书bot | `oc_eae25b93a93612f82042deb68704e2af`（私聊） | ✅ 收发已验通，待接 3082/3083 出口 |
| 旧（停用） | `cli_aa6697691db89c00` | `~/.lark-cli-dsh-superagent` | —（被平台拦） | — | ❌ 每次调用 21001，勿用 |
| 试验残留 | `cli_aa66fc2125f9dc14` | `~/.lark-cli-dsh-superagent-new` | — | — | ❌ 不用，可清 |

- **open_id 按应用隔离**：同一个人的 open_id 在不同应用下不同（例：app3 下 `ou_fa4d5d4e…`），所以跨应用复用 open_id 会失败，必须各自取。
- **bot 不能列 p2p 聊天**：`im +chat-list --types p2p` 只支持 user 身份；拿私聊 chat_id 只能从入站事件里取（`lark-cli event consume im.message.receive_v1 --max-events 1 --timeout 3m`，注意 stdin 不能提前关闭）。
- **新增应用的标准动作**：`pwsh -File tools/init-feishu-app.ps1`（browser 模式走浏览器授权，secret 模式不回显粘贴），落独立目录后用 `restart-feishu-daemon.ps1 -ConfigDir <dir>` 切换。

## 审批 / 提升权限的优先级（2026-11-08）

**问题**：DSH Web 的 `api-remotes` 会注册 `approval/request` 的浏览器转发器，且插件排在它后面；
瀑布事件第一个不 `next()` 的监听器即决定结果，所以审批被浏览器面板接管，飞书收不到「提升权限」。

**修复**：插件用 `prepend` 把审批监听器放进瀑布最外层；默认 `approval.priority: channel-first`。

| 配置（profiles/web/cordis.patch.yml 的插件 config） | 行为 |
|---|---|
| `approval.priority: channel-first`（默认） | 飞书先接审批并阻塞等回复；推不出去/超时才回 DSH 前端 |
| `approval.priority: ui-first` | DSH 前端先接；没有浏览器客户端时飞书兜底 |
| 三态开关 `running` | 通道接审批 |
| 三态开关 `paused` / `stopped` | 立即交回前端，回合不卡死 |

改 `priority` 要重启加载插件的 DSH Web 进程；三态开关仍是热更新。
沙箱升权文案固定为「【提升权限】+ 目标档位 + 原因」，不再把
`escalate sandbox to danger-full-access: …` 原样推给用户。根因与证据见
[FIX-20261108-approval-request-precedence.md](FIX-20261108-approval-request-precedence.md)。

### 决策 / 失败通知开关

`state/control.json` 的 `decisionPush`（默认开）控制三类消息：

| 消息 | 受 `decisionPush` | 受 `resultPush` |
|---|---|---|
| 权限提升 / 危险操作审批 | 是 | 否 |
| `ask_user_question` / `request_user_input` | 是 | 否 |
| 回合异常结束的失败通知 | 是 | 否 |
| 回合正常结束摘要 | 否 | 是 |

关闭时这三类都不发飞书，DSH 前端仍按自己的事件链处理；回合结束的成功摘要不受影响。
飞书里直接发「权限推送关 / 权限推送开 / 审批推送状态」即可；命令行等价：

```powershell
node bin\wx-hitl.mjs decision status
node bin\wx-hitl.mjs decision off
node bin\wx-hitl.mjs decision on
```

开关是热更新：插件每次事件重新读 `control.json`，不用重启 DSH。

