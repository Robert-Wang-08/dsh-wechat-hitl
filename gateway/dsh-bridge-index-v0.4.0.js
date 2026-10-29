/**
 * dsh-bridge v0.4.0 — 微信 <-> DSH 桥（入站转发 + 出站唯一出口 + 人工确认回环）。
 *
 * 相比 v0.3.0 的三处新增：
 *   1. 出站出口（outbox pump）：DSH 会话在沙箱里无法直接跑 openclaw（EPERM），
 *      所以 DSH 侧只把要发的消息写进共享状态文件的发件箱；本插件每 2 秒取一次并真正发出。
 *      于是「微信出站唯一出口 = 网关进程」，DSH 侧零权限要求。
 *   2. 答复拦截：微信入站文本先与待确认请求表匹配；命中即标记答复并交给 DSH 插件注入原会话，
 *      不再当作新任务去 spawn 一个全新回合。
 *   3. 兜底回注：若 DSH 侧插件没能在 12 秒内交付（会话不在活的宿主里），
 *      直接跑 dsh --profile headless --session-id <原会话> 把答复续进原会话。
 *
 * 未改动：<=150s 快路径内联回复；超过则先回执再异步推送（20 分钟硬上限）。
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const MAP_FILE = "C:/Users/wwm_1/.openclaw/state/dsh-bridge-sessions.json";
const DEBUG_FILE = "C:/Users/wwm_1/.openclaw/state/dsh-bridge-debug.log";
const NODE = "C:/openclaw-runtime/node.exe";
const OPENCLAW = "C:/openclaw-runtime/openclaw.cmd";
const DSH_BIN = "C:/Users/wwm_1/AppData/Local/nvm/v24.18.0/node_modules/@deepseek-ai/dsh/lib/bin.js";
const WORKDIR = "D:/nutstore/1.logseq";
const FAST_PATH_MS = 150000;      // 150s 内完成则直接回复
const HARD_CAP_MS = 20 * 60000;   // 异步任务 20 分钟硬上限
// 共享状态层唯一实现（与 DSH 侧插件、CLI 同一份）；可用 DSH_WECHAT_HITL_LIB 覆盖。
const HITL_MODULE = process.env.DSH_WECHAT_HITL_LIB || "file:///D:/src/dsh/dsh-wechat-hitl/lib/hitl-store.js";
const OUTBOX_POLL_MS = 2000;
const DELIVERY_WAIT_MS = 12000;

let hitl = null;
const hitlReady = import(HITL_MODULE)
  .then((mod) => { hitl = mod; return mod; })
  .catch((error) => { dbg({ hitl: "import-failed", error: String(error) }); return null; });

function dbg(obj) {
  try { appendFileSync(DEBUG_FILE, new Date().toISOString() + " " + JSON.stringify(obj).slice(0, 3000) + "\n"); } catch {}
}
function loadMap() { try { return JSON.parse(readFileSync(MAP_FILE, "utf8")); } catch { return {}; } }
function saveMap(m) { try { writeFileSync(MAP_FILE, JSON.stringify(m, null, 2)); } catch {} }

function startDsh(sessionId, text) {
  const args = [DSH_BIN, "--profile", "headless", "--json"];
  if (sessionId) args.push("--session-id", sessionId);
  args.push(text);
  const child = spawn(NODE, args, { cwd: WORKDIR, env: { ...process.env, DSH_WECHAT_HITL_SKIP: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  const st = { out: "", err: "", done: false, code: null, timedOut: false, child };
  child.stdout.on("data", (d) => { st.out += d.toString(); });
  child.stderr.on("data", (d) => { st.err += d.toString(); });
  const timer = setTimeout(() => { st.timedOut = true; try { child.kill(); } catch {} }, HARD_CAP_MS);
  child.on("error", (e) => { st.done = true; st.code = -1; st.err += " spawn:" + e.message; clearTimeout(timer); });
  child.on("close", (code) => { st.done = true; st.code = code; clearTimeout(timer); });
  return st;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDone(st, ms) { const t0 = Date.now(); while (!st.done && Date.now() - t0 < ms) await wait(500); return st.done; }

/**
 * dsh --profile headless 在回合结束后可能长时间不退出（残余句柄，实测 >90s），
 * 因此不能只等 close：NDJSON 里出现 {"type":"final"} 即视为回合完成。
 * @returns {Promise<boolean>} 是否在超时前拿到最终回答
 */
