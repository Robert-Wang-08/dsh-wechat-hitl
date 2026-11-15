#!/usr/bin/env node
/**
 * feishu-daemon.mjs — 飞书通道守护进程（2026-11-05）。
 *
 * 职责（对齐微信侧的 OpenClaw 网关插件 dsh-bridge，但用 lark-cli 实现）：
 *   1) 排空发件箱：每 5 秒 drainOutbox()，出站走 lark-cli bot 直发；
 *   2) 消费入站事件：spawn `lark-cli event consume im.message.receive_v1`（长连接），
 *      解析「识别码 选项 / 会话码 内容」并写回待确认请求；未绑定会话的普通消息按遥控转发；
 *   3) 首条入站自动落点：还没设 target 时，用该消息的 chat_id 当默认落点（免去手工查 id）；
 *   4) 心跳：state/feishu-daemon.json 定期刷新 tickAt，供 fx-hitl daemon status 判断在线。
 *
 * 与微信侧共用同一份状态（pending.json / control.json / hitl.log / sessions.json）：
 * 通道只换传输，审批语义与会话码规则不变。
 *
 * 环境变量：
 *   DSH_HITL_LARK_CONFIG_DIR   lark-cli 配置目录（默认 ~/.lark-cli-feishu-hitl）
 *   DSH_HITL_FEISHU_NO_INBOUND =1  只排空发件箱，不连事件（排障用）
 */
process.env.DSH_HITL_CHANNEL = "feishu";

const { spawn } = await import("node:child_process");
const {
  writeFileSync, readFileSync, renameSync, unlinkSync, existsSync, mkdirSync,
  rmSync, lstatSync,
} = await import("node:fs");
const { join } = await import("node:path");

const store = await import("../lib/hitl-store.js");

const DRAIN_MS = 5000;
const HEARTBEAT_MS = 5000;
const STOP_POLL_MS = 1000;
const startedAt = Date.now();
const beatFile = join(store.PATHS.stateDir, "feishu-daemon.json");
// 用目录做锁：mkdir 是原子操作，避免“文件已创建但内容还没写入”的 TOCTOU 窗口。
const lockDir = join(store.PATHS.stateDir, "feishu-daemon.lock");
const lockOwnerFile = join(lockDir, "owner.json");
const stopFile = join(store.PATHS.stateDir, "feishu-daemon.stop");
let inboundState = process.env.DSH_HITL_FEISHU_NO_INBOUND === "1" ? "disabled" : "starting";
let lastError = null;
let child = null;
let stopping = false;
let inboundReadyAt = 0;
let lastDrainAt = 0;
let heartbeatSeq = 0;
let inboundGeneration = 0;
let inboundRetry = 0;
let retryTimer = null;

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

/**
 * 单实例锁：同一 stateDir 只允许一个 daemon。
 * 锁里记录 pid + startedAt；只有确认旧 pid 已死才抢占，避免两个进程抢同一份 Feishu 事件订阅。
 */
