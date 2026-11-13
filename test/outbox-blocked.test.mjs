import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 针对「出站出口配置阻塞导致结果静默丢弃」的回归测试（2026-11-11 故障）。
 *
 * 故障现场：OpenClaw 网关进程自 11-09 起未重启，内存里是旧版 hitl-store（无 larkCliEnv 清洗），
 * 每次 feishuSend 都被 lark-cli 判为 openclaw context 未 bind（code 3）；
 * drainOutbox 把它当普通瞬时失败，60 秒退避、5 次后从 outbox 删除，正文彻底丢失，
 * 表现为「任务跑完不回信，必须人主动问」。
 *
 * 本文件锁定三件事：
 *   1) 出口配置类失败必须被识别成 config，不消耗 attempts、不丢弃；
 *   2) 被阻塞的条目按 24h 窗口保留，不被 30 分钟 TTL 抢先判死；
 *   3) 任何真正丢弃都要先写死信副本，事后能补发。
 */

const STATE = process.env.DSH_WECHAT_HITL_STATE;
assert.ok(STATE, "本测试必须由 test/run-tests.ps1 设置 DSH_WECHAT_HITL_STATE 指向隔离目录");
const STORE_URL = pathToFileURL(join(process.cwd(), "lib", "hitl-store.js")).href;
const STATE_FILE = join(STATE, "pending.json");
const DEAD_FILE = join(STATE, "outbox-dead-letter.jsonl");

const readOutbox = () => {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")).outbox ?? []; } catch { return []; }
};
const resetState = () => {
  for (const f of [STATE_FILE, STATE_FILE + ".lock", DEAD_FILE]) { try { rmSync(f); } catch {} }
};
const CONFIG_OUTPUT = JSON.stringify({
  ok: false,
  identity: "bot",
  error: {
    type: "config",
    subtype: "not_configured",
    message: "openclaw context detected but lark-cli is not bound to it",
    hint: "run lark-cli config bind",
  },
});

test("classifyOutboxFailure 区分出口配置阻塞与瞬时失败", async () => {
  const { classifyOutboxFailure } = await import(STORE_URL);
  assert.equal(classifyOutboxFailure(CONFIG_OUTPUT), "config", "lark-cli 未 bind 属出口配置阻塞");
  assert.equal(classifyOutboxFailure('{"error":{"type":"api","code":230002,"message":"bot is not in the chat"}}'), "config", "bot 不在群里同样属配置问题");
  assert.equal(classifyOutboxFailure("prepare failed: contextToken missing"), "context");
  assert.equal(classifyOutboxFailure("...\n[timeout]"), "timeout");
  assert.equal(classifyOutboxFailure("ECONNRESET"), "transient");
});

test("blocked=config 的条目按 24h 窗口保留，不被 30 分钟 TTL 丢弃", async () => {
  const { outboxEntryDisposition, CONTEXT_HOLD_MS } = await import(STORE_URL);
  const now = Date.now();
  const blocked = { id: "b", blocked: "config", blockedAt: now - 31 * 60 * 1000, createdAt: now - 31 * 60 * 1000 };
  assert.equal(outboxEntryDisposition(blocked, now), "hold-blocked", "配置阻塞条目不得按 30 分钟 TTL 丢弃");
  const expired = { id: "e", blocked: "config", blockedAt: now - CONTEXT_HOLD_MS - 1000, createdAt: now - CONTEXT_HOLD_MS - 1000 };
  assert.equal(outboxEntryDisposition(expired, now), "drop-blocked-expired", "超过 24h 保留窗口才丢");
});

test("出口配置失败：条目不丢、attempts 不增、标记 blocked=config 并留痕", async () => {
  resetState();
  const store = await import(STORE_URL);
  store.setOutboxSender(async () => ({ ok: false, output: CONFIG_OUTPUT }));
  const id = "out-cfg-" + Math.random().toString(16).slice(2, 8);
  store.mutate((state) => {
    state.outbox = [{ id, text: "config-blocked-payload", createdAt: Date.now(), attempts: 0, target: "oc-test" }];
    return true;
  });
  const result = await store.drainOutbox();
  assert.equal(result.failed, 1, "应记录 1 次失败，实际 " + JSON.stringify(result));
  assert.equal(result.dropped, 0, "配置阻塞不得计为丢弃");
  const [entry] = readOutbox();
  assert.ok(entry, "条目必须保留在发件箱里");
  assert.equal(entry.blocked, "config", "必须标记为出口配置阻塞");
  assert.equal(Number(entry.attempts ?? 0), 0, "配置阻塞不消耗重试次数");
  assert.ok(Number(entry.nextAttemptAt) > Date.now(), "应设置重试节流时间");
  const logText = readFileSync(join(STATE, "hitl.log"), "utf8");
  assert.ok(logText.includes('"op":"outbox-blocked-config"'), "必须留下可定位的阻塞日志");
  store.setOutboxSender(null);
});

test("次数耗尽的条目丢弃前先写死信副本", async () => {
  resetState();
  const store = await import(STORE_URL);
  store.setOutboxSender(async () => ({ ok: false, output: "ECONNRESET" }));
  const id = "out-dl-" + Math.random().toString(16).slice(2, 8);
  store.mutate((state) => {
    state.outbox = [{ id, text: "dead-letter-me", createdAt: Date.now(), attempts: 4, target: "oc-test" }];
    return true;
  });
  const result = await store.drainOutbox();
  assert.equal(result.dropped, 1, "第 5 次失败应丢弃，实际 " + JSON.stringify(result));
  assert.equal(readOutbox().length, 0, "丢弃后队列应为空");
  assert.ok(existsSync(DEAD_FILE), "丢弃必须写死信文件");
  const lines = readFileSync(DEAD_FILE, "utf8").trim().split("\n");
  const record = JSON.parse(lines[lines.length - 1]);
  assert.equal(record.id, id);
  assert.equal(record.reason, "attempts-exhausted");
  assert.equal(record.text, "dead-letter-me", "死信必须保留完整正文以便补发");
  store.setOutboxSender(null);
});

test("被阻塞的条目在 /who 可见，而不是只在日志里", async () => {
  resetState();
  const store = await import(STORE_URL);
  store.mutate((state) => {
    state.outbox = [{ id: "q1", text: "queued", createdAt: Date.now(), blocked: "config", blockedAt: Date.now() }];
    return true;
  });
  const text = store.describeResultPush();
  assert.match(text, /出站积压 1 条/, "必须显示积压条数");
  assert.match(text, /1 条被出站配置阻塞/, "必须点明配置阻塞");
});