async function waitForFinal(st, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (/\{"type":"final"/.test(st.out)) {
      try { st.child?.kill?.(); } catch {}
      return true;
    }
    if (st.done && /\{"type":"final"/.test(st.out)) return true;
    if (st.done) return false;
    await wait(400);
  }
  return false;
}

function parseNdjson(stdout) {
  let sessionId = null, finalText = null, lastText = null;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev; try { ev = JSON.parse(t); } catch { continue; }
    if (ev.type === "session" && ev.sessionId) sessionId = ev.sessionId;
    if (ev.type === "text" && typeof ev.text === "string") lastText = ev.text;
    if (ev.type === "final" && typeof ev.text === "string") finalText = ev.text;
  }
  return { sessionId, text: finalText ?? lastText };
}

function resolveTarget(event, ctx) {
  // v0.4.0 修正：旧实现只看 replyTo/conversationId/peerId/from/sessionKey（= agent:main:main），
  // 因此慢路径异步推送一直拿不到 target（debug 日志里 asyncSend skip target:false）。
  // 实测 ctx 里真正带微信身份的是 chatId / senderId / channelId。
  const cand = [ctx?.chatId, ctx?.senderId, ctx?.replyTo, ctx?.conversationId, ctx?.peerId, ctx?.from, event?.conversationId, event?.from];
  for (const c of cand) { if (typeof c === "string" && c.includes("@im.wechat")) return c; }
  const sk = String(ctx?.sessionKey ?? event?.sessionKey ?? "");
  const m = sk.match(/[A-Za-z0-9_-]+@im\.wechat/);
  return m ? m[0] : (typeof ctx?.chatId === "string" ? ctx.chatId : null);
}

function sendAsync(target, text) {
  if (!target || !text) { dbg({ asyncSend: "skip", target: !!target, hasText: !!text }); return; }
  const child = spawn(OPENCLAW, ["message", "send", "--channel", "openclaw-weixin", "--target", target, "-m", text], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => { err += d.toString(); });
  child.on("close", (code) => dbg({ asyncSend: "done", code, err: err.slice(-300) }));
}

// ── 出站出口：把 DSH 侧写进发件箱的消息真正发出 ──────────────────────────
let draining = false;
let pumpTicks = 0;
let pumpDiagDone = false;
async function pumpOutbox() {
  pumpTicks += 1;
  if (pumpTicks % 30 === 1) dbg({ outbox: "tick", ticks: pumpTicks, ready: !!hitl, draining });
  if (draining || !hitl) return;
  if (!pumpDiagDone) {
    pumpDiagDone = true;
    let probe = null, probeFile = null;
    try { probeFile = hitl.STATE_FILE ?? null; probe = (hitl.loadState()?.outbox ?? []).length; }
    catch (error) { probe = "error:" + String(error); }
    dbg({ hitl: "pump-ready", stateDir: (() => { try { return hitl.PATHS?.stateDir ?? null; } catch { return "n/a"; } })(),
      stateFile: probeFile, outboxLen: probe,
      envState: process.env.DSH_WECHAT_HITL_STATE ?? null,
      cwd: (() => { try { return process.cwd(); } catch { return "n/a"; } })() });
  }
  draining = true;
  try {
    const queueLength = (hitl.loadState().outbox ?? []).length;
    if (queueLength > 0) dbg({ outbox: "draining", queueLength });
    const result = await hitl.drainOutbox();
    if (result.sent || result.failed) dbg({ outbox: result });
  } catch (error) {
    dbg({ outbox: "error", error: String(error) });
  } finally {
    draining = false;
  }
}