function acquireInstanceLock() {
  try { mkdirSync(store.PATHS.stateDir, { recursive: true }); } catch {}
  const body = JSON.stringify({ pid: process.pid, startedAt, createdAt: Date.now() });

  // 只在“目录锁不存在”时创建；mkdir 成功即拥有锁。绝不删除“没有 owner”的锁目录：
  // 那可能是另一个进程刚 mkdir、还没来得及写 owner 的中间态；删除会造成双实例。
  const create = () => {
    try {
      mkdirSync(lockDir);
    } catch (error) {
      if (error?.code !== "EEXIST") return false;
      // 兼容旧版的文件锁：读 pid，活着就拒绝；死了才清掉文件。
      try {
        const stat = lstatSync(lockDir);
        if (stat.isFile()) {
          let legacy = null;
          try { legacy = JSON.parse(readFileSync(lockDir, "utf8")); } catch {}
          if (legacy?.pid && pidAlive(legacy.pid)) {
            store.log({ op: "feishu-daemon-already-running", pid: legacy.pid, legacy: true });
            return false;
          }
          try { unlinkSync(lockDir); } catch {}
          return create();
        }
      } catch {}
      // 目录锁：只按 owner.json 判断；owner 缺失/不可读时拒绝启动，等待人工/脚本清理。
      let owner = null;
      try { owner = JSON.parse(readFileSync(lockOwnerFile, "utf8")); } catch {}
      if (owner?.pid && pidAlive(owner.pid)) {
        store.log({ op: "feishu-daemon-already-running", pid: owner.pid, startedAt: owner.startedAt });
        return false;
      }
      if (owner?.pid) {
        // 抢占前再读一次 owner：如果另一个进程刚好接手并写入新 pid，不能删它的锁。
        let recheck = null;
        try { recheck = JSON.parse(readFileSync(lockOwnerFile, "utf8")); } catch {}
        if (recheck?.pid && pidAlive(recheck.pid)) return false;
        // owner 明确记录且 pid 已死：可安全抢占一次。
        try { rmSync(lockDir, { recursive: true, force: true }); } catch {}
        return create();
      }
      store.log({ op: "feishu-daemon-lock-unknown", note: "lock dir exists without readable owner; refusing to steal" });
      return false;
    }
    try {
      writeFileSync(lockOwnerFile, body);
      return true;
    } catch {
      // 创建目录后写 owner 失败：清掉自己刚建的空目录，避免留下无主锁。
      try { rmSync(lockDir, { recursive: true, force: true }); } catch {}
      return false;
    }
  };
  const acquired = create();
  if (!acquired) return false;
  // 抢占死锁时仍可能两个进程同时 rm/create：写完后必须回读确认 owner 是自己，
  // 否则说明锁已被另一个进程替换，主动退出，避免“两个都以为持有锁”。
  try {
    const owner = JSON.parse(readFileSync(lockOwnerFile, "utf8"));
    if (Number(owner?.pid) !== process.pid) {
      store.log({ op: "feishu-daemon-lock-lost", ownerPid: owner?.pid, note: "another process replaced the lock" });
      releaseInstanceLock();
      return false;
    }
    return true;
  } catch {
    releaseInstanceLock();
    return false;
  }
}

function releaseInstanceLock() {
  try {
    const owner = JSON.parse(readFileSync(lockOwnerFile, "utf8"));
    if (Number(owner?.pid) === process.pid) rmSync(lockDir, { recursive: true, force: true });
  } catch {}
}

if (!acquireInstanceLock()) {
  console.error("[feishu-daemon] another instance is already running; refuse to start a second one");
  process.exit(3);
}
process.on("exit", releaseInstanceLock);

function heartbeat(extra = {}) {
  let target = { id: "", type: "open_id" };
  let switchState = "unknown";
  try { target = store.getFeishuTarget(); } catch {}
  try { switchState = store.getControl().state; } catch {}
  const hint =
    inboundState === "blocked:policy"
      ? "飞书应用权限被拦（21001）：去开放平台开事件订阅+发消息权限并发布"
      : inboundState === "blocked:spawn"
        ? "入站连续启动失败（spawn）：检查 lark-cli/权限/宿主，勿在受限会话里启动"
        : inboundState === "spawn-failed"
          ? "入站启动失败；守护进程会退避重试"
          : (!target.id ? "落点未设置：fx-hitl target --id <open_id|chat_id>" : null);
  const payload = {
    schemaVersion: 2,
    pid: process.pid,
    startedAt,
    tickAt: Date.now(),
    seq: ++heartbeatSeq,
    childPid: child?.pid ?? null,
    inbound: inboundState,
    inboundReadyAt,
    lastDrainAt,
    lastError,
    hint,
    target,
    switchState,
    ...extra,
  };
  const tmp = beatFile + ".tmp-" + process.pid;
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, beatFile);
  } catch (error) {
    // 心跳写失败不能让“看起来死了”变成无证据的静默：至少写一条日志。
    try { store.log({ op: "feishu-heartbeat-error", error: String(error) }); } catch {}
  }
}

