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
import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync, existsSync, openSync, closeSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
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
export const PATHS = {
  stateDir: process.env.DSH_WECHAT_HITL_STATE || DEFAULT_STATE_DIR,
  node: "C:\\openclaw-runtime\\node.exe",
  openclawMjs: "C:\\openclaw-runtime\\node_modules\\openclaw\\openclaw.mjs",
  dshNode: "C:\\Users\\wwm_1\\AppData\\Local\\nvm\\v24.18.0\\node.exe",
  dshBin: "C:\\Users\\wwm_1\\AppData\\Local\\nvm\\v24.18.0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
  workdir: "D:\\nutstore\\1.logseq",
  channel: "openclaw-weixin",
  target: "o9cq809dq0T-EHbYNw82tLLPpkpI@im.wechat",
  gatewayPort: 18789,
  dshHome: "C:\\Users\\wwm_1\\.dsh",
  // DSH 会把工作区路径编码成目录名：D:\nutstore\1.logseq -> --D-nutstore-1.logseq--
  workspaceKey: "--D-nutstore-1.logseq--",
};

export const STATE_FILE = join(PATHS.stateDir, "pending.json");
export const CONTROL_FILE = join(PATHS.stateDir, "control.json");
export const LOG_FILE = join(PATHS.stateDir, "hitl.log");
export const DEFAULT_TTL_MS = 30 * 60 * 1000;
// contextToken 缺失（微信 bot 只能回复最近发过消息的人）时，条目按这个窗口保留等用户回话。
// ISSUE-001：这个窗口原先被 30 分钟 TTL 抢先判死，导致「保留 24h」的承诺失效。
export const CONTEXT_HOLD_MS = 24 * 3600 * 1000;
// 等待 token 期间的发送节流：不然每 2 秒一次 prepare failed，日志被刷爆。
// 2026-10-29 审计：原 60s 冷却被 3 分钟租约盖过，5 条积压每条撞了 158–163 次。
// 现在改成 30 分钟兜底重试；正常恢复靠「用户入站 → releaseContextHold() → 立即补发」。
export const CONTEXT_RETRY_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * 发件箱条目的处置判定（纯函数，便于单测）。
 * @returns {"send"|"hold-context"|"drop-ttl"|"drop-context-expired"}
 */