const queues = new Map();
function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(key, next.finally(() => { if (queues.get(key) === next) queues.delete(key); }));
  return next;
}

/** 等 DSH 侧插件交付（inject）；审批类在回合内消化，不需要等。 */
async function waitDelivery(requestId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const fresh = hitl.getRequest(requestId);
    if (fresh && fresh.deliveredAt) return fresh;
    await wait(400);
  }
  return hitl.getRequest(requestId);
}

function runInBackground(requestId, st, target) {
  return waitForFinal(st, HARD_CAP_MS).then(() => {
    const parsed = parseNdjson(st.out);
    // 标签拆分（2026-10-29）：headless 续跑不是进程内注入，别再把两者混记成 injected。
    try { hitl.markDelivered(requestId, parsed.text ? "headless-bg" : "not-live"); } catch {}
    sendAsync(target, parsed.text ?? "[DSH 无输出] exit=" + st.code);
  });
}

/**
 * 一次延迟重试：not-live 之后隔 60 秒再用 headless 续跑一次。
 *
 * 为什么需要：hasSessionController 恒为 false，非审批答复只能靠 headless 续跑；
 * 会话被 GUI 占着写锁时会立刻失败。以前只回一句「无法接收」，用户不知道答复会不会丢。
 * 这里补一次真实重试，让「稍后自动重试」这句话是有代码支撑的。
 */
function retryLater(requestId, sessionId, prompt, target, delayMs = 60000) {
  const timer = setTimeout(() => {
    try {
      const fresh = hitl?.getRequest?.(requestId);
      if (fresh?.deliveredAt) return;                    // 期间已交付，不重复跑
      const st = startDsh(sessionId, prompt);
      waitForFinal(st, FAST_PATH_MS).then(() => {
        const parsed = parseNdjson(st.out);
        if (parsed.text) {
          hitl.markDelivered(requestId, "headless-bg");
          sendAsync(target, parsed.text);
          dbg({ hitl: "retry-ok", id: requestId });
        } else {
          dbg({ hitl: "retry-empty", id: requestId, code: st.code });
        }
      }).catch(() => {});
    } catch (error) { dbg({ hitl: "retry-error", id: requestId, error: String(error) }); }
  }, delayMs);
  try { timer.unref?.(); } catch {}
}

/**
 * 微信侧「遥控器」命令：
 *   /l 或 列表   -> 列出可驱动会话（编号）
 *   /s 3 或 切 3 -> 绑定第 3 个会话
 *   /a 或 自动   -> 取消绑定，回到默认的 wx- 专属会话
 * 返回 null 表示不是命令。
 */
async function handleControlCommand(text) {
  if (!hitl) return null;
  const raw = String(text ?? "").trim();
  const lower = raw.toLowerCase();
  if (["/l", "/list", "列表", "会话列表"].includes(lower)) {
    const sessions = hitl.listSessionsV2(10);
    if (sessions.length === 0) return "当前没有可驱动的会话。";
    return hitl.formatSessionListV2(sessions);
  }
  if (["/help", "/h", "帮助", "怎么回"].includes(lower)) {
    return hitl.formatSessionListV2(hitl.listSessionsV2(10));
  }
  if (["/a", "/auto", "自动", "取消绑定"].includes(lower)) {
    hitl.clearBinding("wechat");
    return "已取消绑定，后续微信消息走默认的 wx- 会话。";
  }
  const nameMatch = raw.match(/^\/(?:name|命名)\s*([0-9]{1,2})\s*(.+)$/i);
  if (nameMatch) {
    const hit = hitl.sessionByCode(nameMatch[1]);
    if (!hit) return "没有回复id " + nameMatch[1] + "，发 /l 看清单。";
    hitl.setSessionLabel(hit.sessionId, nameMatch[2].trim());
    return "已把回复id " + nameMatch[1] + " 命名为「" + nameMatch[2].trim() + "」。";
  }
  const bindMatch = raw.match(/^(?:\/(?:s|bind)|切|绑定)\s*([0-9]{1,2})$/i);
  if (bindMatch) {
    const sessions = hitl.listSessions(8);
    const picked = hitl.pickSession(bindMatch[1], sessions);
    if (!picked) return "没找到第 " + bindMatch[1] + " 个会话，发 /l 看列表。";
    hitl.setBinding(picked.sessionId, "微信驱动", "wechat");
    return "已绑定到会话 " + picked.sessionId.replace(/^session-/, "").slice(0, 8) + "。之后你发的普通消息都会转给这个会话；发 /a 取消。";
  }
  return null;
}