// ── 入站解析 ────────────────────────────────────────────────────────────────
/** 在任意深度的对象里找第一个带 chat_id 的 message 节点。 */
function findMessage(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return null;
  if (node.chat_id && (node.content || node.message_type)) return node;
  for (const key of Object.keys(node)) {
    const found = findMessage(node[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function messageText(message) {
  const raw = message?.content;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.text === "string") return parsed.text;
      return raw;
    } catch { return raw; }
  }
  if (raw && typeof raw === "object" && typeof raw.text === "string") return raw.text;
  return "";
}

/** One execution path: enqueue for the owning DSH host; never run a second headless turn. */
async function queueRelay(sessionId, text, message, event, ack) {
  let request;
  try {
    request = store.buildMessageRequest({
      sessionId, text, title: "飞书转发", context: "来自飞书 · 会话遥控",
      channel: "feishu", replyChatId: String(message.chat_id || ""),
      sourceMessageId: message.message_id || message.id || event.message_id || event.id || event.event_id || event.header?.event_id || null,
    });
  } catch (error) {
    await ack("未能接收消息：排队失败（" + String(error.message || error).slice(0, 180) + "）。");
    return;
  }
  try {
    const code = store.sessionCode(request.sessionId);
    const disabled = !store.isResultPushEnabled() || !store.isSessionNotificationEnabled(request.sessionId);
    await ack("已排队到会话 " + code + "，等待宿主接收。"
      + (disabled ? "\n该会话的结果推送当前关闭；请在 DSH 查看结果。" : "\n宿主接收和回合结果将分别通知。"));
  } catch (error) {
    store.log({ op: "relay-ack-failed", id: request.id, error: String(error).slice(0, 180) });
  }
}

/** Delivery monitoring reports admission separately from completion, without replaying or cancelling. */
async function reportRelayDelivery(now = Date.now()) {
  for (const req of Object.values(store.loadState().requests ?? {})) {
    if (req.channel !== "feishu" || !req.replyChatId || req.mode !== "message") continue;
    const delivery = String(req.delivery ?? "");
    let report = null;
    let text = null;
    if (/^(?:controller-failed|failed|not-live)/.test(delivery) || req.status === "failed") {
      report = "failed";
      text = "会话消息未确认接收：" + (delivery || req.status) + "。可能已进入宿主，请在 DSH 核对；未自动重试。";
    } else if (delivery === "injected") {
      report = "accepted";
      text = "宿主已接收会话 " + store.sessionCode(req.sessionId) + " 的消息，等待回合结果。";
    } else if (req.status === "expired" || Number(req.expiresAt) < now) {
      report = "expired";
      text = "会话消息等待接收已过期；未确认执行，请在 DSH 核对。未自动重试。";
    } else if (now - req.createdAt >= 60000) {
      report = "waiting";
      text = "会话消息仍未确认接收，请检查 DSH 宿主。消息可能稍后执行，未取消、未自动重试。";
    }
    if (!report || req.relayReport === report || ["accepted", "failed", "expired"].includes(req.relayReport)) continue;
    const sent = await store.feishuSend(req.replyChatId, text, { type: "chat_id" });
    if (sent.code === 0) store.markRelayReport(req.id, report);
  }
}

async function handleInbound(event) {
  const message = findMessage(event);
  if (!message) return;
  const chatId = String(message.chat_id || "");
  const text = messageText(message).trim();
  const sender = message.sender ?? {};
  const senderType = sender.sender_type || sender.type || "";
  // 机器人自己发的消息不处理（否则会把回声当成用户指令）
  if (senderType === "app" || senderType === "bot") return;
  if (!text) return;

  // 首条入站自动落点：让用户不用手查 open_id/chat_id
  const current = store.getFeishuTarget();
  if (!current.id && chatId) {
    store.setFeishuTarget(chatId, "chat_id");
    store.log({ op: "feishu-target-auto", chatId });
  }
  const target = chatId || current.id;

  const ack = async (text2) => {
    if (!text2) return;
    const sent = await store.feishuSend(target, text2, { type: "chat_id" });
    if (sent.code !== 0) throw new Error("飞书回执发送失败，退出码 " + sent.code);
  };

  // 1) 推送总开关的自然表述（与微信侧同一套解析）
  const pushCmd = store.parsePushCommand(text);
  if (pushCmd) {
    if (pushCmd.target === "decision") {
      if (pushCmd.action === "status") { await ack(store.describeDecisionPush()); return; }
      const result = store.setDecisionPush(pushCmd.action === "on", { by: "feishu", reason: "飞书侧指令" });
      await ack((result.to ? "🟢 权限/决策询问：已开" : "🟡 权限/决策询问：已关") + "（" + (result.from ? "开" : "关") + " → " + (result.to ? "开" : "关") + "）");
      return;
    }
    if (pushCmd.action === "status") { await ack(store.describeResultPush()); return; }
    const result = store.setResultPush(pushCmd.action === "on", { by: "feishu", reason: "飞书侧指令" });
    await ack((result.to ? "🟢 结果推送：已开" : "🟡 结果推送：已关") + "\n审批与提问推送不受影响。");
    return;
  }

  // 2) /new：在「已绑定会话」里建新会话（方案 A：会话自己调 new_session，回写标记）
  //    必须排在 runChannelCommand 之前——那边是同步的，会把 /new 当未知指令。
  const newMatch = text.match(/^\/new(?:\s+([\s\S]+))?$/i);
  if (newMatch) {
    const binding = store.getBinding();
    if (!binding?.sessionId) { await ack("先用 /s 绑定一条会话，再 /new——新会话是在那条会话里建的。"); return; }
    const title = (newMatch[1] ?? "").trim() || "远程新建会话";
    const who = binding.label || String(binding.sessionId).slice(0, 12);
    await ack("⏳ 正在「" + who + "」里创建新会话，通常半分钟到一分钟。");
    const run = await store.runHeadlessTurn(binding.sessionId, store.buildNewSessionInstruction({ title })).catch((error) => ({ error: String(error) }));
    const parsed = store.parseNdjson(run?.stdout ?? "");
    const failed = run?.error || parsed.error || run?.timeout || !run?.ok || run?.code !== 0;
    const created = failed ? null : store.parseNewSessionMarker(parsed.text);
    if (!created) {
      const why = run?.error || parsed.error
        ? "执行出错：" + String(run.error || parsed.error).slice(0, 240)
        : (run?.timeout ? "执行超时，未确认创建；请在 DSH 核对，勿直接重试" : "未成功完成（退出码 " + run?.code + "），没拿到 new_session 回执");
      await ack("没建成：" + why + "\n原样回你：" + String(parsed.text ?? "").slice(0, 300));
      return;
    }
    const { code, replaced } = store.sessionCodeWithRecycle(created);
    store.setBinding(created, title, "feishu-new");
    await ack("✅ 已新建并绑定：码 " + code + " · " + title
      + (replaced ? "\n⚠️ 码空间已满：码 " + replaced.code + " 已从「" + (replaced.label || String(replaced.sessionId).slice(0, 12)) + "」回收给新会话。" : ""));
    return;
  }

  // 3) 遥控器命令：/l 清单、/s 绑定、/a 取消、/name 命名、/who 当前
  //    与微信网关同一实现（hitl-store.runChannelCommand），避免再出现「文案有、代码没有」。
  const channelCmd = store.runChannelCommand(text, { by: "feishu" });
  if (channelCmd) {
    const notices = store.drainRecycleNotices();
    const extra = notices.length
      ? "\n\n⚠️ 码空间已满：" + notices.map((n) => "码 " + n.code + " 已从「" + (n.fromLabel || String(n.from).slice(0, 12)) + "」回收").join("；")
      : "";
    await ack(channelCmd.text + extra);
    return;
  }

  // 4) 会话码路由：答复 / 看状态 / 转发
  const routed = store.resolveByCode(text, store.listPending());
  if (routed.kind === "no-code") {
    // 普通消息：绑定了会话就转发，否则给提示
    const binding = store.getBinding();
    if (binding?.sessionId) {
      await queueRelay(binding.sessionId, text, message, event, ack);
      return;
    }
    await ack("没绑定会话。\n/l 看可驱动会话清单，/s <回复id 或 会话码> 绑定后再发普通消息。");
    return;
  }
  if (routed.kind === "status") { await ack(store.formatSessionStatus(routed.sessionId)); return; }
  if (routed.kind === "answer-ambiguous") { await ack(store.formatAmbiguous(routed.candidates)); return; }
  if (routed.kind === "unknown-code") { await ack("没有回复id " + routed.code + "。\n\n" + store.formatSessionListV2(store.listSessionsV2(10))); return; }
  if (routed.kind === "unrecognized-concat") {
    const req = routed.request;
    const handle = store.handleText(req);
    await ack("未识别「" + routed.code + "」：连写会跟会话码混淆。请用「识别码 空格 选项」，例：" + req.options.map((o) => handle + " " + o.key).join(" / "));
    return;
  }
  if (routed.kind === "relay") {
    await queueRelay(routed.sessionId, routed.text, message, event, ack);
    return;
  }
  const request = routed.request;
  const updated = store.markAnswered(request.id, { ...routed.option, raw: text }, "feishu") ?? request;
  await ack(store.formatResolved(updated) + "\n（答复已登记，DSH 侧会注入原会话。）");
}

// ── 事件流子进程（2026-11-15：单实例 + 状态机 + 退避）──────────────────────
function scheduleInboundRetry(delayMs) {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (stopping) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!stopping) startInbound();
  }, Math.max(0, delayMs));
}

