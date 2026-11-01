# POSTMORTEM · 2026-11-01 微信 HITL 通道失效与延迟复盘

范围：用户报障「①微信打开通道不生效、②交互没有会话码/回复码」（11-01）、「OpenClaw 启动后过一会儿变成 Claude」（11-01）、「通道发布时间延长比较多」（11-01 晚）。
账本：D:/src/dsh/.ptc/registry.jsonl，任务 task-…fe62e415de2e / …094a545ce933 / …4e34a759e5f4。

## 一、时间线

| 时间 | 事件 |
| --- | --- |
| 10-29 | inproc 出站引入（避免 spawn openclaw 抢 sqlite）；启动器默认 DSH_BRIDGE_EGRESS=cli |
| 10-30 07:04:45Z | **最后一次成功投递**（mode=cli）。此后出站开始全挂 |
| 10-31 19:58 | openclaw 自更新/重写配置；此后网关多由「无 env 的启动路径」拉起 → inproc 默认生效 |
| 11-01 11:03-12:53 | 用户在微信多次尝试打开通道，均被歧义拦截器抢答；推送 0 送达 |
| 11-01 22:xx | 定位根因并修 lib；三次提权超时未能重启网关 |
| 11-01 23:08 | 用户放开审批 → 配置钉模型（第一次启动被配置校验拒绝，23:20 修复后成功） |
| 11-01 23:21-23:35 | 网关重启后出站恢复，CLI 通道成功投递 10 条（每条 52-57s） |
| 11-01 23:39 | 发现 token 有效窗：距上次入站超约 10 分钟，任何通道都被拒（prepare failed） |
| 11-01 23:50 | 出站策略定稿：inproc 快通道 + 窗口外挂起等入站秒级补发 |
| 11-01 23:58:44 | 实战验证：用户入站后 3 条挂起消息 **1.6 秒**全部补发（旧 CLI 需约 2.7 分钟） |

## 二、故障 A：推送全部失效 / 打开通道不生效 / 「没有码」

| # | 根因 | 机制 | 证据 | 修复 | 状态 |
| --- | --- | --- | --- | --- | --- |
| A1 | **进程内出站拿不到 contextToken** | openclaw-weixin 的 getContextToken() 只查本模块实例内存；网关插件 import 到的是另一个实例，Map 恒空 → 每条推送 contextToken missing → 发件箱 30 分钟 TTL 后丢弃 | hitl.log：10-30 07:04 后 outbox-sent 0 条；mode=inproc 发送 1144 次、成功 0 次；历史成功 12 次全是 mode=cli | lib 三级取 token（内存 → restoreContextTokens → 账号 token 文件并回填），审计 inproc-token-source；缺 token 时退回 CLI | ✅ 已修（inproc-sent 已出现在实战日志） |
| A2 | **复发路径：登录自启钩子缺 egress 环境变量** | 钩子只有入站补丁、没有 DSH_BRIDGE_EGRESS=cli；restart-gateway.ps1 幂等判断只检查第 1 条 → 永远「跳过」 → 每次重启/自启都回到坏路径（这就是「几轮重启之后才坏」） | 修复前钩子内容无 env 行；脚本日志恒为「已带补丁钩子，跳过」 | 幂等条件加查 env 行；钩子由脚本重写（现固定 inproc） | ✅ 已修（现钩子带 DSH_BRIDGE_EGRESS=inproc） |
| A3 | **微信开关指令只认严格短句** | parsePushCommand 只认整条等于「推送开/推送关/推送状态」；「打开会话微信推送开关」「打开openclaw通道」被当普通提问，又被 pending 拦截器回歧义提示 | debug log：hook:fire sample=打开会话微信推送开关 → match ok=false reason=ambiguous | 改为按「动词+名词+开关」认意图（整条匹配约束保留），14 条正例 + 6 条反例测试固化 | ✅ 已修 |
| A4 | **「没有码」是 A1 的观感** | 带全码的正式推送（会话码·识别码·R 编号）一条都没送达；用户唯一能收到的是内联回执，旧文案只印裸数字「1」 | openclaw 日志回执 textLen=166 与 formatAmbiguous() 逐字吻合 | formatAmbiguous/formatNeedOption 写全三号 + 推送开关用法 | ✅ 已修 |

