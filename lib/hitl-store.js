/**
 * hitl-store.js — 微信人工确认回环的共享状态层（DSH 插件 / OpenClaw 网关插件 / CLI 三端共用）。
 *
 * 唯一事实源：一个 JSON 状态文件（pending.json），三端以「文件总线」并发读写：
 *   - DSH 侧插件：写请求、轮询已答复的请求并注入回原会话；
 *   - OpenClaw 网关插件：收到微信回复 -> 匹配 -> 标记 answered；
 *   - CLI：任意脚本/任意 DSH 会话手动发起 ask/notify。
 *
 * 设计要求：
 *   1) 原子写（temp + rename），避免两端同时写导致半截 JSON；
 *   2) 版本号 + 只做增量修改，冲突时重读重试（最多 5 次）；
 *   3) 纯 Node 内置模块，无第三方依赖，可被任何 profile 的插件 import。
 */
import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync, existsSync, openSync, closeSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { request as httpRequest } from "node:http";

// ── 本机常量（换设备时只需改这一段）────────────────────────────────────────
// 状态目录平时跟随模块自身位置（<proj>/lib/../state），整目录搬家不用改代码。
// 但 openclaw 网关会把本文件 vendor 进插件捕获包
// （…\.openclaw\tmp\plugin-captures\<id>\…\node_modules\dsh-wechat-hitl\lib\hitl-store.js）；
// 那种副本里模块相对解析会指向副本自己的 state/，导致网关读不到发件箱、推送静默空转
// （2026-10-28 实测踩到）。因此只要发现自己在捕获包里，就回落到生产绝对路径。
// 自动化测试必须用 DSH_WECHAT_HITL_STATE 指到隔离目录，
// 否则单测产生的推送会真的发到微信（本机踩过一次，已固化隔离）。
const HERE_DIR = dirname(fileURLToPath(import.meta.url));
const PROD_STATE_DIR = "D:\\src\\dsh\\dsh-wechat-hitl\\state";
const IS_BUNDLED_COPY = /[\\/]plugin-captures[\\/]/.test(HERE_DIR);
const DEFAULT_STATE_DIR = IS_BUNDLED_COPY ? PROD_STATE_DIR : join(HERE_DIR, "..", "state");
const RUNTIME_ROOT = process.env.DSH_WECHAT_HITL_RUNTIME_ROOT || "C:\\openclaw-runtime";
export const PATHS = {
  stateDir: process.env.DSH_WECHAT_HITL_STATE || DEFAULT_STATE_DIR,
  node: process.env.DSH_WECHAT_HITL_NODE || join(RUNTIME_ROOT, "node.exe"),
  openclawMjs: process.env.DSH_WECHAT_HITL_OPENCLAW_MJS || join(RUNTIME_ROOT, "node_modules", "openclaw", "openclaw.mjs"),
  dshNode: "C:\\Users\\wwm_1\\AppData\\Local\\nvm\\v24.18.0\\node.exe",
  dshBin: "C:\\Users\\wwm_1\\AppData\\Local\\nvm\\v24.18.0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
  workdir: process.env.DSH_WECHAT_HITL_WORKDIR || "D:\\nutstore\\1.logseq",
  channel: "openclaw-weixin",
  target: process.env.DSH_WECHAT_HITL_TARGET || "o9cq809dq0T-EHbYNw82tLLPpkpI@im.wechat",
  gatewayPort: Number(process.env.DSH_WECHAT_HITL_GATEWAY_PORT || 18789),
  dshHome: process.env.DSH_WECHAT_HITL_DSH_HOME || "C:\\Users\\wwm_1\\.dsh",
  // DSH 会把工作区路径编码成目录名：D:\nutstore\1.logseq -> --D-nutstore-1.logseq--
  workspaceKey: "--D-nutstore-1.logseq--",
};

// ── 通道选择（2026-11-05 新增飞书通道）──────────────────────────────────────
// 同一个 HITL 状态机（待确认 / 发件箱 / 三态开关 / 会话码 / 遥控）可以走两条出口：
//   wechat（默认）= OpenClaw 网关 + openclaw-weixin（既有通道）
//   feishu        = lark-cli bot 身份直发（新通道，DSH_HITL_CHANNEL=feishu 时启用）
// 通道只切换「传输」；状态文件、审批语义、会话码规则、发件箱退避完全共用。
export const HITL_CHANNEL = (String(process.env.DSH_HITL_CHANNEL || "").toLowerCase() === "feishu") ? "feishu" : "wechat";

/**
 * 通道当前值：环境变量优先（fx-hitl / daemon 会强制），其次 state/channel.json（热切换，无需重启 DSH）。
 * 之所以要热切换：DSH 侧插件常驻 Web 宿主，改环境变量得重启 DSH 才生效；写文件 1 秒内即可切换。
 */
export const CHANNEL_FILE = join(PATHS.stateDir, "channel.json");
let channelCache = { at: 0, value: null };
export function currentChannel() {
  const forced = String(process.env.DSH_HITL_CHANNEL || "").toLowerCase();
  if (forced) return forced === "feishu" ? "feishu" : "wechat";
  if (channelCache.value && Date.now() - channelCache.at < 1000) return channelCache.value;
  let value = "wechat";
  try {
    if (existsSync(CHANNEL_FILE)) {
      const parsed = JSON.parse(readFileSync(CHANNEL_FILE, "utf8"));
      if (String(parsed && parsed.channel ? parsed.channel : "").toLowerCase() === "feishu") value = "feishu";
    }
  } catch {}
  channelCache = { at: Date.now(), value };
  return value;
}
export function setChannel(channel, by = "cli") {
  ensureDir();
  const value = String(channel).toLowerCase() === "feishu" ? "feishu" : "wechat";
  writeFileSync(CHANNEL_FILE, JSON.stringify({ channel: value, updatedAt: Date.now(), updatedBy: by }, null, 2));
  channelCache = { at: Date.now(), value };
  log({ op: "channel-switch", channel: value, by });
  return { channel: value };
}

// 2026-11-09 事故（飞书推送整天静默）：DSH Web 从被污染的终端重启后，进程环境带着
// OpenClaw 上下文变量（OPENCLAW_HOME 等）和一个半初始化的 LARKSUITE_CLI_CONFIG_DIR。
// lark-cli 1.0.99 见到 OpenClaw 上下文就要求 `config bind`（code 3），把每次推送都拦在
// 出口；若配置目录指向别的 bot，还会变成 230002「bot 不在群里」。所以飞书出口不再直接
// 信进程环境：
//   1) 配置目录按 state/lark-config-dir.txt（本机唯一事实源）→ 显式 DSH_HITL_LARK_CONFIG_DIR
//      → 合法的 LARKSUITE_CLI_CONFIG_DIR → 默认 bot 的顺序解析；
//   2) 调 lark-cli 前剔除 OpenClaw/Hermes/LarkChannel 的上下文变量。
/** 飞书出口用哪个 lark-cli 配置目录。纯函数式入参，便于单测。 */
export function resolveFeishuConfigDir(options = {}) {
  const env = options.env || process.env;
  const home = options.home || homedir();
  const stateDir = options.stateDir || PATHS.stateDir;
  const explicit = String(env.DSH_HITL_LARK_CONFIG_DIR || "").trim();
  if (explicit) return explicit;
  try {
    const hinted = String(readFileSync(join(stateDir, "lark-config-dir.txt"), "utf8")).trim();
    if (hinted) return hinted;
  } catch {}
  // 兼容 2026-11-06 的约定，但只认「真的有应用配置」的目录，避免空目录/半初始化目录串台。
  const ambient = String(env.LARKSUITE_CLI_CONFIG_DIR || "").trim();
  if (ambient && existsSync(join(ambient, "config.json"))) return ambient;
  for (const name of [".lark-cli-dsh-superagent-feishu2", ".lark-cli-dsh-superagent"]) {
    const dir = join(home, name);
    if (existsSync(dir)) return dir;
  }
  return join(home, ".lark-cli-feishu-hitl");
}

/**
 * 调 lark-cli 前清洗环境变量。
 * OPENCLAW_HOME / HERMES_HOME / LARK_CHANNEL 会让 lark-cli 自动切成「AI Agent 绑定」模式，
 * 未 bind 时直接拒绝执行（type=config, subtype=not_configured）。
 */
export function larkCliEnv(configDir, base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/^OPENCLAW_/i.test(key) || /^HERMES_/i.test(key) || /^LARK_CHANNEL$/i.test(key)) delete env[key];
  }
  env.LARKSUITE_CLI_CONFIG_DIR = configDir;
  return env;
}

export const FEISHU = {
  // lark-cli 是 npm 全局包装器：真正入口是 @larksuite/cli 的 scripts/run.js。
  // 直接 spawn process.execPath + run.js，绕开 .cmd 垫片（Windows 下 spawn .cmd 需要 shell:true，容易踩引号/注入坑）。
  runJs: process.env.DSH_HITL_LARK_RUNJS || "C:/nvm4w/nodejs/node_modules/@larksuite/cli/scripts/run.js",
  // 飞书通道用独立配置目录，不跟 dsh-superagent 的 bot 配置混用（各自的 strict-mode/权限审计分开）。
  configDir: resolveFeishuConfigDir(),
  targetFile: join(PATHS.stateDir, "feishu-target.json"),
  eventKey: process.env.DSH_HITL_FEISHU_EVENT || "im.message.receive_v1",
};

export const STATE_FILE = join(PATHS.stateDir, "pending.json");
export const CONTROL_FILE = join(PATHS.stateDir, "control.json");
export const SESSION_NOTIFICATION_LIMITS_FILE = join(PATHS.stateDir, "session-notification-limits.json");
export const SESSION_NOTIFICATION_CONTROLS_FILE = join(PATHS.stateDir, "session-notification-controls.json");
export const NOTIFICATION_MODES = ["summary", "long"];
export const LONG_NOTIFICATION_LIMITS = [800, 1600, 3000, 0];
// Q1=B（2026-11-09 用户裁决）：未登记的会话不限长；只有显式选 summary 才固定 800。
const DEFAULT_SESSION_NOTIFICATION_CONTROL = { enabled: true, mode: "long", maxChars: 0 };
export const LOG_FILE = join(PATHS.stateDir, "hitl.log");
export const DEFAULT_TTL_MS = 30 * 60 * 1000;
export const NOTIFICATION_LIMIT_KINDS = ["result", "approval", "decision"];

// contextToken 缺失（微信 bot 只能回复最近发过消息的人）时，条目按这个窗口保留等用户回话。
// ISSUE-001：这个窗口原先被 30 分钟 TTL 抢先判死，导致「保留 24h」的承诺失效。
export const CONTEXT_HOLD_MS = 24 * 3600 * 1000;
// 等待 token 期间的发送节流：不然每 2 秒一次 prepare failed，日志被刷爆。
// 2026-10-29 审计：原 60s 冷却被 3 分钟租约盖过，5 条积压每条撞了 158–163 次。
// 现在改成 30 分钟兜底重试；正常恢复靠「用户入站 → releaseContextHold() → 立即补发」。
export const CONTEXT_RETRY_COOLDOWN_MS = 30 * 60 * 1000;
// 出站出口本身不可用（lark-cli 未 bind、配置目录指错、bot 不在群里等「环境没配好」）时的重试节流。
// 这类失败不会自己好：进程不修就一直失败。所以它既不消耗 attempts、也不被 5 次上限丢弃，
// 只用 5 分钟节流避免刷日志；修好后下一次 drain 自动补发。
// 2026-11-11 事故：网关进程自 11-09 起未重启，内存里是旧版模块（无 larkCliEnv 清洗），
// 每次 feishuSend 都被 lark-cli 判为 openclaw context 未 bind（code 3），5 次后静默丢弃，
// 于是「任务跑完不回信，必须人主动问」。
export const CONFIG_BLOCK_RETRY_MS = 5 * 60 * 1000;
// 丢弃条目的死信副本：outbox 一删正文就没了，事后无法人工补发。
export const DEAD_LETTER_FILE = join(PATHS.stateDir, "outbox-dead-letter.jsonl");

/**
 * 出站失败归类（纯函数，便于单测）。
 *   config    出口环境没配好（lark-cli config bind / openclaw context / 无权限）——保留，等修复
 *   context   微信 contextToken 缺失——保留，等用户入站刷新
 *   timeout   子进程超时（可能已送达）——短退避重试
 *   transient 其它瞬时失败——按次数退避，5 次后丢弃并留死信
 * @returns {"config"|"context"|"timeout"|"transient"}
 */
export function classifyOutboxFailure(output) {
  const text = String(output ?? "");
  if (/"type"\s*:\s*"config"|not_configured|config bind|openclaw context|230002|bot is not in/i.test(text)) return "config";
  if (/contextToken|prepare failed/i.test(text)) return "context";
  if (/\[timeout\]/.test(text)) return "timeout";
  return "transient";
}

/**
 * 丢弃前留一份可补发的死信副本（append-only JSONL）。
 * @returns {boolean} 是否写入成功
 */