/** 绑定会话后，把普通消息转发进那个会话（进程内注入优先，headless 兜底）。 */
async function relayToBoundSession(text, target, binding) {
  const request = hitl.buildMessageRequest({ sessionId: binding.sessionId, text, context: "来自微信 · 绑定会话" });
  dbg({ hitl: "relay-created", id: request.id, sessionId: binding.sessionId });
  const delivered = await waitDelivery(request.id, DELIVERY_WAIT_MS);
  if (delivered?.deliveredAt && String(delivered.delivery ?? "").startsWith("injected")) {
    return "已转给会话 " + binding.sessionId.replace(/^session-/, "").slice(0, 8) + "，它跑完会把结果推给你。";
  }
  dbg({ hitl: "relay-fallback", id: request.id, delivery: delivered?.delivery ?? null });
  const st = startDsh(binding.sessionId, text);
  const finished = await waitForFinal(st, FAST_PATH_MS);
  const parsed = parseNdjson(st.out);
  if (finished && parsed.text) {
    hitl.markDelivered(request.id, "headless-fast");
    return "已转给会话 " + binding.sessionId.replace(/^session-/, "").slice(0, 8) + "：" + "\n\n" + parsed.text;
  }
  if (!finished) {
    runInBackground(request.id, st, target).catch(() => {});
    return "已转给会话，正在后台跑，完成后单独推结果。";
  }
  hitl.markDelivered(request.id, "not-live");
  retryLater(request.id, binding.sessionId, text, target);
  return "会话当前收不了（可能正被界面占用），消息已记下；60 秒后自动重试一次，重试成功会直接把结果推给你。";
}


/**
 * 「会话码 + 内容」路由（用户要求：每条回话都带会话码）。
 *   3 1        -> 会话码 3 的待确认选第 1 项
 *   3 帮我跑测试 -> 把「帮我跑测试」转发进会话码 3 的会话
 *   3          -> 看会话码 3 的状态（有没有待确认）
 * 返回 null 表示这条消息没有会话码，交回原有逻辑。
 */
