# 飞书通道（feishu channel）

> 2026-11-05 建立。把「人工确认回环 / 结果推送 / 会话遥控」从微信换到飞书，复用同一套状态机。
> 微信通道按用户要求关闭，代码与登录态保留，可随时回切。

## 1. 现状（截至 2026-11-05 16:08）

| 层次 | 状态 | 证据 |
| --- | --- | --- |
| 微信通道开关 | **stopped**（关） | `wx-hitl status` → `switch.state=stopped` |
| 飞书通道开关 | **running**（开） | `fx-hitl status` → `switch.state=running` |
| 通道选择 | **feishu** | `state/channel.json` = `{"channel":"feishu"}` |
| 飞书守护进程 | 在线，心跳正常 | `state/feishu-daemon.json` `tickAt` 每 5 秒刷新 |
| 飞书出站 | **被拦（21001）** | `hitl.log` `feishu-send ok=false code=21001 data security policy` |
| 飞书入站（长连接事件） | **被拦（21001）** | `feishu-inbound-blocked reason=21001`，按 10 分钟退避 |
| 落点 target | 未设置 | `fx-hitl target --show` → `id=""` |

**结论**：代码链路已通到飞书 API 边界，最后一段被飞书应用的**数据安全策略**拦住（21001）。
同一应用在 dsh-superagent 那边同样是：`auth scopes` / `im +chat-list` / `event consume` 全部 21001。

## 2. 架构：一个状态机，两条传输

```
DSH 宿主（pkg/dsh-wechat-hitl 插件）
   │  pushWechat() 把「回合结果 / 审批 / 提问」写进发件箱
   ▼
state/pending.json  ← 唯一事实源（requests / outbox / sessions）
   ▲                     │
   │  写答复              │ drainOutbox()（谁排空由通道决定）
   │                     ├── wechat：OpenClaw 网关插件 dsh-bridge（inproc/CLI 出口）
   │                     └── feishu：feishu/feishu-daemon.mjs → lark-cli bot 直发
   │
feishu-daemon 事件子进程（lark-cli event consume im.message.receive_v1，长连接）
   └── 解析「识别码 选项 / 会话码 内容」→ markAnswered / 转发会话 → 回执
```

通道落点由两处决定，都在 `state/` 下、可热切换（无需重启 DSH）：

- `state/channel.json`：`{"channel":"feishu"|"wechat"}`（`fx-hitl channel`）
- `state/feishu-target.json`：`{"id":"ou_xxx"|"oc_xxx","type":"open_id"|"chat_id"}`（`fx-hitl target`）

开关是**每通道独立**的：`control.json` 顶层 = 微信，`control.json.channels.feishu` = 飞书。
关掉微信不会连带关掉飞书（2026-11-05 用户要求）。

## 3. 文件

| 文件 | 作用 |
| --- | --- |
| `lib/hitl-store.js` | 共享状态机；新增 `currentChannel/setChannel`、`feishuSend`、`getFeishuTarget/setFeishuTarget`、`feishuDaemonAlive`、每通道开关 |
| `bin/fx-hitl.mjs` | 飞书侧 CLI（status/channel/target/probe/notify/ask/switch/push/sessions/bind/daemon/list） |
| `bin/wx-hitl.mjs` | 微信侧 CLI，强制 `DSH_HITL_CHANNEL=wechat`，与飞书互不干扰 |
| `feishu/feishu-daemon.mjs` | 飞书守护进程：排空发件箱 + 长连接事件消费 + 心跳 + 首条入站自动落点 |
| `state/lark-config-dir.txt` | 飞书出口用哪个 lark-cli 配置目录（本机唯一事实源，换 bot 改这一行就够） |
| `tools/restart-feishu-daemon.ps1` | 起/停/查守护进程（WMI 脱离 DSH Job，做法同 restart-gateway.ps1） |

## 4. 用法

```powershell
$fx = 'D:\src\dsh\dsh-wechat-hitl\bin\fx-hitl.mjs'
node $fx status                       # 通道 / 开关 / 落点 / 队列 / 守护进程心跳
node $fx channel feishu               # 切到飞书（wechat 可回切）
node $fx target --id ou_xxx --type open_id   # 设落点；也可用 --type chat_id 发到群
node $fx probe --text "通道测试"      # 直发一条，验证 lark-cli 出口
node $fx notify --title "构建完成" --text "3 个包已发布"
node $fx ask --question "要删 _INBOX/tmp 吗？" --options "允许|拒绝" --mode approval
node $fx switch --state running|paused|stopped    # 飞书自己的开关

pwsh -NoProfile -File D:\src\dsh\dsh-wechat-hitl\tools\restart-feishu-daemon.ps1 [-Action start|stop|status|restart]
```