export function appendDeadLetter(entry, reason) {
  try {
    ensureDir();
    appendFileSync(DEAD_LETTER_FILE, JSON.stringify({
      droppedAt: Date.now(),
      reason: String(reason ?? "unknown"),
      id: entry?.id ?? null,
      sessionId: entry?.sessionId ?? null,
      target: entry?.target ?? null,
      createdAt: Number(entry?.createdAt ?? 0),
      attempts: Number(entry?.attempts ?? 0),
      lastError: String(entry?.lastError ?? "").slice(0, 500),
      text: String(entry?.text ?? ""),
    }) + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * 发件箱条目的处置判定（纯函数，便于单测）。
 * @returns {"send"|"hold-context"|"drop-context-expired"|"hold-blocked"|"drop-blocked-expired"|"drop-ttl"}
 */
export function outboxEntryDisposition(entry, now = Date.now()) {
  if (!entry) return "send";
  if (entry.blocked === "config") {
    const blockedMs = now - Number(entry.blockedAt ?? entry.createdAt ?? 0);
    return blockedMs > CONTEXT_HOLD_MS ? "drop-blocked-expired" : "hold-blocked";
  }
  if (entry.needsContext === true) {
    const heldMs = now - Number(entry.contextMissingAt ?? entry.createdAt ?? 0);
    return heldMs > CONTEXT_HOLD_MS ? "drop-context-expired" : "hold-context";
  }
  const ageMs = now - Number(entry.createdAt ?? 0);
  return ageMs > DEFAULT_TTL_MS ? "drop-ttl" : "send";
}

/**
 * 自动推送的三态开关。
 *
 *   running  正常：检测事件 + 推送 + 审批阻塞等微信答复
 *   paused   暂停发送：不再推送（推送被抑制并审计），审批**立即委派**回 DSH 界面，
 *            保证 DSH 回合不会因为「暂停」而卡住
 *   stopped  关闭服务：DSH 侧完全静默（不检测、不建请求、不阻塞），网关出站泵同时停发
 *
 * 三个写入面（任选其一都会立即生效，无需重启网关）：
 *   1) CLI：`wx-hitl.mjs switch --state paused`
 *   2) 文件：直接改 state/control.json
 *   3) 环境变量：DSH_WECHAT_HITL_SWITCH=running|paused|stopped（优先级最高，仅影响本进程，测试用）
 */
export const CONTROL_STATES = ["running", "paused", "stopped"];

const CONTROL_DEFAULT = { state: "running", updatedAt: 0, updatedBy: "default", reason: "未设置时默认开启", decisionPush: true, resultPush: true };

/** 读开关：环境变量 > control.json > 默认 running。 */
export function getControl(channel) {
  const ch = String(channel || currentChannel()).toLowerCase();
  const env = String(process.env.DSH_WECHAT_HITL_SWITCH ?? "").trim().toLowerCase();
  if (CONTROL_STATES.includes(env)) return { ...CONTROL_DEFAULT, state: env, updatedBy: "env" };
  try {
    const parsed = JSON.parse(readFileSync(CONTROL_FILE, "utf8"));
    if (ch !== "wechat") {
      // 每通道独立开关：关掉微信不能连带关掉飞书（2026-11-05 用户要求）
      const sub = parsed && parsed.channels ? parsed.channels[ch] : null;
      if (sub && CONTROL_STATES.includes(String(sub.state))) return sub;
      return { state: "running", updatedAt: 0, updatedBy: "default", reason: "该通道未单独设置时默认开启", decisionPush: !(parsed && parsed.decisionPush === false), resultPush: !(parsed && parsed.resultPush === false) };
    }
    if (parsed && CONTROL_STATES.includes(String(parsed.state))) return parsed;
  } catch {}
  return { ...CONTROL_DEFAULT };
}

/** 写开关（原子替换 + 保留最近 20 条历史）。 */
export function setControl(state, options = {}) {
  const next = String(state ?? "").trim().toLowerCase();
  if (!CONTROL_STATES.includes(next)) throw new Error("state 必须是 running|paused|stopped，收到: " + String(state));
  ensureDir();
  const channel = String(options.channel || currentChannel()).toLowerCase();
  if (channel !== "wechat") {
    let root = {};
    try { root = JSON.parse(readFileSync(CONTROL_FILE, "utf8")) || {}; } catch {}
    const previous = (root.channels && root.channels[channel]) || { state: "running", updatedAt: 0, updatedBy: "default" };
    const subRecord = {
      state: next,
      updatedAt: Date.now(),
      updatedBy: String(options.by ?? "cli").slice(0, 60),
      reason: String(options.reason ?? "").slice(0, 300),
      decisionPush: previous.decisionPush === undefined ? true : previous.decisionPush === true,
       resultPush: previous.resultPush === undefined ? true : previous.resultPush === true,
      history: Array.isArray(previous.history) ? previous.history.slice(-19) : [],
    };
    subRecord.history.push({ state: previous.state, at: previous.updatedAt ?? 0, by: previous.updatedBy ?? "unknown" });
    root.channels = { ...(root.channels || {}), [channel]: subRecord };
    const tmpPath = CONTROL_FILE + ".tmp-" + process.pid + "-" + randomBytes(3).toString("hex");
    writeFileSync(tmpPath, JSON.stringify(root, null, 2), "utf8");
    renameSync(tmpPath, CONTROL_FILE);
    log({ op: "switch", channel, from: previous.state, to: next, by: subRecord.updatedBy, reason: subRecord.reason });
    return subRecord;
  }
  const previous = getControl();
  const record = {
    state: next,
    updatedAt: Date.now(),
    updatedBy: String(options.by ?? "cli").slice(0, 60),
    reason: String(options.reason ?? "").slice(0, 300),
    // 结果推送是独立维度：重写 control.json 时不能把它丢掉
    decisionPush: previous.decisionPush === undefined ? true : previous.decisionPush === true,
       resultPush: previous.resultPush === undefined ? true : previous.resultPush === true,
    history: Array.isArray(previous.history) ? previous.history.slice(-19) : [],
  };
  record.history.push({ state: previous.state, at: previous.updatedAt ?? 0, by: previous.updatedBy ?? "unknown" });
  const tmp = CONTROL_FILE + ".tmp-" + process.pid + "-" + randomBytes(3).toString("hex");
  writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
  renameSync(tmp, CONTROL_FILE);
  log({ op: "switch", from: previous.state, to: next, by: record.updatedBy, reason: record.reason });
  return record;
}

/** REQ-001：结果推送总开关（与 running/paused/stopped 这个「全部推送」维度解耦）。 */
export function getResultPush() {
  const env = String(process.env.DSH_WECHAT_HITL_RESULT_PUSH ?? "").trim().toLowerCase();
  if (["on", "off", "1", "0", "true", "false"].includes(env)) return !["off", "0", "false"].includes(env);
  try {
    const parsed = JSON.parse(readFileSync(CONTROL_FILE, "utf8"));
    if (typeof parsed.resultPush === "boolean") return parsed.resultPush;
  } catch {}
  return true;
}

/** 写结果推送开关（保留 state/history，原子替换 + 审计）。 */
export function setResultPush(on, options = {}) {
  const truthy = on === true || ["on", "1", "true"].includes(String(on).toLowerCase());
  ensureDir();
  const previous = getControl();
  const before = getResultPush();
  const record = {
    state: previous.state,
    updatedAt: Date.now(),
    updatedBy: String(options.by ?? "cli").slice(0, 60),
    reason: String(options.reason ?? "").slice(0, 300),
    decisionPush: previous.decisionPush === undefined ? true : previous.decisionPush === true,
     resultPush: truthy,
    history: Array.isArray(previous.history) ? previous.history.slice(-19) : [],
  };
  const tmp = CONTROL_FILE + ".tmp-" + process.pid + "-" + randomBytes(3).toString("hex");
  writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
  renameSync(tmp, CONTROL_FILE);
  log({ op: "result-push", from: before ? "on" : "off", to: truthy ? "on" : "off", by: record.updatedBy });
  return { ok: true, from: before, to: truthy, record };
}

/** 是否真的推「回合结束」：两个维度取交集，paused/stopped 仍然一票否决。 */
/** REQ-003：权限与决策询问独立开关。覆盖 approval/request 与 ask_user_question。 */
export function getDecisionPush() {
  const env = String(process.env.DSH_WECHAT_HITL_DECISION_PUSH ?? "").trim().toLowerCase();
  if (["on", "off", "1", "0", "true", "false"].includes(env)) return !["off", "0", "false"].includes(env);
  try {
    const parsed = JSON.parse(readFileSync(CONTROL_FILE, "utf8"));
    if (typeof parsed.decisionPush === "boolean") return parsed.decisionPush;
  } catch {}
  return true;
}

export function setDecisionPush(on, options = {}) {
  const truthy = on === true || ["on", "1", "true"].includes(String(on).toLowerCase());
  ensureDir();
  const previous = getControl();
  const before = getDecisionPush();
  const record = {
    state: previous.state,
    updatedAt: Date.now(),
    updatedBy: String(options.by ?? "cli").slice(0, 60),
    reason: String(options.reason ?? "").slice(0, 300),
    decisionPush: truthy,
    resultPush: previous.resultPush === undefined ? true : previous.resultPush === true,
    history: Array.isArray(previous.history) ? previous.history.slice(-19) : [],
  };
  const tmp = CONTROL_FILE + ".tmp-" + process.pid + "-" + randomBytes(3).toString("hex");
  writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
  renameSync(tmp, CONTROL_FILE);
  log({ op: "decision-push", from: before ? "on" : "off", to: truthy ? "on" : "off", by: record.updatedBy });
  return { ok: true, from: before, to: truthy, record };
}

export function isDecisionPushEnabled() {
  return isSending() && getDecisionPush();
}

export function describeDecisionPush() {
  return (getDecisionPush() ? "🟢 权限/决策询问：开" : "🟡 权限/决策询问：关") + "（总开关：" + getControl().state + "）";
}

export function describeChannelControl() {
  const control = getControl();
  return {
    master: control.state,
    decisionPush: getDecisionPush(),
    resultPush: getResultPush(),
    effectiveDecisionPush: isDecisionPushEnabled(),
    effectiveResultPush: isResultPushEnabled(),
  };
}

export function isResultPushEnabled() {
  return isSending() && getResultPush();
}

export function describeResultPush() {
  const base = (getResultPush() ? "🟢 结果推送：开" : "🟡 结果推送：关") + "（总开关：" + getControl().state + "）";
  let queue = [];
  try { queue = loadState()?.outbox ?? []; } catch {}
  if (queue.length === 0) return base;
  const blocked = queue.filter((item) => item.blocked === "config").length;
  const blockedNote = blocked > 0
    ? "，其中 " + blocked + " 条被出站配置阻塞（lark-cli 未 bind / 配置目录错）：修好后自动补发，日志查 outbox-blocked-config"
    : "";
  return base + "\n📮 出站积压 " + queue.length + " 条" + blockedNote;
}

/**
 * REQ-002：解析微信侧的推送开关指令。
 * 只认整条消息就是短指令的情况，避免把「1 帮我跑测试」这类会话驱动误判成开关。
 */
export function parsePushCommand(text) {
  const raw = String(text ?? "").trim();
  if (!raw || raw.length > 24) return null;
  // 归一：去空白/全角空格/标点，去称呼与助词，小写。
  // 2026-11-01 用户实测：「打开会话微信推送开关」「打开openclaw通道」这类自然说法
  // 被旧实现（只认「推送开/推送关/推送状态」）判为普通提问，于是既没开也没关，
  // 还被待确认请求拦截器回了一句「有 N 个待确认」。这里改成认意图而不是认字面。
  let t = raw.replace(/[\s　]+/g, "").replace(/[：:，。！、,.!]/g, "").toLowerCase();
  t = t.replace(/^(?:请|麻烦|你|帮我|把|给|先|再|马上|就|现在|一下)+/, "");
  const verbMatch = t.match(/^(打开|开启|恢复|启动|开|关掉|关闭|关|停用|停止|暂停|查询|查看|看)(.*)$/);
  let verb = null;
  if (verbMatch) { verb = verbMatch[1]; t = verbMatch[2]; }
  // 名词部分：可选前缀（会话/微信/结果/消息/openclaw）+ 推送/通知/通道（+推送）+ 可选「开关」
  const decisionNoun = /^(?:权限|决策|审批|询问|提问|与|和)+(?:推送|通知|通道)?(?:的)?(?:开关)?$/;
  const decisionAction = verb ? (["关掉", "关闭", "关", "停用", "停止", "暂停"].includes(verb) ? "off" : (["查询", "查看", "看"].includes(verb) ? "status" : "on")) : "status";
  if (decisionNoun.test(t)) return { action: decisionAction, target: "decision" };
  const decisionTail = t.match(/^(.*?)(开|打开|开启|关|关闭|关掉|状态|on|off|status)$/);
  if (decisionTail && decisionNoun.test(decisionTail[1])) {
    const v = decisionTail[2];
    return { action: ["关", "关闭", "关掉", "off"].includes(v) ? "off" : (["状态", "status"].includes(v) ? "status" : "on"), target: "decision" };
  }
  const noun = /^(?:(?:会话|微信|结果|消息|openclaw)*)(?:推送|通知|通道)(?:推送|通知)?(?:的)?(?:总)?(?:开关)?$/;
  let action = null;
  if (noun.test(t)) {
    action = verb ? (["关掉", "关闭", "关", "停用", "停止", "暂停"].includes(verb) ? "off" : (["查询", "查看", "看"].includes(verb) ? "status" : "on")) : "status";
  } else {
    // 无动词时允许把动作词贴在末尾：「推送开」「推送关」「推送状态」「openclaw通道 开」
    const tail = t.match(/^(.*?)(开|打开|开启|关|关闭|关掉|状态|on|off|status)$/);
    if (tail && noun.test(tail[1])) {
      const v = tail[2];
      action = ["关", "关闭", "关掉", "off"].includes(v) ? "off" : (["状态", "status"].includes(v) ? "status" : "on");
    }
  }
  if (!action) return null;
  return { action };
}

/** 是否允许真正把消息发出去（只有 running 允许）。 */
export function isSending() { return getControl().state === "running"; }

/** 插件是否介入事件处理（stopped 完全不介入）。 */
export function isActive() { return getControl().state !== "stopped"; }

/** 面向人的一行描述，供微信/CLI 输出。 */
export function describeControl(control = getControl()) {
  const label = { running: "🟢 running（开启）", paused: "🟡 paused（暂停发送）", stopped: "🔴 stopped（已关闭服务）" };
  const at = control.updatedAt ? new Date(control.updatedAt).toLocaleString("zh-CN", { hour12: false }) : "-";
  return label[control.state] + "  by=" + (control.updatedBy ?? "-") + "  at=" + at + (control.reason ? "  reason=" + control.reason : "");
}

function ensureDir() {
  try { if (!existsSync(PATHS.stateDir)) mkdirSync(PATHS.stateDir, { recursive: true }); } catch {}
}

export function log(entry) {
  ensureDir();
  try {
    appendFileSync(LOG_FILE, new Date().toISOString() + " " + JSON.stringify(entry).slice(0, 4000) + "\n");
  } catch {}
}

const EMPTY = () => ({ version: 1, seq: 0, requests: {} });

export function loadState() {
  try {
    const raw = readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.requests !== "object") return EMPTY();
    return parsed;
  } catch {
    return EMPTY();
  }
}

/** 原子写：temp 写入 + rename 覆盖。 */
export function saveState(state) {
  ensureDir();
  const tmp = STATE_FILE + ".tmp-" + process.pid + "-" + randomBytes(3).toString("hex");
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, STATE_FILE);
}

/**
 * 跨进程互斥锁（独占创建 + 过期抢占）。
 *
 * 为什么必须加锁：pending.json 有 3 个写入者（DSH 宿主插件、OpenClaw 网关出站泵、CLI），
 * 原来的「重读+重试」只防重试失败，不防丢更新：A 读到快照 → B 写入新条目 → A 用旧快照整体覆盖，
 * B 的条目静默消失。实测 2026-10-26 14:42 网关重启窗口里 out-1792996945520-4f5afe
 * 只有 push-queued，既无 outbox-sent 也无 outbox-failed 就没了，你手机上没收到。
 *
 * 失败降级：拿不到锁超过 timeoutMs 时仍然写入（并记 state-lock-timeout），
 * 因为「偶发丢更新」比「完全不写」危害小；正常情况下锁只持有几毫秒。
 */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* spin fallback */ } }
}

function stateLockPath() { return STATE_FILE + ".lock"; }

// 同一进程内可重入：不同锁文件各自计深度，避免 setSessionLabel 里再调 sessionCode 时自锁。
const LOCK_DEPTH = new Map();

function acquireLock(lock, timeoutMs = 5000, staleMs = 15000) {
  const depth = LOCK_DEPTH.get(lock) ?? 0;
  if (depth > 0) { LOCK_DEPTH.set(lock, depth + 1); return true; }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try { writeFileSync(fd, String(process.pid)); } catch {}
      try { closeSync(fd); } catch {}
      LOCK_DEPTH.set(lock, 1);
      return true;
    } catch (error) {
      if (error && error.code !== "EEXIST") return false;
      // 锁文件存在：判断持有者是否已死（超时未释放视为崩溃残留）
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
          try { unlinkSync(lock); } catch {}
          continue;
        }
      } catch { continue; }
      if (Date.now() >= deadline) return false;
      sleepSync(15);
    }
  }
}

function releaseLock(lock) {
  const depth = LOCK_DEPTH.get(lock) ?? 0;
  if (depth > 1) { LOCK_DEPTH.set(lock, depth - 1); return; }
  LOCK_DEPTH.delete(lock);
  try { unlinkSync(lock); } catch {}
}

function acquireStateLock(timeoutMs = 5000, staleMs = 15000) {
  return acquireLock(stateLockPath(), timeoutMs, staleMs);
}

function releaseStateLock() { releaseLock(stateLockPath()); }

// 会话码表（sessions.json）也必须读-改-写原子：并发分配曾让上百个会话同码（2026-11-06 实测）。
function registryLockPath() { return REGISTRY_FILE + ".lock"; }
function acquireRegistryLock() { return acquireLock(registryLockPath(), 5000, 15000); }
function releaseRegistryLock() { releaseLock(registryLockPath()); }

/**
 * 读-改-写事务：mutator 返回 true 表示需要落盘。
 * 并发由跨进程锁保证，锁内不做任何 await，避免长时间持有。
 */
