/**
 * set-openclaw-model.mjs — 把 OpenClaw 网关 agent 的模型钉死到 DeepSeek（2026-11-01）。
 *
 * 证据链（为什么必须钉）：
 *   - openclaw.json 里没有 agents.defaults.model → 启动日志 "agent model: openai/gpt-6-astra"
 *     来自内置默认（dist/defaults-*.mjs: DEFAULT_PROVIDER="openai", DEFAULT_MODEL="gpt-6-astra"）。
 *   - 本机没有任何 OpenAI 凭据（auth_profile_store 空、环境变量无 OPENAI_API_KEY），
 *     agent DB 里有一条该模型的 run_status=errored 记录；openclaw 有 auto model fallback
 *     （modelOverrideSource:"auto"），而 anthropic 插件已加载且 ~/.claude 有登录 →
 *     过一会儿回落到 Claude 后端（用户实测「启动后过一会儿转成叫 Claude」）。
 *
 * 改动（都先备份 openclaw.json 再写）：
 *   1) agents.defaults.model = { primary: "opencode-go/deepseek-v4.1-flash",
 *        fallbacks: ["ais-2dsglm/deepseek-v4.1-flash"] }   —— 只在 DeepSeek 两条路由里降级
 *   2) models.providers 注册 opencode-go 与 ais-2dsglm；apiKey 用 {source:"env"} 秘密引用，
 *      配置与输出都不落明文（openclaw 网关进程从用户环境变量里取值）
 *   3) plugins.entries.anthropic.enabled = false（禁用 Claude 后端；codex 不动）
 *
 * 用法：
 *   node D:\src\dsh\dsh-wechat-hitl\tools\set-openclaw-model.mjs
 *   pwsh -NoProfile -File D:\src\dsh\dsh-wechat-hitl\tools\restart-gateway.ps1 -TimeoutSeconds 220 -Force
 * 回滚：把 openclaw.json.bak-before-model-pin-<ts> 复制回 openclaw.json，再重启网关。
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG = join(homedir(), ".openclaw", "openclaw.json");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backup = CONFIG + ".bak-before-model-pin-" + stamp;

const raw = readFileSync(CONFIG, "utf8");
const cfg = JSON.parse(raw);
copyFileSync(CONFIG, backup);

// 秘密引用：只写环境变量名，不写值。缺变量时只警告（网关侧会在调用时报缺凭据）。
function envRef(name) {
  const present = Boolean(process.env[name]);
  if (!present) console.log("[warn] 环境变量 " + name + " 当前不存在（凭据引用仍会写入，运行时报缺）");
  return { source: "env", id: name };
}

const aisBase = (process.env.DSHPACK_BASE_AIS || "").trim() || "http://47.101.159.7:29988/v1";

cfg.agents ??= {};
cfg.agents.defaults ??= {};
cfg.agents.defaults.model = {
  primary: "opencode-go/deepseek-v4.1-flash",
  fallbacks: ["ais-2dsglm/deepseek-v4.1-flash"],
};

cfg.models ??= {};
cfg.models.providers ??= {};
cfg.models.providers["opencode-go"] = {
  baseUrl: "https://opencode.ai/zen/go/v1",
  api: "openai-completions",
  apiKey: envRef("DSHPACK_KEY_OPENCODE"),
  models: [
    {
      id: "deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      reasoning: true,
      contextWindow: 1000000,
      maxTokens: 384000,
    },
  ],
};
cfg.models.providers["ais-2dsglm"] = {
  baseUrl: aisBase,
  api: "openai-completions",
  apiKey: envRef("DSHPACK_KEY_AIS"),
  models: [
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (AIS)", reasoning: true, contextWindow: 131072, maxTokens: 32768 },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash (AIS)", reasoning: true, contextWindow: 131072, maxTokens: 32768 },
  ],
};

cfg.plugins ??= {};
cfg.plugins.entries ??= {};
cfg.plugins.entries.anthropic = { ...(cfg.plugins.entries.anthropic ?? {}), enabled: false };

writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n", "utf8");

// 自检：重新解析 + 关键字段断言 + 确认没有明文 key 落进配置
const check = JSON.parse(readFileSync(CONFIG, "utf8"));
const m = check.agents.defaults.model;
if (m.primary !== "opencode-go/deepseek-v4.1-flash") throw new Error("primary 未写入");
if (JSON.stringify(m.fallbacks) !== JSON.stringify(["ais-2dsglm/deepseek-v4.1-flash"])) throw new Error("fallbacks 未写入");
if (check.plugins.entries.anthropic.enabled !== false) throw new Error("anthropic 未禁用");
if (/sk-[A-Za-z0-9_\-]{8,}/.test(JSON.stringify(check.models))) throw new Error("配置里疑似出现明文 key，拒绝写出");

console.log("OK 已写入 " + CONFIG);
console.log("备份 " + backup);
console.log("agents.defaults.model =", JSON.stringify(m));
console.log("models.providers =", Object.keys(check.models.providers).join(", "));
console.log("plugins.anthropic.enabled =", check.plugins.entries.anthropic.enabled);
console.log("下一步：重启 OpenClaw 网关（restart-gateway.ps1），启动日志应出现");
console.log('  "agent model: opencode-go/deepseek-v4.1-flash"');