async function handleCodedReply(text, target) {
  if (!hitl) return null;
  // REQ-002：微信侧切换「结果推送」总开关。
  // 必须排在会话码路由之前，但解析是「整条消息严格匹配」，所以不会抢走「1 帮我跑测试」这类驱动。
  const pushCmd = typeof hitl.parsePushCommand === "function" ? hitl.parsePushCommand(text) : null;
  if (pushCmd) {
    if (pushCmd.action === "status") return hitl.describeResultPush();
    const result = hitl.setResultPush(pushCmd.action === "on", { by: "wechat", reason: "微信侧指令" });
    return (result.to ? "🟢 结果推送：已开" : "🟡 结果推送：已关") +
      "（" + (result.from ? "开" : "关") + " → " + (result.to ? "开" : "关") + "）" +
      "\n审批与提问推送不受影响。";
  }
  const routed = hitl.resolveByCode(text, hitl.listPending());
  if (routed.kind === "no-code") return null;
  if (routed.kind === "unrecognized-concat") {
    // 用户口径（2026-10-29）：连写不猜，回未识别 + 正确写法。
    const req = routed.request;
    const handle = hitl.handleText(req);
    const examples = req.options.map((option) => handle + " " + option.key).join(" / ");
    return "未识别「" + routed.code + "」：连写会跟会话码混淆，所以不做猜测。\n" +
      "请用「识别码 空格 选项」回复，例：" + examples;
  }
  if (routed.kind === "unknown-code") {
    const sessions = hitl.listSessions(8);
    return "没有回复id " + routed.code + "。\n\n" + hitl.formatSessionListV2(hitl.listSessionsV2(10));
  }
  if (routed.kind === "status") return hitl.formatSessionStatus(routed.sessionId);
  if (routed.kind === "answer-ambiguous") return hitl.formatAmbiguous(routed.candidates);
  if (routed.kind === "relay") {
    // 用户回「37 1」时若那条确认已过期，过去会被静默转成普通消息，用户以为批复生效了
    // （2026-10-29 实测：回复晚到 5 分钟 → 过期 → 被 relay → 会话又提权 → 又推一条）。
    // 现在明确告诉他：这条确认已不存在，转达内容仍然送给会话。
    const numeric = /^[0-9]{1,2}(\s+[0-9]{1,2})?$/.test(String(routed.text ?? "").trim());
    const relayed = await relayToBoundSession(routed.text, target, { sessionId: routed.sessionId });
    if (!numeric) return relayed;
    return "这条确认已经不在了（可能已过期或被处理），所以没有当成批准。\n" +
      "已把你的内容作为普通消息转给该会话。\n" +
      (relayed ? "" : "") + "如果还需要批准，会话会再发一条新的确认——看首行 R 编号区分。";
  }

  const request = routed.request;
  const updated = hitl.markAnswered(request.id, { ...routed.option, raw: text }, "wechat") ?? request;
  const delivered = await waitDelivery(request.id, DELIVERY_WAIT_MS);
  if (delivered?.deliveredAt && String(delivered.delivery ?? "").startsWith("injected")) {
    return hitl.formatResolved(updated) + "\n（答复已注入原会话，正在继续执行。）";
  }
  const prompt = hitl.buildContinuationPrompt(updated);
  const st = startDsh(request.sessionId, prompt);
  const finished = await waitForFinal(st, FAST_PATH_MS);
  const parsed = parseNdjson(st.out);
  if (finished && parsed.text) {
    hitl.markDelivered(request.id, "headless-fast");
    return hitl.formatResolved(updated) + "\n\n" + parsed.text;
  }
  if (!finished) {
    runInBackground(request.id, st, target).catch(() => {});
    return hitl.formatResolved(updated) + "\n已交给原会话继续跑，完成后单独推结果。";
  }
  hitl.markDelivered(request.id, "not-live");
  retryLater(request.id, request.sessionId, prompt, target);
  return hitl.formatResolved(updated) + "\n原会话当前收不了（可能正被界面占用）；60 秒后自动重试一次，成功会直接把结果推给你。";
}