export function mutate(mutator, retries = 5) {
  const locked = acquireStateLock();
  if (!locked) log({ op: "state-lock-timeout" });
  try {
    let lastError = null;
    for (let i = 0; i < retries; i += 1) {
      const state = loadState();
      let changed = false;
      try {
        changed = mutator(state) === true;
      } catch (error) {
        lastError = error;
        continue;
      }
      if (!changed) return state;
      state.seq = (Number(state.seq) || 0) + 1;
      try {
        saveState(state);
        return state;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) log({ op: "mutate-failed", error: String(lastError) });
    return loadState();
  } finally {
    if (locked) releaseStateLock();
  }
}

// ── 请求模型 ──────────────────────────────────────────────────────────────
/**
 * @typedef {Object} HitlRequest
 * @property {string} id            req-<utc compact>-<4 hex>
 * @property {string} sessionId     DSH 会话 id
 * @property {"approval"|"inject"} mode  approval=需在回合内返回裁决；inject=答复后作为新回合注入
 * @property {string} kind          approval | question | confirm | manual
 * @property {string} title
 * @property {string} question
 * @property {{key:string,label:string}[]} options
 * @property {string} context       上下文摘要（可空）
 * @property {string} cwd
 * @property {number} createdAt
 * @property {number} expiresAt
 * @property {"pending"|"answered"|"expired"|"cancelled"} status
 * @property {{key:string,label:string,raw:string,via:string,at:number}|null} answer
 * @property {number|null} deliveredAt
 * @property {string|null} delivery   in-turn | injected | headless-fast | headless-bg | not-live | failed:<msg>
 *   injected      = DSH 插件进程内注入（本机 hasSessionController 恒 false，从未出现过）
 *   headless-fast = 网关 spawn headless，150 秒内拿到文本
 *   headless-bg   = 网关后台 headless（含 not-live 后的 60 秒延迟重试）拿到文本
 *   not-live      = 会话当前收不了（写锁被占 / 续跑无输出），已排队延迟重试
 */

export function newRequestId() {
  const compact = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  return "req-" + compact + "-" + randomBytes(2).toString("hex");
}

export function shortId(id) {
  return String(id || "").split("-").pop();
}

/**
 * 微信里对用户可见的「识别码」(handle)。
 * 用户反馈：4 位十六进制（如 1fca）在手机键盘上难打、复制也不顺手。
 * 因此改成 1–2 位纯数字：键盘一排数字、复制粘贴无歧义；
 * 单调递增分配并跳过未完成请求占用的号，避免回给上一条消息造成串号。
 * 内部幂等键仍是 request id（req-…-<4hex>），handle 只用于显示与回复。
 */
export function allocateHandle(state) {
  const used = new Set();
  for (const req of Object.values(state.requests || {})) {
    if (req && req.status === "pending" && Number.isInteger(req.handle)) used.add(req.handle);
  }
  for (let candidate = 1; candidate <= 99; candidate += 1) {
    if (!used.has(candidate)) return candidate;
  }
  return 1;
}

export function createRequest(input, ttlMs = DEFAULT_TTL_MS) {
  // 三态开关：非 running 不建请求（否则会留下永远等不到答复的悬空请求）。
  // 插件内部已有前置判断；这里兜底 CLI/脚本路径。input.force=true 可强制建立（排障用）。
  const gate = getControl();
  if (gate.state !== "running" && input?.force !== true) {
    const error = new Error("auto-push is " + gate.state + ": request not created");
    error.code = "SWITCH_NOT_RUNNING";
    error.switchState = gate.state;
    log({ op: "create-suppressed", state: gate.state, mode: input?.mode ?? null, question: String(input?.question ?? "").slice(0, 80) });
    throw error;
  }
  const now = Date.now();
  const req = {
    id: input.id ?? newRequestId(),
    handle: null,
    sessionId: input.sessionId ?? "",
    mode: input.mode === "approval" ? "approval" : "inject",
    kind: input.kind ?? "manual",
    title: input.title ?? "需要确认",
    question: String(input.question ?? "").trim(),
    options: Array.isArray(input.options) && input.options.length > 0
      ? input.options.map((item, index) => ({ key: String(index + 1), label: typeof item === "string" ? item : String(item.label ?? ""), aliases: (typeof item === "object" && Array.isArray(item.aliases)) ? item.aliases : [] }))
      : [{ key: "1", label: "确认", aliases: [] }, { key: "2", label: "取消", aliases: [] }],
    context: String(input.context ?? "").slice(0, 800),
    cwd: input.cwd ?? PATHS.workdir,
    createdAt: now,
    expiresAt: now + (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS),
    status: "pending",
    answer: null,
    deliveredAt: null,
    delivery: null,
  };
  mutate((state) => {
    req.handle = allocateHandle(state);
    state.requests[req.id] = req;
    return true;
  });
  log({ op: "create", id: req.id, handle: req.handle, mode: req.mode, kind: req.kind, sessionId: req.sessionId });
  return req;
}

export function getRequest(id) {
  const state = loadState();
  return state.requests?.[id] ?? null;
}

export function markAnswered(id, answer, via = "wechat") {
  let updated = null;
  mutate((state) => {
    const req = state.requests?.[id];
    if (!req || req.status !== "pending") return false;
    req.status = "answered";
    req.answer = {
      key: answer.key ?? "",
      label: answer.label ?? "",
      raw: String(answer.raw ?? "").slice(0, 500),
      via,
      at: Date.now(),
    };
    updated = req;
    return true;
  });
  if (updated) log({ op: "answered", id, key: updated.answer.key, raw: updated.answer.raw, via });
  return updated;
}

/** Claim admission once across host processes. A stranded claim is uncertain, never auto-replayed. */
export function claimRequestDelivery(id) {
  if (!acquireStateLock()) return false;
  try {
    const state = loadState();
    const req = state.requests?.[id];
    if (!req || req.deliveredAt || req.deliveryClaim || req.deliveryFailureAt) return false;
    if (req.mode === "message" ? req.status !== "pending" : req.status !== "answered") return false;
    if (req.mode === "message" && req.expiresAt < Date.now()) return false;
    req.deliveryClaim = { pid: process.pid, at: Date.now() };
    state.seq = (Number(state.seq) || 0) + 1;
    saveState(state);
    return true;
  } finally { releaseStateLock(); }
}

export function failRequestDelivery(id, error) {
  mutate((state) => {
    const req = state.requests?.[id];
    if (!req || req.deliveredAt) return false;
    req.delivery = "controller-failed:" + String(error).slice(0, 240);
    req.deliveryFailureAt = Date.now();
    if (req.mode === "message") req.status = "failed";
    return true;
  });
  log({ op: "delivery-failed", id, error: String(error).slice(0, 240) });
}

export function markRelayReport(id, report) {
  mutate((state) => {
    const req = state.requests?.[id];
    if (!req || req.relayReport === report) return false;
    req.relayReport = report;
    req.relayReportAt = Date.now();
    return true;
  });
}

export function markDelivered(id, delivery) {
  mutate((state) => {
    const req = state.requests?.[id];
    if (!req) return false;
    req.deliveredAt = Date.now();
    req.delivery = delivery;
    // message（转发型）请求没有“答复”这一步，投递即闭环；
    // 必须移出 pending，否则后续微信消息会被它当成答复拦截。
    if (req.mode === "message" && req.status === "pending") req.status = delivery === "not-live" ? "failed" : "delivered";
    return true;
  });
  log({ op: "delivered", id, delivery });
}

export function markStatus(id, status) {
  mutate((state) => {
    const req = state.requests?.[id];
    if (!req || req.status !== "pending") return false;
    req.status = status;
    req.answer = req.answer ?? null;
    return true;
  });
}

export function expireStale() {
  const now = Date.now();
  let expired = [];
  mutate((state) => {
    for (const req of Object.values(state.requests || {})) {
      if (req.status === "pending" && Number(req.expiresAt) > 0 && Number(req.expiresAt) < now) {
        req.status = "expired";
        expired.push(req.id);
      }
    }
    return expired.length > 0;
  });
  if (expired.length > 0) log({ op: "expired", ids: expired });
  return expired;
}

/** 发件箱积压概况（含因缺 contextToken 滞留的条数），供 status 展示。 */
export function outboxSummary() {
  const state = loadState();
  const queue = Array.isArray(state.outbox) ? state.outbox : [];
  return { queued: queue.length, needsContext: queue.filter((item) => item.needsContext).length, oldestMs: queue.reduce((min, item) => Math.min(min, Number(item.createdAt) || Infinity), Infinity) };
}

export function listPending() {
  expireStale();
  const state = loadState();
  return Object.values(state.requests || {})
    .filter((req) => req.status === "pending")
    .sort((a, b) => b.createdAt - a.createdAt);
}


// ── 微信「驱动」任意会话：绑定表 ────────────────────────────────────────────
/**
 * 绑定：微信里发来的普通消息（不是答复、不是命令）要被送进哪个 DSH 会话。
 *   - null：不绑定 → 维持原行为（走 dsh-bridge 的 wx- 专属会话）
 *   - { sessionId, label }：把消息注入该会话（进程内优先，headless 兜底）
 */
export const BIND_FILE = join(PATHS.stateDir, "binding.json");

export function getBinding() {
  try {
    const parsed = JSON.parse(readFileSync(BIND_FILE, "utf8"));
    if (parsed && typeof parsed.sessionId === "string" && parsed.sessionId.length > 0) return parsed;
  } catch {}
  return null;
}

export function setBinding(sessionId, label, by = "cli") {
  ensureDir();
  const record = { sessionId: String(sessionId), label: String(label ?? "").slice(0, 120), updatedAt: Date.now(), by };
  const tmp = BIND_FILE + ".tmp-" + process.pid + "-" + randomBytes(3).toString("hex");
  writeFileSync(tmp, JSON.stringify(record, null, 2), "utf8");
  renameSync(tmp, BIND_FILE);
  log({ op: "bind", sessionId: record.sessionId, label: record.label, by });
  return record;
}

export function clearBinding(by = "cli") {
  try { writeFileSync(BIND_FILE, JSON.stringify({ sessionId: "", label: "", updatedAt: Date.now(), by }, null, 2), "utf8"); } catch {}
  log({ op: "bind-clear", by });
  return null;
}

/**
 * 列出本工作区可驱动的会话（按最近活跃排序）。
 * 只读文件系统，不需要 DSH 宿主配合；用于微信里发「/l」时给用户挑。
 */
export function listSessions(limit = 8) {
  const base = join(PATHS.dshHome, "sessions", PATHS.workspaceKey);
  let names = [];
  try { names = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("session-")).map((d) => d.name); } catch { return []; }
  const rows = [];
  for (const name of names) {
    const file = join(base, name, "session.v4.jsonl.zstd");
    try {
      const stat = statSync(file);
      rows.push({ sessionId: name, mtime: stat.mtimeMs, sizeKb: Math.round(stat.size / 1024) });
    } catch {}
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.slice(0, limit).map((row, index) => ({ index: index + 1, ...row }));
}

/** 把「/s 3」「3」「会话 3」解析成清单里的第 3 个（1-based）。 */
export function pickSession(token, sessions) {
  const wanted = String(token ?? "").replace(/[^0-9]/g, "");
  if (!wanted) return null;
  return sessions.find((row) => String(row.index) === wanted) ?? null;
}

/**
 * ── 渠道内「遥控器」命令（微信网关 / 飞书 daemon 共用）─────────────────────
 * 背景：飞书 daemon 曾经把「/l」「/s」只写在提示文案里而没有实现，
 * 结果用户发 /s 3 会被当成普通消息转发进绑定会话（2026-11-06 核实）。
 * 这里做成一个纯入口，两个通道都调它，避免再出现「文案有、代码没有」。
 *
 *   /l [N]                      列出可驱动会话（跨工作区，默认 10 条）
 *   /s <回复id|会话码|标题前缀>  绑定默认落点（不带码的消息进这条会话）
 *   /a                          取消绑定
 *   /name <会话码> <名称>        给会话起名（人可读，便于 /s 用标题选）
 *   /who                        当前绑定 + 通道 + 开关状态
 *   /push <码> on|off            打开/关闭单个会话推送
 *   /push all on|off             一键打开/关闭所有会话推送
 *   /push <码> mode summary|long [800|1600|3000|full]
 *
 * 返回 null 表示不是命令（调用方继续走原有路由）。
 * @returns {null|{kind:string,text:string,sessionId?:string}}
 */
export function runChannelCommand(rawText, options = {}) {
  const raw = String(rawText ?? "").trim();
  if (!raw) return null;
  const by = String(options.by ?? "channel");
  const lower = raw.toLowerCase();
  const head = lower.split(/\s+/)[0];

  // 1) 清单 / 帮助
  if (["/l", "/list", "/help", "/h"].includes(head) || ["列表", "会话列表", "帮助", "怎么回"].includes(lower)) {
    const limitMatch = raw.match(/^\/(?:l|list)\s+([0-9]{1,2})$/i);
    const limit = limitMatch ? Math.min(Number(limitMatch[1]) || 10, 30) : 10;
    const sessions = listSessionsV2(limit);
    if (sessions.length === 0) return { kind: "list", text: "当前没有可驱动的会话。" };
    const bound = getBinding();
    const headText = bound
      ? "当前绑定：码 " + sessionCode(bound.sessionId) + " · " + (bound.label || "(未命名)") + "\n\n"
      : "当前未绑定：不带码的消息会提示你选会话。\n\n";
    return {
      kind: "list",
      text: headText + formatSessionListV2(sessions) + "\n绑定：/s <回复id 或 会话码>｜取消：/a｜命名：/name <码> <名称>｜当前：/who",
    };
  }

  // 2) 取消绑定
  if (["/a", "/auto", "/off", "/unbind"].includes(lower) || ["自动", "取消绑定"].includes(lower)) {
    const old = getBinding();
    clearBinding(by);
    if (!old?.sessionId) return { kind: "unbind", text: "本来就没有绑定。" };
    return { kind: "unbind", text: "已取消绑定（原：码 " + sessionCode(old.sessionId) + " · " + (old.label || "(未命名)") + "）。" };
  }

  // 3) 会话级推送控制：/push all on|off、/push <会话码> on|off、/push <会话码> mode summary|long [800|1600|3000|full]
  const pushSessionMatch = raw.match(/^\/push\s+(all|[0-9]{1,3})\s+(on|off)$/i);
  if (pushSessionMatch) {
    const target = pushSessionMatch[1].toLowerCase();
    const enabled = pushSessionMatch[2].toLowerCase() === "on";
    if (target === "all") { setAllSessionNotificationEnabled(enabled, { by }); return { kind: "push-control", text: enabled ? "已一键打开所有会话推送。" : "已一键关闭所有会话推送。" }; }
    const hit = sessionByCode(target);
    if (!hit) return { kind: "error", text: "没有会话码 " + target + "，发 /l 看清单。" };
    setSessionNotificationControl(hit.sessionId, { enabled }, { by });
    return { kind: "push-control", sessionId: hit.sessionId, text: "已将码 " + target + " 的推送设为" + (enabled ? "开" : "关") + "。" };
  }
  const pushModeMatch = raw.match(/^\/push\s+([0-9]{1,3})\s+mode\s+(summary|long)(?:\s+(800|1600|3000|full))?$/i);
  if (pushModeMatch) {
    const hit = sessionByCode(pushModeMatch[1]);
    if (!hit) return { kind: "error", text: "没有会话码 " + pushModeMatch[1] + "，发 /l 看清单。" };
    const mode = pushModeMatch[2].toLowerCase();
    const maxChars = mode === "summary" ? 800 : (pushModeMatch[3]?.toLowerCase() === "full" ? 0 : Number(pushModeMatch[3] || 800));
    setSessionNotificationControl(hit.sessionId, { mode, maxChars }, { by });
    return { kind: "push-control", sessionId: hit.sessionId, text: "码 " + pushModeMatch[1] + " 已设为" + (mode === "summary" ? "摘要模式（800字）" : "长文模式（" + (maxChars === 0 ? "全文" : maxChars + "字") + "）") + "。" };
  }

  // 4) 当前状态
  if (["/who", "/whoami", "/me"].includes(lower)) {
    const bound = getBinding();
    const lines = [
      "通道：" + currentChannel() + "｜总闸：" + describeControl(),
      "结果推送：" + (isResultPushEnabled() ? "开" : "关") + "｜决策推送：" + (isDecisionPushEnabled() ? "开" : "关"),
      bound?.sessionId
        ? "默认落点：码 " + sessionCode(bound.sessionId) + " · " + (bound.label || "(未命名)") + "\n" + formatSessionStatus(bound.sessionId)
        : "默认落点：未绑定（/l 看清单，/s 绑定）",
    ];
    return { kind: "who", text: lines.join("\n") };
  }

  // 4) 命名（码 = 清单里的「回复id」）
  const nameMatch = raw.match(/^\/(?:name|命名)\s*([0-9]{1,2})\s+([\s\S]+)$/i);
  if (nameMatch) {
    const hit = sessionByCode(nameMatch[1]);
    if (!hit) return { kind: "error", text: "没有会话码 " + nameMatch[1] + "，发 /l 看清单。" };
    const label = nameMatch[2].trim().slice(0, 60);
    setSessionLabel(hit.sessionId, label);
    return { kind: "name", sessionId: hit.sessionId, text: "已把码 " + hit.code + " 命名为「" + label + "」，之后可用 /s " + label + " 绑定。" };
  }

  // 5) 绑定
  const bindMatch = raw.match(/^(?:\/s|\/bind|切|绑定)\s+([\s\S]+)$/i);
  if (bindMatch) {
    const token = bindMatch[1].trim();
    const target = resolveBindTarget(token);
    if (target?.ambiguous) {
      return {
        kind: "error",
        text: "「" + token + "」命中多条：\n" + target.ambiguous.map((row) => "码 " + row.code + " · " + row.label).join("\n") + "\n请用 /s <回复id 或 会话码>。",
      };
    }
    if (!target) return { kind: "error", text: "没找到「" + token + "」。发 /l 看清单，或用会话码。" };
    const old = getBinding();
    setBinding(target.sessionId, target.label, by);
    const code = sessionCode(target.sessionId);
    const lines = ["✅ 已绑定：码 " + code + " · " + target.label, "不带码的消息都进这条会话；带「码 内容」仍可指定别的会话。"];
    if (old?.sessionId && old.sessionId !== target.sessionId) lines.push("回滚：/s " + sessionCode(old.sessionId));
    return { kind: "bind", sessionId: target.sessionId, text: lines.join("\n") };
  }

  // 认得出是斜杠指令，但不是已知指令
  if (raw.startsWith("/")) return { kind: "unknown", text: "没这个指令。\n/l 清单 ｜ /s 绑定 ｜ /new 建会话 ｜ /a 取消 ｜ /name 命名 ｜ /who 当前" };
  return null;
}

/**
 * /new 的接线（方案 A，不新增服务）：
 * 把一条自包含指令注入**已绑定会话**，由它调用 DSH 的 new_session 工具建会话，
 * 再用固定标记把新 sessionId 回写；daemon 解析后自动绑定并分配会话码。
 */
export const NEW_SESSION_MARKER = "[[new_session:";

export function buildNewSessionInstruction({ title, workspace } = {}) {
  const wanted = String(title ?? "").trim() || "远程新建会话";
  const ws = String(workspace ?? "").trim();
  return [
    "【系统指令·建会话】本轮只做一件事，不要做别的：",
    "1) 调用 new_session 工具创建一个新会话；title 用 " + JSON.stringify(wanted) + (ws ? "；cwd 用 " + JSON.stringify(ws) : "；cwd 用当前会话的工作区"),
    "2) 记住工具返回的 sessionId；",
    "3) **只输出一行**，格式严格如下，前后不要有任何其它文字：",
    NEW_SESSION_MARKER + "<sessionId>]]",
    "说明：这行会被飞书通道解析并自动完成绑定；写错或省略等于没建。",
  ].join("\n");
}

/** 从会话回复里取回 new_session 的 id；取不到返回 null。 */
export function parseNewSessionMarker(text) {
  const hit = String(text ?? "").match(/\[\[new_session:(session-[0-9a-zA-Z-]{8,})\]\]/);
  return hit ? hit[1] : null;
}

/**
 * /s 的 token → 目标会话。优先级：会话码 → 标题唯一命中 → 清单第 N 行兜底。
 * 命中多条时返回 { ambiguous }，交给调用方要求用户改用编号或码。
 */
export function resolveBindTarget(token, sessions = listSessionsV2(20)) {
  const raw = String(token ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits && /^[0-9]{1,3}$/.test(raw)) {
    // 顺序很重要：清单第一列展示的就是「会话码」，所以码优先；
    // 早期版本先按 index 命中，导致「看到 50、绑到第 50 行」这种错绑（2026-11-06 修）。
    const byRowCode = (sessions || []).find((row) => Number(row.code) === Number(digits));
    if (byRowCode) {
      return { sessionId: byRowCode.sessionId, label: sessionLabel(byRowCode.sessionId) || byRowCode.name || "", via: "code", code: byRowCode.code };
    }
    const byCode = sessionByCode(raw);
    if (byCode) return { sessionId: byCode.sessionId, label: sessionLabel(byCode.sessionId) || byCode.sessionId.slice(0, 12), via: "code", code: byCode.code };
    // 兜底：仍接受「清单第 N 行」的写法（老提示里叫回复id，现在等价于码）。
    const byIndex = pickSession(raw, sessions);
    if (byIndex) {
      return { sessionId: byIndex.sessionId, label: sessionLabel(byIndex.sessionId) || byIndex.name || byIndex.workspace || "", via: "index", code: byIndex.code };
    }
  }
  const needle = raw.toLowerCase();
  const hits = (sessions || []).filter((row) => {
    // 清单展示的 name 已经是「登记名，或 工作区·短id」的兜底，所以按它匹配才对得上用户看到的那一列。
    const label = String(sessionLabel(row.sessionId) || row.name || "").toLowerCase();
    return label.length > 0 && label.includes(needle);
  });
  if (hits.length === 1) {
    const row = hits[0];
    return { sessionId: row.sessionId, label: sessionLabel(row.sessionId) || row.name || "", via: "title", code: row.code };
  }
  if (hits.length > 1) return { ambiguous: hits.slice(0, 6).map((row) => ({ code: row.code, label: sessionLabel(row.sessionId) || row.name || "(未命名)" })) };
  return null;
}

export function buildMessageRequest(input) {
  const control = getControl();
  if (control.state !== "running") {
    const error = new Error("auto-push is " + control.state + ": message not accepted");
    error.code = "SWITCH_NOT_RUNNING";
    error.switchState = control.state;
    throw error;
  }
  const request = {
    id: newRequestId(),
    handle: null,
    sessionId: input.sessionId,
    mode: "message",
    kind: "relay",
    title: input.title ?? "微信转发",
    question: String(input.text ?? "").slice(0, 2000),
    options: [],
    context: input.context ?? "",
    cwd: input.cwd ?? PATHS.workdir,
    createdAt: Date.now(),
    expiresAt: Date.now() + DEFAULT_TTL_MS,
    status: "pending",
    answer: null,
    deliveredAt: null,
    delivery: null,
  };
  // Deduplicate the transport message atomically with enqueueing, including daemon restarts.
  request.channel = input.channel ?? null;
  request.replyChatId = input.replyChatId ?? null;
  request.sourceMessageId = input.sourceMessageId ?? null;
  const sourceKey = request.sourceMessageId
    ? JSON.stringify([request.channel, request.replyChatId, request.sourceMessageId]) : null;
  request.sourceKey = sourceKey;
  let selected = request;
  // Unlike legacy mutate(), this admission transaction must fail closed on lock/write failure.
  if (!acquireStateLock()) throw new Error("relay queue lock unavailable");
  try {
    const state = loadState();
    const previous = sourceKey && Object.values(state.requests ?? {}).find((item) => item.sourceKey === sourceKey);
    if (previous) selected = previous;
    else {
      state.requests[request.id] = request;
      state.seq = (Number(state.seq) || 0) + 1;
      saveState(state);
    }
  } finally { releaseStateLock(); }
  log({ op: selected.id === request.id ? "relay-create" : "relay-duplicate", id: selected.id, sessionId: selected.sessionId });
  return selected;
}

export function formatSessionList(sessions, bound) {
  const rows = sessions.map((row) => {
    const mark = bound && bound.sessionId === row.sessionId ? "当前" : "";
    return [String(row.index), String(sessionCode(row.sessionId)), sessionDisplayName(row.sessionId).slice(0, 22), new Date(row.mtime).toLocaleString("zh-CN", { hour12: false }).slice(5, 16), mark];
  });
  const table = drawTable(["号", "会话码", "会话", "最近活跃", "绑定"], rows);
  return ["可驱动会话（/s 编号 绑定，/a 取消）", "", table].join("\n");
}
export function normalizeReply(text) {
  let value = String(text ?? "").trim();
  value = value.replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  value = value.replace(/＃/g, "#");
  value = value.replace(/．/g, ".").replace(/，/g, ",").replace(/：/g, ":");
  // 微信里长按复制常常把识别码连括号/引号一起带走，括号在回复里没有语义，一律去掉：
  // 「[7] 1」「【7】1」「（7）1」「"7" 1」→ 71 / 7 1
  value = value.replace(/[\[\]【】（）()]/g, "");
  value = value.replace(/^["'\u201c\u2018<]+/u, "").replace(/["'\u201d\u2019>]+$/u, "");
  return value.trim();
}

/** 识别码的显示形式：纯数字，不带任何符号，方便直接敲。 */
export function handleText(req) {
  if (Number.isInteger(req?.handle)) return String(req.handle);
  return shortId(req?.id); // 兼容旧记录（无 handle 时退回 4 位短号）
}

/**
 * 解析一条微信回复。
 * @returns {{ok:true, request:HitlRequest, option:{key:string,label:string}} |
 *           {ok:false, reason:"none"|"ambiguous"|"nomatch", candidates?:HitlRequest[]}}
 */
export function matchReply(rawText, pending = listPending()) {
  const text = normalizeReply(rawText);
  if (!text) return { ok: false, reason: "none" };
  if (pending.length === 0) return { ok: false, reason: "none" };
  const body = text.replace(/^#\s*/, "");

  // ① 显式 hex 短号（兼容旧消息）：#a1b2 1 / a1b2 1
  const legacy = body.match(/^([0-9a-fA-F]{4})\s*[-:：. ]?\s*(.*)$/);
  if (legacy) {
    const wanted = legacy[1].toLowerCase();
    const target = pending.find((req) => shortId(req.id).toLowerCase() === wanted);
    if (target) {
      const option = pickOption(target, legacy[2]);
      if (option) return { ok: true, request: target, option };
      return { ok: false, reason: "need-option", request: target };
    }
  }

  // ② 识别码 + 选项：7 1 / 71 / 7-1 / 7:1 / 7 允许
  for (const req of pending) {
    const code = handleText(req);
    if (!body.startsWith(code)) continue;
    const rest = body.slice(code.length).replace(/^[^\p{L}\p{N}]+/u, "");
    if (rest === "") {
      // 只有一个待确认请求时，「1」应当按“选第 1 项”理解，而不是“只回了码 1”。
      // 多个请求时才需要使用码来消歧，此时才提示「请连写选项」。
      if (pending.length > 1) return { ok: false, reason: "need-option", request: req };
      continue;
    }
    const option = pickOption(req, rest);
    if (option) return { ok: true, request: req, option };
    // 「7 加个新方案」这类自由补充：仅非审批类接受
    if (req.mode !== "approval" && rest.length <= 500) return { ok: true, request: req, option: { key: "", label: rest } };
    return { ok: false, reason: "need-option", request: req };
  }

  // ③ 裸数字：只有一个待确认请求时最省事；多个请求时若该选项键唯一也可
  const bareNumber = body.match(/^([0-9]{1,2})\s*[.。)）:：、]?$/);
  if (bareNumber) {
    const key = bareNumber[1];
    const hits = pending.filter((req) => req.options.some((option) => option.key === key));
    if (pending.length === 1) {
      const only = pending[0];
      const option = pickOption(only, key);
      if (option) return { ok: true, request: only, option };
    }
    if (hits.length === 1) return { ok: true, request: hits[0], option: pickOption(hits[0], key) };
    if (hits.length > 1) return { ok: false, reason: "ambiguous", candidates: hits };
    return { ok: false, reason: "nomatch", candidates: pending };
  }

  // ④ 关键词/标签匹配
  const labelHits = [];
  for (const req of pending) {
    const option = pickOption(req, body);
    if (option) labelHits.push({ req, option });
  }
  if (labelHits.length === 1) return { ok: true, request: labelHits[0].req, option: labelHits[0].option };
  if (labelHits.length > 1) return { ok: false, reason: "ambiguous", candidates: labelHits.map((hit) => hit.req) };

  // ⑤ 只有一个待确认请求时，自由文本视为答复（审批类除外，避免随口一句被当放行）
  if (pending.length === 1 && pending[0].mode !== "approval" && body.length <= 500) {
    return { ok: true, request: pending[0], option: { key: "", label: body } };
  }
  return { ok: false, reason: "ambiguous", candidates: pending };
}

/** 在单个请求内匹配选项：数字键优先，其次标签/别名互相包含。 */
export function pickOption(req, needle) {
  const value = normalizeReply(needle).toLowerCase();
  if (!value) return null;
  const numeric = value.match(/^#?\s*([0-9]{1,2})\s*[.。)）:：、]?$/);
  if (numeric) {
    const hit = req.options.find((option) => option.key === numeric[1]);
    if (hit) return { key: hit.key, label: hit.label };
  }
  const flat = value.replace(/[\s\p{P}]/gu, "");
  if (!flat) return null;
  const scores = [];
  for (const option of req.options) {
    const terms = [option.label, ...(Array.isArray(option.aliases) ? option.aliases : [])]
      .map((term) => String(term ?? "").replace(/[\s\p{P}]/gu, "").toLowerCase())
      .filter(Boolean);
    for (const term of terms) {
      if (!term) continue;
      if (term === flat) { scores.push({ option, score: 3 }); break; }
      if (flat.includes(term) || term.includes(flat)) { scores.push({ option, score: term.length >= flat.length ? 2 : 1 }); break; }
    }
  }
  if (scores.length === 0) return null;
  scores.sort((a, b) => b.score - a.score);
  return { key: scores[0].option.key, label: scores[0].option.label };
}


// ── 会话码：每个会话一个稳定短数字，用于「码 + 内容」精确路由 ──────────────
export const REGISTRY_FILE = join(PATHS.stateDir, "sessions.json");

function loadRegistry() {
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
    if (parsed && typeof parsed.bySession === "object") return parsed;
  } catch {}
  return { version: 1, nextCode: 1, bySession: {} };
}

function saveRegistry(registry) {
  ensureDir();
  const tmp = REGISTRY_FILE + ".tmp-" + process.pid + "-" + randomBytes(3).toString("hex");
  writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf8");
  renameSync(tmp, REGISTRY_FILE);
}

/** 会话码空间上限：1..999，用满后回收最老的一条复用。 */
export const MAX_SESSION_CODE = 999;

// 码被回收时写一条提示，由下一次指令回复带给用户（避免"码悄悄换了人"）。
const recycleNotices = [];
export function drainRecycleNotices() {
  const out = recycleNotices.slice();
  recycleNotices.length = 0;
  return out;
}

/**
 * 取会话码；没登记过的会话按递增分配（1..MAX_SESSION_CODE），并持久化。
 * 空间用满时回收 createdAt 最小的一条，返回信息由 sessionCodeWithRecycle 带出。
 * @returns {number|null}
 */
export function sessionCode(sessionId) {
  return sessionCodeWithRecycle(sessionId).code;
}

/** 同 sessionCode，但把"这条码是从谁那儿回收来的"一并返回，便于提示替换。 */
export function sessionCodeWithRecycle(sessionId) {
  const id = String(sessionId ?? "");
  if (!id) return { code: null, replaced: null };
  // 读-改-写整体加锁：不加锁时并发进程各自按旧快照算「第一个空号」，
  // 结果是同号发给多个会话、且后写者覆盖前写者（2026-11-06 实测：8 进程全拿 1..6）。
  acquireRegistryLock();
  try {
    return sessionCodeLocked(id);
  } finally {
    releaseRegistryLock();
  }
}

function sessionCodeLocked(id) {
  const registry = loadRegistry();
  const existing = registry.bySession[id];
  if (existing && Number.isInteger(existing.code)) return { code: existing.code, replaced: null };
  const used = new Map();
  for (const [sid, item] of Object.entries(registry.bySession)) {
    if (Number.isInteger(item?.code)) used.set(item.code, sid);
  }
  let code = 1;
  while (used.has(code) && code < MAX_SESSION_CODE) code += 1;
  let replaced = null;
  if (used.has(code)) {
    // 满了：回收最老的一条（createdAt 最小，缺失当 0），把它的码给新会话。
    const oldest = Object.entries(registry.bySession)
      .filter(([, item]) => Number.isInteger(item?.code))
      .sort((a, b) => Number(a[1].createdAt || 0) - Number(b[1].createdAt || 0))[0];
    if (oldest) {
      const [victimId, victimItem] = oldest;
      code = victimItem.code;
      replaced = { sessionId: victimId, code, label: String(victimItem.label || "") };
      delete registry.bySession[victimId];
      log({ op: "session-code-recycle", code, from: victimId, to: id });
      recycleNotices.push({ code, from: victimId, fromLabel: replaced.label, to: id, at: Date.now() });
    }
  }
  registry.bySession[id] = { code, createdAt: Date.now(), label: String(existing?.label || "") };
  registry.nextCode = Math.max(Number(registry.nextCode) || 1, code + 1);
  saveRegistry(registry);
  log({ op: "session-code", sessionId: id, code, replaced: replaced ? replaced.sessionId : undefined });
  return { code, replaced };
}

/** 反查：会话码 -> sessionId。 */
export function sessionByCode(code) {
  const wanted = Number(String(code ?? "").replace(/[^0-9]/g, ""));
  if (!Number.isInteger(wanted)) return null;
  const registry = loadRegistry();
  for (const [sessionId, item] of Object.entries(registry.bySession)) {
    if (item && item.code === wanted) return { sessionId, code: wanted };
  }
  return null;
}

/** 给推送正文统一加「会话码」抬头，保证每条消息都能被用户带回。 */
export function codeLine(sessionId) {
  const code = sessionCode(sessionId);
  return code === null ? "" : "会话码 " + code + " · 回复请用「" + code + " 内容」";
}

/**
 * 「码 + 内容」解析：微信里以会话码开头的消息优先按会话码路由。
 * @returns {{kind:"answer",sessionId,option,request}
 *          |{kind:"relay",sessionId,text}
 *          |{kind:"status",sessionId}
 *          |{kind:"unknown-code",code}
 *          |{kind:"no-code"}}
 */
export function resolveByCode(rawText, pending = listPending()) {
  const text = normalizeReply(rawText);
  const matched = text.match(/^([0-9]{1,3})(?:\s+([\s\S]*))?$/);
  if (!matched) return { kind: "no-code" };
  // 粘连写法**不猜**（2026-10-29 用户口径：提示未识别即可）。
  // 纯数字、无空格、且能拆成「识别码+选项」时，会和 2 位会话码互抢
  // （"11" = 识别码 1 + 选项 1，也 = 会话码 11）。这里两边都不选，
  // 交给网关回「未识别 + 正确写法」，把选择权交回用户。
  if (!matched[2] && matched[1].length >= 2) {
    const possible = matchConcatenatedAnswer(pending, matched[1]);
    if (possible) return { kind: "unrecognized-concat", code: matched[1], request: possible.request };
  }
  const hit = sessionByCode(matched[1]);
  if (!hit) return { kind: "unknown-code", code: matched[1] };
  const rest = (matched[2] ?? "").trim();
  const sessionPending = pending.filter((req) => req.sessionId === hit.sessionId);
  if (rest === "") return { kind: "status", sessionId: hit.sessionId };
  const asOption = pickOptionFromPending(sessionPending, rest);
  if (asOption) return { kind: "answer", sessionId: hit.sessionId, option: asOption.option, request: asOption.request };
  if (sessionPending.length > 0 && /^[0-9]{1,2}(\s+[0-9]{1,2})?$/.test(rest)) {
    return { kind: "answer-ambiguous", sessionId: hit.sessionId, candidates: sessionPending };
  }
  return { kind: "relay", sessionId: hit.sessionId, text: rest };
}

/**
 * 「识别码 + 选项」粘连**探测**（如识别码 1 + 选项 1 写成 "11"）。
 * 只用于判断「这串数字是否像粘连写法」；命中后由网关回「未识别」，不当作答复。
 * 识别码按长度倒序尝试，避免 1 + 1 与 11 + 空 争抢同一串数字。
 */
export function matchConcatenatedAnswer(pending, digits) {
  const list = (pending || []).filter((req) => req && req.status === "pending");
  const handles = [...new Set(list.map((req) => handleText(req)).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const handle of handles) {
    if (!digits.startsWith(handle)) continue;
    const rest = digits.slice(handle.length);
    if (!rest) continue;
    const request = list.find((req) => handleText(req) === handle);
    const option = pickOption(request, rest);
    if (option) return { request, option };
  }
  return null;
}

/** 在该会话的待确认里找选项：先按唯一请求，再按码+选项。 */
export function pickOptionFromPending(sessionPending, rest) {
  if (sessionPending.length === 0) return null;
  if (sessionPending.length === 1) {
    const option = pickOption(sessionPending[0], rest);
    return option ? { request: sessionPending[0], option } : null;
  }
  const two = String(rest).match(/^([0-9]{1,2})\s*([0-9]{1,2})$/);
  if (two) {
    const target = sessionPending.find((req) => handleText(req) === two[1]);
    if (target) {
      const option = pickOption(target, two[2]);
      if (option) return { request: target, option };
    }
  }
  return null;
}

/** 会话状态一句话（微信回「码」时用）。 */
export function formatSessionStatus(sessionId) {
  const code = sessionCode(sessionId);
  const pending = listPending().filter((req) => req.sessionId === sessionId);
  const lines = ["会话码 " + code + " · " + String(sessionId).replace(/^session-/, "").slice(0, 8)];
  if (pending.length === 0) {
    lines.push("当前没有待确认。直接发「" + code + " 你的指令」即可驱动该会话。");
    return lines.join("\n");
  }
  for (const req of pending) {
    lines.push("");
    lines.push("待确认 " + handleText(req) + "：" + String(req.question).slice(0, 60));
    for (const option of req.options) lines.push("　" + option.key + ") " + option.label);
  }
  lines.push("");
  lines.push("回复：" + code + " <选项号>，例：" + code + " " + (pending[0].options[0]?.key ?? "1"));
  return lines.join("\n");
}


// ── 会话清单 v2：带工作区、可自定义名称、明确回复格式 ──────────────────────
/** 目录名 -> 工作区提示（DSH 把路径编码成 --D-nutstore-1.logseq-- 这种形式，不能完全还原分隔符）。 */
export function workspaceHint(dirName) {
  const inner = String(dirName ?? "").replace(/^--/, "").replace(/--$/, "");
  return inner.replace(/-/g, "\\").replace(/^([A-Za-z])\\/, "$1:\\");
}

/** 给会话起个名字（存在注册表里，清单与推送都用它显示）。 */
export function setSessionLabel(sessionId, label) {
  const id = String(sessionId ?? "");
  if (!id) return null;
  acquireRegistryLock();
  try {
    // 锁内重新取号（可重入）并重读表，避免覆盖并发分配出来的其它条目。
    const registry = loadRegistry();
    const entry = registry.bySession[id] ?? { code: sessionCode(id), createdAt: Date.now() };
    const fresh = loadRegistry();
    entry.label = String(label ?? "").slice(0, 40);
    fresh.bySession[id] = { ...(fresh.bySession[id] ?? entry), ...entry };
    saveRegistry(fresh);
    log({ op: "session-label", sessionId: id, label: entry.label });
    return entry;
  } finally {
    releaseRegistryLock();
  }
}

export function sessionLabel(sessionId) {
  const registry = loadRegistry();
  const entry = registry.bySession[String(sessionId ?? "")];
  return entry?.label ?? "";
}

const SESSION_TITLE_CACHE = new Map();

/**
 * 从 DSH 会话投影（projcache JSON）头部提取真实标题。
 * 只解析前若干字节：单份投影可达数十 MB，为列一个清单整份读入不值得。
 */
export function extractSessionTitle(text) {
  const matched = String(text ?? "").match(/"title"\s*:\s*\{[^{}]*?"val"\s*:\s*(null|"(?:[^"\\]|\\.)*")/);
  if (!matched) return "";
  if (matched[1] === "null") return "";
  try { return String(JSON.parse(matched[1])).trim(); } catch { return ""; }
}

/** 读某会话的真实标题（带进程内缓存；读不到返回空串，绝不抛错）。 */
export function readSessionTitle(sessionId) {
  const id = String(sessionId ?? "");
  if (!id) return "";
  if (SESSION_TITLE_CACHE.has(id)) return SESSION_TITLE_CACHE.get(id);
  let title = "";
  try {
    const file = join(PATHS.dshHome, "storages", "session_projcache", "sessions", id + ".json");
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(65536);
      const read = readSync(fd, buf, 0, buf.length, 0);
      title = extractSessionTitle(buf.subarray(0, read).toString("utf8"));
    } finally { closeSync(fd); }
  } catch {}
  SESSION_TITLE_CACHE.set(id, title);
  return title;
}

/** 会话显示名：人工命名 > DSH 真实标题 > 工作区+短码兜底（只在真读不到时用）。 */
export function sessionDisplayName(sessionId, workspace) {
  const labeled = sessionLabel(sessionId);
  if (labeled) return labeled;
  const titled = readSessionTitle(sessionId);
  if (titled) return titled;
  const ws = String(workspace ?? "").split(/[\\/]/).filter(Boolean).pop() || "会话";
  return ws + "·" + String(sessionId ?? "").replace(/^session-/, "").slice(0, 6);
}

/** 遍历所有工作区，列出可驱动会话（带工作区、名称、活跃时间、体积）。 */
export function listSessionsV2(limit = 10) {
  const base = join(PATHS.dshHome, "sessions");
  let dirs = [];
  try { dirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  const rows = [];
  for (const workspace of dirs) {
    let names = [];
    try { names = readdirSync(join(base, workspace), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("session-")).map((d) => d.name); } catch { continue; }
    for (const name of names) {
      try {
        const stat = statSync(join(base, workspace, name, "session.v4.jsonl.zstd"));
        rows.push({ sessionId: name, workspaceDir: workspace, workspace: workspaceHint(workspace), mtime: stat.mtimeMs, sizeKb: Math.round(stat.size / 1024) });
      } catch {}
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.slice(0, limit).map((row, index) => ({
    index: index + 1,
    ...row,
    code: sessionCode(row.sessionId),
    name: sessionDisplayName(row.sessionId, row.workspace),
  }));
}

/**
 * 会话 id 是否真实存在于磁盘上的会话记录（任意工作区）。
 * 只给「显式指定 --session」做校验用；不用于决定推送与否。
 */
export function sessionExists(sessionId) {
  const id = String(sessionId ?? "").trim();
  if (!id.startsWith("session-")) return false;
  const base = join(PATHS.dshHome, "sessions");
  let workspaces = [];
  try { workspaces = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return false; }
  for (const workspace of workspaces) {
    try {
      if (statSync(join(base, workspace, id, "session.v4.jsonl.zstd")).isFile()) return true;
    } catch {}
  }
  return false;
}

/** 会话清单（字符表格 + 明确的回复格式说明）。 */
export function formatSessionListV2(sessions) {
  const rows = sessions.map((row) => [
    String(row.code),
    String(row.name).slice(0, 22),
    String(row.workspace).slice(-28),
    new Date(row.mtime).toLocaleString("zh-CN", { hour12: false }).slice(5, 16),
  ]);
  const table = drawTable(["回复id", "会话名", "工作区", "活跃"], rows);
  return [
    "可驱动会话（回复 id 就是左列数字）",
    "",
    table,
    "",
    "回复格式：<回复id> <选项号或内容>",
    "　例：1 2　　　　 = 会话 1 选第 2 项",
    "　例：3 帮我跑测试 = 让会话 3 执行这句话",
    "　例：1　　　　　 = 看会话 1 的待确认",
    "　例：/name 1 日报 = 把会话 1 命名为「日报」",
  ].join("\n");
}

/**
 * 每个会话可分别限制三类通知长度（legacy 表）。
 * 只返回**显式配置过**的 kind：未配置的 kind 不出现在结果里，0 表示显式不限长。
 * 与 state/session-notification-controls.json 的合并口径只在 limitNotificationText 里决定。
 */
export function getSessionNotificationLimits(sessionId) {
  const id = String(sessionId ?? "");
  if (!id) return {};
  try {
    const root = JSON.parse(readFileSync(SESSION_NOTIFICATION_LIMITS_FILE, "utf8"));
    const saved = root?.sessions?.[id] ?? {};
    return Object.fromEntries(
      NOTIFICATION_LIMIT_KINDS
        .filter((kind) => Number.isSafeInteger(saved[kind]) && saved[kind] >= 0)
        .map((kind) => [kind, saved[kind]]),
    );
  } catch {
    return {};
  }
}

function normalizeNotificationMode(mode) {
  return NOTIFICATION_MODES.includes(String(mode)) ? String(mode) : DEFAULT_SESSION_NOTIFICATION_CONTROL.mode;
}

function normalizeNotificationMaxChars(value, mode = DEFAULT_SESSION_NOTIFICATION_CONTROL.mode) {
  const n = Number(value);
  if (mode === "summary") return 800;
  if (!Number.isSafeInteger(n) || n < 0 || n > 20000) return DEFAULT_SESSION_NOTIFICATION_CONTROL.maxChars;
  return n;
}

export function getSessionNotificationControl(sessionId) {
  const id = String(sessionId ?? "");
  if (!id) return { ...DEFAULT_SESSION_NOTIFICATION_CONTROL };
  try {
    const root = JSON.parse(readFileSync(SESSION_NOTIFICATION_CONTROLS_FILE, "utf8"));
    const saved = root?.sessions?.[id] ?? {};
    const mode = normalizeNotificationMode(saved.mode);
    const defaultEnabled = root?.default?.enabled !== false;
    return { enabled: saved.enabled === undefined ? defaultEnabled : saved.enabled === true, mode, maxChars: normalizeNotificationMaxChars(saved.maxChars, mode) };
  } catch { return { ...DEFAULT_SESSION_NOTIFICATION_CONTROL }; }
}

export function setSessionNotificationControl(sessionId, control = {}, options = {}) {
  const id = String(sessionId ?? "");
  if (!id) throw new Error("缺少 sessionId");
  ensureDir();
  let root = { version: 1, default: { enabled: true }, sessions: {} };
  try { root = JSON.parse(readFileSync(SESSION_NOTIFICATION_CONTROLS_FILE, "utf8")) || root; } catch {}
  root.version = 1; root.sessions = root.sessions && typeof root.sessions === "object" ? root.sessions : {};
  // 只落显式给出的字段：把继承来的默认值写死，会让「未设置」变成「显式 800」，
  // 之后再改默认口径也改不动历史会话（2026-11-09 裁决 Q1=B 时的迁移障碍）。
  const saved = root.sessions[id] && typeof root.sessions[id] === "object" ? { ...root.sessions[id] } : {};
  const mode = normalizeNotificationMode(control.mode ?? saved.mode);
  if (control.enabled !== undefined) saved.enabled = control.enabled === true;
  if (control.mode !== undefined) saved.mode = mode;
  if (control.maxChars !== undefined) saved.maxChars = normalizeNotificationMaxChars(control.maxChars, mode);
  saved.updatedAt = Date.now(); saved.updatedBy = String(options.by ?? "cli").slice(0, 60);
  root.sessions[id] = saved;
  const tmp = SESSION_NOTIFICATION_CONTROLS_FILE + ".tmp-" + process.pid + "-" + randomBytes(3).toString("hex");
  writeFileSync(tmp, JSON.stringify(root, null, 2), "utf8"); renameSync(tmp, SESSION_NOTIFICATION_CONTROLS_FILE);
  log({ op: "session-notification-control", sessionId: id, control: saved });
  return { sessionId: id, control: getSessionNotificationControl(id) };
}

export function setAllSessionNotificationEnabled(enabled, options = {}) {
  ensureDir();
  let root = { version: 1, default: { enabled: true }, sessions: {} };
  try { root = JSON.parse(readFileSync(SESSION_NOTIFICATION_CONTROLS_FILE, "utf8")) || root; } catch {}
  root.version = 1; root.default = { ...(root.default ?? {}), enabled: enabled === true, updatedAt: Date.now(), updatedBy: String(options.by ?? "cli").slice(0, 60) };
  root.sessions = root.sessions && typeof root.sessions === "object" ? root.sessions : {};
  for (const [id, saved] of Object.entries(root.sessions)) root.sessions[id] = { ...saved, enabled: enabled === true, updatedAt: Date.now(), updatedBy: root.default.updatedBy };
  const tmp = SESSION_NOTIFICATION_CONTROLS_FILE + ".tmp-" + process.pid + "-" + randomBytes(3).toString("hex");
  writeFileSync(tmp, JSON.stringify(root, null, 2), "utf8"); renameSync(tmp, SESSION_NOTIFICATION_CONTROLS_FILE);
  log({ op: "all-session-notification-control", enabled: enabled === true, by: root.default.updatedBy });
  return { enabled: enabled === true, sessions: Object.keys(root.sessions).length };
}

export function isSessionNotificationEnabled(sessionId) { return getSessionNotificationControl(sessionId).enabled; }

function validateNotificationLimit(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > 20000) throw new Error("通知长度必须是 0 到 20000 的整数（0 表示不限长）");
  return n;
}

export function setSessionNotificationLimits(sessionId, limits = {}) {
  const id = String(sessionId ?? "");
  if (!id) throw new Error("缺少 sessionId");
  ensureDir();
  let root = { version: 1, sessions: {} };
  try { root = JSON.parse(readFileSync(SESSION_NOTIFICATION_LIMITS_FILE, "utf8")) || root; } catch {}
  root.version = 1;
  root.sessions = root.sessions && typeof root.sessions === "object" ? root.sessions : {};
  const previous = getSessionNotificationLimits(id);
  const next = { ...previous };
  for (const kind of NOTIFICATION_LIMIT_KINDS) if (limits[kind] !== undefined) next[kind] = validateNotificationLimit(limits[kind]);
  next.updatedAt = Date.now();
  root.sessions[id] = next;
  const tmp = SESSION_NOTIFICATION_LIMITS_FILE + ".tmp-" + process.pid + "-" + randomBytes(3).toString("hex");
  writeFileSync(tmp, JSON.stringify(root, null, 2), "utf8");
  renameSync(tmp, SESSION_NOTIFICATION_LIMITS_FILE);
  log({ op: "session-notification-limits", sessionId: id, limits: next });
  return { sessionId: id, limits: getSessionNotificationLimits(id) };
}

export function clearSessionNotificationLimits(sessionId) {
  const id = String(sessionId ?? "");
  if (!id) return false;
  let root = null;
  try { root = JSON.parse(readFileSync(SESSION_NOTIFICATION_LIMITS_FILE, "utf8")); } catch { return false; }
  if (!root?.sessions?.[id]) return false;
  delete root.sessions[id];
  const tmp = SESSION_NOTIFICATION_LIMITS_FILE + ".tmp-" + process.pid + "-" + randomBytes(3).toString("hex");
  writeFileSync(tmp, JSON.stringify(root, null, 2), "utf8");
  renameSync(tmp, SESSION_NOTIFICATION_LIMITS_FILE);
  log({ op: "session-notification-limits-clear", sessionId: id });
  return true;
}

function hardLimitNotificationText(text, max) {
  const suffix = "\n…通知内容已按会话长度限制截断…";
  const chars = Array.from(String(text ?? ""));
  const room = Math.max(1, max - Array.from(suffix).length);
  const head = Math.ceil(room * 0.72);
  const tail = Math.max(0, room - head);
  return chars.slice(0, head).join("") + suffix + (tail ? chars.slice(-tail).join("") : "");
}

function compactNotificationText(text, kind, max) {
  const raw = toWechatText(String(text ?? ""));
  if (kind === "result") {
    // 回合结束摘要已经是结构化的多级列表：先按「其他 → 进度 → 缩短条目」的顺序瘦身，
    // 保住 recap、标题和「待定/已做」，避免退回平铺压缩把结构抹掉。
    const structured = compactTurnEnd(raw, max);
    if (structured) return structured;
    const digest = distillForChannel(raw, { channel: currentChannel(), maxChars: Math.max(600, max * 2), maxItems: 6 });
    if (digest.length > 0) return digest.join("\n");
  }
  if (kind === "approval" || kind === "decision") {
    return raw.split(/\r?\n/).map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("背景：")) return trimmed.slice(0, 100) + (trimmed.length > 100 ? "…" : "");
      if (trimmed.length > 180 && !/^【|^回复格式|^有效期|^[0-9１２３４５６７８９]+[.)）]/.test(trimmed)) return trimmed.slice(0, 179) + "…";
      return line;
    }).filter((line) => !/同一操作会重复申请/.test(line)).join("\n");
  }
  return raw;
}

/** 回合结束摘要超长时的结构化瘦身；不是回合结束消息返回 null。 */
function compactTurnEnd(raw, max) {
  if (!/【回合结束】/.test(raw)) return null;
  const lines = String(raw).split(/\r?\n/).map((line) => line.trim());
  const recap = lines.find((line) => /^(?:待定|阻塞|答|无变更)[：:。]/.test(line)) ?? "";
  const title = lines.find((line) => /^【回合结束】/.test(line)) ?? "";
  const hint = lines.filter((line) => /^(?:回[「\s]|本条是摘要)/.test(line));
  const taskAt = lines.indexOf("一、任务");
  const resultAt = lines.indexOf("二、结果");
  const task = taskAt >= 0 ? (lines[taskAt + 1] ?? "") : "";
  const bullets = resultAt >= 0 ? lines.slice(resultAt + 1).filter((line) => /^　?・/.test(line)) : [];
  const take = (label) => bullets.filter((line) => new RegExp("^　?・" + label + "：").test(line));
  const blocked = take("阻塞");
  const decide = take("待定");
  const done = take("已做");
  const progress = take("进度");
  const other = bullets.filter((line) => !/^　?・(?:阻塞|待定|已做|进度)：/.test(line));
  const shorten = (line) => (line.length > 60 ? cutAtBoundary(line, 60) : line);
  const size = (text) => Array.from(text).length;
  // 从信息最少的条目开始丢：其他 → 进度 → 已做 → 只留阻塞/第一条待定；最后连任务与尾巴也去掉。
  const combos = [
    { task, items: [...blocked, ...decide, ...done, ...progress, ...other], hint },
    { task, items: [...blocked, ...decide, ...done, ...progress], hint },
    { task, items: [...blocked, ...decide, ...done], hint },
    { task, items: [...blocked, ...decide], hint },
    { task: "", items: [...blocked, ...decide], hint },
    { task: "", items: [...blocked, ...decide].slice(0, 1), hint: [] },
  ];
  for (const combo of combos) {
    const out = [recap, "────────────", title];
    if (combo.task) out.push("一、任务", combo.task);
    if (combo.items.length) out.push(combo.task ? "二、结果" : "", ...combo.items.map(shorten));
    if (combo.hint.length) out.push("", ...combo.hint);
    const text = out.filter((line) => line !== "").join("\n");
    if (size(text) <= max) return text;
  }
  return null;
}


/**
 * 合并 legacy limits 表与新 controls 表的唯一口径（2026-11-09 用户裁决 Q1=B / Q2=A）：
 *  - Q2=A：legacy 显式值优先，包括显式 0（=不限长）；未配置的 kind 不出现在 legacy 表里。
 *  - legacy 未配置该 kind 时，才用 controls 的 maxChars。
 *  - Q1=B：controls 未登记时默认 long/0（不限长）；显式 summary 恒为 800。
 */
export function limitNotificationText(text, sessionId, kind) {
  const raw = String(text ?? "");
  const legacy = getSessionNotificationLimits(sessionId)[kind];
  const max = legacy !== undefined ? legacy : getSessionNotificationControl(sessionId).maxChars;
  if (!max || Array.from(raw).length <= max) return raw;
  const compact = compactNotificationText(raw, kind, max);
  if (Array.from(compact).length <= max) return compact;
  return hardLimitNotificationText(compact, max);
}

/**
 * 一句话 recap 的候选句。
 *
 * 2026-11-08 用户反馈「答：会话 1a2b3c4d。」完全不是 one-line-recap 风格：
 * 旧实现按行取第一条非结构性文字，而 `formatTurnEnd` 的正文第二行恰好是「会话 <sid>」，
 * 于是 recap 抓到的永远是会话号。现在：
 *   1) 跳过抬头、分隔线、会话号、回码提示、任务/结果标签等结构性行；
 *   2) 按句切分，只留真正的结论/动作句；
 *   3) 交给 caveman 压缩（去填充词与完成度宣告，见 cavemanRecapBody）。
 */
function recapSentences(text) {
  const SKIP = /^(?:【[^】]*】|[─—\-=_·.。\s]+|回复格式|有效期|背景：|会话码|识别码|R[0-9a-f-]+|会话\s+[0-9a-f]{6,8}|任务[：:]|结果[：:]|回[「\s]|本条是摘要)/;
  return toWechatText(String(text ?? ""))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !SKIP.test(line) && !/^（.*）$/.test(line))
    .flatMap((line) => line.split(/(?<=[。！？；])/))
    .map((sentence) => sentence.trim().replace(/^(?:【[^】]*】|■|・|#{1,6}\s*|[-*+]\s*|\d+[.)、]\s*)+/, "").trim())
    .filter((sentence) => sentence.length >= 4 && /[\u4e00-\u9fa5]/.test(sentence));
}

const RECAP_DECISION = /需要.{0,6}(确认|决策|裁定|拍板)|待定|待裁定|请确认|建议先|是否|要不要|你定/;
const RECAP_BLOCKED = /阻塞|失败|未能|无法|未闭环|错误/;
const RECAP_ACTION = /已|写|改|生成|给|定|补齐|修复|完成|落盘|验证|通过|提交|输出|建|加|删|移|跑|测|查|读|开|合|推/;

/**
 * caveman 压缩：只留结论与动作，去掉填充词与完成度宣告（对齐 one-line-recap 口径）。
 * 例：「已完成：发布清单与风险分级」→「发布清单与风险分级」。
 */
function cavemanRecapBody(input, maxChars = 24) {
  let s = String(input ?? "");
  s = s
    .replace(/^(?:[#>*・■]|\d+[.)、])\s*/, "")
    .replace(/^(?:任务|结果|进度|结论|说明|背景|摘要)[：:]\s*/, "")
    .replace(/^[（(][^）)]{0,20}[）)]\s*/, "")
    .replace(/^(?:已完成|已全部完成|均已|全部完成|完成)[：:]?\s*/, "")
    .replace(/^已经/, "")
    .replace(/(?:已经|已全部|本轮|这次|基本上|大致|主要|相关的?|一些|进行|做了)/g, "")
    .replace(/\s+/g, " ")
    .replace(/[，、；：:]+$/, "")
    .replace(/[。！？；]+$/, "")
    .trim();
  s = s.replace(/^[，、；：:\s]+/, "");
  if (Array.from(s).length > maxChars) s = cutAtBoundary(s, maxChars);
  return s;
}

function oneLineRecap(text, kind = "result") {
  const sentences = recapSentences(text);
  const pick = (pattern) => sentences.find((sentence) => pattern.test(sentence));
  const decision = pick(RECAP_DECISION);
  const blocked = decision ? null : pick(RECAP_BLOCKED);
  // 结果轮没有显式决策/阻塞时，取「动作信息最多」的一句，而不是第一句（第一句常是标题或问候）。
  const source = decision ?? blocked ?? sentences
    .map((sentence, index) => ({ sentence, index, score: (RECAP_ACTION.test(sentence) ? 2 : 0) + Math.min(sentence.length, 80) / 80 }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.sentence ?? "";
  const isDecisionKind = kind === "approval" || kind === "decision";
  const label = decision || isDecisionKind ? "待定：" : (blocked ? "阻塞：" : "答：");
  let body = cavemanRecapBody(source);
  if (!body) return "无变更。";
  // 原句若自带「阻塞：/待定：」标签，先剥掉，避免 recap 出现两个标签（阻塞：阻塞：…）。
  body = body.replace(/^(?:待定|阻塞|答|无变更)[：:]\s*/, "");
  // 「待定」句只保留要人拍板的那半句：
  //   「发布清单是否对外公开：涉及…边界」→「发布清单是否对外公开」
  //   「危险操作需要批准：删除临时文件」→「删除临时文件」
  if (label === "待定：") {
    const parts = body.split(/[：:]/);
    if (parts.length > 1) {
      const head = parts[0].trim();
      const tail = parts.slice(1).join("：").trim();
      if (/需要(?:批准|确认|回答)|请确认|批准/.test(head)) body = tail || head;
      else if (/是否|要不要|你定|待定|待裁定/.test(head)) body = head;
    }
  }
  // 「答」句里若带「设计查询入口：人工查询文件」这种小标题冒号，换成逗号避免 recap 里两个冒号。
  body = body.replace(/：/g, "，").replace(/[，、；]+$/, "");
  let result = label + body + (body.endsWith("…") ? "" : "。");
  const chars = Array.from(result);
  if (chars.length > 30) result = chars.slice(0, 29).join("").replace(/[，、；：]$/, "") + "。";
  return result;
}

export function applyOneLineRecap(text, sessionId, kind = "result", recap = "") {
  const raw = String(text ?? "");
  const firstLine = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  // 消息本身已带 recap（formatTurnEnd 的第一行）：不重复加，只做长度限制，
  // 也让 applyOneLineRecap 对同一段文本幂等。
  if (/^(?:待定|阻塞|答|无变更)[：:。]/.test(firstLine)) return limitNotificationText(raw, sessionId, kind);
  // 审批/提问可以由调用方给一句准确的摘要（如「提升权限 → 完全访问」）；
  // 没给才退回从正文猜，猜出来的常是「会话 af71bbe5」这类元数据，等于没摘要。
  const explicit = String(recap ?? "").replace(/\s+/g, " ").trim();
  if (explicit) {
    const label = (kind === "approval" || kind === "decision") ? "待定：" : "答：";
    const line = label + explicit.replace(/[。！？；：:]+$/, "").trim() + "。";
    return limitNotificationText(line + "\n────────────\n" + raw, sessionId, kind);
  }
  const auto = oneLineRecap(raw, kind);
  return limitNotificationText(auto + "\n────────────\n" + raw, sessionId, kind);
}

function inferNotificationKind(text) {
  const value = String(text ?? "");
  if (/^【需要批准】|^【提升权限】|批准请求已过期/.test(value)) return "approval";
  if (/^【需要回答】|^【需要确认】/.test(value)) return "decision";
  return "result";
}

/** 每条推送末尾统一的「怎么回」提示。 */
export function replyHint(sessionId, options) {
  const code = sessionCode(sessionId);
  const firstKey = options?.[0]?.key ?? "1";
  const lines = [];
  lines.push("回复格式：<回复id> <内容>（本会话回复id " + code + "）");
  if (options && options.length > 0) {
    lines.push("　" + code + " " + firstKey + " = 选「" + (options[0].label ?? firstKey) + "」");
  }
  lines.push("　" + code + " " + "你的话 = 直接驱动该会话");
  return lines.join("\n");
}

// ── 微信文案 ──────────────────────────────────────────────────────────────
/**
 * 微信推送文案（纯文本，不用 Markdown）。
 *
 * 规则（用户明确要求）：
 *   1) 不用 **加粗**、# 标题、> 引用、`行内代码`、表格竖线语法等 Markdown；
 *   2) 层级用缩进 + 全角/中文序号（①②/1)）表达，多层列表；
 *   3) 只有"天然是表格"的内容（会话清单等）才用字符绘制表格（┌┬┐├┼┤└┴┘）；
 *   4) 直接输出纯文本，不带代码块围栏。
 */
export function formatAsk(req) {
  const pending = listPending();
  const multi = pending.length > 1;
  const code = handleText(req);
  // 提升权限是审批的一个特殊子类：标题已经说明性质，首行不再写泛化的「需要批准」。
  const head = req.mode === "approval"
    ? (req.title === "提升权限" ? "提升权限" : "需要批准")
    : (req.kind === "question" ? "需要回答" : "需要确认");
  const minutes = Math.max(1, Math.round((req.expiresAt - req.createdAt) / 60000));
  const lines = [];
  // 请求短号进首行：同一条命令被重复申请时，正文几乎一样，只有编号能区分
  // （2026-10-29 用户把「新请求」误认成「重复发送」就是缺这个）。
  lines.push("【" + head + "】会话码 " + sessionCode(req.sessionId) + " · 识别码 " + code + " · R" + String(req.id).slice(-6));
  lines.push("──────────────");
  const meta = [];
  // head 已经用了「提升权限」时不再重复打印同名 title，省下的行留给原因。
  if (req.title && req.title !== head) meta.push(req.title);
  if (req.sessionId) meta.push("会话 " + String(req.sessionId).replace(/^session-/, "").slice(0, 8));
  if (meta.length) lines.push(meta.join("　·　"));
  if (req.context) lines.push("背景：" + req.context);
  lines.push("");
  lines.push(req.question);
  lines.push("");
  for (const option of req.options) lines.push("　" + option.key + ") " + option.label);
  lines.push("");
  const firstKey = req.options[0]?.key ?? "1";
  if (multi) {
  lines.push(replyHint(req.sessionId, req.options));
  } else {
    lines.push(replyHint(req.sessionId, req.options));
  }
  lines.push("有效期 " + minutes + " 分钟　·　申请于 " + new Date(req.createdAt).toLocaleTimeString("zh-CN", { hour12: false }));
  lines.push("（同一操作会重复申请；R 编号不同即为新请求，不是重复发送）");
  return limitNotificationText(lines.join("\n"), req.sessionId, req.mode === "approval" ? "approval" : "decision");
}

/** 用户答复后的确认回执（纯文本，一句话）。 */
export function formatResolved(req) {
  const label = req.answer?.label || req.answer?.raw || "已答复";
  return "已收到（识别码 " + handleText(req) + "）：" + label;
}

/** 只回了识别码：告诉他码对应哪一问、怎么补全。 */
export function formatNeedOption(req) {
  const code = handleText(req);
  const examples = req.options.map((option) => code + " " + option.key).join(" / ");
  const lines = [];
  // 2026-11-01：用户反馈「现在的交互没有码了」。这里把三个号都写出来：
  // 会话码（属于哪个会话）、识别码（哪一问）、R 编号（同一问题的第几次申请）。
  lines.push("会话码 " + sessionCode(req.sessionId) + " · 识别码 " + code + " · R" + String(req.id).slice(-6) + " 对应：");
  lines.push("　" + String(req.question).slice(0, 60));
  lines.push("");
  lines.push("请回「识别码 空格 选项」：" + examples);
  return lines.join("\n");
}

/** 多个待确认且用户回复有歧义时的提示（多层列表）。 */
export function formatAmbiguous(candidates) {
  const lines = [];
  // 2026-10-29：提示里必须带空格。以前写「例：11」教用户粘连，正好撞上 2 位会话码。
  // 2026-11-01：用户反馈「现在的交互没有码了」——旧文案只印裸数字「1」，看起来不像编号。
  // 现在每条都写全「会话码 / 识别码 / R 编号」，与正式推送的首行格式一致。
  lines.push("有 " + candidates.length + " 个待确认，请用「识别码 空格 选项」回复");
  lines.push("");
  for (const req of candidates.slice(0, 5)) {
    const code = handleText(req);
    lines.push("　会话码 " + sessionCode(req.sessionId) + " · 识别码 " + code + " · R" + String(req.id).slice(-6));
    lines.push("　　" + String(req.question).slice(0, 24));
    lines.push("　　选项：" + req.options.map((option) => code + " " + option.key + "=" + option.label).join("　"));
  }
  lines.push("");
  lines.push("例：" + handleText(candidates[0]) + " " + (candidates[0].options[0]?.key ?? "1") + "（中间要有空格）");
  lines.push("推送开关：发「推送开」「推送关」「推送状态」");
  return lines.join("\n");
}

/**
 * 回合结束摘要（纯文本 + 键值块；耗时/任务/结果按层级缩进）。
 * 保持短小，避免在微信里刷屏。
 */
const WECHAT_WIDTH = 34; // 约 17 个汉字：手机气泡安全宽度（CJK 记 2，其它记 1）

/** 按「显示宽度」折行：微信不做等宽排版，长行会被硬折并从字中间断开。 */
export function wrapCjk(text, width = WECHAT_WIDTH) {
  const src = String(text ?? "");
  const out = [];
  let line = "";
  let w = 0;
  const weight = (ch) => (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1);
  // 断行点优先级：标点/空格 > 字符边界，避免「已 / 定位未修」这种断在词中间
  // 不用半角空格做断点：中文正文里的半角空格多是「srs处理 5 条」这种局部，断在那里最丑
  const BREAKS = "\u3000，。、；：！？）」』】,.;:!?)]}";
  for (const ch of src) {
    const cw = weight(ch);
    if (w + cw > width && line.length > 0) {
      const chars = [...line];
      const widths = chars.map((c) => weight(c));
      // 取「行内最靠前」的合法断点，让每行尽量填满；
      // 若取最近的断点，会把「　待裁定」这种三字尾巴甩到下一行（2026-10-27 实测）。
      const lineWidth = widths.reduce((n, v) => n + v, 0);
      let acc = 0;
      let cut = -1;
      for (let i = chars.length - 1; i >= 0; i -= 1) {
        acc += widths[i];
        if (acc > width) break;
        if (!BREAKS.includes(chars[i])) continue;
        // 英文 token 内部的 . , : ; 不算断点：restart-feishu-daemon.ps1 / v1.2 / a,b 不能被切开
        if (/[.,:;]/.test(chars[i]) && /[A-Za-z0-9]/.test(chars[i - 1] ?? "") && /[A-Za-z0-9]/.test(chars[i + 1] ?? "")) continue;
        const prefixWidth = lineWidth - acc + widths[i];
        if (prefixWidth < width * 0.35) break; // 前半段太短就没有意义，宁可硬断
        cut = i;
      }
      if (cut >= 0 && cut < chars.length - 1) {
        out.push(chars.slice(0, cut + 1).join(""));
        line = chars.slice(cut + 1).join("") + ch;
        w = [...line].reduce((n, c) => n + weight(c), 0);
      } else {
        // 不要在 ASCII 词（路径/变量名/命令）中间硬断：退到该词起点，让整词换到下一行
        const chars = [...line];
        let tokenStart = chars.length;
        while (tokenStart > 0 && /[A-Za-z0-9_.\-\/\\]/.test(chars[tokenStart - 1])) tokenStart -= 1;
        const tokenFits = chars.length - tokenStart <= Math.floor(width * 0.6);
        if (tokenStart > 0 && tokenStart < chars.length && tokenFits) {
          out.push(chars.slice(0, tokenStart).join(""));
          line = chars.slice(tokenStart).join("") + ch;
          w = [...line].reduce((n, c) => n + weight(c), 0);
        } else {
          out.push(line);
          line = ch;
          w = cw;
        }
      }
    } else { line += ch; w += cw; }
  }
  if (line.length > 0) out.push(line);
  // 标点避头（CJK 排版规则）：行首不能是收尾标点，否则会出现「…技术标识符」/「，旧规则…」这种断法。
  // 溢出最多 1 个字符宽度，比换行后以标点开头好看得多（2026-11-06 实测）。
  const NO_HEAD = "，。、；：！？）」』】〕》’”…,.;:!?)]}";
  for (let i = 1; i < out.length; i += 1) {
    while (out[i].length > 0 && NO_HEAD.includes(out[i][0])) {
      out[i - 1] += out[i][0];
      out[i] = out[i].slice(1);
    }
  }
  return out.filter((item) => item.length > 0);
}

/** 按「　」分段打包成若干行：段间保留分隔符，尽量把一行填满。 */
export function packSegments(text, width = WECHAT_WIDTH) {
  const widthOf = (s) => [...s].reduce((n, ch) => n + (/[\u2E80-\uFFE6]/.test(ch) ? 2 : 1), 0);
  const segs = String(text ?? "").split("\u3000").filter((seg) => seg.length > 0);
  const rows = [];
  for (const seg of segs) {
    if (widthOf(seg) > width) {
      for (const line of wrapCjk(seg, width)) rows.push([line]);
      continue;
    }
    const last = rows[rows.length - 1];
    const merged = last ? last.join("\u3000") + "\u3000" + seg : seg;
    if (last && widthOf(merged) <= width) last.push(seg);
    else rows.push([seg]);
  }
  // 末行过短就从前一行挪一段下来，避免「　待裁定」这种三字孤行
  for (let i = rows.length - 2; i >= 0; i -= 1) {
    const tail = rows[i + 1].join("\u3000");
    if (widthOf(tail) >= width * 0.4) break;
    if (rows[i].length <= 1) break;
    const moved = [rows[i][rows[i].length - 1], ...rows[i + 1]];
    if (widthOf(moved.join("\u3000")) > width) break;
    rows[i].pop();
    rows[i + 1] = moved;
  }
  const out = rows.map((row) => row.join("\u3000")).filter((line) => line.length > 0);
  return out.length > 0 ? out : [""];
}



/**
 * 去掉微信不该看见的技术细节：编号、数量、路径、URL、代码片段。
 * 用户明确要求：微信侧只留「已处理 / 当前进度 / 需决策」，不要数字与技术细节。
 */
export function stripWechatNoise(input, options = {}) {
  let t = String(input ?? "");
  // 2026-11-06：飞书侧的读者是操作者本人，env 变量名/路径/标识符是**信息**不是噪音。
  // 之前一律删掉，导致「设的是 ，而 只认 ，」这种把句子掏空的推送。
  const keepTechnical = options.keepTechnical === true;
  if (!keepTechnical) {
    t = t.replace(/https?:\/\/\S+/g, "");
    t = t.replace(/[A-Za-z]:\\[^\s，。；、)]+/g, "");
    t = t.replace(/\b[A-Z]{2,}-\d+\b/g, "");
  }
  t = t.replace(/`([^`]*)`/g, "$1");
  t = t.replace(/[（(]\s*[^（()）]{0,40}(?:\d+\s*(?:条|项|个|张|行|字|%))[^（()）]{0,40}[）)]/g, "");
  if (!keepTechnical) {
    t = t.replace(/\d+\s*(?=条|项|个|张|行|字)/g, "若干");
    t = t.replace(/\d+(?:\.\d+)?%/g, "");
    // 代码标识符 / 英文技术词对微信读者无意义
    t = t.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gi, "");
    // 只删「标识符形态」的英文（camelCase / 长 hex）；普通产品名（superagent、feishu）要留着，
    // 否则句子会被掏空成「把 从 切给 HITL」这种看不懂的话。
    t = t.replace(/\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g, "");
    t = t.replace(/\b[0-9a-f]{10,}\b/gi, "");
  }
  t = t.replace(/\s{2,}/g, " ").replace(/[ \t]+$/gm, "");
  return t.trim();
}

/**
 * 三段式压缩：已处理 / 进度 / 需决策。
 * 按用户要求「剔除数字与技术细节，简述已处理、当前进度、需决策」。
 */
export function distillForWechat(input, options = {}) {
  const lineWidth = options.lineWidth ?? WECHAT_WIDTH - 2;
  const clean = stripWechatNoise(toWechatText(String(input ?? ""), 1500));
  const rawLines = clean.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  // 把「标题行」与紧随的正文合并，避免只摘到 "已完成" 这种空标题
  const merged = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i].replace(/^[・■\-\s]+/, "");
    const isHeading = line.length <= 12 && !/[。！？]/.test(line);
    if (isHeading && rawLines[i + 1]) {
      merged.push(line + "：" + rawLines[i + 1].replace(/^[・■\-\s]+/, ""));
      i += 1;
    } else merged.push(line);
  }
  const sentences = merged
    .flatMap((line) => line.split(/(?<=[。！？；])/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 80)
    // 纯枚举（一堆顿号/编号）对微信读者没有价值
    .filter((s) => (s.match(/、/g) ?? []).length < 3)
    // 清洗后剩下空壳（如只剩「保守处理：」）的句子没有价值
    .filter((s) => /[一-龥]{6,}/.test(s) && !/[：:]s*$/.test(s));
  const buckets = {
    已处理: /已完成|已处理|已经完成|已落地|已注入|已通过|全部通过|写入|落地|定稿/,
    需决策: /需要.{0,6}(确认|决策|裁定|拍板)|待裁定|请确认|建议先|阻塞|风险|等待.{0,4}(答复|确认)/,
    进度: /进度|当前|目前|剩余|待补|进行中|下一步|继续|仍/,
  };
  const picked = [];
  const used = new Set();
  for (const [label, pattern] of Object.entries(buckets)) {
    const hit = sentences
      .filter((s) => !used.has(s) && pattern.test(s))
      .sort((a, b) => a.length - b.length)[0];
    if (!hit) continue;
    used.add(hit);
    picked.push({ label, text: hit });
  }
  if (picked.length === 0) {
    for (const s of sentences.slice(0, 2)) picked.push({ label: "", text: s });
  }
  return picked.flatMap((item) => {
    // 单条压到 40 字以内：微信侧是通知，不是报告
    let body0 = item.label ? item.text.replace(new RegExp("^" + item.label + "[：:]\s*"), "") : item.text;
    const brief = body0.length > 40 ? body0.slice(0, 40).replace(/[，、；：]+$/, "") + "…" : body0;
    const body = item.label ? "・" + item.label + "：" + brief : "・" + brief;
    return wrapCjk(body, lineWidth);
  });
}

/**
 * 回合结束摘要。
 *
 * 版式依据微信实际渲染（2026-10-27 用户反馈「换行不友好」后重写）：
 *   1) 只用单个 \n 分行；空行只留 1 处（微信会把连续空行压掉）；
 *   2) **不用行首空格/全角空格做缩进**——各客户端 trim 不一致，且手机气泡仅 ~17 汉字宽；
 *   3) 层级用前缀符号表达：・并列、：键值；不用 Markdown；
 *   4) 每行按显示宽度折到 17 汉字，避免微信硬折行；
 *   5) 分隔线固定 12 个 ─，超出气泡宽度会自己被折断。
 */
/**
 * 面向单个通道的压缩：决策项优先、说人话、短句。
 *
 * 风格约定（用户 2026-11-05 要求）：caveman 风格但说人话——只留结论和动作，
 * 不解释过程、不堆术语；「要你定」永远排最前面，一眼能扫到。
 */
/**
 * 按「句/分句/词」边界截断，绝不切在半句或半词上（2026-11-06 用户反馈「截断太多」）。
 * 优先 。！？； → ，、 → 空格 → 硬断；只补一个省略号，具体全文让用户回码看。
 */
export function cutAtBoundary(text, maxChars) {
  const src = String(text ?? "");
  const limit = Number(maxChars);
  if (!Number.isFinite(limit) || limit <= 0 || src.length <= limit) return src;
  const head = src.slice(0, limit);
  const tail = src.slice(limit);
  for (const marks of ["。！？；", "，、", " "]) {
    const at = Math.max(...[...marks].map((mark) => head.lastIndexOf(mark)));
    if (at >= Math.floor(limit * 0.5)) return head.slice(0, at + 1).replace(/[，、；：]+$/, "") + "…";
  }
  // 英文/路径类 token 不要切一半：退到最近的空白
  const spaceAt = head.search(/[A-Za-z0-9_.\-\/]+$/);
  if (spaceAt > Math.floor(limit * 0.5)) return head.slice(0, spaceAt) + "…";
  return head + "…";
}

export function distillForChannel(input, options = {}) {
  const channel = options.channel ?? currentChannel();
  const width = options.lineWidth ?? WECHAT_WIDTH - 2;
  const maxChars = options.maxChars ?? (channel === "feishu" ? 4000 : 1500);
  const perItem = options.perItem ?? (channel === "feishu" ? 120 : 40);
  const maxItems = options.maxItems ?? (channel === "feishu" ? 10 : 4);
  const clean = stripWechatNoise(toWechatText(String(input ?? ""), maxChars), { keepTechnical: channel === "feishu" });
  const sentences = clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => line.split(/(?<=[。！？；])/))
    .map((s) => s.trim().replace(/^(?:【[^】]{1,10}】|#{1,6}\s*|[・■\-\s]+)+/, ""))
    // 以前这里用 <=160 把「长句」整条丢掉，等于把信息最多的那句删了（用户只看到碎片）。
    // 现在改成保留 + 按句读边界截断，宁可短也不要整句消失。
    .filter((s) => s.length >= 6)
    .map((s) => (s.length > (channel === "feishu" ? 220 : 160) ? cutAtBoundary(s, channel === "feishu" ? 220 : 160) : s));
  const hit = (re) => sentences.filter((s) => re.test(s));
  const decisions = hit(/需要.{0,6}(确认|决策|裁定|拍板)|待裁定|请确认|建议先|阻塞|风险|等你|你定|是否|要不要/);
  const done = hit(/已完成|已处理|已写|已落地|已通过|已改|修好|完成|建好/);
  const progress = hit(/进度|当前|剩余|下一步|继续|仍|待补/);
  const used = new Set();
  const lines = [];
  const push = (label, text) => {
    if (!text || used.has(text)) return;
    used.add(text);
    const body = perItem && text.length > perItem ? cutAtBoundary(text, perItem) : text;
    lines.push(...wrapCjk("・" + label + body, width));
  };
  for (const s of decisions.slice(0, 2)) push("❗要你定：", s);
  for (const s of done.slice(0, 1)) push("已做：", s);
  for (const s of progress.slice(0, 1)) push("进度：", s);
  if (lines.length === 0) for (const s of sentences.slice(0, 2)) push("", s);
  return lines.slice(0, Math.max(2, maxItems));
}

/**
 * 飞书侧的正文保留策略（2026-11-06：用户反馈「截断比较多」）。
 *
 * 微信那套「只留 已处理/进度/需决策 三句」是为手机气泡和信息密度设计的；
 * 飞书的读者是操作者本人，看的是**结构和技术细节**，所以这里改成：
 * 保留原有分条与编号，只做「去装饰 + 按行预算截断」，不按关键词筛掉整句。
 */
export function trimForFeishu(input, options = {}) {
  const width = options.width ?? 54;
  const lineBudget = options.lineBudget ?? 22;
  const charBudget = options.charBudget ?? 1800;
  const text = toWechatText(String(input ?? ""));
  const raw = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^[─—\-=_·.。\s]+$/.test(line))          // 纯装饰线
    .filter((line) => !/^\|?\s*:?-{2,}/.test(line));             // 表格残留
  const out = [];
  let used = 0;
  for (const line of raw) {
    if (out.length >= lineBudget || used >= charBudget) break;
    const room = charBudget - used;
    const body = line.length > room ? cutAtBoundary(line, room) : line;
    const wrapped = wrapCjk(body, width);
    for (const part of wrapped) {
      if (out.length >= lineBudget) break;
      out.push(part);
      used += part.length;
    }
  }
  return out;
}

/**
 * 回合结束摘要的「尾巴提示」。
 *
 * 2026-11-06 用户指出歧义：原文是「回复 100 <内容> 可继续，细节在本会话」——
 *   1. 「本会话」在飞书里有两种读法：这条飞书聊天，还是产生推送的 DSH 会话；
 *   2. 「细节在本会话」容易被读成"细节就在这条消息里"；
 *   3. 「<内容>」是占位符写法，群里看着像要照抄尖括号。
 * 这里改成：说清"回的话送进哪条 DSH 会话"，并把"摘要/全文在哪"分开讲。
 */
export function turnEndHint(sessionId, code, options = {}) {
  const sid = String(sessionId ?? "").replace(/^session-/, "").slice(0, 8);
  const wide = options.wide === true;
  if (code === null || code === undefined) {
    return wide ? "本条是摘要，全文在 DSH 会话 " + sid : "本条是摘要，全文在 DSH 会话里";
  }
  if (wide) {
    // 一行讲清"回什么、回给谁"，第二行讲"全文在哪"；两行都短，避免再被折行拆散。
    return "回「" + code + " 你的话」继续 → DSH 会话 " + sid + "\n本条是摘要，全文在 DSH 里";
  }
  return "回 " + code + " 内容 可继续（摘要，全文在 DSH）";
}

/** 任务行：取用户消息里最能说明目的的首句，按 caveman 口径限长。 */
function terseTask(input, maxChars) {
  const raw = toWechatText(String(input ?? ""))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0] ?? "";
  const first = raw.split(/(?<=[。！？；])/)[0].trim();
  const body = cavemanRecapBody(
    first
      .replace(/^(?:任务|用户任务|需求)[：:]\s*/, "")
      .replace(/^(?:最后)?创建一个任务[，,]\s*(?:这个任务)?(?:就是|是)?\s*/, ""),
    maxChars,
  );
  return body || cutAtBoundary(raw, maxChars);
}

/**
 * 把最终回答拆成可归类的要点（多级列表的第二层）。
 *
 * 2026-11-08 用户要求「多级列表、便于人工查看、抓住关键要素」：
 * 旧版飞书侧只是把原文按行平铺（trimForFeishu），长回答读起来像一堵墙。
 * 这里按语义分成「待定 / 已做 / 进度 / 其他」四类，决策项排最前，每类下用 ・ 二级条目；
 * 同时记住最近的 Markdown 小标题（如「待确认」「下一步」），让该标题下的条目归到对的一类。
 */
function resultItems(text, options = {}) {
  const wide = options.wide === true;
  const perItem = options.perItem ?? (wide ? 120 : 40);
  const maxItems = options.maxItems ?? (wide ? 9 : 3);
  const skip = /^(?:[─—\-=_·.。\s]+|会话\s+[0-9a-f]{6,8}|回[「\s]|本条是摘要|会话\s*ID[：:]|会话码[：:]|工作区[：:]|执行分工[：:]|模型[：:]|分支[：:]|提交[：:]|地址[：:]|链接[：:]|PR[：:]|「[^」]{2,80}」$)/i;
  const rows = toWechatText(String(text ?? ""))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !skip.test(line));
  const decision = /需要.{0,6}(确认|决策|裁定|拍板)|待定|待裁定|请确认|建议先|是否|要不要|你定/;
  const blocked = /阻塞|失败|未能|无法|未闭环|错误/;
  const done = /已完成|已处理|已写|已落地|已通过|已改|修好|完成|建好|已创建|已发送|已新建|生成|输出|写入|补齐|修复|提交|落到|落盘|抽象/;
  const progress = /进度|当前|剩余|下一步|继续|仍|待补|在跑|进行中/;
  const buckets = { blocked: [], decide: [], done: [], progress: [], other: [] };
  let section = "";
  const sectionKind = () => {
    if (/风险|阻塞|问题|失败/.test(section)) return "blocked";
    if (/已确认|已定|已做|完成|结果|产出/.test(section)) return "done";
    if (/待确认|确认|待定/.test(section)) return "decide";
    if (/下一步|后续|计划|待办|剩余/.test(section)) return "progress";
    return "";
  };
  const normalize = (value) => value
    .replace(/^(?:已完成|已处理|已全部完成|均已|全部完成|完成|结论|说明|阻塞|待定|风险)[：:]?\s*/, "")
    .replace(/^已(创建|发送|新建|开|落)/, "$1")
    .trim();
  for (const line of rows) {
    const stripped = line.replace(/^(?:【[^】]*】|■|・|#{1,6}\s*|[-*+]\s*|\d+[.)、]\s*)+/, "").trim();
    if (!stripped || skip.test(stripped)) continue;
    // 只有源文本里的标题行（toWechatText 把 # 变成 ■）才当小标题；
    // 「・灰度顺序是否按部门分批」这类短条目不能被误判成标题（2026-11-08 实测漏条目）。
    const isHeadingLine = /^■/.test(line);
    if (isHeadingLine && !/[。！？；]/.test(line)) { section = stripped; continue; }
    const hint = sectionKind();
    for (const sentence of stripped.split(/(?<=[。！？；])/)) {
      const rawValue = sentence.trim();
      const wasDone = /^(?:已完成|已处理|已全部完成|均已|完成|已创建|已发送|已新建)/.test(rawValue);
      const value = normalize(rawValue);
      if (value.length < 4 || !/[\u4e00-\u9fa5]/.test(value)) continue;
      const item = cutAtBoundary(value, perItem);
      if (buckets.blocked.includes(item) || buckets.decide.includes(item) || buckets.done.includes(item) || buckets.progress.includes(item) || buckets.other.includes(item)) continue;
      if (hint === "blocked" || blocked.test(value)) buckets.blocked.push(item);
      else if (hint === "decide" || decision.test(value)) buckets.decide.push(item);
      else if (hint === "progress") buckets.progress.push(item);
      else if (wasDone || hint === "done" || done.test(value)) buckets.done.push(item);
      else if (progress.test(value)) buckets.progress.push(item);
      else buckets.other.push(item);
    }
  }
  const bullet = wide ? "　・" : "・";
  const lines = [];
  const push = (label, items, cap) => {
    for (const item of items.slice(0, cap)) {
      const body = item.replace(/：/g, "，").replace(/[，、；]+$/, "");
      lines.push(bullet + (label ? label + "：" + body : body));
    }
  };
  push("阻塞", buckets.blocked, wide ? 2 : 1);
  push("待定", buckets.decide, wide ? 3 : 2);
  push("已做", buckets.done, wide ? 4 : 2);
  push("进度", buckets.progress, wide ? 2 : 1);
  push("", buckets.other, wide ? 1 : 0);
  if (lines.length === 0) for (const line of rows.slice(0, wide ? 2 : 1)) lines.push(bullet + cutAtBoundary(line, perItem));
  return lines.slice(0, maxItems);
}

export function formatTurnEnd(input) {
  const seconds = Number.isFinite(input.durationMs) ? Math.round(input.durationMs / 1000) : null;
  const code = sessionCode(input.sessionId);
  const channel = currentChannel();
  const wide = channel === "feishu";
  const width = wide ? 56 : WECHAT_WIDTH;
  const lines = [];
  // 第一行必须是 recap：让人一眼看到结论/待定，同时它是 applyOneLineRecap 的幂等标记，
  // 出口不会再在前面重复加一条（2026-11-08 用户要求 one-line-recap + caveman 风格）。
  lines.push(oneLineRecap(input.text ?? "", "result"));
  lines.push("────────────");
  // 抬头已由 outboxTag 写成「【会话码 X · sid】」，正文不再重复「会话 <sid>」，节省气泡行数。
  lines.push("【回合结束】" + (seconds === null ? "" : seconds + " 秒"));
  const task = terseTask(input.summary, wide ? 90 : 36);
  const items = resultItems(input.text, { wide });
  if (wide) {
    // 飞书：两级结构（一、任务 / 二、结果 → 　・待定/已做/进度/其他），每层可单独扫读。
    lines.push("一、任务");
    lines.push("　・" + (task || "（无）"));
    if (items.length > 0) {
      lines.push("二、结果");
      for (const item of items) for (const line of wrapCjk(item, width)) lines.push(line);
    }
  } else {
    // 微信：手机气泡窄，保留「・」二级条目，不加大标题与缩进（各客户端 trim 不一致）。
    if (task) for (const line of wrapCjk("・任务：" + task, width)) lines.push(line);
    for (const item of items) for (const line of wrapCjk(item, width)) lines.push(line);
  }
  lines.push("");
  // 提示本身可能有意分成两行（飞书），要逐行折行——否则 "\n" 被当成普通字符，
  // 两行会被拼成一行再折一次，出现「本条是摘要，/全文在 DSH 里」这种半句换行。
  for (const hintLine of turnEndHint(input.sessionId, code, { wide }).split("\n")) {
    for (const line of wrapCjk(hintLine, width)) lines.push(line);
  }
  return limitNotificationText(lines.join("\n"), input.sessionId, "result");
}

/** 字符绘制表格（只在天然表格的场合用：会话清单）。 */
export function drawTable(headers, rows) {
  const all = [headers, ...rows].map((row) => row.map((cell) => String(cell ?? "")));
  const width = (text) => {
    let w = 0;
    for (const ch of text) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
    return w;
  };
  const cols = headers.map((_, index) => Math.max(...all.map((row) => width(row[index] ?? ""))));
  const pad = (text, target) => text + " ".repeat(Math.max(0, target - width(text)));
  const line = (left, mid, right) => left + cols.map((size) => "─".repeat(size + 2)).join(mid) + right;
  const render = (row) => "│" + row.map((cell, index) => " " + pad(cell, cols[index]) + " ").join("│") + "│";
  const out = [line("┌", "┬", "┐"), render(all[0]), line("├", "┼", "┤")];
  for (const row of all.slice(1)) out.push(render(row));
  out.push(line("└", "┴", "┘"));
  return out.join("\n");
}


// ── 出口清洗：把模型输出里的 Markdown 转成微信可读纯文本 ────────────────────
/**
 * 微信不支持 Markdown：模型回答里的 # 标题、粗体、竖线表格、列表符号、代码围栏、
 * 链接等都会原样显示成噪声。这里在**发送出口**统一清洗（网关 drainOutbox 与 CLI 直发都会走）。
 *
 * 表格处理：分隔行丢弃，数据行把竖线换成全角空格分隔（微信字体非等宽，画表更乱；
 * 需要真表格时用 drawTable 显式生成）。
 */
export function toWechatText(input) {
  let text = String(input ?? "");
  if (!text) return "";
  const FENCE = String.fromCharCode(96, 96, 96);
  if (text.includes(FENCE)) {
    const fenceLine = new RegExp("^\\s*" + FENCE + "[a-zA-Z0-9+#-]*\\s*$", "gm");
    text = text.replace(fenceLine, "");
  }
  // ATX 标题：# / ## / ### → ■
  // 行首必须容忍全角缩进「　」：formatTurnEnd() 给正文每行加了 U+3000 前缀，
  // 若只认 ^# ，标题会整段逃过清洗（2026-10-27 会话码 14/8 的实测泄漏点）。
  const INDENT = "[ \\t\\u3000]*";
  // 扁平化文本兜底：微信复制/转发常把换行压成空格，导致除第一个标题外
  // 其余 "## xxx" 都变成行内标记而逃过清洗（2026-10-27 会话码 5 的 out-…33db0f 实测）。
  // 先把「空白 + ### 」还原成换行，再走行首规则。
  text = text.replace(new RegExp("[ \\t\\u3000]+(?=#{1,6}[ \\t])", "g"), "\n");
  text = text.replace(new RegExp("^" + INDENT + "#{1,6}[ \\t]*(.+?)[ \\t]*#*[ \\t]*$", "gm"), "■ $1");
  // 表格：逐行处理（分隔行丢弃，数据行竖线换成全角空格）
  if (new RegExp("^" + INDENT + "\\|", "m").test(text)) {
    const kept = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("|")) { kept.push(line); continue; }
      if (/^[|: \t-]+$/.test(trimmed) && trimmed.includes("-")) continue;
      const indent = (line.match(new RegExp("^" + INDENT)) ?? [""])[0];
      const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()).filter((cell) => cell.length > 0);
      kept.push(indent + cells.join("　"));
    }
    text = kept.join("\n");
  }
  // 粗体 / 斜体 / 删除线 / 行内代码
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
  text = text.replace(/~~([^~]+)~~/g, "$1");
  const TICK = String.fromCharCode(96);
  if (text.includes(TICK)) {
    text = text.split(TICK).join("");
  }
  // 链接 / 图片
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1（$2）");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1（$2）");
  // 无序列表 → ・
  text = text.replace(/^\s*[-*+]\s+/gm, "・");
  // 扁平化兜底 1：先把连成一串的分隔单元格（|---|---|）整段删掉，
  // 否则压成一行后会变成 "｜ --- ｜ --- ｜" 这种更难看的东西。
  text = text.replace(/[ \t\u3000]*\|[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)+/g, " ");
  // 扁平化兜底 2：行内残留的表格竖线换成全角竖线，避免微信里出现 " | a | b | " 噪音
  text = text.replace(/[ \t\u3000]*\|[ \t\u3000]*/g, " ｜ ");
  text = text.replace(/(?: ｜)+[ \t]*/g, " ｜ ");
  text = text.replace(/ ｜ (?=\S)/g, (m) => m);
  // 引用
  text = text.replace(new RegExp("^" + INDENT + ">[ \\t]?", "gm"), "");
  // 水平线
  text = text.replace(new RegExp("^" + INDENT + "([-*_])(?:[ \\t]*\\1){2,}[ \\t]*$", "gm"), "─────────");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// ── 微信主动推送 ──────────────────────────────────────────────────────────
/**
 * 通过 OpenClaw 主动发微信（直接 node 执行 openclaw.mjs，绕开 .cmd 的引号问题）。
 * @returns {Promise<{ok:boolean, code:number|null, output:string}>}
 */
/**
 * 用「文件描述符」而不是管道接子进程输出。
 *
 * 为什么：DSH 沙箱在受限模式下禁止程序打开命名管道，因此
 * child_process.spawn(..., { stdio: "pipe" }) 会直接 EPERM。改用
 * stdio: ['ignore', fd, fd]（stdout/stderr 指向同一文件）在沙箱内外都成立，
 * 代价是必须等子进程退出后读文件取结果。
 */
export function runToFile(command, argv, options = {}) {
  ensureDir();
  const outFile = options.outFile ?? join(PATHS.stateDir, "run-" + Date.now() + "-" + randomBytes(3).toString("hex") + ".log");
  let fd;
  try { fd = openSync(outFile, "w"); } catch (error) { return Promise.resolve({ code: null, output: "open-failed:" + String(error), outFile }); }
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const finish = (code, extra) => {
      if (settled) return;
      settled = true;
      let output = "";
      try { output = readFileSync(outFile, "utf8"); } catch {}
      resolve({ code, output: (output + (extra ?? "")).slice(-8000), outFile });
    };
    try {
      child = spawn(command, argv, {
        cwd: options.cwd ?? PATHS.workdir,
        env: options.env ?? { ...process.env },
        stdio: ["ignore", fd, fd],
        windowsHide: true,
      });
    } catch (error) {
      try { closeSync(fd); } catch {}
      resolve({ code: null, output: "spawn-failed:" + String(error), outFile });
      return;
    }
    try { closeSync(fd); } catch {}
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null, "\n[timeout]"); }, Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 60000);
    // dsh --profile headless 收尾阶段会长时间不退出（残余句柄），NDJSON 打出 final 就代表回合已结束。
    // 因此按 final 标早早退：既能立刻拿到结果，也不会把子进程一直挂着。
    let poller = null;
    if (options.finalMarker === true) {
      poller = setInterval(() => {
        let text = "";
        try { text = readFileSync(outFile, "utf8"); } catch { return; }
        if (/\{"type":"final"/.test(text)) {
          clearInterval(poller);
          try { child.kill(); } catch {}
          finish(0, "");
        }
      }, 400);
      if (typeof poller.unref === "function") poller.unref();
    }
    const cleanup = () => { clearTimeout(timer); if (poller) clearInterval(poller); };
    child.on("error", (error) => { cleanup(); finish(null, "\n[error]" + String(error)); });
    child.on("close", (code) => { cleanup(); finish(code, ""); });
  });
}

/**
 * 发件箱统一抬头：每条出站消息都必须能回答「这是哪个会话的」。
 * 正文里已带「会话码」（formatAsk / formatTurnEnd 等）时不重复加。
 * 会话身份缺失时原样发出，不伪造。
 */
/**
 * 出口兜底：改写"旧宿主"产出的尾巴。
 *
 * 背景（2026-11-06 用户实测）：DSH Web（3080）的插件进程里缓存的是**旧版** hitl-store，
 * 它仍会产出「回复 100 <内容> 可继续，细节在本会话」。重启 3080 会打断正在跑的会话，
 * 所以改在**出口**（outboxTag）统一改写——daemon 重启即可，全局立即生效。
 */
export function upgradeLegacyHint(text, sessionId) {
  const raw = String(text ?? "");
  if (!raw) return raw;
  const wide = currentChannel() === "feishu";
  return raw
    // 优先沿用旧文案里已经写好的会话码（它是产物的一部分），不自作聪明重算，
    // 否则隔离环境/换绑后会出现"抬头 100、尾巴 1"的错位。
    .replace(/回复\s*(\d+)\s*<内容>\s*可继续[，,]?\s*细节在本会话里?/g, (_m, legacyCode) =>
      turnEndHint(sessionId, Number(legacyCode), { wide }))
    .replace(/[，,]?\s*细节在本会话里?/g, "；本条是摘要，全文在 DSH 里");
}

export function outboxTag(entry) {
  // 出口统一清洗 Markdown（模型回答里常带 # 标题、竖线表格、加粗）
  // 并兜底改写旧宿主的尾巴措辞（见 upgradeLegacyHint）。
  const text = upgradeLegacyHint(toWechatText(entry?.text ?? ""), entry?.sessionId ?? null);
  if (!text || /会话码/.test(text)) return text;
  const sessionId = entry?.sessionId ?? null;
  if (!sessionId) return text;
  const code = sessionCode(sessionId);
  if (code === null) return text;
  const sid = String(sessionId).replace(/^session-/, "").slice(0, 8);
  return "【会话码 " + code + " · " + sid + "】\n" + text;
}

/**
 * 微信出站有两条路，取决于「谁在跑」：
 *
 *  1) direct（网关进程内，未受沙箱限制）：直接 spawn openclaw 发消息。
 *     触发条件：环境变量 DSH_WECHAT_HITL_EGRESS=direct，或显式 { direct: true }。
 *  2) queued（DSH 会话内，受 DSH 沙箱限制）：沙箱禁止 openclaw 写 ~/.openclaw/tmp，
 *     因此把消息写进状态文件里的发件箱，由常驻的 OpenClaw 网关插件在 2 秒内取出并真正发送。
 *
 * 这条边界是本机实测结论：在 DSH 沙箱里 spawn openclaw 会以
 * EPERM（plugin-captures 清理失败）退出，所以「微信出站唯一出口 = 网关进程」。
 */
export async function pushWechat(text, target, options = {}) {
  // 三态开关：只有 running 才真的发。paused/stopped 一律抑制并审计，
  // 避免「暂停了还在发」或「关了服务又被队列补发」。
  const control = getControl();
  if (control.state !== "running") {
    log({ op: "push-suppressed", state: control.state, preview: String(text ?? "").slice(0, 120) });
    return { ok: false, suppressed: true, state: control.state, output: "suppressed:" + control.state, mode: "suppressed" };
  }
  // 通道无关的默认落点：feishu 读 feishu-target.json / 环境变量，wechat 用 PATHS.target。
  const sendTarget = target || resolveDefaultTarget();
  const sessionId = options.sessionId ?? null;
  const kind = options.kind ?? inferNotificationKind(text);
  const processedText = applyOneLineRecap(text, sessionId, kind, options.recap);
  const direct = options.direct === true || process.env.DSH_WECHAT_HITL_EGRESS === "direct";
  if (direct) {
    const run = await runToFile(PATHS.node, [PATHS.openclawMjs, "message", "send", "--channel", PATHS.channel, "--target", sendTarget, "-m", outboxTag({ text: processedText, sessionId })], {
      cwd: PATHS.workdir,
      timeoutMs: options.timeoutMs ?? 120000,
    });
    const output = run.output.trim().slice(-800);
    const ok = run.code === 0 && !/\b(EPERM|failed|error)\b/i.test(output);
    log({ op: "push-direct", ok, code: run.code, output: output.slice(-300) });
    return { ok, code: run.code, output, mode: "direct" };
  }
  const entry = { id: "out-" + Date.now() + "-" + randomBytes(3).toString("hex"), text: processedText, target: sendTarget, createdAt: Date.now(), attempts: 0, sessionId };
  // Only a correlated Feishu request may override the channel default; never reuse a legacy WeChat target.
  if (typeof options.feishuReplyChatId === "string" && options.feishuReplyChatId.startsWith("oc_")) {
    entry.feishuTarget = { id: options.feishuReplyChatId, type: "chat_id" };
  }
  mutate((state) => {
    state.outbox = Array.isArray(state.outbox) ? state.outbox : [];
    state.outbox.push(entry);
    if (state.outbox.length > 40) state.outbox = state.outbox.slice(-40);
    return true;
  });
  // 入队成功即算成功。网关探活改为异步：HTTP 探测在 CPU 饥饿 / 网关重启窗口会超时，
  // 但消息此时已经安全入队（实测 06:42、06:49 两次 notify 都误报 gateway-probe-timeout，
  // 45 秒后照常 outbox-sent）。同步等探测只会让调用方把「已入队」误判成失败。
  // 入队日志必须同步写：CLI（wx-hitl.mjs）拿到返回值就 process.exit()，
  // 异步回调里的日志会被直接丢掉（2026-10-26 17:28 实测三条推送都没有 push-queued 行）。
  log({ op: "push-queued", id: entry.id, gatewayUp: null, sessionId: entry.sessionId });
  gatewayAlive(Number(options.probeMs) > 0 ? Number(options.probeMs) : 6000)
    .then((up) => log({ op: "push-probe", id: entry.id, gatewayUp: up }))
    .catch(() => {});
  return { ok: true, queued: true, id: entry.id, gatewayUp: null, output: "queued", mode: "queued" };
}

/** 网关是否在跑（决定 queued 推送是否会被真正发出）。 */
export function gatewayAlive(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    try {
      const req = httpRequest({ host: "127.0.0.1", port: PATHS.gatewayPort, path: "/", method: "GET", timeout: timeoutMs }, (res) => { res.resume(); finish(Number(res.statusCode) > 0); });
      req.on("timeout", () => { req.destroy(); finish(false); });
      req.on("error", () => finish(false));
      req.end();
    } catch { finish(false); }
  });
}

/**
 * 网关侧：把发件箱里的消息真正发出去（唯一出口）。成功即从队列移除；失败累计 attempts。
 * @returns {Promise<{sent:number, failed:number}>}
 */
// ── 出站出口注入：inproc-egress-v1 ──────────────────────────────────────────────
/**
 * 网关插件（dsh-bridge）在网关进程内直接调用 openclaw-weixin 的 sendMessageWeixin，
 * 从而不再 spawn 独立子进程发消息（子进程会自开 openclaw-agent.sqlite，
 * 与网关 getUpdates 抢写，实测引发 SqliteSessionMutationConflictError）。
 *
 * DSH_BRIDGE_EGRESS=cli 强制退回旧的子进程路径；未注入发送器时也自动退回 CLI。
 */
let outboxSender = null;
export function setOutboxSender(fn) {
  outboxSender = typeof fn === "function" ? fn : null;
  log({ op: "outbox-sender", mode: outboxSender ? "set" : "cleared" });
}
export function getOutboxEgressMode() {
  return String(process.env.DSH_BRIDGE_EGRESS ?? "inproc").toLowerCase() === "cli" ? "cli" : "inproc";
}

// ── 进程内发送实现（inproc-egress-v2）──────────────────────────────────────────
/**
 * 真正的进程内出站：直接调用 openclaw-weixin 官方包自己的发送函数。
 *
 *   dist/src/messaging/send.js      sendMessageWeixin({ to, text, opts })   (src: src/messaging/send.ts:103)
 *   dist/src/auth/accounts.js       loadWeixinAccount(accountId) -> { token, baseUrl }  (src: src/auth/accounts.ts:164)
 *   dist/src/messaging/inbound.js   getContextToken(accountId, userId)      (src: src/messaging/inbound.ts:109)
 *
 * 为什么放在这里而不是 dsh-bridge：本模块被网关插件 dsh-bridge 在**网关进程内**加载，
 * 所以这里的 import 与网关同一模块实例、同一解析规则；同时本文件在工作区内，可被正常维护。
 * 它只走 ilink HTTPS + 账号 token + contextToken 文件，**不打开 openclaw-agent.sqlite**，
 * 因此不再和网关 getUpdates 抢写（13:25 那次 SqliteSessionMutationConflictError 的来源）。
 *
 * 网关外（wx-hitl CLI 里）import 会失败，此时自动退回子进程路径，行为与改造前一致。
 */
const WEIXIN_EXT_DIST = process.env.DSH_WEIXIN_EXT_DIST ?? "C:/Users/wwm_1/.openclaw/extensions/openclaw-weixin/dist";
const WEIXIN_ACCOUNT_ID = process.env.DSH_WEIXIN_ACCOUNT_ID ?? "66b3a3ae4579-im-bot";
const WEIXIN_DEFAULT_BASE = "https://ilinkai.weixin.qq.com";
// openclaw 自己的状态目录（extension 的 resolveStateDir 同口径）。
// contextToken 除了进程内存，还会被写入
//   <state>/openclaw-weixin/accounts/<accountId>.context-tokens.json
// 用户每发一条入站消息，这个文件都会被刷新一次。
const WEIXIN_STATE_DIR = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim() || join(homedir(), ".openclaw");
const CONTEXT_TOKEN_FILE = (accountId) => join(WEIXIN_STATE_DIR, "openclaw-weixin", "accounts", accountId + ".context-tokens.json");
let inprocEgress = null;
let inprocState = "unknown";

/**
 * 从账号 token 文件直接取 contextToken（2026-11-01 修复）。
 *
 * 为什么必须有这条兜底：extension 的 getContextToken() 只查**本模块实例内存里的 Map**，
 * 只有「同一实例」收到入站（setContextToken）或启动时 restoreContextTokens() 才会填。
 * 网关插件里 import(extension 的 inbound.js) 拿到的常常是**另一个实例**：
 * 它的 Map 永远是空的，于是每条推送都返回 contextToken missing，进发件箱后被 TTL 丢掉。
 * 实测：hitl.log 里 mode=inproc 的发送 1144 次、成功 0 次；成功投递全部走的是 mode=cli。
 * 账号 token 文件是跨实例唯一可信来源，所以缺 token 时以它为准并顺手回填内存。
 */
export function readContextTokenFromFile(accountId, target) {
  try {
    const raw = JSON.parse(readFileSync(CONTEXT_TOKEN_FILE(accountId), "utf8"));
    const value = raw && typeof raw === "object" ? raw[target] : null;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

async function loadInprocEgress() {
  if (inprocState === "ready") return inprocEgress;
  if (inprocState === "unavailable") return null;
  try {
    const send = await import("file:///" + WEIXIN_EXT_DIST + "/src/messaging/send.js");
    const accounts = await import("file:///" + WEIXIN_EXT_DIST + "/src/auth/accounts.js");
    const inbound = await import("file:///" + WEIXIN_EXT_DIST + "/src/messaging/inbound.js");
    if (typeof send.sendMessageWeixin !== "function") throw new Error("sendMessageWeixin 未导出");
    if (typeof accounts.loadWeixinAccount !== "function") throw new Error("loadWeixinAccount 未导出");
    if (typeof inbound.getContextToken !== "function") throw new Error("getContextToken 未导出");
    inprocEgress = {
      sendMessageWeixin: send.sendMessageWeixin,
      loadWeixinAccount: accounts.loadWeixinAccount,
      getContextToken: inbound.getContextToken,
      // 有就用，没有也不致命（下面还有 token 文件兜底）。
      restoreContextTokens: typeof inbound.restoreContextTokens === "function" ? inbound.restoreContextTokens : null,
      setContextToken: typeof inbound.setContextToken === "function" ? inbound.setContextToken : null,
    };
    inprocState = "ready";
    log({ op: "inproc-egress", state: "ready", dist: WEIXIN_EXT_DIST });
    return inprocEgress;
  } catch (error) {
    inprocState = "unavailable";
    log({ op: "inproc-egress", state: "unavailable", error: String(error).slice(0, 220) });
    return null;
  }
}

/** 进程内发一条微信；返回 { ok, output }，output 里保留可判定的失败原因。 */
async function inprocSend(target, text) {
  const mod = await loadInprocEgress();
  if (!mod) return { ok: false, output: "inproc-unavailable" };
  try {
    const account = mod.loadWeixinAccount(WEIXIN_ACCOUNT_ID);
    const token = account && typeof account.token === "string" ? account.token.trim() : "";
    if (!token) return { ok: false, output: "inproc: no account token for " + WEIXIN_ACCOUNT_ID };
    // 三级取 token（2026-11-01）：内存 → 让本实例从磁盘复原 → 直接读账号 token 文件。
    // 只有三级全空才是真的「用户还没给 bot 发过话」，才交给上层走「等 token」逻辑。
    let contextToken = mod.getContextToken(WEIXIN_ACCOUNT_ID, target);
    let tokenSource = contextToken ? "memory" : null;
    if (!contextToken && typeof mod.restoreContextTokens === "function") {
      try { mod.restoreContextTokens(WEIXIN_ACCOUNT_ID); } catch {}
      contextToken = mod.getContextToken(WEIXIN_ACCOUNT_ID, target);
      if (contextToken) tokenSource = "restore";
    }
    if (!contextToken) {
      const fromFile = readContextTokenFromFile(WEIXIN_ACCOUNT_ID, target);
      if (fromFile) {
        contextToken = fromFile;
        tokenSource = "file";
        try { mod.setContextToken?.(WEIXIN_ACCOUNT_ID, target, fromFile); } catch {}
      }
    }
    if (!contextToken) return { ok: false, output: "contextToken missing for " + target };
    if (tokenSource !== "memory") log({ op: "inproc-token-source", source: tokenSource, to: target });
    const sent = await mod.sendMessageWeixin({
      to: target,
      text,
      opts: {
        baseUrl: (account && account.baseUrl) || WEIXIN_DEFAULT_BASE,
        token,
        contextToken,
        accountId: WEIXIN_ACCOUNT_ID,
      },
    });
    log({
      op: "inproc-sent",
      to: target,
      chars: String(text ?? "").length,
      messageId: sent && sent.messageId ? String(sent.messageId) : null,
      serverMessageId: sent && sent.serverMessageId ? String(sent.serverMessageId) : null,
    });
    return { ok: true, output: "inproc-ok" };
  } catch (error) {
    log({ op: "inproc-error", to: target, error: String(error).slice(0, 220) });
    return { ok: false, output: "inproc-error: " + String(error) };
  }
}


/**
 * 用户入站时调用：把「等 contextToken」的条目全部解锁，下一次 drain 立即补发。
 *
 * 为什么需要它：`needsContext` 条目有兜底重试冷却（30 分钟），但如果只靠定时重试，
 * 「用户发一句话 → 积压立刻补发」的承诺就会拖到冷却结束。入站是 token 刷新的唯一信号，
 * 所以在这里显式放开，而不是把冷却调短（调短会让日志被重试刷爆，2026-10-29 审计过）。
 */
export function releaseContextHold() {
  let released = 0;
  mutate((fresh) => {
    for (const item of fresh.outbox || []) {
      // blocked=config 的条目也一并解锁：用户入站是「通道刚被人工动过」的最强信号，
      // 立刻重试一次能让「刚修好出口」的场景无需等 5 分钟节流。
      if (!item.needsContext && item.blocked !== "config") continue;
      item.needsContext = false;
      item.contextMissingAt = 0;
      item.blocked = undefined;
      item.blockedAt = 0;
      item.nextAttemptAt = 0;
      item.claimedAt = 0;
      released += 1;
    }
    return released > 0;
  });
  if (released > 0) log({ op: "outbox-hold-released", count: released });
  return released;
}

let lastNoTargetLogAt = 0;

export async function drainOutbox() {
  const control = getControl();
  if (control.state !== "running") {
    // 注意：不清空队列。暂停期间积压的消息在恢复后会按 30 分钟 TTL 过滤后发送，
    // 更老的直接丢弃（见下方 createdAt 判断），不会一次性刷屏。
    return { sent: 0, failed: 0, skipped: control.state };
  }
  const state = loadState();
  const queue = Array.isArray(state.outbox) ? state.outbox : [];
  if (queue.length === 0) return { sent: 0, failed: 0 };
  // 飞书落点还没配好时不要空转重试：没有目标的失败会把发件箱条目按 attempts 耗尽丢掉。
  if (currentChannel() === "feishu" && !getFeishuTarget().id) {
    if (Date.now() - lastNoTargetLogAt > 5 * 60 * 1000) {
      lastNoTargetLogAt = Date.now();
      log({ op: "outbox-wait-target", note: "feishu 落点未设置：fx-hitl target --id <open_id|chat_id>" });
    }
    return { sent: 0, failed: 0, skipped: "no-target" };
  }
  let sent = 0;
  let failed = 0;
  let dropped = 0;
  for (const entry of queue.slice(0, 10)) {
    const disposition = outboxEntryDisposition(entry);
    if (disposition === "drop-ttl" || disposition === "drop-context-expired" || disposition === "drop-blocked-expired") {
      // 丢弃必须留痕：原先这里静默移除，日志里查不到「这条为什么没收到」。
      // 三种原因分开记：ttl = 普通积压超时；context-expired = 等 token 等到 24h 上限；
      // blocked-expired = 出站出口一直没修好，等满 24h。
      // 同时写死信副本：正文一旦从 outbox 删掉就再也补不回来（2026-11-11）。
      const reason = disposition === "drop-ttl" ? "ttl"
        : (disposition === "drop-blocked-expired" ? "blocked-expired" : "context-expired");
      const deadLettered = appendDeadLetter(entry, reason);
      mutate((fresh) => { fresh.outbox = (fresh.outbox || []).filter((item) => item.id !== entry.id); return true; });
      dropped += 1;
      log({
        op: "outbox-dropped",
        id: entry.id,
        reason,
        deadLettered,
        ageMs: Date.now() - Number(entry.createdAt ?? 0),
        ttlMs: disposition === "drop-ttl" ? DEFAULT_TTL_MS : CONTEXT_HOLD_MS,
        createdAt: Number(entry.createdAt ?? 0),
        sessionId: entry.sessionId ?? null,
        preview: String(entry.text ?? "").slice(0, 80),
      });
      continue;
    }
    // 统一退避：任何条目只要 nextAttemptAt 还没到就跳过。
    // 以前只对 hold-context 生效，普通失败会 2 秒后立刻重发——2026-10-29 因此出现过
    // 「CLI 90 秒超时被判失败 → 立刻重发 → 微信收到两条一样的审批」。
    if (Number(entry.nextAttemptAt ?? 0) > Date.now()) continue;
    if (disposition === "hold-context") {
      // ISSUE-001：等 token 的条目**豁免 30 分钟 TTL**，改由 contextMissingAt 的 24h 窗口管；
      // 冷却由上面的 nextAttemptAt 统一管（CONTEXT_RETRY_COOLDOWN_MS）。
    }
    // 认领 = 租约，而不是永久占用：
    //   - 多实例并发时，只有抢到租约的那个发（避免重复推送）；
    //   - 发送失败/进程崩溃后，租约到期可被重新认领（否则该条永久卡死，实测踩过）。
    const CLAIM_LEASE_MS = 3 * 60 * 1000;
    let claimed = false;
    mutate((fresh) => {
      const target = (fresh.outbox || []).find((item) => item.id === entry.id);
      if (!target) return false;
      const leased = Number(target.claimedAt) > 0 && Date.now() - Number(target.claimedAt) < CLAIM_LEASE_MS;
      if (leased) return false;
      target.claimedAt = Date.now();
      claimed = true;
      return true;
    });
    if (!claimed) continue;
    // 租约过期后被重新认领：说明上一任持有者（多半是网关进程）中途死了。
    // 留痕，便于对齐「这条为什么晚到」与「这条是否真的丢了」。
    if (Number(entry.claimedAt) > 0) log({ op: "outbox-reclaim", id: entry.id, previousClaimAt: Number(entry.claimedAt) });
    const payload = outboxTag(entry);
    // 审计实际发出的正文：出站文本经过 Markdown 清洗 + 会话码抬头，
    // 只有记下最终 payload，事后才能回答「对方到底收到了什么」。
    log({ op: "outbox-send", id: entry.id, chars: payload.length, preview: payload.slice(0, 180) });
    const sendTo = entry.target || resolveDefaultTarget();
    const egressMode = getOutboxEgressMode();
    let run;
    // 三级出口：① 插件注入的发送器 ② 本模块自己的进程内发送 ③ 子进程 CLI（兜底）
    let senderFn = null;
    log({ op: "egress-decision", channel: currentChannel(), egressMode });
    // 飞书通道没有 inproc 出口（那是微信/openclaw 的扩展）；先判通道，避免 inproc 抢占后误走微信发送。
    if (currentChannel() !== "feishu" && egressMode === "inproc") {
      if (typeof outboxSender === "function") senderFn = outboxSender;
      else if (await loadInprocEgress()) senderFn = inprocSend;
    }
    if (senderFn) {
      try {
        const r = await senderFn(sendTo, payload);
        run = { code: r && r.ok ? 0 : 1, output: String((r && r.output) ?? ""), mode: "inproc" };
      } catch (error) {
        run = { code: 1, output: "inproc-error: " + String(error), mode: "inproc" };
      }
    } else if (currentChannel() === "feishu") {
      // 飞书出口：lark-cli 以 bot 身份直发。没有 inproc 注入，也不依赖 openclaw 网关。
      // 飞书落点是通道级配置（state/feishu-target.json），不能沿用条目上残留的微信 target
      run = await feishuSend(entry.feishuTarget?.id || null, payload, { type: entry.feishuTarget?.type });
    } else {
      // 超时 180s：实测 openclaw CLI 发一条 50–90s（进程退出慢），90s 会误判超时；
      // 误判后立刻重发就是「微信收到两条」的直接原因（2026-10-29 05:48/05:49）。
      run = await runToFile(PATHS.node, [PATHS.openclawMjs, "message", "send", "--channel", PATHS.channel, "--target", sendTo, "-m", payload], {
        cwd: PATHS.workdir,
        timeoutMs: 180000,
      });
      run.mode = "cli";
    }
    // 进程内出口拿不到 contextToken（或 extension 不可用）时，立刻换 CLI 出口再试一次（2026-11-01）。
    // 注意「prepare failed / ret=-2」**不能**退 CLI（2026-11-01 23:45 实测：那是微信 token 过期，
    // 服务端对任何通道都拒发，CLI 试了也白等 47 秒）；它由下面的 needsContext 分支挂起，
    // 等用户下一次入站刷新 token 后用 inproc 秒级补发（releaseContextHold 会清冷却）。
    // 只对「inproc 自己拿不到 token、CLI 能拿到」的场景兜底，避免重复投递与无谓等待。
    if (run.code !== 0 && /contextToken missing|inproc-unavailable/i.test(run.output || "")) {
      const fallback = await runToFile(PATHS.node, [PATHS.openclawMjs, "message", "send", "--channel", PATHS.channel, "--target", sendTo, "-m", payload], {
        cwd: PATHS.workdir,
        timeoutMs: 180000,
      });
      fallback.mode = "cli-fallback";
      log({ op: "outbox-egress-fallback", id: entry.id, from: run.mode, code: fallback.code, output: String(fallback.output ?? "").slice(-160) });
      run = fallback;
    }
    log({ op: "outbox-egress", id: entry.id, mode: run.mode });
    const ok = run.code === 0;
    if (ok) {
      sent += 1;
      mutate((fresh) => { fresh.outbox = (fresh.outbox || []).filter((item) => item.id !== entry.id); return true; });
      log({ op: "outbox-sent", id: entry.id });
    } else {
      failed += 1;
      const attempts = Number(entry.attempts ?? 0) + 1;
      const kind = classifyOutboxFailure(run.output);
      let willDrop = false;
      mutate((fresh) => {
        const target = (fresh.outbox || []).find((item) => item.id === entry.id);
        if (!target) return false;
        target.lastError = run.output.slice(-200);
        target.claimedAt = 0;   // 失败也立即放租约，别让下一条排队等 3 分钟
        // 出口环境没配好（lark-cli 未 bind / 配置目录错 / bot 不在群）：不是瞬时故障，
        // 重试只会耗尽次数把正文丢掉。保留原文 + 标记，修好后下一次 drain 自动补发。
        if (kind === "config") {
          target.blocked = "config";
          target.blockedAt = target.blockedAt ?? Date.now();
          target.nextAttemptAt = Date.now() + CONFIG_BLOCK_RETRY_MS;
          return true;
        }
        target.blocked = undefined;
        target.blockedAt = 0;
        // contextToken 缺失（微信 bot 只能回复「最近发过消息的人」）同样不是可重试的瞬时错误：
        // 保留 + 标记，等用户下一次入站刷新 token 后自动补发。
        if (kind === "context") {
          target.needsContext = true;
          target.contextMissingAt = target.contextMissingAt ?? Date.now();
          target.lastError = "contextToken missing";
          target.nextAttemptAt = Date.now() + CONTEXT_RETRY_COOLDOWN_MS;
          return true;
        }
        target.attempts = attempts;
        // 超时 ≠ 没发出去：openclaw CLI 常常「消息已送达但进程不退出」。
        // 这种情况判失败再立刻重发，用户就会收到两条一样的（2026-10-29 实测）。
        // 处理：记为 uncertain，退避 3 分钟后再试一次；明确失败按 60 秒退避。
        target.uncertain = kind === "timeout" ? "timeout" : undefined;
        target.nextAttemptAt = Date.now() + (kind === "timeout" ? 3 * 60 * 1000 : 60 * 1000);
        if (attempts >= 5) willDrop = true;
        return true;
      });
      if (willDrop) {
        // 次数耗尽的条目先留死信再删：日志只能证明「丢过」，死信才能补发。
        const deadLettered = appendDeadLetter(entry, "attempts-exhausted");
        mutate((fresh) => { fresh.outbox = (fresh.outbox || []).filter((item) => item.id !== entry.id); return true; });
        dropped += 1;
        log({ op: "outbox-dead-lettered", id: entry.id, attempts, reason: "attempts-exhausted", deadLettered, output: run.output.slice(-160) });
      }
      // 四种结局分开记账：出口配置阻塞 / 等 token / 超时不确定 / 明确失败。
      // 超时那条容易重复投递，必须能一眼查出来；配置阻塞那条要能被 /who 与日志直接定位。
      const failedOp = kind === "config" ? "outbox-blocked-config"
        : (kind === "context" ? "outbox-wait-context"
        : (kind === "timeout" ? "outbox-uncertain" : "outbox-failed"));
      log({
        op: failedOp,
        id: entry.id,
        attempts: kind === "config" ? Number(entry.attempts ?? 0) : attempts,
        backoffMin: kind === "config" ? 5 : (kind === "timeout" ? 3 : 1),
        output: run.output.slice(-160),
      });
    }
  }
  return { sent, failed, dropped };
}

// ── 答复回注原会话 ────────────────────────────────────────────────────────
/**
 * 把微信答复包装成明确的自述式提示，交给原会话继续。
 * 措辞刻意包含「这是对哪个请求的答复」，避免模型把它当成新任务。
 */
export function buildContinuationPrompt(req) {
  const chosen = req.answer?.key ? req.answer.key + ") " + req.answer.label : (req.answer?.label || req.answer?.raw || "");
  const optionList = req.options.map((option) => option.key + ") " + option.label).join("  ");
  return [
    "【微信人工确认答复｜请据此继续原任务】",
    "你此前通过微信向用户发起了确认请求（请求号 " + req.id + "）。",
    "问题：" + req.question,
    "选项：" + optionList,
    "用户选择：" + chosen,
    "用户原始回复：" + (req.answer?.raw ?? ""),
    "请直接据此推进原任务；如已无可推进内容，用一两句话说明当前结论。",
  ].join("\n");
}

/** 用 headless 跑一个已有会话的一轮（回环兜底路径）。 */
export async function runHeadlessTurn(sessionId, text, timeoutMs = 8 * 60 * 1000) {
  const args = [PATHS.dshBin, "--profile", "headless", "--json"];
  if (sessionId) args.push("--session-id", sessionId);
  args.push(text);
  const run = await runToFile(PATHS.dshNode, args, {
    cwd: PATHS.workdir,
    env: { ...process.env, DSH_WECHAT_HITL_SKIP: "1" },
    timeoutMs,
    finalMarker: true,
  });
  return { ok: run.code === 0, timeout: /\[timeout\]/.test(run.output), stdout: run.output, stderr: run.output, code: run.code };
}

/** 从 dsh --json 的 NDJSON 里取最终回答、会话 id 和结构化错误。 */
export function parseNdjson(stdout) {
  let sessionId = null;
  let finalText = null;
  let lastText = null;
  let error = null;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (event.type === "error") error = String(event.message ?? event.error?.message ?? "headless failed");
    if (event.type === "session" && event.sessionId) sessionId = event.sessionId;
    if (event.type === "text" && typeof event.text === "string") lastText = event.text;
    if (event.type === "final" && typeof event.text === "string") finalText = event.text;
  }
  return { sessionId, text: finalText ?? lastText, error };
}

// ── 飞书出口（lark-cli bot 身份，2026-11-05）───────────────────────────────
/**
 * 飞书目标：{ id, type }，type ∈ open_id | chat_id | email。
 * 取值顺序：显式参数 > state/feishu-target.json > 环境变量。
 * 与微信不同，飞书没有「网关插件排空发件箱」这一层：
 * DSH 侧插件写队列，feishu 守护进程（feishu/feishu-daemon.mjs）排空并消费事件。
 */
export function getFeishuTarget() {
  if (existsSync(FEISHU.targetFile)) {
    try {
      const parsed = JSON.parse(readFileSync(FEISHU.targetFile, "utf8"));
      if (parsed && parsed.id) return { id: String(parsed.id), type: String(parsed.type || "open_id"), source: "file" };
    } catch {}
  }
  const envId = process.env.DSH_HITL_FEISHU_TARGET || "";
  if (envId) return { id: envId, type: process.env.DSH_HITL_FEISHU_TARGET_TYPE || "open_id", source: "env" };
  return { id: "", type: "open_id", source: "none" };
}

export function setFeishuTarget(id, type = "open_id") {
  ensureDir();
  writeFileSync(FEISHU.targetFile, JSON.stringify({ id: String(id), type: String(type), updatedAt: Date.now(), updatedBy: process.env.DSH_SESSION_ID || "cli" }, null, 2));
  log({ op: "feishu-target", id: String(id), type: String(type) });
  return { id: String(id), type: String(type) };
}

/** 当前通道的默认落点。 */
export function resolveDefaultTarget() {
  return currentChannel() === "feishu" ? getFeishuTarget().id : PATHS.target;
}

/**
 * 用 lark-cli 以 bot 身份发一条消息。
 * 成功判定：退出码 0 且输出信封里 ok=true（不是 code==0，见 lark-shared 输出契约）。
 */
export async function feishuSend(target, text, options = {}) {
  const info = target
    ? { id: String(target), type: String(options.type || getFeishuTarget().type || "open_id") }
    : getFeishuTarget();
  if (!info.id) return { code: 1, output: "feishu-target-missing: 先跑 fx-hitl target --id <open_id|chat_id|email>", mode: "feishu" };
  const env = larkCliEnv(FEISHU.configDir);
  // lark-cli 的 +messages-send 只接受 --chat-id（oc_…）或 --user-id（ou_…），没有通用的 --receive-id。
  const recvFlag = info.type === "chat_id" ? "--chat-id" : "--user-id";
  const argv = [FEISHU.runJs, "im", "+messages-send", "--as", "bot", recvFlag, info.id, "--text", String(text ?? "")];
  const run = await runToFile(process.execPath, argv, { cwd: PATHS.workdir, env, timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 60000 });
  const ok = run.code === 0 && /"ok"\s*:\s*true/.test(run.output || "");
  log({ op: "feishu-send", ok, target: info.id, type: info.type, code: run.code, output: String(run.output ?? "").slice(-200) });
  return { code: ok ? 0 : (run.code ?? 1), output: String(run.output ?? "").slice(-800), mode: "feishu" };
}

/** 守护进程心跳：读 state/feishu-daemon.json，判断飞书通道是否在线。 */
export function feishuDaemonAlive(maxAgeMs = 30000) {
  const file = join(PATHS.stateDir, "feishu-daemon.json");
  if (!existsSync(file)) return { up: false, reason: "no-heartbeat" };
  try {
    const beat = JSON.parse(readFileSync(file, "utf8"));
    const age = Date.now() - Number(beat.tickAt || 0);
    return { up: age <= maxAgeMs, ageMs: age, pid: beat.pid, startedAt: beat.startedAt, inbound: beat.inbound ?? null, lastError: beat.lastError ?? null };
  } catch (error) {
    return { up: false, reason: String(error) };
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
