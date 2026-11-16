import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { PATHS, feishuDaemonAlive } from "../lib/hitl-store.js";

assert.ok(process.env.DSH_WECHAT_HITL_STATE, "本测试必须由 test/run-tests.ps1 设置 DSH_WECHAT_HITL_STATE 指向隔离目录");
const beatFile = join(PATHS.stateDir, "feishu-daemon.json");
mkdirSync(PATHS.stateDir, { recursive: true });

function writeBeat(extra = {}) {
  const now = Date.now();
  const beat = {
    pid: process.pid,
    startedAt: now - 1000,
    tickAt: now,
    inbound: "running",
    inboundReadyAt: now - 500,
    lastError: null,
    ...extra,
  };
  writeFileSync(beatFile, JSON.stringify(beat), "utf8");
}

test("fresh heartbeat + live pid + ready inbound is up", () => {
  writeBeat();
  const status = feishuDaemonAlive();
  assert.equal(status.up, true);
  assert.equal(status.reason, null);
  assert.equal(status.pidAlive, true);
  assert.ok(status.ageMs >= 0 && status.ageMs < 5000);
});

test("stale heartbeat is not up", () => {
  writeBeat({ tickAt: Date.now() - 60000 });
  const status = feishuDaemonAlive();
  assert.equal(status.up, false);
  assert.equal(status.reason, "heartbeat-stale");
});

test("inbound without ready evidence is not up", () => {
  writeBeat({ inbound: "starting", inboundReadyAt: 0 });
  const status = feishuDaemonAlive();
  assert.equal(status.up, false);
  assert.equal(status.reason, "inbound-not-ready");
});

test("spawn-failed heartbeat is not up even if fresh", () => {
  writeBeat({ inbound: "spawn-failed", inboundReadyAt: 0 });
  const status = feishuDaemonAlive();
  assert.equal(status.up, false);
  assert.equal(status.reason, "inbound-not-ready");
});

test("dead pid is not up", () => {
  writeBeat({ pid: 2147483647 });
  const status = feishuDaemonAlive();
  assert.equal(status.up, false);
  assert.equal(status.reason, "pid-not-alive");
});

test("missing heartbeat is unknown", () => {
  try { unlinkSync(beatFile); } catch {}
  const status = feishuDaemonAlive();
  assert.equal(status.up, false);
  assert.equal(status.reason, "no-heartbeat");
});
