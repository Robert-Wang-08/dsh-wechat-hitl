#!/usr/bin/env node
/**
 * wx-hitl.mjs — DSH 侧命令行：把「需要人工确认」或「会话结果」主动推到微信，并支持回环验证。
 *
 * 用法（在任意 DSH 会话的 bash/pwsh 里都可跑）：
 *   node D:\nutstore\1.logseq\70-WorkSpace\wechat-hitl-20261026\bin\wx-hitl.mjs notify --text "任务完成：xxx"
 *   node ...\wx-hitl.mjs ask --question "是否允许删除 _INBOX/tmp？" --options "允许|拒绝" --title "删除文件"
 *   node ...\wx-hitl.mjs status
 *   node ...\wx-hitl.mjs resolve --id req-xxxx --answer 1        # 不用微信也能模拟答复
 *   node ...\wx-hitl.mjs continue --id req-xxxx                  # 手动把答复注入原会话（headless）
 *
 * 会话 id 默认取 $env:DSH_SESSION_ID（DSH 会给每个会话注入），可用 --session 覆盖。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PATHS, createRequest, listPending, getRequest, matchReply, markAnswered, markDelivered,
  markStatus, formatAsk, formatResolved, formatAmbiguous, pushWechat, buildContinuationPrompt,
  runHeadlessTurn, parseNdjson, shortId, log,
  getControl, setControl, describeControl, CONTROL_STATES, loadState as loadStateSafe,
  getResultPush, setResultPush, describeResultPush, parsePushCommand,
  getBinding, setBinding, clearBinding, listSessions, pickSession, formatSessionList, buildMessageRequest,
} from "../lib/hitl-store.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { args[key] = true; } else { args[key] = next; i += 1; }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function currentSession(args) {
  const value = args.session && args.session !== true ? args.session : (process.env.DSH_SESSION_ID || "");
  return value === "auto" ? (process.env.DSH_SESSION_ID || "") : value;
}

function out(text) { process.stdout.write(text + "\n"); }

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "status";

if (command === "notify") {
  const text = typeof args.text === "string" ? args.text : "";
  if (!text) { out("notify 需要 --text \"内容\""); process.exit(2); }
  const header = args.title ? String(args.title) + "\n" : "";
  const result = await pushWechat(header + text);
  out(JSON.stringify({ ok: result.ok, code: result.code, output: result.output.slice(-300) }));
  process.exit(result.ok ? 0 : 1);
} else if (command === "ask") {
  const question = typeof args.question === "string" ? args.question : "";
  if (!question) { out("ask 需要 --question \"问题\""); process.exit(2); }
  const options = typeof args.options === "string" && args.options.length > 0
    ? args.options.split("|").map((item) => item.trim()).filter(Boolean)
    : null;
  const ttlMin = args["ttl-min"] ? Number(args["ttl-min"]) : 30;
  let req;
  try {
    req = createRequest({
      sessionId: currentSession(args),
      mode: args.mode === "approval" ? "approval" : "inject",
      kind: args.kind ? String(args.kind) : "manual",
      title: args.title ? String(args.title) : (options ? "需要确认" : "需要回答"),
      question,
      options: options ?? undefined,
      context: args.context ? String(args.context) : "",
      cwd: process.env.DSH_SESSION_ID ? process.cwd() : PATHS.workdir,
    }, ttlMin * 60 * 1000);
  } catch (error) {
    // 非 running（paused/stopped）时拒绝建请求：既不推送也不留悬空请求
    out(JSON.stringify({ ok: false, suppressed: true, state: error.switchState ?? getControl().state, error: String(error.message) }));
    process.exit(1);
  }
  const result = await pushWechat(formatAsk(req));
  out(JSON.stringify({ ok: result.ok, handle: req.handle, requestId: req.id, sessionId: req.sessionId, push: result.output.slice(-200) }));
  process.exit(result.ok ? 0 : 1);
} else if (command === "switch" || command === "on" || command === "pause" || command === "off") {
  // 三态开关：switch --state running|paused|stopped；或简写 on / pause / off
  const shorthand = { on: "running", pause: "paused", off: "stopped" };
  const wanted = shorthand[command] ?? (typeof args.state === "string" ? args.state : "");
  if (!wanted) { out("用法: wx-hitl.mjs switch --state running|paused|stopped [--reason \"...\"]  或 on / pause / off"); process.exit(2); }
  const record = setControl(wanted, { by: args.by ? String(args.by) : "cli", reason: args.reason ? String(args.reason) : "" });
  out(JSON.stringify({ ok: true, state: record.state, describe: describeControl(record) }));
} else if (command === "sessions") {
  const sessions = listSessions(8);
  const bound = getBinding();
  out(JSON.stringify({ bound: bound ? bound.sessionId : null, sessions }, null, 2));
  if (sessions.length > 0) out(formatSessionList(sessions, bound));
} else if (command === "bind") {
  if (args.auto || args.clear) {
    clearBinding("cli");
    out(JSON.stringify({ ok: true, bound: null }));
  } else {
    const token = args.session && args.session !== true ? String(args.session) : (args._[1] ?? "");
    const sessions = listSessions(8);
    const picked = pickSession(token, sessions);
    if (!picked) { out(JSON.stringify({ ok: false, error: "找不到会话: " + token + "（先用 sessions 看清单）" })); process.exit(1); }
    const record = setBinding(picked.sessionId, args.label ? String(args.label) : "微信驱动", "cli");
    out(JSON.stringify({ ok: true, bound: record.sessionId, label: record.label }));
  }
} else if (command === "push") {
  // REQ-001/002：结果推送总开关（on | off | status）
  const arg = String(args._[1] ?? args.state ?? "status").toLowerCase();
  if (!["on", "off", "status", "开", "关"].includes(arg)) {
    out(JSON.stringify({ ok: false, error: "用法：push on|off|status" }));
    process.exit(2);
  }
  if (arg === "status") { out(describeResultPush()); process.exit(0); }
  const on = ["on", "开"].includes(arg);
  const result = setResultPush(on, { by: "cli", reason: "wx-hitl push " + arg });
  out((result.to ? "🟢 结果推送：已开" : "🟡 结果推送：已关") + "（" + (result.from ? "开" : "关") + " → " + (result.to ? "开" : "关") + "）");
  process.exit(0);
} else if (command === "relay") {
  // 把一段文本转发进指定会话（微信之外的另一个驱动入口，便于脚本/测试）
  const text = typeof args.text === "string" ? args.text : "";
  const bound = getBinding();
  const sessionId = args.session && args.session !== "auto" ? String(args.session) : (bound?.sessionId ?? "");
  if (!sessionId) { out(JSON.stringify({ ok: false, error: "没有绑定会话，也没有 --session" })); process.exit(1); }
  if (!text) { out(JSON.stringify({ ok: false, error: "relay 需要 --text" })); process.exit(1); }
  try {
    const req = buildMessageRequest({ sessionId, text, context: "CLI relay" });
    // 优先等活着的宿主注入（进程内）；12 秒没动静就 headless 续跑兜底
    let delivered = null;
    for (let i = 0; i < 24; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const fresh = getRequest(req.id);
      if (fresh?.deliveredAt) { delivered = fresh; break; }
    }
    if (delivered) {
      out(JSON.stringify({ ok: true, requestId: req.id, sessionId, delivery: delivered.delivery, note: "已由活着的宿主注入" }));
    } else {
      const run = await runHeadlessTurn(sessionId, text);
      const parsed = parseNdjson(run.stdout);
      markDelivered(req.id, parsed.text ? "injected" : "not-live");
      out(JSON.stringify({ ok: run.ok || !!parsed.text, requestId: req.id, sessionId, delivery: parsed.text ? "headless-injected" : "failed", text: parsed.text, stderrTail: String(run.stderr ?? "").trim().split(/\r?\n/).pop() ?? "" }));
      process.exit(parsed.text ? 0 : 1);
    }
  } catch (error) {
    out(JSON.stringify({ ok: false, suppressed: true, state: error.switchState ?? null, error: String(error.message) }));
    process.exit(1);
  }
} else if (command === "status") {
  const control = getControl();
  const pending = listPending();
  const state = JSON.parse(JSON.stringify(loadStateSafe()));
  out(JSON.stringify({
    switch: { state: control.state, describe: describeControl(control), updatedAt: control.updatedAt, updatedBy: control.updatedBy, reason: control.reason ?? "" },
    sending: control.state === "running",
    outboxQueued: Array.isArray(state.outbox) ? state.outbox.length : 0,
    pendingCount: pending.length,
    pending: pending.map((req) => ({ handle: req.handle ?? null, id: req.id, mode: req.mode, kind: req.kind, question: req.question.slice(0, 80), sessionId: req.sessionId, expiresAt: new Date(req.expiresAt).toISOString() })),
  }, null, 2));
} else if (command === "resolve") {
  const id = args.id && args.id !== true ? String(args.id) : "";
  if (!id) { out("resolve 需要 --id <requestId|shortId>"); process.exit(2); }
  const pending = listPending();
  const target = pending.find((req) => req.id === id || shortId(req.id) === id) ?? null;
  if (!target) { out(JSON.stringify({ ok: false, error: "no such pending request: " + id })); process.exit(1); }
  const matched = matchReply(String(args.answer ?? "1"), [target]);
  const option = matched.ok ? matched.option : { key: "", label: String(args.answer ?? "") };
  markAnswered(target.id, { key: option.key, label: option.label, raw: String(args.answer ?? "") }, "cli");
  out(JSON.stringify({ ok: true, id: target.id, answer: option }));
} else if (command === "continue") {
  const id = args.id && args.id !== true ? String(args.id) : "";
  const state = id ? getRequest(id) : null;
  if (!state) { out(JSON.stringify({ ok: false, error: "no such request: " + id })); process.exit(1); }
  if (state.status !== "answered") { out(JSON.stringify({ ok: false, error: "request not answered yet: " + state.status })); process.exit(1); }
  const prompt = buildContinuationPrompt(state);
  const run = await runHeadlessTurn(state.sessionId, prompt);
  const parsed = parseNdjson(run.stdout);
  markDelivered(state.id, run.ok ? "injected" : "failed:" + (run.code ?? "error"));
  if (!run.timeout && run.code !== 0 && /writer|owned|lock/i.test(run.stderr || "")) {
    markDelivered(state.id, "not-live");
  }
  out(JSON.stringify({ ok: run.ok, code: run.code, timeout: !!run.timeout, text: parsed.text, stderrTail: String(run.stderr ?? "").trim().split(/\r?\n/).pop() ?? "" }));
  process.exit(run.ok ? 0 : 1);
} else if (command === "cancel") {
  const id = args.id && args.id !== true ? String(args.id) : "";
  markStatus(id, "cancelled");
  out(JSON.stringify({ ok: true, id }));
} else {
  out("用法: wx-hitl.mjs <notify|ask|status|resolve|continue|cancel> [选项]\n" + JSON.stringify(PATHS));
  process.exit(2);
}
