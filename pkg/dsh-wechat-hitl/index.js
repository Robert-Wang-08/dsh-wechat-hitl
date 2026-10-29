/**
 * dsh-wechat-hitl — DSH 侧「微信人工确认回环」插件（Cordis 宿主插件）。
 *
 * 职责（只做三件事，出站全部交给 OpenClaw 网关）：
 *   1. 审批门禁：监听 'approval/request' waterfall，把 dangerously 需要批准的操作推到微信，
 *      阻塞等待用户微信回复；回复 1 -> allowed-once，2 -> rejected，超时 -> next() 交回 DSH 界面。
 *   2. 提问推送：监听 session/event 的 tool/call + ask_user_question，把问题与选项推到微信；
 *      用户的微信回复由本插件轮询状态文件后，作为新一轮注入原会话（sessionController.prompt 优先）。
 *   3. 回合结束摘要：turn/end 且该 turn 的最终 assistant/消息是纯文本回答时，推送摘要到微信。
 *
 * 事件契约（已从 DSH 源码确认）：
 *   - ctx.on('session/event', (session, event))          事件类型 turn/start、user/message、
 *                                                        assistant/message、tool/call、turn/end、
 *                                                        approval/asked、tool/result
 *   - ctx.on('approval/request', (req, next))           waterfall，返回 closed outcome 或 next() 委派
 *   - ctx.on('session/disposed', (session))
 *
 * 本插件不改 DSH 本体，不依赖第三方包，所有跨进程状态走共享状态文件（hitl-store.js）。
 */
// 共享状态层唯一实现位于 DSH 工作区；整目录再搬家时只需改这一行，或用 DSH_WECHAT_HITL_LIB 覆盖。
const STORE_URL = new URL(process.env.DSH_WECHAT_HITL_LIB || "file:///D:/src/dsh/dsh-wechat-hitl/lib/hitl-store.js");

export const name = "wechat-hitl";

/** 不依赖任何 DSH 服务：完全靠事件与可选服务探测（sessionController 用 ctx.get 取）。 */
export const inject = [];

const store = await import(STORE_URL.href);

function isMainSession(session) {
  const header = session?.header ?? {};
  if (header.origin === "subagent") return false;
  const depth = header.delegationDepth;
  if (depth === undefined) return true;
  return Number.isSafeInteger(depth) && depth === 0;
}

