import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 针对「发件箱静默丢消息」的回归测试（2026-10-26 故障）。
 *
 * 故障现场：out-1792996945520-4f5afe 在 14:42 网关重启窗口只有 push-queued，
 * 既没有 outbox-sent 也没有 outbox-failed 就消失了，用户手机上没收到。
 * 根因类别：三个写入者（DSH 宿主插件 / 网关出站泵 / CLI）对 pending.json 做
 * 无锁「读-改-写」，后写者用旧快照整体覆盖，前者的条目被抹掉。
 *
 * 这里只测状态层能自证的部分：跨进程互斥、崩溃残留锁自愈、入队不再被探活阻塞。
 * 真正的「网关重启中途死亡」端到端验证靠线上日志（outbox-reclaim / outbox-sent）。
 */

const STATE = process.env.DSH_WECHAT_HITL_STATE;
assert.ok(STATE, "本测试必须由 test/run-tests.ps1 设置 DSH_WECHAT_HITL_STATE 指向隔离目录");
const STORE_URL = pathToFileURL(join(process.cwd(), "lib", "hitl-store.js")).href;
const STATE_FILE = join(STATE, "pending.json");
const LOCK_FILE = STATE_FILE + ".lock";

const readOutbox = () => {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")).outbox ?? []; } catch { return []; }
};
const resetState = () => {
  try { rmSync(STATE_FILE); } catch {}
  try { rmSync(LOCK_FILE); } catch {}
};

function pushInChild(tag) {
  const script = [
    "const { pushWechat } = await import(" + JSON.stringify(STORE_URL) + ");",
    "for (let i = 0; i < 5; i += 1) { await pushWechat(" + JSON.stringify(tag) + " + '-' + i, undefined, { probeMs: 100 }); }",
    "process.exit(0);",
  ].join("\n");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: process.env, stdio: "ignore" });
    child.on("exit", (code) => resolve(code));
    child.on("error", () => resolve(-1));
  });
}

test("三个进程并发写入：15 条一条都不能少（跨进程锁）", async () => {
  resetState();
  const codes = await Promise.all([pushInChild("p1"), pushInChild("p2"), pushInChild("p3")]);
  assert.deepEqual(codes, [0, 0, 0], "子进程应正常退出");
  const outbox = readOutbox();
  assert.equal(outbox.length, 15, "实际条数=" + outbox.length + "，说明有丢更新");
  const ids = new Set(outbox.map((item) => item.id));
  assert.equal(ids.size, 15, "id 不应重复");
  assert.equal(existsSync(LOCK_FILE), false, "锁必须在写入后释放");
});

test("崩溃残留锁（超过 staleMs）可被抢占自愈", async () => {
  resetState();
  writeFileSync(LOCK_FILE, "999999", "utf8");
  const old = new Date(Date.now() - 60000);
  utimesSync(LOCK_FILE, old, old);
  const { pushWechat } = await import(STORE_URL);
  const started = Date.now();
  const result = await pushWechat("after-stale-lock", undefined, { probeMs: 100 });
  assert.equal(result.ok, true);
  assert.equal(readOutbox().length, 1, "抢占后应能正常写入");
  assert.equal(existsSync(LOCK_FILE), false, "抢占后应释放锁");
  assert.ok(Date.now() - started < 3000, "抢占不应长时间阻塞");
});

test("入队立即返回 queued，不再等网关探活（不再误报 gateway-probe-timeout）", async () => {
  resetState();
  const { pushWechat } = await import(STORE_URL);
  const started = Date.now();
  const result = await pushWechat("probe-nonblocking", undefined, { probeMs: 3000 });
  const elapsed = Date.now() - started;
  assert.equal(result.output, "queued");
  assert.equal(result.gatewayUp, null, "探活结果改为异步写入审计日志，不再阻塞返回");
  assert.ok(elapsed < 1500, "入队耗时 " + elapsed + "ms，说明仍在同步等探活");
});
test("超过 TTL 的积压被丢弃时必须留痕（outbox-dropped）", async () => {
  resetState();
  const store = await import(STORE_URL);
  const expiredId = "out-ttl-test-" + Math.random().toString(16).slice(2, 8);
  const expired = { id: expiredId, text: "ttl-expired-" + expiredId, createdAt: Date.now() - 31 * 60 * 1000, attempts: 0 };
  store.mutate((state) => { state.outbox = [expired]; return true; });
  const result = await store.drainOutbox();
  assert.equal(result.dropped, 1, "应统计到 1 条 TTL 丢弃，实际 " + JSON.stringify(result));
  assert.equal(readOutbox().length, 0, "过期条目应从队列移除");
  const logText = readFileSync(join(STATE, "hitl.log"), "utf8");
  assert.ok(logText.includes('"op":"outbox-dropped"') && logText.includes(expiredId), "丢弃必须留痕并可追溯到具体条目");
});

