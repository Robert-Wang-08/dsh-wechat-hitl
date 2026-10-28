import { test } from "node:test";
import assert from "node:assert/strict";
import { apply } from "../pkg/dsh-wechat-hitl/index.js";

/** 造一个最小假 ctx：记录监听器、提供事件发射与 effect。 */
function fakeCtx() {
  const listeners = new Map();
  const effects = [];
  return {
    listeners,
    on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); return () => {}; },
    effect(fn) { effects.push(fn); return () => {}; },
    get(name) { return undefined; },
    emit(name, ...args) { for (const fn of listeners.get(name) ?? []) fn(...args); },
    effects,
  };
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

