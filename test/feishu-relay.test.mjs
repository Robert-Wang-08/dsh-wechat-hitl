import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
const isolatedRoot = fileURLToPath(new URL("../state-test/", import.meta.url));
mkdirSync(isolatedRoot, { recursive: true });
process.env.DSH_WECHAT_HITL_STATE = mkdtempSync(isolatedRoot + "feishu-relay-");
process.env.DSH_HITL_CHANNEL = "feishu";
delete process.env.DSH_WECHAT_HITL_EGRESS;
delete process.env.DSH_WECHAT_HITL_SKIP;
const store = await import("../lib/hitl-store.js");
const { apply } = await import("../pkg/dsh-wechat-hitl/index.js");
const input = (id) => ({ sessionId: "session-remote-test", text: "remote test", channel: "feishu", replyChatId: "oc_test", sourceMessageId: id });

test("transport replay persists one request across module reloads", async () => {
  const id = "om-" + Date.now();
  const a = store.buildMessageRequest(input(id));
  const b = store.buildMessageRequest(input(id));
  const fresh = await import("../lib/hitl-store.js?reload=" + Date.now());
  const c = fresh.buildMessageRequest(input(id));
  assert.equal(a.id, b.id);
  assert.equal(a.id, c.id);
  assert.equal(Object.values(store.loadState().requests).filter((r) => r.sourceMessageId === id).length, 1);
  store.markStatus(a.id, "cancelled");
});

test("same text with different source message ids is not deduplicated", () => {
  const a = store.buildMessageRequest(input("om-a-" + Date.now()));
  const b = store.buildMessageRequest(input("om-b-" + Date.now()));
  assert.notEqual(a.id, b.id);
  store.markStatus(a.id, "cancelled"); store.markStatus(b.id, "cancelled");
});

test("admission claim blocks another host and failure is not delivered", () => {
  const req = store.buildMessageRequest(input("om-claim-" + Date.now()));
  assert.equal(store.claimRequestDelivery(req.id), true);
  assert.equal(store.claimRequestDelivery(req.id), false);
  store.failRequestDelivery(req.id, "host rejected");
  const saved = store.getRequest(req.id);
  assert.equal(saved.status, "failed");
  assert.equal(saved.deliveredAt, null);
  assert.equal(store.claimRequestDelivery(req.id), false);
});

test("NDJSON retains a structured error even after partial text", () => {
  const parsed = store.parseNdjson(JSON.stringify({ type: "text", text: "partial" }) + "\n" + JSON.stringify({ type: "error", message: "preset not composed" }));
  assert.equal(parsed.error, "preset not composed");
});

function host(controller) {
  const listeners = new Map();
  let tick;
  const original = globalThis.setInterval;
  globalThis.setInterval = (fn) => { tick = fn; return { unref() {} }; };
  const ctx = {
    on(name, fn) { const list = listeners.get(name) ?? []; list.push(fn); listeners.set(name, list); },
    get: (name) => name === "sessionController" ? controller : undefined,
    emit(name, ...args) { for (const fn of listeners.get(name) ?? []) fn(...args); },
  };
  try { apply(ctx, { pollMs: 500, minTurnMs: 3000 }); } finally { globalThis.setInterval = original; }
  return { ctx, tick };
}
async function settle(predicate) {
  for (let i = 0; i < 50; i++) { if (predicate()) return; await new Promise(setImmediate); }
  assert.ok(predicate(), "injector must settle");
}

test("controller rejection never sets deliveredAt", async () => {
  const req = store.buildMessageRequest(input("om-reject-" + Date.now()));
  const h = host({ prompt: async () => { throw new Error("admission rejected"); } });
  h.tick();
  await settle(() => store.getRequest(req.id).status === "failed");
  assert.equal(store.getRequest(req.id).deliveredAt, null);
});

test("no controller leaves request pending without claiming delivery", async () => {
  const req = store.buildMessageRequest(input("om-offline-" + Date.now()));
  host(undefined).tick();
  await new Promise(setImmediate);
  assert.equal(store.getRequest(req.id).status, "pending");
  assert.equal(store.getRequest(req.id).deliveryClaim, undefined);
  store.markStatus(req.id, "cancelled");
});

test("two host pollers admit once and return a subsecond remote final beyond 900 chars", async () => {
  const req = store.buildMessageRequest(input("om-once-" + Date.now()));
  const full = "远程完整回答".repeat(200) + "END-OF-REPLY";
  let calls = 0;
  let h;
  const controller = { prompt: async (request, signal) => {
    calls++; assert.equal(request.mode, "queue"); assert.ok(signal instanceof AbortSignal);
    assert.equal(request.requestId, "rpc-" + req.id);
    const session = { id: req.sessionId, header: { cwd: "D:/test" } };
    const emit = (type, data, time) => h.ctx.emit("session/event", session, { type, data, time });
    emit("turn/start", { turn: 1 }, 1000);
    emit("user/message", { source: { kind: "user", rpcId: request.requestId }, content: request.content });
    emit("assistant/message", { turn: 1, message: { content: [{ type: "text", text: full }] } });
    emit("turn/end", { turn: 1, reason: { kind: "completed" } }, 1100);
  } };
  h = host(controller);
  const second = host(controller);
  h.tick(); second.tick();
  await settle(() => store.getRequest(req.id).delivery === "injected");
  assert.equal(calls, 1);
  const results = store.loadState().outbox.filter((r) => r.sessionId === req.sessionId);
  assert.equal(results.length, 1);
  assert.match(results[0].text, /END-OF-REPLY/);
  assert.match(results[0].text, /会话回复/);
  assert.deepEqual(results[0].feishuTarget, { id: "oc_test", type: "chat_id" });
});

test("remote failed turn also sends its notification to the source chat", async () => {
  const req = store.buildMessageRequest({ ...input("om-error-" + Date.now()), sessionId: "session-error-test", replyChatId: "oc_source_error" });
  const h = host(undefined);
  const session = { id: req.sessionId, header: { cwd: "D:/test" } };
  const emit = (type, data, time) => h.ctx.emit("session/event", session, { type, data, time });
  emit("turn/start", { turn: 1 }, 1000);
  emit("user/message", { source: { kind: "user", rpcId: "rpc-" + req.id }, content: [{ type: "text", text: "test" }] });
  emit("turn/end", { turn: 1, reason: { kind: "error" } }, 1100);
  await new Promise(setImmediate);
  const notice = store.loadState().outbox.find((r) => r.sessionId === req.sessionId);
  assert.deepEqual(notice.feishuTarget, { id: "oc_source_error", type: "chat_id" });
  store.markStatus(req.id, "cancelled");
});
