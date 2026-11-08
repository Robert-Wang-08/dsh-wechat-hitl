import { test } from "node:test";
import assert from "node:assert/strict";
import { apply } from "../pkg/dsh-wechat-hitl/index.js";

/** 造一个最小假 ctx：记录监听器（含 prepend 顺序）、提供事件发射与 effect。 */
function fakeCtx() {
  const listeners = new Map();
  const options = new Map();
  const effects = [];
  return {
    listeners,
    options,
    on(name, fn, opts) {
      options.set(name, [...(options.get(name) ?? []), opts ?? {}]);
      const list = listeners.get(name) ?? [];
      if (opts === true || opts?.prepend === true) list.unshift(fn);
      else list.push(fn);
      listeners.set(name, list);
      return () => {};
    },
    effect(fn) { effects.push(fn); return () => {}; },
    get(name) { return undefined; },
    emit(name, ...args) { for (const fn of listeners.get(name) ?? []) fn(...args); },
    effects,
  };
}

/** 轮询等待某个待确认请求出现（最多 timeoutMs）。 */
async function waitPending(predicate, timeoutMs = 2000) {
  const store = await import("../lib/hitl-store.js");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = store.listPending().find(predicate);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

const mainSession = (id = "session-test-1") => ({ id, header: { cwd: "D:/x" } });

test("turn/end 合格回合会触发推送（无审批/提问干扰）", async () => {
  const ctx = fakeCtx();
  apply(ctx, { minTurnMs: 0, pollMs: 0, excludeSessionIdPrefixes: ["wx-"] });
  const session = mainSession();
  const t0 = Date.now();
  ctx.emit("session/event", session, { type: "turn/start", time: t0, data: { turn: 1 } });
  ctx.emit("session/event", session, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "跑个测试" }] } });
  ctx.emit("session/event", session, { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "插件已装" }] } } });
  const before = JSON.stringify((await import("../lib/hitl-store.js")).loadState().outbox ?? []);
  ctx.emit("session/event", session, { type: "turn/end", time: t0 + 12000, data: { turn: 1, reason: { kind: "completed" } } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const store = await import("../lib/hitl-store.js");
  const outbox = store.loadState().outbox ?? [];
  assert.equal(outbox.length > 0, true, "outbox 应至少多一条：before=" + before);
  assert.match(outbox[outbox.length - 1].text, /回合结束/);
});

test("wx- 前缀会话（微信桥会话）不推送，避免重复打扰", async () => {
  const ctx = fakeCtx();
  apply(ctx, { minTurnMs: 0, pollMs: 0, excludeSessionIdPrefixes: ["wx-"] });
  const session = { id: "wx-abc", header: { cwd: "D:/x" } };
  const store = await import("../lib/hitl-store.js");
  const before = (store.loadState().outbox ?? []).length;
  const t0 = Date.now();
  ctx.emit("session/event", session, { type: "turn/start", time: t0, data: { turn: 1 } });
  ctx.emit("session/event", session, { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "hi" }] } } });
  ctx.emit("session/event", session, { type: "turn/end", time: t0 + 12000, data: { turn: 1, reason: { kind: "completed" } } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((store.loadState().outbox ?? []).length, before);
});

test("ask_user_question 会建 inject 请求并推送选项", async () => {
  const ctx = fakeCtx();
  apply(ctx, { minTurnMs: 0, pollMs: 0, excludeSessionIdPrefixes: ["wx-"] });
  const session = mainSession("session-test-q");
  const store = await import("../lib/hitl-store.js");
  const t0 = Date.now();
  ctx.emit("session/event", session, { type: "turn/start", time: t0, data: { turn: 1 } });
  ctx.emit("session/event", session, {
    type: "tool/call",
    data: { turn: 1, callId: "call-1", name: "ask_user_question", arguments: JSON.stringify({ questions: [{ id: "q1", question: "选 A 还是 B？", options: [{ label: "A" }, { label: "B" }] }] }) },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const pending = store.listPending().filter((req) => req.sessionId === "session-test-q");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].mode, "inject");
  assert.deepEqual(pending[0].options.map((o) => o.label), ["A", "B"]);
  const outbox = store.loadState().outbox ?? [];
  assert.match(outbox[outbox.length - 1].text, /选 A 还是 B/);
  // 清理，避免污染后续真实待确认表
  store.markStatus(pending[0].id, "cancelled");
});

