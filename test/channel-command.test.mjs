import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";

// 在 runner 给的隔离根目录下再切一层 "-channel"：/l 会给会话分配会话码并写 sessions.json，
// 直接共用 state-test 会把兄弟用例对「码 / 粘连写法」的断言搅乱（2026-11-06 实测）。
const TEST_BASE = process.env.DSH_WECHAT_HITL_STATE || "D:/src/dsh/dsh-wechat-hitl/state-test";
process.env.DSH_WECHAT_HITL_STATE = TEST_BASE + "/channel"; // 子目录：state-test/ 已被 .gitignore 覆盖
const store = await import("../lib/hitl-store.js");

const rows = [
  { index: 1, sessionId: "session-aaa", code: 50, name: "信用账户SRS修订与待核事项", workspace: "D:\\src\\ncbs" },
  { index: 2, sessionId: "session-bbb", code: 7, name: "日报", workspace: "D:\\work\\a" },
  { index: 3, sessionId: "session-ccc", code: 12, name: "翻译·菜单", workspace: "D:\\src\\ncbs" },
];

test("非指令不算命令", () => {
  assert.equal(store.runChannelCommand("帮我跑一下测试"), null);
  assert.equal(store.runChannelCommand("50 继续"), null);
  assert.equal(store.runChannelCommand(""), null);
});

test("/l 返回清单而不是空", () => {
  const r = store.runChannelCommand("/l", { by: "feishu" });
  assert.equal(r.kind, "list");
  assert.match(r.text, /可驱动会话/);
});

test("按清单第一列（会话码）命中，而不是按第 N 行", () => {
  // 码 7 在第 2 行：按行号会让它去第 7 行（不存在），按码才是对的
  assert.equal(store.resolveBindTarget("7", rows).sessionId, "session-bbb");
  assert.equal(store.resolveBindTarget("50", rows).sessionId, "session-aaa");
});

test("码不存在时退回「第 N 行」兜底", () => {
  // 隔离目录可能残留上一轮的会话码，先清空登记表，确保是"码不存在"的场景
  mkdirSync(process.env.DSH_WECHAT_HITL_STATE, { recursive: true });
  writeFileSync(store.REGISTRY_FILE, JSON.stringify({ version: 1, nextCode: 1, bySession: {} }), "utf8");
  assert.equal(store.resolveBindTarget("2", rows).sessionId, "session-bbb");
});

test("标题唯一命中；多条命中报歧义不猜；找不到返回 null", () => {
  assert.equal(store.resolveBindTarget("信用账户", rows).sessionId, "session-aaa");
  const ambiguous = store.resolveBindTarget("翻译", [
    { index: 1, sessionId: "session-x1", code: 1, name: "翻译·菜单" },
    { index: 2, sessionId: "session-x2", code: 2, name: "翻译·词根" },
  ]);
  assert.equal(ambiguous.sessionId, undefined);
  assert.equal(ambiguous.ambiguous.length, 2);
  assert.equal(store.resolveBindTarget("不存在的名字", rows), null);
  assert.equal(store.resolveBindTarget("  ", rows), null);
});

test("/a 取消绑定，/who 能反映未绑定", () => {
  assert.equal(store.runChannelCommand("/a", { by: "feishu" }).kind, "unbind");
  assert.equal(store.getBinding()?.sessionId ?? "", "");
  const who = store.runChannelCommand("/who", { by: "feishu" });
  assert.equal(who.kind, "who");
  assert.match(who.text, /通道：/);
  assert.match(who.text, /默认落点/);
});

test("未知斜杠指令给出用法（含 /new），不会被当普通消息转发", () => {
  const r = store.runChannelCommand("/xyz", { by: "feishu" });
  assert.equal(r.kind, "unknown");
  assert.match(r.text, /\/l/);
  assert.match(r.text, /\/new/);
});

test("/new：指令自包含，回执标记能被解析", () => {
  const ins = store.buildNewSessionInstruction({ title: "远程日报" });
  assert.match(ins, /new_session/);
  assert.match(ins, /远程日报/);
  assert.match(ins, /\[\[new_session:</); // 指令里必须示范标记格式
  assert.equal(store.parseNewSessionMarker("好的\n[[new_session:session-1234abcd-5678]]\n完毕"), "session-1234abcd-5678");
  assert.equal(store.parseNewSessionMarker("没有标记"), null);
  assert.equal(store.parseNewSessionMarker("[[new_session:bad]]"), null);
});

test("码空间 1..999：满了回收最老的一条，并留下替换提示", () => {
  assert.equal(store.MAX_SESSION_CODE, 999);
  const dir = process.env.DSH_WECHAT_HITL_STATE;
  mkdirSync(dir, { recursive: true });
  const bySession = {};
  for (let code = 1; code <= 999; code += 1) {
    bySession["session-old-" + code] = { code, createdAt: 1000 + code, label: code === 1 ? "最老的一条" : "" };
  }
  writeFileSync(store.REGISTRY_FILE, JSON.stringify({ version: 1, nextCode: 1000, bySession }), "utf8");
  store.drainRecycleNotices();

  const out = store.sessionCodeWithRecycle("session-brand-new");
  assert.equal(out.replaced.code, 1);            // 回收 createdAt 最小的（code 1）
  assert.equal(out.replaced.label, "最老的一条");
  assert.equal(out.code, 1);                     // 新会话复用这条码
  assert.equal(store.sessionByCode(1).sessionId, "session-brand-new");
  const notices = store.drainRecycleNotices();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].code, 1);
  assert.equal(store.drainRecycleNotices().length, 0); // 提示只给一次
});
