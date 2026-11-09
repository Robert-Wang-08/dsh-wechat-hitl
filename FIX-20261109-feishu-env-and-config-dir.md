# FIX 2026-11-09 飞书推送静默（DSH Web Profile）

## 症状

- 2026-11-09 11:41（本地）之后，HITL 私聊 `oc_3c60d05…` 再没收到 `【回合结束】` 推送；
  用户 17:19 在群里问「反馈一下最近会话的情况」也没有推送侧响应。
- `state/hitl.log`：`feishu-send ok=false code=3`，lark-cli 报
  `openclaw context detected but lark-cli is not bound`（hint: `lark-cli config bind`）。
- `fx-hitl status`：`daemon.up=false`，原因是 `state/feishu-daemon.json` 变成 309 字节全 `\0`
  （非原子写被打断），守护进程也不在了。

## 根因

同一个终端里先做过飞书应用初始化：

```powershell
$env:LARKSUITE_CLI_CONFIG_DIR = "$env:USERPROFILE\.lark-cli-hitl-aa67"   # 半初始化目录
.\init-feishu-app.ps1
```

随后在同一终端 `dsh --profile web`（14:07 启动，pid 13436）。于是 DSH Web 进程环境里带着：

1. `OPENCLAW_HOME` 一类的 Agent 上下文变量 —— lark-cli 1.0.99 检测到就要求先
   `config bind`，所有 `im +messages-send` 在出口被拒（code 3）；
2. 指向半初始化目录的 `LARKSUITE_CLI_CONFIG_DIR` —— 即使不被拦，也会让 HITL 换到
   另一个 bot / 不在目标群里的应用，表现为 230002「Bot/User can NOT be out of the chat」。

`hitl-store` 之前把 `LARKSUITE_CLI_CONFIG_DIR` 当第一优先级（2026-11-06 的改动），
所以终端里的一次性实验环境会直接改写常驻推送通道的 bot。

## 修复

1. `lib/hitl-store.js`
   - 新增 `state/lark-config-dir.txt` 作为本机唯一事实源（优先级：
     `DSH_HITL_LARK_CONFIG_DIR` > state 文件 > 带 `config.json` 的 `LARKSUITE_CLI_CONFIG_DIR`
     > 默认 `.lark-cli-dsh-superagent-feishu2`）；
   - 新增 `larkCliEnv()`：spawn lark-cli 前剔除 `OPENCLAW_*` / `HERMES_*` / `LARK_CHANNEL`，
     并锁定 `LARKSUITE_CLI_CONFIG_DIR`。
2. `feishu/feishu-daemon.mjs`：入站 `lark-cli event consume` 同样用 `larkCliEnv()`。
3. `tools/restart-feishu-daemon.ps1`：同时设置 `DSH_HITL_LARK_CONFIG_DIR`（`-ConfigDir` 仍生效）。
4. 运行侧：写 `state/lark-config-dir.txt` → 删掉损坏心跳 → 重启 daemon →
   重启 DSH Web（3080）让插件加载新代码。

## 验证

- `test/run-tests.ps1`：全套 `tests exit=0`；`hitl-store` 38 项通过（新增 2 项：
  `larkCliEnv` 清洗、`resolveFeishuConfigDir` 优先级）。
- 故意在环境里设置 `OPENCLAW_HOME` + 错误的 `LARKSUITE_CLI_CONFIG_DIR`，执行
  `fx-hitl probe` 仍投递成功（`message_id om_x100b602e687110a4dd1b1e665378bae`），
  说明污染环境下出口不再被拦。
- 重建 daemon：`fx-hitl status` → `daemon.up=true, inbound=running`，configDir 为
  `C:\Users\wwm_1\.lark-cli-dsh-superagent-feishu2`。
- 重启后 DSH Web（pid 24864）`plugin-loaded` 正常，端口 3080 正常监听。

## 以后

- 换 HITL bot：改 `state/lark-config-dir.txt`（一行路径），不要依赖终端里的
  `LARKSUITE_CLI_CONFIG_DIR`。
- DSH Web 若仍从「做过飞书实验」的终端启动，也不再影响 HITL：环境会被清洗，
  配置目录以 state 文件为准。