function sessionCwd(session) {
  const cwd = session?.header?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

export function apply(ctx, config = {}) {
  const cfg = {
    enabled: true,
    notifyOnTurnEnd: true,
    minTurnMs: 3000,
    maxTextChars: 900,
    pollMs: 1500,
    approval: { enabled: true, timeoutMs: 5 * 60 * 1000, options: ["允许一次", "拒绝"] },
    excludeSessionIdPrefixes: ["wx-"],
    excludeKinds: [],
    ...config,
  };
  cfg.approval = { ...{ enabled: true, timeoutMs: 5 * 60 * 1000, options: ["允许一次", "拒绝"] }, ...(config.approval ?? {}) };

  const skipByEnv = process.env.DSH_WECHAT_HITL_SKIP === "1";
  const log = (obj) => store.log({ plugin: "wechat-hitl", ...obj });

  const excluded = (session) => {
    if (!cfg.enabled || skipByEnv) return true;
    const id = session?.id;
    if (typeof id !== "string" || id.length === 0) return true;
    if (Array.isArray(cfg.excludeSessionIdPrefixes) && cfg.excludeSessionIdPrefixes.some((prefix) => prefix && id.startsWith(prefix))) return true;
    if (!isMainSession(session)) return true;
    return false;
  };

  const clip = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, cfg.maxTextChars);

  // ── turn 跟踪（复用 notify-bell 的严格判定语义）───────────────────────────
  const turns = new Map();
  const currentTurn = new Map();
  const endedTurns = new Map();
  let order = 0;
  const entryFor = (sessionId, turn) => {
    const key = sessionId + ":" + turn;
    let entry = turns.get(key);
    if (!entry) {
      entry = { sessionId, startTime: null, firstUser: null, lastAssistant: null, lastToolCall: null };
      turns.set(key, entry);
    }
    return entry;
  };
  const isAfter = (a, b) => {
    if (!a || !b) return false;
    return a.order > b.order;
  };

  /** 本轮是否已经推送过「需要确认」类消息：避免提问与回合摘要重复打扰。 */
  const awaitingTurn = new Map();

  // ── 答复注入：把已答复的 inject 型请求送回原会话 ─────────────────────────
  let injecting = false;
  async function injectAnswered() {
    if (injecting) return;
    injecting = true;
    try {
      // 两类要投递的请求：
      //   inject  — 用户答复了某个确认请求，作为新回合续跑原任务
      //   message — 微信里直接发的普通消息，绑定到某个会话后原样转发进去（微信当遥控器）
      const answered = Object.values(store.loadState().requests ?? {}).filter((req) => {
        if (req.deliveredAt) return false;
        if (req.mode === "inject") return req.status === "answered";
        if (req.mode === "message") return req.status === "pending";
        return false;
      });
      for (const req of answered) {
        const prompt = req.mode === "message" ? req.question : store.buildContinuationPrompt(req);
        let delivery = null;
        // 首选：DSH 会话控制器（web profile 有；把答复作为新用户消息入队并唤醒会话）
        const controller = ctx.get?.("sessionController");
        if (controller && typeof controller.prompt === "function") {
          try {
            // prompt(request, signal)：signal 是必填的（web 宿主实测未传会抛
            // "Cannot read properties of undefined (reading 'throwIfAborted')"）。
            const abort = new AbortController();
            await controller.prompt(
              { requestId: "rpc-" + req.id, sessionId: req.sessionId, mode: "queue", content: [{ type: "text", text: prompt }] },
              abort.signal,
            );
            delivery = "injected";
          } catch (error) {
            delivery = "controller-failed:" + String(error && error.message ? error.message : error).slice(0, 160);
          }
        }
        // 没有会话控制器（headless / tui profile）时不要标注为已交付，
        // 交给网关插件走 headless 续跑兜底，避免「已投递」的假阳性。
        if (delivery === null) {
          if (!controller) {
            // 本进程没有 sessionController（headless / tui 等），不代表会话死了：
            // 真正的宿主可能是另一个进程。这里什么都不标，留给宿主或网关兜底处理。
            log({ stage: "injector-skip-no-controller", id: req.id, sessionId: req.sessionId });
            continue;
          }
          delivery = "controller-failed";
        }
        store.markDelivered(req.id, delivery);
        if (delivery === "injected") {
          // message 模式不额外推「已注入」提示（用户刚发完，避免回声刷屏）
          if (req.mode === "inject") await store.pushWechat("▶️ " + store.handleText(req) + " 答复已注入原会话，正在继续执行。", undefined, { sessionId: req.sessionId });
          else log({ stage: "relayed", id: req.id, sessionId: req.sessionId });
        }
      }
    } finally {
      injecting = false;
    }
  }

  // pollMs <= 0 关闭轮询（单测用：避免同一进程里多个插件实例互相干扰）
  if (Number(cfg.pollMs) > 0) {
    const timer = setInterval(() => {
      store.expireStale();
      injectAnswered().catch((error) => log({ stage: "inject", error: String(error) }));
    }, Math.max(500, Number(cfg.pollMs)));
    if (typeof timer.unref === "function") timer.unref();
    if (typeof ctx.effect === "function") {
      ctx.effect(() => () => clearInterval(timer), "wechat-hitl poll");
    }
  }

  // ── 审批门禁：微信阻塞式批准 ──────────────────────────────────────────────
  ctx.on("approval/request", async (req, next) => {
    if (!cfg.approval.enabled) return next();
    // 三态开关：只有 running 才把审批推到微信并阻塞等待。
    // paused / stopped 必须立刻 next() 交回 DSH 原生界面处理，否则暂停就会把回合卡死。
    const control = store.getControl();
    if (control.state !== "running") {
      log({ stage: "approval-delegated-by-switch", state: control.state, tool: req?.toolName ?? null });
      return next();
    }
    const session = req?.agent?.session;
    if (excluded(session)) return next();
    if (Array.isArray(cfg.excludeKinds) && cfg.excludeKinds.includes(req?.toolName)) return next();
    // TTL 必须等于实际等待窗口：以前用默认 30 分钟 TTL 却只等 5 分钟，
    // 推送写着「有效期 30 分钟」，用户在 5 分钟后就被判过期（2026-10-29 审计）。
    const approvalTimeoutMs = Math.max(5000, Number(cfg.approval.timeoutMs) || 300000);
    const request = store.createRequest({
      sessionId: session.id,
      mode: "approval",
      kind: "approval",
      title: "危险操作需要批准",
      question: String(req?.toolName ?? "unknown") + (req?.reason ? "：" + String(req.reason) : ""),
      options: cfg.approval.options,
      context: sessionCwd(session) ?? "",
    }, approvalTimeoutMs);
    log({ stage: "approval-ask", id: request.id, tool: req?.toolName, sessionId: session.id, ttlMs: approvalTimeoutMs });
    const pushed = await store.pushWechat(store.formatAsk(request));
    if (!pushed.ok) {
      log({ stage: "approval-push-failed", id: request.id, output: pushed.output });
      store.markStatus(request.id, "cancelled");
      return next();
    }
    const deadline = Date.now() + approvalTimeoutMs;
    while (Date.now() < deadline) {
      if (req?.signal?.aborted) { store.markStatus(request.id, "cancelled"); return "cancelled"; }
      const fresh = store.getRequest(request.id);
      if (fresh?.status === "answered") {
        const rejected = String(fresh.answer?.key ?? "") === "2";
        store.markDelivered(request.id, "in-turn");
        log({ stage: "approval-decided", id: request.id, key: fresh.answer?.key, rejected });
        return rejected ? "rejected" : "allowed-once";
      }
      if (fresh?.status === "cancelled" || fresh?.status === "expired") break;
      await store.sleep(700);
    }
    store.markStatus(request.id, "expired");
    await store.pushWechat("⌛ 批准请求已过期（" + Math.round((Number(cfg.approval.timeoutMs) || 300000) / 60000) + " 分钟无回复），已交回 DSH 界面处理。", undefined, { sessionId: request.sessionId });
    return next();
  });

  // ── 会话事件 ─────────────────────────────────────────────────────────────
  ctx.on("session/disposed", (session) => {
    const sessionId = session?.id;
    if (typeof sessionId !== "string") return;
    currentTurn.delete(sessionId);
    endedTurns.delete(sessionId);
    awaitingTurn.delete(sessionId);
    for (const [key, entry] of turns) if (entry.sessionId === sessionId) turns.delete(key);
  });

  ctx.on("session/event", (session, event) => {
    // stopped = 关闭服务：完全不介入（不建请求、不打日志、不推送）
    if (!store.isActive()) return;
    if (excluded(session)) return;
    const sessionId = session?.id;
    const type = event?.type;
    const data = event?.data ?? {};

    if (type === "turn/start") {
      const turn = data.turn;
      if (!Number.isSafeInteger(turn) || turn <= 0) return;
      currentTurn.set(sessionId, turn);
      order += 1;
      const entry = entryFor(sessionId, turn);
      entry.startTime = typeof event.time === "number" ? event.time : null;
      awaitingTurn.set(sessionId, false);
      return;
    }
    if (type === "user/message") {
      const turn = currentTurn.get(sessionId);
      if (!Number.isSafeInteger(turn)) return;
      const entry = entryFor(sessionId, turn);
      if (entry.firstUser !== null) return;
      if (data.source?.kind !== "user") return;
      const text = (Array.isArray(data.content) ? data.content : []).filter((block) => block?.type === "text").map((block) => block.text).join(" ");
      entry.firstUser = clip(text) || null;
      return;
    }
    if (type === "assistant/message") {
      const turn = data.turn;
      if (!Number.isSafeInteger(turn) || turn <= 0) return;
      order += 1;
      const entry = entryFor(sessionId, turn);
      const content = Array.isArray(data.message?.content) ? data.message.content : [];
      const hasText = content.some((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0);
      const hasToolCall = content.some((block) => block?.type === "tool-call");
      entry.lastAssistant = { order, hasText, hasToolCall, text: clip(content.filter((block) => block?.type === "text").map((block) => block.text).join(" ")) };
      return;
    }
    if (type === "tool/call") {
      const turn = data.turn;
      if (!Number.isSafeInteger(turn) || turn <= 0) return;
      order += 1;
      const entry = entryFor(sessionId, turn);
      entry.lastToolCall = { order };
      if (data.name === "ask_user_question") {
        // 暂停期间不建待确认请求（推送层还会再拦一次），避免留下必然过期的悬空请求
        if (store.getControl().state !== "running") { log({ stage: "question-skipped-by-switch", state: store.getControl().state }); return; }
        let args = {};
        try { args = typeof data.arguments === "string" ? JSON.parse(data.arguments) : (data.arguments ?? {}); } catch { args = {}; }
        const questions = Array.isArray(args.questions) ? args.questions : [];
        const first = questions[0] ?? {};
        const options = Array.isArray(first.options) && first.options.length > 0 ? first.options.map((option) => String(option.label ?? option.id ?? "选项")) : ["确认", "取消"];
        const request = store.createRequest({
          sessionId: session.id,
          mode: "inject",
          kind: "question",
          title: first.header ? String(first.header) : "DSH 向你提问",
          question: String(first.question ?? "(未提供问题文本)"),
          options,
          context: sessionCwd(session) ?? "",
        });
        awaitingTurn.set(sessionId, true);
        store.pushWechat(store.formatAsk(request), undefined, { sessionId: session.id }).catch((error) => log({ stage: "question-push", error: String(error) }));
        log({ stage: "question-ask", id: request.id, sessionId: session.id, options: options.length });
      }
      return;
    }
    if (type === "turn/end") {
      const turn = data.turn;
      log({ stage: "turn-end-received", sessionId, turn, reason: data.reason?.kind ?? null });
      if (!Number.isSafeInteger(turn) || turn <= 0) return;
      if (currentTurn.get(sessionId) === turn) currentTurn.delete(sessionId);
      const key = sessionId + ":" + turn;
      const entry = turns.get(key);
      turns.delete(key);
      if (endedTurns.get(sessionId) >= turn) return;
      endedTurns.set(sessionId, turn);
      const wasAwaiting = awaitingTurn.get(sessionId) === true;
      awaitingTurn.delete(sessionId);
      if (!cfg.notifyOnTurnEnd) return;
      if (store.getControl().state !== "running") { log({ stage: "turnend-skipped-by-switch", state: store.getControl().state }); return; }
      if (wasAwaiting) return;
      if (data.reason?.kind !== "completed") return;
      const durationMs = entry !== undefined && entry.startTime !== null && typeof event.time === "number" ? Math.max(0, event.time - entry.startTime) : null;
      log({
        stage: "turn-end-eval",
        sessionId,
        turn,
        hasEntry: entry !== undefined,
        hasText: entry?.lastAssistant?.hasText ?? null,
        hasToolCall: entry?.lastAssistant?.hasToolCall ?? null,
        durationMs,
        notified: false,
      });
      if (!entry || !entry.lastAssistant?.hasText || entry.lastAssistant.hasToolCall) return;
      if (entry.lastToolCall && !isAfter(entry.lastAssistant, entry.lastToolCall)) return;
      if (durationMs !== null && durationMs < Number(cfg.minTurnMs)) return;
      // REQ-001：结果推送有独立总开关，关掉时只跳过"回合结束通知"，
      // 审批门禁与 ask_user_question 推送不受影响。
      if (typeof store.isResultPushEnabled === "function" && !store.isResultPushEnabled()) {
        log({ stage: "turn-end-suppressed", sessionId, turn, reason: "result-push-off" });
        return;
      }
      const summary = entry.firstUser ?? "(无用户输入)";
      const tail = entry.lastAssistant.text ?? "";
      const text = store.formatTurnEnd({ sessionId, durationMs, summary, text: tail });
      store.pushWechat(text, undefined, { sessionId }).catch((error) => log({ stage: "turnend-push", error: String(error) }));
      log({ stage: "turn-end-notify", sessionId, turn, durationMs });
      return;
    }
  });

  log({
    stage: "plugin-loaded",
    pid: process.pid,
    profile: process.env.DSH_PROFILE ?? null,
    hasSessionController: typeof ctx.get?.("sessionController") === "object",
    cfg: { notifyOnTurnEnd: cfg.notifyOnTurnEnd, approval: cfg.approval.enabled, excludes: cfg.excludeSessionIdPrefixes },
  });
}