function onInboundFailure(gen, error) {
  if (gen !== inboundGeneration) return;
  // 使这个 child 后续的 exit 回调失效，避免 error + exit 各触发一次重试。
  inboundGeneration += 1;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  child = null;
  inboundReadyAt = 0;
  inboundRetry += 1;
  lastError = String(error?.message || error);
  inboundState = inboundRetry >= 3 ? "blocked:spawn" : "spawn-failed";
  store.log({ op: "feishu-inbound-error", stage: "spawn", attempt: inboundRetry, error: lastError });
  heartbeat();
  if (inboundRetry >= 3) {
    store.log({ op: "feishu-inbound-blocked", reason: "spawn failed 3x", error: lastError, retryInMin: 10 });
    scheduleInboundRetry(10 * 60 * 1000);
  } else {
    const delays = [1000, 2000, 4000];
    scheduleInboundRetry(delays[Math.min(inboundRetry - 1, delays.length - 1)]);
  }
}

function markInboundReady(proof) {
  if (inboundState === "running" && inboundReadyAt > 0) return;
  inboundState = "running";
  inboundReadyAt = Date.now();
  inboundRetry = 0;
  store.log({ op: "feishu-inbound-ready", pid: child?.pid, proof: String(proof).slice(0, 160) });
  heartbeat();
}

