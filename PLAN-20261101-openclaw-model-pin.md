# PLAN-20261101 · OpenClaw 模型钉死到 DeepSeek（禁用 Claude 后端）

- 时间：2026-11-01
- 报障：用户「OpenClaw 启动起来后，过一会儿会转成叫 Claude；不希望它用 Claude 的 key，要用 ais-2dsglm 或 OpenCode 的 DeepSeek 4.1 flash」。

## 一、证据链

| # | 证据 | 结论 |
| --- | --- | --- |
| 1 | `openclaw.json` 全文没有 `agents.defaults.model`；启动日志 `agent model: openai/gpt-6-astra (thinking=medium, fast=off)`（openclaw-2026-10-31.log 11:58:33Z） | 模型**没有钉**，来自 openclaw 内置默认 `DEFAULT_PROVIDER="openai"/DEFAULT_MODEL="gpt-6-astra"`（dist/defaults-Jag53zwP.mjs） |
| 2 | `auth_profile_store`、`secret_store_entries` 均为 0 行；用户环境变量无 `OPENAI_API_KEY`；agent DB `message_tool_run_outcomes` 有一条 `openai/gpt-6-astra, run_status=errored, outcome=mute` | 默认模型**没有可用凭据**，真实回合会失败 |
| 3 | openclaw 有 auto model fallback 机制（`modelOverrideSource:"auto"`、`hasSessionAutoModelFallback`、auto fallback probe）；启动插件表里有 `anthropic`（Claude 后端），且本机 `~/.claude` 存在 Claude Code 登录 | 主模型失败后，auto 降级可以落到 Claude —— 与「过一会儿转成 Claude」吻合 |
| 4 | openclaw 会话表 `session_windows.model_provider/model` 全部是 `openai/gpt-6-astra`；transcript 里的 "claude" 字样只出现在转发的 DSH 文本里 | Claude 不是配置出来的，是**运行时降级**出来的 |
| 5 | DSH 侧（微信真正走的链路 dsh-bridge → dsh --profile headless）`agent-default-model = deepseek-official/deepseek-flash`，host failover 链（route-config.json）里没有 Claude | 微信回话本身不用 Claude；Claude 只会出现在 openclaw 自跑的回合（heartbeat/cron、以及 dsh-bridge 未接管时的消息） |

## 二、改动（tools/set-openclaw-model.mjs，先备份后写）

1. `agents.defaults.model = { primary: "opencode-go/deepseek-v4.1-flash", fallbacks: ["ais-2dsglm/deepseek-v4.1-flash"] }`
   —— 主备都钉在 DeepSeek，降级只会在这两条路由之间，永远不会漂到 Claude/GPT。
2. `models.providers` 注册两个 provider（schema 见 dist/model-registry-Cft8Rf7W.mjs `ProviderConfigSchema`）：
   - `opencode-go`: baseUrl `https://opencode.ai/zen/go/v1`，api `openai-completions`，apiKey 写字符串引用 `"$" + "{DSHPACK_KEY_OPENCODE}"`（模型目录取自 pi-ai `opencode-go.json`，deepseek-v4.1-flash 确实在目录里）。
   - `ais-2dsglm`: baseUrl 取 `DSHPACK_BASE_AIS`（缺省 `http://47.101.159.7:29988/v1`，与 dsh-config-pack/config/40-models.yml 一致），apiKey `"$" + "{DSHPACK_KEY_AIS}"`，模型 `deepseek-v4.1-flash`、`glm-5.3-flash`。
   - **踩坑记录（2026-11-01 23:16）**：第一版把 apiKey 写成 `{source:"env", id:"…"}` 对象，网关启动报
     `models.providers.*.apiKey: *** input` 拒绝启动——这个位置的 apiKey 只接受字符串；
     env 引用约定是形如 "$" + "{ENV_VAR}" 的字符串（解析期由 normalizeApiKeyConfig 转成环境变量名，
     见 dist/models-config.providers.secret-helpers-D_hIA8wW.mjs）。已改为字符串形式。
   - 秘密只写环境变量名，不落明文；脚本自带断言，写出前会检查配置里没有明文 key。
3. `plugins.entries.anthropic.enabled = false` —— 拆掉 Claude 后端；codex 不动（用户未要求）。

## 三、生效与验收

```powershell
node D:srcdshdsh-wechat-hitl	oolsset-openclaw-model.mjs
pwsh -NoProfile -File D:srcdshdsh-wechat-hitl	oolsestart-gateway.ps1 -TimeoutSeconds 220 -Force
```

验收点：
1. 网关启动日志出现 `agent model: opencode-go/deepseek-v4.1-flash`（日志文件 `state/gateway.log` 或 %TEMP%/openclaw/openclaw-<date>.log）。
2. 微信发一句话给 bot，回合能正常回答（走 DeepSeek）。
3. `state/hitl.log` 出现 `outbox-sent`（上一个修复的推送通道同时恢复）。

回滚：把 `openclaw.json.bak-before-model-pin-<ts>` 复制回 `openclaw.json`，重启网关。

## 四、限制

- openclaw 的 opencode-go/openai 目录里没有现成的 ais-2dsglm provider，这里是手工注册；若中转站改地址，需要同步 `DSHPACK_BASE_AIS` 与本配置。
- 秘密引用依赖网关进程能读到 `DSHPACK_KEY_OPENCODE`/`DSHPACK_KEY_AIS`（用户级环境变量，登录自启的网关可以读到）；若某台设备没有这两个变量，运行时会报缺凭据而不是静默换 Claude——这是期望行为。
- `openclaw config` CLI 在 DSH 沙箱里无法读写（需要写 %LOCALAPPDATA% 缓存），所以本改动用脚本直接改 `openclaw.json`，并在改前备份。
