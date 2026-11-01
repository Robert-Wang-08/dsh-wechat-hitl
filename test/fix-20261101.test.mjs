/**
 * fix-20261101.test.mjs — 2026-11-01 通道恢复的三个回归点。
 *
 * 起因：用户报「微信打开通道不生效、交互没有会话码/回复码」。实测根因两条：
 *   1) 网关进程内出站（inproc）每次都 contextToken missing，推送全部积压后被 TTL 丢掉；
 *   2) 微信侧开关指令只认「推送开／推送关／推送状态」这种严格短句，
 *      「打开会话微信推送开关」「打开openclaw通道」被判成普通提问，被待确认拦截器截胡。
 * 这里把修复口径固化为断言，避免以后再退回字面匹配。
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.DSH_WECHAT_HITL_STATE = process.env.DSH_WECHAT_HITL_STATE || "D:/src/dsh/dsh-wechat-hitl/state-test";

const store = await import("../lib/hitl-store.js");

beforeEach(() => {
  store.setControl("running", { by: "beforeEach" });
  store.mutate((state) => {
    state.outbox = [];
    state.requests = {};
    return true;
  });
});

test("推送开关：自然表述也能识别（含 openclaw 通道说法）", () => {
  const cases = [
    ["推送开", "on"],
    ["推送关", "off"],
    ["推送状态", "status"],
    ["推送", "status"],
    ["打开推送", "on"],
    ["打开会话微信推送开关", "on"],
    ["打开openclaw通道", "on"],
    ["先把推送打开", "on"],
    ["关掉推送", "off"],
    ["关闭结果推送", "off"],
    ["恢复推送", "on"],
    ["结果推送关", "off"],
    ["推送通知开启", "on"],
    ["查询推送", "status"],
  ];
  for (const [text, action] of cases) {
    assert.equal(store.parsePushCommand(text)?.action, action, text + " 应识别为 " + action);
  }
});

test("推送开关：不像开关指令的句子一律不抢（会话驱动/其他语义）", () => {
  for (const text of [
    "1 帮我跑测试",
    "关闭其他会话的推送",
    "推送 关 谢谢",
    "这个会话的推送怎么没有了",
    "把 logseq 里的推送记录清一下",
    "",
  ]) {
    assert.equal(store.parsePushCommand(text), null, "不得误判：" + text);
  }
});

test("文案：歧义提示与补选项提示都要带会话码/识别码/R 编号", () => {
  const req = store.createRequest({
    sessionId: "session-fix20261101-aaaa-bbbb",
    mode: "inject",
    kind: "question",
    title: "回归用例",
    question: "这是回归用例的问题正文",
    options: ["第一项", "第二项"],
    context: "test",
  });
  const handle = store.handleText(req);
  const code = store.sessionCode(req.sessionId);
  const rNo = "R" + String(req.id).slice(-6);

  const ambiguous = store.formatAmbiguous([req]);
  assert.match(ambiguous, new RegExp("会话码 " + code));
  assert.match(ambiguous, new RegExp("识别码 " + handle));
  assert.ok(ambiguous.includes(rNo), "歧义提示必须带 R 编号");
  assert.match(ambiguous, /推送开关/, "歧义提示要告诉用户怎么开关推送");

  const needOption = store.formatNeedOption(req);
  assert.match(needOption, new RegExp("会话码 " + code));
  assert.match(needOption, new RegExp("识别码 " + handle));
  assert.match(needOption, /请回「识别码 空格 选项」/);
});

test("contextToken 兜底：读账号 token 文件不炸、账号不存在时返回 null", () => {
  assert.equal(store.readContextTokenFromFile("no-such-account-for-test", "nobody@im.wechat"), null);
  const value = store.readContextTokenFromFile("66b3a3ae4579-im-bot", "o9cq809dq0T-EHbYNw82tLLPpkpI@im.wechat");
  // 本机联网账号正常情况下有 token；没有也不该抛异常，只允许 null。
  assert.ok(value === null || typeof value === "string");
});