function startInbound() {
  if (stopping) return;
  if (process.env.DSH_HITL_FEISHU_NO_INBOUND === "1") {
    inboundState = "disabled";
    heartbeat();
    return;
  }
  const gen = ++inboundGeneration;
  inboundState = "starting";
  heartbeat();
  let c;
  const env = store.larkCliEnv(store.FEISHU.configDir);
  try {
    c = spawn(process.execPath, [store.FEISHU.runJs, "event", "consume", store.FEISHU.eventKey], {
      cwd: store.PATHS.workdir,
      env,
      // 必须保持 stdin 打开：lark-cli event consume 把 stdin EOF 当成退出信号（原 "ignore" 会让它立刻退出）
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    onInboundFailure(gen, error);
    return;
  }
  child = c;
  c.on("error", (error) => onInboundFailure(gen, error));

  let buffer = "";
  let childLastError = "";
  c.stdout.on("data", (chunk) => {
    if (gen !== inboundGeneration) return;
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      // lark-cli 不同版本可能把 ready 打到 stdout 或 stderr；两边都认。
      if (/\[event\] ready|websocket: connected/i.test(line)) markInboundReady(line);
      let event = null;
      try { event = JSON.parse(line); } catch { continue; }
      store.log({ op: "feishu-inbound", preview: line.slice(0, 160) });
      handleInbound(event).catch((error) => {
        lastError = String(error);
        store.log({ op: "feishu-inbound-error", stage: "handle", error: lastError });
      });
    }
  });
  c.stderr.on("data", (chunk) => {
    if (gen !== inboundGeneration) return;
    const text = chunk.toString("utf8").trim().slice(0, 400);
    if (!text) return;
    childLastError = text;
    lastError = text;
    store.log({ op: "feishu-inbound-stderr", text });
    // 只有真正连上才把 running 当健康态；spawn 成功 != 事件订阅已就绪。
    if (/\[event\] ready|websocket: connected/i.test(text)) markInboundReady(text);
  });
  c.on("exit", (code) => {
    if (gen !== inboundGeneration) return;
    const wasReady = inboundReadyAt > 0;
    child = null;
    inboundReadyAt = 0;
    if (stopping) { heartbeat({ inbound: "stopped" }); return; }
    // 21001（数据安全策略拦截）不是「掉线」，是权限没开：每 10 秒重连只会刷爆日志。
    // 只看本 child 的 stderr，避免上一代 child 的错误影响本次分类。
    const policyBlocked = /21001|data security policy|access_denied/i.test(String(childLastError || ""));
    if (policyBlocked) {
      inboundState = "blocked:policy";
      store.log({ op: "feishu-inbound-blocked", reason: "21001 数据安全策略拦截：事件订阅/发送权限未开", retryInMin: 10 });
      heartbeat();
      scheduleInboundRetry(10 * 60 * 1000);
    } else {
      inboundState = "exited:" + code;
      // 未 ready 就退出视为启动失败，按 10/20/30/40/50/60s 退避；ready 后掉线仍 10s 快速重连。
      if (!wasReady) inboundRetry += 1;
      const delayMs = wasReady ? 10000 : Math.min(60000, 10000 * Math.max(1, inboundRetry));
      store.log({ op: "feishu-inbound-exit", code, wasReady, retryInMs: delayMs });
      heartbeat();
      scheduleInboundRetry(delayMs);
    }
  });
  store.log({ op: "feishu-inbound-start", pid: c.pid, eventKey: store.FEISHU.eventKey });
}

// ── 排空 + 心跳 ─────────────────────────────────────────────────────────────
let draining = false;
async function tick() {
  if (draining) return;
  draining = true;
  try {
    store.expireStale();
    await reportRelayDelivery();
    const result = await store.drainOutbox();
    lastDrainAt = Date.now();
    heartbeat({ lastDrain: result });
  } catch (error) {
    lastError = "drain: " + String(error);
    store.log({ op: "feishu-daemon-error", stage: "drain", error: lastError });
    heartbeat();
  } finally {
    draining = false;
  }
}

function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  inboundState = "stopped";
  inboundReadyAt = 0;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  const c = child;
  child = null;
  if (c?.stdin) { try { c.stdin.end(); } catch {} }
  if (c) setTimeout(() => { try { c.kill(); } catch {} }, 1000);
  store.log({ op: "feishu-daemon-stop", reason });
  heartbeat({ stoppedAt: Date.now(), inbound: "stopped" });
  setTimeout(() => process.exit(0), 1500);
}