test("审批请求：微信回 1 -> allowed-once；回 2 -> rejected", async () => {
  const ctx = fakeCtx();
  const store = await import("../lib/hitl-store.js");
  apply(ctx, { minTurnMs: 0, pollMs: 0, excludeSessionIdPrefixes: ["wx-"], approval: { enabled: true, timeoutMs: 8000, options: ["允许一次", "拒绝"] } });

  const session = mainSession("session-test-a");
  const handlers = ctx.listeners.get("approval/request") ?? [];
  assert.equal(handlers.length, 1);

  // 找到刚建立的审批请求并替它答复
  const answerWhenPending = async (predicate, key) => {
    for (let i = 0; i < 40; i += 1) {
      const hit = store.listPending().find(predicate);
      if (hit) { store.markAnswered(hit.id, { key, label: key === "1" ? "允许一次" : "拒绝", raw: key }, "test"); return hit.id; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  };

  const allowPromise = handlers[0]({ agent: { session }, toolName: "pwsh", reason: "删除文件" }, () => Promise.resolve("unavailable"));
  const allowedId = await answerWhenPending((req) => req.sessionId === "session-test-a" && req.mode === "approval", "1");
  assert.notEqual(allowedId, null, "应出现审批请求");
  assert.equal(await allowPromise, "allowed-once");

  const rejectPromise = handlers[0]({ agent: { session }, toolName: "pwsh", reason: "再删一次" }, () => Promise.resolve("unavailable"));
  const rejectedId = await answerWhenPending((req) => req.sessionId === "session-test-a" && req.mode === "approval", "2");
  assert.notEqual(rejectedId, null);
  assert.equal(await rejectPromise, "rejected");
});

test("审批超时：委派给下一个 answerer（next），不擅自放行", async () => {
  const ctx = fakeCtx();
  apply(ctx, { minTurnMs: 0, pollMs: 0, excludeSessionIdPrefixes: ["wx-"], approval: { enabled: true, timeoutMs: 600, options: ["允许一次", "拒绝"] } });
  const session = mainSession("session-test-t");
  const handlers = ctx.listeners.get("approval/request") ?? [];
  const outcome = await handlers[0]({ agent: { session }, toolName: "pwsh" }, () => Promise.resolve("unavailable"));
  assert.equal(outcome, "unavailable");
});

test("channel-first：通道审批监听器 prepend 到浏览器转发器之前", async () => {
  const ctx = fakeCtx();
  const store = await import("../lib/hitl-store.js");
  let uiCalls = 0;
  // 模拟 DSH Web 的 api-remotes：先注册的浏览器转发器会“接住”请求
  ctx.on("approval/request", () => { uiCalls += 1; return Promise.resolve("ui-outcome"); });
  apply(ctx, { minTurnMs: 0, pollMs: 0, excludeSessionIdPrefixes: ["wx-"], approval: { enabled: true, timeoutMs: 8000, options: ["允许一次", "拒绝"], priority: "channel-first" } });
  const handlers = ctx.listeners.get("approval/request");
  assert.equal(handlers.length, 2);
  assert.equal(ctx.options.get("approval/request")[1].prepend, true, "后注册的通道监听器应带 prepend");
  const session = mainSession("session-test-order");
  const req = { agent: { session }, toolName: "pwsh", reason: "删除文件" };
  // 按 waterfall 语义：handlers[0] 的 next 才到 handlers[1]
  const promise = handlers[0](req, () => handlers[1](req, () => Promise.resolve("unavailable")));
  const hit = await waitPending((item) => item.sessionId === "session-test-order" && item.mode === "approval");
  assert.notEqual(hit, null, "通道应先建出审批请求");
  store.markAnswered(hit.id, { key: "1", label: "允许一次", raw: "1" }, "test");
  assert.equal(await promise, "allowed-once");
  assert.equal(uiCalls, 0, "浏览器转发器不应被调用");
});

test("ui-first：通道监听器排在浏览器之后，浏览器可先接管", async () => {
  const ctx = fakeCtx();
  let uiCalls = 0;
  ctx.on("approval/request", () => { uiCalls += 1; return Promise.resolve("ui-outcome"); });
  apply(ctx, { minTurnMs: 0, pollMs: 0, excludeSessionIdPrefixes: ["wx-"], approval: { enabled: true, timeoutMs: 600, options: ["允许一次", "拒绝"], priority: "ui-first" } });
  const handlers = ctx.listeners.get("approval/request");
  assert.equal(handlers.length, 2);
  const session = mainSession("session-test-ui-first");
  const outcome = await handlers[0]({ agent: { session }, toolName: "pwsh" }, () => handlers[1]({ agent: { session }, toolName: "pwsh" }, () => Promise.resolve("unavailable")));
  assert.equal(outcome, "ui-outcome");
  assert.equal(uiCalls, 1);
  const pending = (await import("../lib/hitl-store.js")).listPending().filter((item) => item.sessionId === "session-test-ui-first");
  assert.equal(pending.length, 0, "浏览器接管时通道不应建请求");
});

test("沙箱升权翻译成「提升权限」文案", async () => {
  const ctx = fakeCtx();
  const store = await import("../lib/hitl-store.js");
  apply(ctx, { minTurnMs: 0, pollMs: 0, excludeSessionIdPrefixes: ["wx-"], approval: { enabled: true, timeoutMs: 8000, options: ["允许一次", "拒绝"], priority: "channel-first" } });
  const session = mainSession("session-test-escalation");
  const handlers = ctx.listeners.get("approval/request");
  const promise = handlers[0]({ agent: { session }, toolName: "pwsh", reason: "escalate sandbox to danger-full-access: 需要一次性重建被清理的沙箱临时目录" }, () => Promise.resolve("unavailable"));
  const hit = await waitPending((item) => item.sessionId === "session-test-escalation" && item.mode === "approval");
  assert.notEqual(hit, null);
  assert.equal(hit.title, "提升权限");
  assert.match(hit.question, /工具：pwsh/);
  assert.match(hit.question, /完全访问/);
  assert.match(hit.question, /danger-full-access/);
  assert.match(hit.question, /一次性重建/);
  const pushed = (store.loadState().outbox ?? []).filter((entry) => entry.sessionId === "session-test-escalation" && String(entry.text ?? "").includes("【提升权限】")).pop();
  assert.ok(pushed, "应推送一条提升权限消息");
  assert.match(pushed.text, /^待定：提升权限 → 完全访问/);
  store.markAnswered(hit.id, { key: "2", label: "拒绝", raw: "2" }, "test");
  assert.equal(await promise, "rejected");
});

test("decisionPush 关闭：权限提升审批不建请求，直接交回前端", async () => {
  const ctx = fakeCtx();
  const store = await import("../lib/hitl-store.js");
  store.setDecisionPush(false, { by: "test" });
  try {
    apply(ctx, { minTurnMs: 0, pollMs: 0, excludeSessionIdPrefixes: ["wx-"], approval: { enabled: true, timeoutMs: 8000, options: ["允许一次", "拒绝"], priority: "channel-first" } });
    const session = mainSession("session-test-decision-off-approval");
    const handlers = ctx.listeners.get("approval/request");
    const outcome = await handlers[0]({ agent: { session }, toolName: "pwsh", reason: "删除文件" }, () => Promise.resolve("next-outcome"));
    assert.equal(outcome, "next-outcome");
    const pending = store.listPending().filter((item) => item.sessionId === "session-test-decision-off-approval");
    assert.equal(pending.length, 0, "开关关闭时通道不应建请求");
  } finally {
    store.setDecisionPush(true, { by: "test" });
  }
});

test("decisionPush 关闭：逐个询问不建请求、不推送", async () => {
  const ctx = fakeCtx();
  const store = await import("../lib/hitl-store.js");
  store.setDecisionPush(false, { by: "test" });
  try {
    apply(ctx, { minTurnMs: 0, pollMs: 0, excludeSessionIdPrefixes: ["wx-"] });
    const session = mainSession("session-test-decision-off-question");
    const before = (store.loadState().outbox ?? []).length;
    const t0 = Date.now();
    ctx.emit("session/event", session, { type: "turn/start", time: t0, data: { turn: 1 } });
    for (const name of ["ask_user_question", "request_user_input"]) {
      ctx.emit("session/event", session, {
        type: "tool/call",
        data: { turn: 1, callId: "call-" + name, name, arguments: JSON.stringify({ questions: [{ question: "选 A 还是 B？", options: [{ label: "A" }, { label: "B" }] }] }) },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    const pending = store.listPending().filter((item) => item.sessionId === "session-test-decision-off-question");
    assert.equal(pending.length, 0, "开关关闭时不应建询问请求");
    assert.equal((store.loadState().outbox ?? []).length, before, "开关关闭时不应推送询问");
  } finally {
    store.setDecisionPush(true, { by: "test" });
  }
});

test("decisionPush 关闭：异常结束不推失败通知；打开时推", async () => {
  const store = await import("../lib/hitl-store.js");
  const runTurn = async (sessionId, decisionOn) => {
    store.setDecisionPush(decisionOn, { by: "test" });
    const ctx = fakeCtx();
    apply(ctx, { minTurnMs: 0, pollMs: 0, excludeSessionIdPrefixes: ["wx-"] });
    const session = mainSession(sessionId);
    const t0 = Date.now();
    ctx.emit("session/event", session, { type: "turn/start", time: t0, data: { turn: 1 } });
    ctx.emit("session/event", session, { type: "turn/end", time: t0 + 5000, data: { turn: 1, reason: { kind: "error" } } });
    await new Promise((resolve) => setTimeout(resolve, 250));
    return (store.loadState().outbox ?? []).filter((entry) => entry.sessionId === sessionId);
  };
  try {
    assert.equal((await runTurn("session-test-fail-off", false)).length, 0, "开关关闭时失败通知不应推送");
    const on = await runTurn("session-test-fail-on", true);
    assert.equal(on.length > 0, true, "开关打开时应推送失败通知");
    assert.match(on[on.length - 1].text, /异常结束/);
  } finally {
    store.setDecisionPush(true, { by: "test" });
  }
});