export function outboxEntryDisposition(entry, now = Date.now()) {
  if (!entry) return "send";
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

const CONTROL_DEFAULT = { state: "running", updatedAt: 0, updatedBy: "default", reason: "未设置时默认开启" };

/** 读开关：环境变量 > control.json > 默认 running。 */
export function getControl() {
  const env = String(process.env.DSH_WECHAT_HITL_SWITCH ?? "").trim().toLowerCase();
  if (CONTROL_STATES.includes(env)) return { ...CONTROL_DEFAULT, state: env, updatedBy: "env" };
  try {
    const parsed = JSON.parse(readFileSync(CONTROL_FILE, "utf8"));
    if (parsed && CONTROL_STATES.includes(String(parsed.state))) return parsed;
  } catch {}
  return { ...CONTROL_DEFAULT };
}

/** 写开关（原子替换 + 保留最近 20 条历史）。 */
export function setControl(state, options = {}) {
  const next = String(state ?? "").trim().toLowerCase();
  if (!CONTROL_STATES.includes(next)) throw new Error("state 必须是 running|paused|stopped，收到: " + String(state));
  ensureDir();
  const previous = getControl();
  const record = {
    state: next,
    updatedAt: Date.now(),
    updatedBy: String(options.by ?? "cli").slice(0, 60),
    reason: String(options.reason ?? "").slice(0, 300),
    // 结果推送是独立维度：重写 control.json 时不能把它丢掉
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
export function isResultPushEnabled() {
  return isSending() && getResultPush();
}

export function describeResultPush() {
  return (getResultPush() ? "🟢 结果推送：开" : "🟡 结果推送：关") + "（总开关：" + getControl().state + "）";
}

/**
 * REQ-002：解析微信侧的推送开关指令。
 * 只认整条消息就是短指令的情况，避免把「1 帮我跑测试」这类会话驱动误判成开关。
 */
export function parsePushCommand(text) {
  const raw = String(text ?? "").trim().replace(/^[\s　]+/, "");
  const m = raw.match(/^(?:结果推送|推送通知|推送)\s*[：:]?\s*(开|关|打开|关闭|状态|on|off|status)?\s*$/i);
  if (!m) return null;
  const v = (m[1] ?? "status").toLowerCase();
  if (["开", "打开", "on"].includes(v)) return { action: "on" };
  if (["关", "关闭", "off"].includes(v)) return { action: "off" };
  return { action: "status" };
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

function acquireStateLock(timeoutMs = 5000, staleMs = 15000) {
  const lock = stateLockPath();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try { writeFileSync(fd, String(process.pid)); } catch {}
      try { closeSync(fd); } catch {}
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

function releaseStateLock() {
  try { unlinkSync(stateLockPath()); } catch {}
}

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
 * @property {string|null} delivery   in-turn | injected | not-live | failed:<msg>
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
  mutate((state) => { state.requests[request.id] = request; return true; });
  log({ op: "relay-create", id: request.id, sessionId: request.sessionId });
  return request;
}

export function formatSessionList(sessions, bound) {
  const rows = sessions.map((row) => {
    const mark = bound && bound.sessionId === row.sessionId ? "当前" : "";
    return [String(row.index), String(sessionCode(row.sessionId)), row.sessionId.replace(/^session-/, "").slice(0, 8), new Date(row.mtime).toLocaleString("zh-CN", { hour12: false }).slice(5, 16), mark];
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

/** 取会话码；没登记过的会话按递增分配（1..99），并持久化。 */
export function sessionCode(sessionId) {
  const id = String(sessionId ?? "");
  if (!id) return null;
  const registry = loadRegistry();
  const existing = registry.bySession[id];
  if (existing && Number.isInteger(existing.code)) return existing.code;
  const used = new Set(Object.values(registry.bySession).map((item) => item.code));
  let code = 1;
  while (used.has(code) && code <= 99) code += 1;
  registry.bySession[id] = { code, createdAt: Date.now() };
  registry.nextCode = Math.max(Number(registry.nextCode) || 1, code + 1);
  saveRegistry(registry);
  log({ op: "session-code", sessionId: id, code });
  return code;
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
  const matched = text.match(/^([0-9]{1,2})(?:\s+([\s\S]*))?$/);
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
  const registry = loadRegistry();
  const entry = registry.bySession[id] ?? { code: sessionCode(id), createdAt: Date.now() };
  entry.label = String(label ?? "").slice(0, 40);
  registry.bySession[id] = entry;
  saveRegistry(registry);
  log({ op: "session-label", sessionId: id, label: entry.label });
  return entry;
}

export function sessionLabel(sessionId) {
  const registry = loadRegistry();
  const entry = registry.bySession[String(sessionId ?? "")];
  return entry?.label ?? "";
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
    name: sessionLabel(row.sessionId) || (String(row.workspace).split(/[\\/]/).filter(Boolean).pop() || "会话") + "·" + row.sessionId.replace(/^session-/, "").slice(0, 6),
  }));
}

/** 会话清单（字符表格 + 明确的回复格式说明）。 */
export function formatSessionListV2(sessions) {
  const rows = sessions.map((row) => [
    String(row.code),
    String(row.name).slice(0, 14),
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
  const head = req.mode === "approval" ? "需要批准" : (req.kind === "question" ? "需要回答" : "需要确认");
  const minutes = Math.max(1, Math.round((req.expiresAt - req.createdAt) / 60000));
  const lines = [];
  lines.push("【" + head + "】会话码 " + sessionCode(req.sessionId) + " · 识别码 " + code);
  lines.push("──────────────");
  const meta = [];
  if (req.title) meta.push(req.title);
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
  lines.push("有效期 " + minutes + " 分钟");
  return lines.join("\n");
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
  lines.push("识别码 " + code + " 对应：");
  lines.push("　" + String(req.question).slice(0, 60));
  lines.push("");
  lines.push("请回「识别码 空格 选项」：" + examples);
  return lines.join("\n");
}

/** 多个待确认且用户回复有歧义时的提示（多层列表）。 */
export function formatAmbiguous(candidates) {
  const lines = [];
  // 2026-10-29：提示里必须带空格。以前写「例：11」教用户粘连，正好撞上 2 位会话码。
  lines.push("有 " + candidates.length + " 个待确认，请用「识别码 空格 选项」回复");
  lines.push("");
  for (const req of candidates.slice(0, 5)) {
    const code = handleText(req);
    lines.push("　" + code + " · " + String(req.question).slice(0, 24));
    lines.push("　　　选项：" + req.options.map((option) => code + " " + option.key + "=" + option.label).join("　"));
  }
  lines.push("");
  lines.push("例：" + handleText(candidates[0]) + " " + (candidates[0].options[0]?.key ?? "1") + "（中间要有空格）");
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
        const prefixWidth = lineWidth - acc + widths[i];
        if (prefixWidth < width * 0.35) break; // 前半段太短就没有意义，宁可硬断
        cut = i;
      }
      if (cut >= 0 && cut < chars.length - 1) {
        out.push(chars.slice(0, cut + 1).join(""));
        line = chars.slice(cut + 1).join("") + ch;
        w = [...line].reduce((n, c) => n + weight(c), 0);
      } else {
        out.push(line);
        line = ch;
        w = cw;
      }
    } else { line += ch; w += cw; }
  }
  if (line.length > 0) out.push(line);
  return out;
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
export function stripWechatNoise(input) {
  let t = String(input ?? "");
  t = t.replace(/https?:\/\/\S+/g, "");
  t = t.replace(/[A-Za-z]:\\[^\s，。；、)]+/g, "");
  t = t.replace(/\b[A-Z]{2,}-\d+\b/g, "");
  t = t.replace(/`([^`]*)`/g, "$1");
  t = t.replace(/[（(]\s*[^（()）]{0,40}(?:\d+\s*(?:条|项|个|张|行|字|%))[^（()）]{0,40}[）)]/g, "");
  t = t.replace(/\d+\s*(?=条|项|个|张|行|字)/g, "若干");
  t = t.replace(/\d+(?:\.\d+)?%/g, "");
  // 代码标识符 / 英文技术词对微信读者无意义
  t = t.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gi, "");
  t = t.replace(/\b[A-Za-z]{5,}\b/g, "");
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
export function formatTurnEnd(input) {
  const seconds = Number.isFinite(input.durationMs) ? Math.round(input.durationMs / 1000) : null;
  const code = sessionCode(input.sessionId);
  const sid = String(input.sessionId ?? "").replace(/^session-/, "").slice(0, 8);
  const lines = [];
  lines.push("【回合结束】" + (seconds === null ? "" : seconds + " 秒"));
  lines.push((code === null ? "" : "码 " + code + " · ") + "会话 " + sid);
  lines.push("────────────");
  const summary = toWechatText(String(input.summary ?? ""), 120, { singleLine: true });
  if (summary) for (const line of wrapCjk("任务：" + summary, WECHAT_WIDTH)) lines.push(line);
  if (input.text) {
    // 微信侧只留「已处理 / 进度 / 需决策」：用户明确要求剔除数字与技术细节，
    // 且桌面版微信不保证渲染换行，长文在这里就是纯噪音（2026-10-27 反馈）。
    let digest = distillForWechat(String(input.text));
    // 压缩后可能一条都不剩（正文全是标题/编号），此时退回原始前两行，别让「结果」空着
    if (digest.length === 0) {
      const fallback = toWechatText(String(input.text), 240).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0).slice(0, 2);
      digest = fallback.flatMap((line) => wrapCjk("・" + line, WECHAT_WIDTH - 2));
    }
    if (digest.length > 0) {
      lines.push("结果：");
      for (const line of digest.slice(0, 4)) lines.push(line.replace(/[ \u3000]+$/, ""));
    }
  }
  lines.push("");
  const hint = code === null ? "细节在本会话里" : "回复 " + code + " <内容> 可继续，细节在本会话";
  for (const line of wrapCjk(hint, WECHAT_WIDTH)) lines.push(line);
  return lines.join("\n");
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
export function outboxTag(entry) {
  // 出口统一清洗 Markdown（模型回答里常带 # 标题、竖线表格、加粗）
  const text = toWechatText(entry?.text ?? "");
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
export async function pushWechat(text, target = PATHS.target, options = {}) {
  // 三态开关：只有 running 才真的发。paused/stopped 一律抑制并审计，
  // 避免「暂停了还在发」或「关了服务又被队列补发」。
  const control = getControl();
  if (control.state !== "running") {
    log({ op: "push-suppressed", state: control.state, preview: String(text ?? "").slice(0, 120) });
    return { ok: false, suppressed: true, state: control.state, output: "suppressed:" + control.state, mode: "suppressed" };
  }
  const direct = options.direct === true || process.env.DSH_WECHAT_HITL_EGRESS === "direct";
  if (direct) {
    const run = await runToFile(PATHS.node, [PATHS.openclawMjs, "message", "send", "--channel", PATHS.channel, "--target", target, "-m", outboxTag({ text, sessionId: options.sessionId ?? null })], {
      cwd: PATHS.workdir,
      timeoutMs: options.timeoutMs ?? 120000,
    });
    const output = run.output.trim().slice(-800);
    const ok = run.code === 0 && !/\b(EPERM|failed|error)\b/i.test(output);
    log({ op: "push-direct", ok, code: run.code, output: output.slice(-300) });
    return { ok, code: run.code, output, mode: "direct" };
  }
  const entry = { id: "out-" + Date.now() + "-" + randomBytes(3).toString("hex"), text, target, createdAt: Date.now(), attempts: 0, sessionId: options.sessionId ?? null };
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
let inprocEgress = null;
let inprocState = "unknown";

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
    const contextToken = mod.getContextToken(WEIXIN_ACCOUNT_ID, target);
    // contextToken 缺失是微信平台限制（bot 只能回最近发过消息的人），必须让上层走「等 token」逻辑
    if (!contextToken) return { ok: false, output: "contextToken missing for " + target };
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
      if (!item.needsContext) continue;
      item.needsContext = false;
      item.contextMissingAt = 0;
      item.nextAttemptAt = 0;
      item.claimedAt = 0;
      released += 1;
    }
    return released > 0;
  });
  if (released > 0) log({ op: "outbox-hold-released", count: released });
  return released;
}

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
  let sent = 0;
  let failed = 0;
  let dropped = 0;
  for (const entry of queue.slice(0, 10)) {
    const disposition = outboxEntryDisposition(entry);
    if (disposition === "drop-ttl" || disposition === "drop-context-expired") {
      // 丢弃必须留痕：原先这里静默移除，日志里查不到「这条为什么没收到」。
      // 两种原因分开记：ttl = 普通积压超时；context-expired = 等 token 等到 24h 上限。
      mutate((fresh) => { fresh.outbox = (fresh.outbox || []).filter((item) => item.id !== entry.id); return true; });
      dropped += 1;
      log({
        op: "outbox-dropped",
        id: entry.id,
        reason: disposition === "drop-ttl" ? "ttl" : "context-expired",
        ageMs: Date.now() - Number(entry.createdAt ?? 0),
        ttlMs: disposition === "drop-ttl" ? DEFAULT_TTL_MS : CONTEXT_HOLD_MS,
        createdAt: Number(entry.createdAt ?? 0),
        sessionId: entry.sessionId ?? null,
        preview: String(entry.text ?? "").slice(0, 80),
      });
      continue;
    }
    if (disposition === "hold-context") {
      // ISSUE-001：等 token 的条目**豁免 30 分钟 TTL**，改由 contextMissingAt 的 24h 窗口管；
      // 但发送要节流，否则每 2 秒一次 prepare failed 会把日志刷爆（实测 04:15 段）。
      if (Number(entry.nextAttemptAt ?? 0) > Date.now()) continue;
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
    const sendTo = entry.target || PATHS.target;
    const egressMode = getOutboxEgressMode();
    let run;
    // 三级出口：① 插件注入的发送器 ② 本模块自己的进程内发送 ③ 子进程 CLI（兜底）
    let senderFn = null;
    if (egressMode === "inproc") {
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
    } else {
      run = await runToFile(PATHS.node, [PATHS.openclawMjs, "message", "send", "--channel", PATHS.channel, "--target", sendTo, "-m", payload], {
        cwd: PATHS.workdir,
        timeoutMs: 90000,
      });
      run.mode = "cli";
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
      // contextToken 缺失（微信 bot 只能回复「最近发过消息的人」）不是可重试的瞬时错误：
      // 反复重试只会把消息耗尽丢掉。这里改成「保留 + 标记」，等用户下一次入站刷新 token 后自动补发。
      const needsContext = /contextToken|prepare failed/i.test(run.output || "");
      mutate((fresh) => {
        const target = (fresh.outbox || []).find((item) => item.id === entry.id);
        if (!target) return false;
        if (needsContext) {
          target.needsContext = true;
          target.contextMissingAt = target.contextMissingAt ?? Date.now();
          target.lastError = "contextToken missing";
          // 节流：60 秒内不再重试，避免每 2 秒一次 prepare failed 刷日志
          target.nextAttemptAt = Date.now() + CONTEXT_RETRY_COOLDOWN_MS;
          // 释放租约：否则要等 CLAIM_LEASE_MS 才被回收，重试节奏被租约主导，
          // 审计里 5 条积压每条被重试 158–163 次就是这么来的（2026-10-29）。
          target.claimedAt = 0;
          // 保留窗口与丢弃判定已统一到 outboxEntryDisposition()（CONTEXT_HOLD_MS），此处不再重复删除
          return true;
        }
        target.attempts = attempts;
        target.lastError = run.output.slice(-200);
        target.claimedAt = 0;   // 失败也立即放租约，别让下一条排队等 3 分钟
        if (attempts >= 5) fresh.outbox = fresh.outbox.filter((item) => item.id !== entry.id);
        return true;
      });
      log({ op: needsContext ? "outbox-wait-context" : "outbox-failed", id: entry.id, attempts, output: run.output.slice(-160) });
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

/** 从 dsh --json 的 NDJSON 里取最终回答与会话 id。 */
export function parseNdjson(stdout) {
  let sessionId = null;
  let finalText = null;
  let lastText = null;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (event.type === "session" && event.sessionId) sessionId = event.sessionId;
    if (event.type === "text" && typeof event.text === "string") lastText = event.text;
    if (event.type === "final" && typeof event.text === "string") finalText = event.text;
  }
  return { sessionId, text: finalText ?? lastText };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