process.on("SIGINT", () => shutdown("sigint"));
process.on("SIGTERM", () => shutdown("sigterm"));
process.on("uncaughtException", (error) => {
  try { store.log({ op: "feishu-daemon-fatal", signal: "uncaughtException", error: String(error?.stack || error) }); } catch {}
  try { heartbeat({ inbound: "fatal", lastError: String(error?.message || error) }); } catch {}
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  try { store.log({ op: "feishu-daemon-fatal", signal: "unhandledRejection", error: String(error?.stack || error) }); } catch {}
  try { heartbeat({ inbound: "fatal", lastError: String(error?.message || error) }); } catch {}
  process.exit(1);
});

store.log({ op: "feishu-daemon-start", pid: process.pid, configDir: store.FEISHU.configDir });
heartbeat();
// 先关心跳：即使首次 drain 卡住，也不能让状态看起来“死了”。
setInterval(() => heartbeat(), HEARTBEAT_MS);
startInbound();
tick().catch((error) => {
  lastError = "first-tick: " + String(error);
  store.log({ op: "feishu-daemon-error", stage: "first-tick", error: lastError });
  heartbeat();
});
setInterval(tick, DRAIN_MS);
setInterval(() => {
  try {
    if (existsSync(stopFile)) {
      unlinkSync(stopFile);
      shutdown("stop-file");
    }
  } catch {}
}, STOP_POLL_MS);