## 三、故障 B：OpenClaw 启动后「变成 Claude」

| # | 根因 | 机制 | 证据 | 修复 | 状态 |
| --- | --- | --- | --- | --- | --- |
| B1 | **agent 模型从未配置** | openclaw.json 无 agents.defaults.model → 回落内置默认 openai/gpt-6-astra | 启动日志 agent model: openai/gpt-6-astra；dist/defaults DEFAULT_PROVIDER/MODEL | 钉 opencode-go/deepseek-v4.1-flash（主）+ ais-2dsglm/deepseek-v4.1-flash（备） | ✅ 已修（启动日志已显示新路由） |
| B2 | **默认模型无凭据** | auth_profile_store/secret_store 0 行、无 OPENAI_API_KEY；agent DB 有该模型 errored 记录 | sqlite 查询记录 | 同上（换到有 key 的两条 DeepSeek 路由） | ✅ 已修 |
| B3 | **auto fallback + Claude 后端在位** | openclaw 有 modelOverrideSource:"auto" 降级机制；anthropic 插件已加载且 ~/.claude 有登录 → 主模型报错后落到 Claude | 插件表（修复前 16 个含 anthropic）；~/.claude 存在 | plugins.entries.anthropic.enabled=false，且 fallbacks 只钉 DeepSeek 两条 | ✅ 已修（插件表 15 个无 anthropic） |
| B4 | **二次坑：apiKey 对象写法被拒** | models.providers.*.apiKey 只接受字符串；写成 {source:"env"} 对象 → 网关启动报 OpenClaw config is invalid 拒启 | 第一次重启失败日志（23:16） | 改为「${ENV_VAR}」字符串引用；脚本加「疑似明文 key 拒绝写出」断言 | ✅ 已修（23:20 启动成功） |

注：B4 中的「${ENV_VAR}」是 openclaw 的 env 引用字面写法（解析期转成环境变量名），本行因 Markdown/模板转义写作 \\$\\{…\\}。

## 四、延迟问题（发布时间延长）

| # | 因素 | 量化 | 处置 | 状态 |
| --- | --- | --- | --- | --- |
| C1 | CLI 出站每条 spawn 一次 openclaw，串行 | 单条 52–57s；积压按条数线性放大 | 默认改 inproc 快通道 | ✅ 已修（窗口内秒级） |
| C2 | **微信 contextToken 有效窗 ≈10 分钟**（平台约束） | 23:28 入站 → 23:31-23:35 推送成功；23:39 起所有通道 prepare failed | 窗口外挂起（24h 保留），入站后 releaseContextHold 秒级补发；不退 CLI（同样被拒，白等 47s） | ✅ 已定稿（平台约束无法消除，只能最优等待） |
| C3 | 补发速度 | 旧 CLI：55s/条（3 条 ≈2.7 分钟）；新 inproc：**3 条 1.6 秒**（23:58:44 实测） | inproc 为默认 | ✅ 已验证 |
| C4 | 网关启动后 45 秒泵延迟 | 启动窗口内推送晚约 45s | 保留（历史踩坑：过早发送会把微信通道插件「强制退役」） | ⏸ 有意保留 |

## 五、当前状态快照（2026-11-01 24:00）

- 网关 HTTP 200；control: running + resultPush=false（按用户要求关闭各会话结果通知；审批/提问仍推）；
- 发件箱 0 积压；待确认请求 1 条（信用账户 SRS Q-04，会话码 50 / 识别码 1，**11-02 07:07 到期**）；
- 代码全部推送：子模块 86ff87d → a25f60a → 07fd3cc → aeb593a，父仓指针同步；skill 库副本已同步。

## 六、遗留与可选增强

1. **按会话粒度的推送开关**（「45 关通知」/「只留 51」）：未实现，用户提出需求即可加（改 lib + DSH 插件，需重启网关与 DSH Web）。
2. token 有效窗外的延迟是微信平台约束；若想进一步压缩，需要研究 getUpdates 空轮询是否携带新 token（不确定可行，暂不动）。
3. openclaw config CLI 在 DSH 沙箱内不可用（需写 %LOCALAPPDATA% 缓存），改 openclaw.json 一律走 tools/set-openclaw-model.mjs（自带备份+断言）。
