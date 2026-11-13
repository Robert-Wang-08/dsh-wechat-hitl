import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Exercise the daemon's real inbound handler without starting its event listener or sending messages.
const source = readFileSync(new URL("../feishu/feishu-daemon.mjs", import.meta.url), "utf8");
const body = source.slice(source.indexOf("function findMessage("), source.indexOf("// ── 事件流子进程"));
function harness() {
  const requests = [];
  const replies = [];
  let headless = 0;
  const store = {
    getFeishuTarget: () => ({ id: "oc_test", type: "chat_id" }),
    feishuSend: async (target, text) => { replies.push(text); return { code: 0 }; },
    parsePushCommand: () => null,
    runChannelCommand: () => null,
    resolveByCode: (text) => text.startsWith("87 ") ? { kind: "relay", sessionId: "session-test", text: text.slice(3) } : { kind: "no-code" },
    listPending: () => [],
    getBinding: () => ({ sessionId: "session-test", label: "测试会话" }),
    buildMessageRequest: (input) => { const req = { id: "req-" + requests.length, ...input, status: "pending" }; requests.push(req); return req; },
    runHeadlessTurn: async () => { headless++; return { ok: false, code: 1, stdout: JSON.stringify({ type: "error", message: "preset not composed" }) }; },
    parseNdjson: () => ({ text: null, error: "preset not composed" }),
    buildNewSessionInstruction: () => "create session",
    parseNewSessionMarker: () => "session-new",
    setBinding: () => { throw new Error("must not change binding on failure"); },
    markDelivered: () => {},
    sessionCode: () => 87,
    isResultPushEnabled: () => true,
    isSessionNotificationEnabled: () => true,
    loadState: () => ({ requests: Object.fromEntries(requests.map((req) => [req.id, req])) }),
    markRelayReport: (id, report) => { requests.find((req) => req.id === id).relayReport = report; },
    log: () => {},
  };
  const { handle, monitor } = new Function("store", body + "\nreturn { handle: handleInbound, monitor: reportRelayDelivery };")(store);
  const event = (text) => ({ message: { message_id: "om_test", chat_id: "oc_test", sender: { sender_type: "user" }, content: JSON.stringify({ text }) } });
  return { store, requests, replies, handle, monitor, event, get headless() { return headless; } };
}

for (const text of ["仍然异常吗", "87 仍然异常吗"]) {
  test("remote message queues once without launching headless: " + text, async () => {
    const h = harness();
    await h.handle(h.event(text));
    assert.equal(h.headless, 0, "preset sessions must stay in their original host");
    assert.equal(h.requests.length, 1, "one remote message must create one delivery request");
    assert.match(h.replies.join("\n"), /排队|待.*投递/);
    assert.doesNotMatch(h.replies.join("\n"), /没有拿到文本|已转给会话。/);
  });
}

test("queue failure is reported instead of claiming delivery", async () => {
  const h = harness();
  h.store.buildMessageRequest = () => { throw new Error("queue unavailable"); };
  await h.handle(h.event("继续"));
  assert.equal(h.headless, 0);
  assert.match(h.replies.join("\n"), /失败|未.*接收/);
  assert.doesNotMatch(h.replies.join("\n"), /已转给|已排队/);
});

test("ack rejection never requeues or calls an accepted request a queue failure", async () => {
  const h = harness();
  h.store.feishuSend = async () => { throw new Error("outbound offline"); };
  await h.handle(h.event("继续"));
  assert.equal(h.requests.length, 1);
  assert.equal(h.headless, 0);
});

test("/new surfaces preset errors and never changes the binding", async () => {
  const h = harness();
  await h.handle(h.event("/new 验证"));
  assert.equal(h.headless, 1);
  assert.match(h.replies.join("\n"), /preset not composed/);
  assert.doesNotMatch(h.replies.join("\n"), /已新建并绑定/);
});

test("legacy controller-failed status is never reported as accepted", async () => {
  const h = harness();
  h.requests.push({ id: "req-f", channel: "feishu", mode: "message", replyChatId: "oc_test", sessionId: "session-test", status: "delivered", delivery: "controller-failed:rejected" });
  await h.monitor();
  assert.match(h.replies[0], /未确认接收/);
  assert.doesNotMatch(h.replies[0], /宿主已接收/);
  await h.monitor();
  assert.equal(h.replies.length, 1);
});

test("waiting warning does not cancel or replay and can progress to accepted", async () => {
  const h = harness();
  const req = { id: "req-w", channel: "feishu", mode: "message", replyChatId: "oc_test", sessionId: "session-test", status: "pending", createdAt: 0, expiresAt: 200000 };
  h.requests.push(req);
  await h.monitor(60001);
  assert.match(h.replies[0], /未取消、未自动重试/);
  assert.equal(req.status, "pending");
  await h.monitor(60002);
  assert.equal(h.replies.length, 1);
  req.delivery = "injected";
  await h.monitor(70000);
  assert.match(h.replies[1], /宿主已接收/);
  assert.doesNotMatch(h.replies[1], /已完成/);
  assert.equal(h.headless, 0);
});

test("expired requests produce one warning without reexecution", async () => {
  const h = harness();
  h.requests.push({ id: "req-e", channel: "feishu", mode: "message", replyChatId: "oc_test", status: "expired", expiresAt: 1 });
  await h.monitor(100);
  assert.match(h.replies[0], /过期/);
  assert.equal(h.headless, 0);
});