/** 入站文本命中待确认请求时的处理；返回 null 表示不拦截（走普通任务路径）。 */
async function handleHumanReply(text, target) {
  if (!hitl) return null;
  let pending;
  try { pending = hitl.listPending(); } catch (error) { dbg({ hitl: "list-failed", error: String(error) }); return null; }
  if (pending.length === 0) {
    // 没有待确认请求：若绑定了某个会话，把这条消息当作遥控指令转发进去
    const binding = hitl.getBinding();
    if (binding && binding.sessionId) return relayToBoundSession(text, target, binding);
    return null;
  }
  const matched = hitl.matchReply(text, pending);
  dbg({ hitl: "match", pending: pending.length, ok: matched.ok, reason: matched.reason ?? null, raw: text.slice(0, 60) });
  if (!matched.ok) {
    if (pending.length === 0) {
      // 没有待确认请求：若绑定了某个会话，把这条消息当作「遥控指令」转发进去
      const binding = hitl.getBinding();
      if (binding?.sessionId) return relayToBoundSession(text, target, binding);
      return null;
    }
    // 只回了识别码、没带选项：直接把「码 + 选项」的写法告诉他，别当成答非所问
    if (matched.reason === "need-option" && matched.request) return hitl.formatNeedOption(matched.request);
    if (matched.reason === "ambiguous" || matched.reason === "nomatch") return hitl.formatAmbiguous(matched.candidates ?? pending);
    return null;
  }
  const request = matched.request;
  const updated = hitl.markAnswered(request.id, { ...matched.option, raw: text }, "wechat") ?? { ...request, answer: matched.option };
  if (request.mode === "approval") {
    return hitl.formatResolved(updated) + "\n（该批准已在原回合内生效，DSH 会继续执行。）";
  }
  const delivered = await waitDelivery(request.id, DELIVERY_WAIT_MS);
  if (delivered?.deliveredAt && String(delivered.delivery ?? "").startsWith("injected")) {
    return hitl.formatResolved(updated) + "\n（答复已注入原会话，正在继续执行。）";
  }
  // 兜底：原会话不在活的宿主里（或注入失败）→ 直接 headless 续跑
  dbg({ hitl: "fallback-headless", id: request.id, delivery: delivered?.delivery ?? null });
  const prompt = hitl.buildContinuationPrompt(request);
  await wait(300);
  const st = startDsh(request.sessionId, prompt);
  const finished = await waitForFinal(st, FAST_PATH_MS);
  const parsed = parseNdjson(st.out);
  if (finished && parsed.text) {
    hitl.markDelivered(request.id, "headless-fast");
    return hitl.formatResolved(updated) + "\n\n" + parsed.text;
  }
  const tail = (st.err || "").trim().split(/\r?\n/).pop() || "";
  if (/writer|owned|lock|already/i.test(st.err || "")) {
    hitl.markDelivered(request.id, "not-live");
    return hitl.formatResolved(updated) + "\n⚠️ 原会话正在 DSH 界面里运行（会话写入锁被占用），答复已记录；请在界面继续该会话，或等它空闲后重发一次。";
  }
  if (!finished) {
    runInBackground(request.id, st, target).catch(() => {});
    return hitl.formatResolved(updated) + "\n⏳ 原会话已收到答复并在后台继续，完成后单独推送结果。";
  }
  hitl.markDelivered(request.id, "not-live");
  retryLater(request.id, request.sessionId, prompt, target);
  return hitl.formatResolved(updated) + "\n[续跑无输出] exit=" + st.code + (tail ? " stderr=" + tail.slice(-200) : "") +
    "\n60 秒后自动重试一次。";
}