## 5. 必须先由人在飞书开放平台做的事（当前唯一阻塞）

应用 `cli_aa6697691db89c00`（brand=feishu，bot 身份）。在开放平台 → 该应用：

1. **权限（权限管理）** 至少：
   - `im:message:send_as_bot`（机器人发消息）
   - `im:message` / `im:message.p2p_msg:readonly`（能拿到与你单聊的消息）
   - 若要用群：`im:chat:readonly`
2. **事件订阅**：订阅方式改为 **长连接**（不是 webhook），订阅 `im.message.receive_v1`。
   lark-cli 在本机用长连接，需要「长连接」模式 + 该事件被勾选。
3. **版本发布 / 可用范围**：改完权限必须 **创建版本并发布**，且你的账号在可用范围内，否则仍 21001。
4. **管理后台数据安全策略**：21001 明确写着 "blocked by data security policy"。
   若你们租户管理后台对自建应用有「数据安全 / 信息权限」限制（例如限制机器人主动发消息、限制读取消息内容），需要管理员放开该应用。

完成后自检（不改代码即可看到效果）：

```powershell
$env:LARKSUITE_CLI_CONFIG_DIR = "$env:USERPROFILE\.lark-cli-dsh-superagent"
lark-cli auth scopes                     # 不再 21001，能看到权限清单
lark-cli event consume im.message.receive_v1 --timeout 10s   # 能连上（无事件时也只是空跑）
```

## 6. 接通后的验证清单

1. 你在飞书里给 bot 发一句话 → 守护进程自动把 `chat_id` 落成 target（`feishu-target-auto`）。
2. `node $fx probe --text "通了"` → 你在飞书收到。
3. 任一 DSH 会话跑完一个回合 → 飞书收到「回合结束」推送（`hitl.log` 里 `outbox-sent`）。
4. `node $fx ask ... --mode approval` → 飞书收到带选项的确认；回复「码 1」→ `hitl.log` 出现 `switch/answer`，DSH 侧注入原会话。
5. `fx-hitl daemon status` → `inbound=running`，`hint=null`。

## 7. 回滚到微信（随时可用）

```powershell
node D:\src\dsh\dsh-wechat-hitl\bin\fx-hitl.mjs channel wechat
node D:\src\dsh\dsh-wechat-hitl\bin\wx-hitl.mjs on
pwsh -NoProfile -File D:\src\dsh\dsh-wechat-hitl\tools\restart-gateway.ps1 200
```

微信侧仍需 contextToken：你在微信里给 bot 发一句话即可刷新（见 wechat-hitl skill 第 5 条排障顺序）。

## 8. 排障顺序（飞书）

1. `node $fx status` → 看 `channel`、`switch.state`、`target.id`、`daemon.inbound`、`daemon.hint`。
2. `state/feishu-daemon.json` 的 `hint`：`落点未设置` / `飞书应用权限被拦（21001）` / null。
3. `state/hitl.log` 搜 `feishu-send`（出站）、`feishu-inbound-*`（入站）、`outbox-dropped`（丢弃原因）。
4. `feishu-send code=3` + `openclaw context detected but lark-cli is not bound`：
   发送进程环境里有 `OPENCLAW_HOME`/`HERMES_HOME`/`LARK_CHANNEL`。现已由 `larkCliEnv()` 清洗；
   若仍出现，说明跑的代码旧，重启对应 DSH Web / daemon。
5. `feishu-send code=230002`：配置目录里的 bot 不在目标群。改 `state/lark-config-dir.txt`
   指向目标群那个 bot 的配置目录；别用终端里的 `LARKSUITE_CLI_CONFIG_DIR` 顶替。
6. 21001 → 看第 5 节，属人工在开放平台处理，代码侧无解。
7. 改了 `lib/hitl-store.js` 或守护进程 → 必须重启守护进程（`-Action restart`）；DSH 侧插件是模块缓存，改插件代码才需要重启 DSH。
