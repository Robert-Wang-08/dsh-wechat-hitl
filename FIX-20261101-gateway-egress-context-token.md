# FIX-20261101 · 微信 HITL 通道失效（网关出站 contextToken + 码位显示）

- 时间：2026-11-01
- 报障：用户（微信）「通过微信想打开这个通道不生效」「现在的交互没有会话码和回复码」
- 结论：两条独立故障叠加，**不是** DSH 重启把状态弄丢了，而是网关出站路径静默失效 + 内联回复文案退化成裸数字。

## 一、现象与证据

| 现象 | 证据位置 | 事实 |
| --- | --- | --- |
| 微信收不到任何推送 | `state/hitl.log` | 最后一次成功投递 2026-10-30T07:04:45Z，此后 `outbox-sent` 0 条 |
| 进程内出站从未成功 | `state/hitl.log` | `outbox-egress mode=inproc` 1144 次，紧随其后全是 `outbox-wait-context`（`contextToken missing`）；历史 12 次成功投递全部是 `mode=cli` |
| 微信侧开关指令无效 | `.openclaw/state/dsh-bridge-debug.log` | `hook:fire sample=打开会话微信推送开关 / 打开openclaw通道` 之后紧跟 `hitl:match ok=false reason=ambiguous`，被待确认拦截器抢答 |
| 「没有码」 | openclaw 日志 + 代码 | 每条回执 `textLen=166`，与 `formatAmbiguous()` 长度逐字吻合；旧文案只印裸数字「1」，没有「会话码／识别码／R 编号」字样 |
| 重启就复发 | `tools/restart-gateway.ps1` + Startup 钩子 | 网关启动器会写 `DSH_BRIDGE_EGRESS=cli`，但**登录自启钩子没有这一行**，而脚本的幂等判断只检查「有没有入站补丁」，永远「跳过」→ 那条真实启动路径一直用进程内出口 |

## 二、根因

### 根因 1（致命）：进程内出站拿不到 contextToken

`lib/hitl-store.js` 的 inproc 出口调用 openclaw-weixin extension 的 `getContextToken(accountId, userId)`。
该函数**只查本模块实例内存里的 Map**：只有「同一实例」的入站（`setContextToken`）或启动时
`restoreContextTokens()` 才会填。网关插件 `import(file:///…/dist/src/messaging/inbound.js)`
拿到的实例与通道自己用的实例不是同一个，Map 恒空 → 每条推送都判 `contextToken missing` →
进发件箱、30 分钟 TTL 后被丢弃。于是「微信侧永远收不到」，而网关日志一切正常。

账号 token 其实**一直在磁盘上**：`<OPENCLAW_STATE_DIR>/openclaw-weixin/accounts/<accountId>.context-tokens.json`，
用户每发一条入站消息就刷新一次（本次实测文件内容长度 136，与通道日志 `contextToken=…(len=136)` 一致）。

### 根因 2：「打开通道」的说法不被识别

`parsePushCommand()` 旧实现只认整条等于 `推送开／推送关／推送状态` 的短句。
用户实际发的是「打开会话微信推送开关」「打开openclaw通道」，被判成普通提问，随后被
`handleHumanReply()`（有 1 条待确认）回了一句歧义提示——用户看不到任何开关生效的迹象。

### 根因 3：「没有码」

用户能看到的只有那条歧义提示，而 `formatAmbiguous()` 旧文案是「　1 · 问题…」，裸数字看起来不像编号，
也没有 R 编号；正式推送（带「会话码 50 · 识别码 1 · R0-c815」）因为根因 1 一条都没送达，所以用户
体感是「码没了」。

## 三、改动

`lib/hitl-store.js`
1. 新增 `readContextTokenFromFile(accountId, target)`：直接读账号 token 文件（跨实例唯一可信来源）。
2. `inprocSend()` 取 token 改成三级：内存 → `restoreContextTokens()` 复原 → 读账号 token 文件，并回填内存；
   新增审计 `inproc-token-source`（source=memory/restore/file）。
3. `drainOutbox()`：进程内出口因 `contextToken missing`／`inproc-unavailable` 失败时，**立即**换 CLI 出口重试一次
   （`mode=cli-fallback` + `outbox-egress-fallback` 审计）。只对「确定没发出去」的失败兜底，避免重复投递。
4. `parsePushCommand()` 改成认意图：去空白/标点/称呼/助词后按「动词 + 名词 + 开关」判定，
   支持 `打开会话微信推送开关`、`打开openclaw通道`、`先把推送打开`、`结果推送关`、`查询推送` 等；
   仍要求整条消息匹配，`1 帮我跑测试`、`关闭其他会话的推送` 一律不抢。
5. `formatAmbiguous()` / `formatNeedOption()`：每条都写全「会话码 X · 识别码 Y · R…」，并附推送开关用法。

`tools/restart-gateway.ps1`
6. 登录自启钩子幂等条件加上 `DSH_BRIDGE_EGRESS=cli`（原来只检查入站补丁，导致旧钩子永远不补这一行）；
   钩子注释改 ASCII，避免 cmd OEM 代码页把中文写成「?」。

`test/fix-20261101.test.mjs`（新增，已进 `test/run-tests.ps1`）
7. 固化 14 条开关表述、6 条反例、码位文案、token 文件兜底共 4 组断言。

## 四、验证

- 单测：`pwsh -NoProfile -File test/run-tests.ps1` → 5 个文件 47 条全绿（原 43 + 新增 4）。
- 手动探针：`readContextTokenFromFile("66b3a3ae4579-im-bot", "o9cq…@im.wechat")` 返回 136 字符 token；
  磁盘 token 文件与通道日志长度一致。
- 线上验收到「微信真的收到」这一步见下文，需要重启网关（工作区外的进程控制）。

## 五、限制

- 进程内出口即使拿到 token，仍依赖 openclaw-weixin extension 的 dist 内部实现；
  官方包升级若改 `getContextToken` 签名，兜底会静默退回 CLI 出口（可用，但每次发送多一个子进程）。
- 启动器与登录自启钩子在 `~/.openclaw`、`%APPDATA%\.…\Startup`，属工作区外，需一次提权写入。
- 网关进程是插件模块缓存，**改了 lib 必须重启网关**（DSH 重启不带它）。

## 六、下一步唯一动作

重启 OpenClaw 网关（`pwsh -NoProfile -File tools/restart-gateway.ps1 -TimeoutSeconds 220 -Force`），
然后在微信里发一句「推送状态」：应收到带「会话码／识别码／R 编号」的回执，
且 `state/hitl.log` 出现 `outbox-sent`（积压补发）或 `inproc-token-source source=file`。