export default definePluginEntry({
  id: "dsh-bridge", name: "DSH Bridge",
  register(api) {
    // 出站泵：插件加载即启动，随网关生命周期存在。
    // 出站泵延迟启动：网关刚起来时 weixin 通道还在初始化，
    // 过早发起 sendMessage 会与之抢资源（实测会把通道插件“强制退役”，
    // 之后所有发送都报 sendMessage ret=-2 prepare failed）。
    const PUMP_START_DELAY_MS = 45000;
    setInterval(() => { pumpOutbox().catch(() => {}); }, OUTBOX_POLL_MS);
    setTimeout(() => { pumpOutbox().catch(() => {}); }, PUMP_START_DELAY_MS);
    dbg({ boot: "dsh-bridge 0.4.0", outboxPollMs: OUTBOX_POLL_MS, pumpStartDelayMs: 45000,
      // 诊断：泵读的到底是哪个 state 文件（路径错位时会静默空转，必须留痕）
      hitlStateDir: (() => { try { return hitl?.PATHS?.stateDir ?? null; } catch { return "n/a"; } })(),
      hitlStateFile: (() => { try { return hitl?.STATE_FILE ?? null; } catch { return "n/a"; } })(),
      hitlOutboxAtBoot: (() => { try { return (hitl?.loadState()?.outbox ?? []).length; } catch (error) { return "error:" + String(error); } })() });

    api.on("before_agent_reply", async (event, ctx) => {
      const text = String(event?.cleanedBody ?? event?.body ?? "").trim();
      if (!text) return undefined;
      // 入站即刷新：用户随手发一句话就会刷新微信 bot 的 contextToken，
      // 这时立刻把因缺 token 而滞留的积压补发出去（相当于「预热」的自愈形态）。
      // 入站 = contextToken 刷新信号：先解开「等 token」的持有，再立刻补发。
      // 没有这一步，补发要等 30 分钟兜底冷却（2026-10-29 审计）。
      try {
        if (hitl) {
          const backlog = (hitl.loadState().outbox ?? []).filter((item) => item.needsContext).length;
          if (backlog > 0) {
            const released = typeof hitl.releaseContextHold === "function" ? hitl.releaseContextHold() : 0;
            dbg({ hitl: "flush-on-inbound", backlog, released });
            pumpOutbox().catch(() => {});
          }
        }
      } catch {}
      const target = resolveTarget(event, ctx);
      const rawKey = String(ctx?.sessionKey ?? event?.sessionKey ?? "wx-default");
      const mapKey = rawKey.replace(/[^A-Za-z0-9_-]+/g, "-").slice(-60);
      dbg({ hook: "fire", sessionKey: rawKey, sample: text.slice(0, 60) });

      // 1) 人工确认回环：命中待确认请求就不走新任务路径
      try {
        await hitlReady;
        const command = await handleControlCommand(text);
        if (command !== null) return { handled: true, reply: { text: command } };
        const coded = await handleCodedReply(text, target);
        if (coded !== null) return { handled: true, reply: { text: coded } };
        const human = await handleHumanReply(text, target);
        if (human !== null) return { handled: true, reply: { text: human } };
      } catch (error) {
        dbg({ hitl: "handler-error", error: String(error) });
      }

      // 2) 原有路径：把整条消息交给 DSH 会话（快路径内联 / 慢路径异步推送）
      const run = enqueue(mapKey, async () => {
        const map = loadMap();
        let st = startDsh(map[mapKey] || null, text);
        await waitDone(st, 30000);
        if (!st.done && /does not exist/.test(st.err)) { try { st.child?.kill?.(); } catch {} st = startDsh(null, text); }
        else if (st.done && /does not exist/.test(st.err)) { st = startDsh(null, text); }
        await waitForFinal(st, HARD_CAP_MS);
        const parsed = parseNdjson(st.out);
        if (parsed.sessionId) { const m2 = loadMap(); if (m2[mapKey] !== parsed.sessionId) { m2[mapKey] = parsed.sessionId; saveMap(m2); } }
        if (st.timedOut) return "[DSH 超时] 任务超过 20 分钟未完成。";
        if (parsed.text) return parsed.text;
        const tailErr = (st.err || "").trim().split(/\r?\n/).pop() || "";
        return "[DSH 无输出] exit=" + st.code + (tailErr ? " stderr=" + tailErr.slice(-300) : "");
      });

      const fast = await Promise.race([run, wait(FAST_PATH_MS).then(() => null)]);
      if (fast !== null) return { handled: true, reply: { text: fast } };
      run.then((finalText) => sendAsync(target, finalText));
      return { handled: true, reply: { text: "⏳ 收到，这个任务比较重，处理完成后我会主动把结果发你（最多等 20 分钟）。" } };
    }, { eligibleTriggers: ["user"], timeoutMs: 200000 });
  },
});
