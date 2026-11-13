#!/usr/bin/env node
/**
 * fx-hitl.mjs — 飞书侧命令行（2026-11-05 新通道）。
 *
 * 与 wx-hitl.mjs 共用同一个 HITL 状态机（lib/hitl-store.js），差别只有两点：
 *   1) 进程启动前把 DSH_HITL_CHANNEL 固定成 feishu（决定出口走 lark-cli 而不是 openclaw 网关）；
 *   2) 落点从 state/feishu-target.json 读（open_id | chat_id | email）。
 *
 * 用法：
 *   node D:\src\dsh\dsh-wechat-hitl\bin\fx-hitl.mjs status
 *   node ...\fx-hitl.mjs target --id ou_xxx --type open_id        # 设落点
 *   node ...\fx-hitl.mjs target --show
 *   node ...\fx-hitl.mjs probe --text "通道测试"                  # 直接发一条，验证 lark-cli 出口
 *   node ...\fx-hitl.mjs notify --title "构建完成" --text "3 个包已发布"
 *   node ...\fx-hitl.mjs ask --title "删除确认" --question "要删 _INBOX/tmp 吗？" --options "允许|拒绝" --ttl-min 30
 *   node ...\fx-hitl.mjs switch --state running|paused|stopped  （或 on / pause / off）
 *   node ...\fx-hitl.mjs sessions / bind --session 3 / bind --auto
 *   node ...\fx-hitl.mjs daemon status                          # 看守护进程心跳
 */
process.env.DSH_HITL_CHANNEL = process.env.DSH_HITL_CHANNEL || "feishu";

const store = await import("../lib/hitl-store.js");

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

function out(value) { process.stdout.write(value + "\n"); }

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "status";

if (command === "status") {
  const control = store.getControl();
  const target = store.getFeishuTarget();
  const daemon = store.feishuDaemonAlive();
  out(JSON.stringify({
    channel: store.currentChannel(),
    switch: { state: control.state, describe: store.describeControl(control) },
    resultPush: store.describeResultPush(),
    sending: store.isSending(),
    outboxQueued: store.outboxSummary().queued ?? store.outboxSummary(),
    pendingCount: store.listPending().length,
    target,
    larkRunJs: store.FEISHU.runJs,
    larkConfigDir: store.FEISHU.configDir,
    daemon,
  }, null, 2));
} else if (command === "channel") {
  const wanted = String(args._[1] ?? args.state ?? "show").toLowerCase();
  if (wanted === "show" || wanted === "status") {
    out(JSON.stringify({ ok: true, channel: store.currentChannel(), file: store.CHANNEL_FILE }, null, 2));
  } else if (wanted === "feishu" || wanted === "wechat") {
    const saved = store.setChannel(wanted, "cli");
    out(JSON.stringify({ ok: true, channel: saved.channel, note: "DSH 侧插件 1 秒内生效，无需重启 DSH" }));
  } else {
    out("用法: fx-hitl channel feishu|wechat|show");
    process.exit(2);
  }
} else if (command === "target") {
  if (args.show) {
    out(JSON.stringify({ ok: true, target: store.getFeishuTarget() }, null, 2));
  } else if (typeof args.id === "string" && args.id) {
    const saved = store.setFeishuTarget(args.id, typeof args.type === "string" ? args.type : "open_id");
    out(JSON.stringify({ ok: true, target: saved }));
  } else {
    out(JSON.stringify({ ok: false, error: "用法: fx-hitl target --id <open_id|chat_id|email> [--type open_id|chat_id|email] 或 target --show" }));
    process.exit(2);
  }
} else if (command === "probe") {
  const text = typeof args.text === "string" ? args.text : "fx-hitl 通道测试 " + new Date().toISOString();
  const result = await store.feishuSend(null, text);
  out(JSON.stringify({ ok: result.code === 0, output: result.output.slice(-500) }));
  process.exit(result.code === 0 ? 0 : 1);
} else if (command === "notify") {
  const text = typeof args.text === "string" ? args.text : "";
  if (!text) { out("notify 需要 --text \"内容\""); process.exit(2); }
  const header = args.title ? String(args.title) + "\n" : "";
  const result = await store.pushWechat(header + text);
  out(JSON.stringify({ ok: result.ok, queued: result.queued ?? false, suppressed: result.suppressed ?? false, mode: result.mode, output: String(result.output ?? "").slice(-300) }));
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
    req = store.createRequest({
      sessionId: currentSession(args),
      mode: args.mode === "approval" ? "approval" : "inject",
      kind: args.kind ? String(args.kind) : "manual",
      title: args.title ? String(args.title) : (options ? "需要确认" : "需要回答"),
      question,
      options: options ?? undefined,
      context: args.context ? String(args.context) : "",
      cwd: process.env.DSH_SESSION_ID ? process.cwd() : store.PATHS.workdir,
    }, ttlMin * 60 * 1000);
  } catch (error) {
    out(JSON.stringify({ ok: false, suppressed: true, state: error.switchState ?? store.getControl().state, error: String(error.message) }));
    process.exit(1);
  }
  const result = await store.pushWechat(store.formatAsk(req));
  out(JSON.stringify({ ok: result.ok, handle: req.handle, requestId: req.id, sessionId: req.sessionId, push: String(result.output ?? "").slice(-200) }));
  process.exit(result.ok ? 0 : 1);
} else if (command === "switch" || command === "on" || command === "pause" || command === "off") {
  const shorthand = { on: "running", pause: "paused", off: "stopped" };
  const wanted = shorthand[command] ?? (typeof args.state === "string" ? args.state : "");
  if (!wanted) { out("用法: fx-hitl.mjs switch --state running|paused|stopped [--reason \"...\"]  或 on / pause / off"); process.exit(2); }
  const record = store.setControl(wanted, { by: args.by ? String(args.by) : "cli", reason: args.reason ? String(args.reason) : "" });
  out(JSON.stringify({ ok: true, state: record.state, describe: store.describeControl(record) }));
} else if (command === "push") {
  const arg = String(args._[1] ?? args.state ?? "status").toLowerCase();
  if (["on", "开"].includes(arg)) { const r = store.setResultPush(true, { by: "cli" }); out(JSON.stringify({ ok: true, resultPush: r.to })); }
  else if (["off", "关"].includes(arg)) { const r = store.setResultPush(false, { by: "cli" }); out(JSON.stringify({ ok: true, resultPush: r.to })); }
  else out(store.describeResultPush());
} else if (command === "sessions") {
  const sessions = store.listSessions(8);
  const bound = store.getBinding();
  out(JSON.stringify({ bound: bound ? bound.sessionId : null, sessions }, null, 2));
} else if (command === "bind") {
  if (args.auto || args.clear) {
    store.clearBinding("cli");
    out(JSON.stringify({ ok: true, bound: null }));
  } else {
    const token = args.session && args.session !== true ? String(args.session) : (args._[1] ?? "");
    const picked = store.pickSession(token, store.listSessions(8));
    if (!picked) { out(JSON.stringify({ ok: false, error: "找不到会话: " + token })); process.exit(1); }
    const record = store.setBinding(picked.sessionId, args.label ? String(args.label) : "飞书驱动", "cli");
    out(JSON.stringify({ ok: true, bound: record.sessionId, label: record.label }));
  }
} else if (command === "daemon") {
  const sub = String(args._[1] ?? "status");
  if (sub === "status") out(JSON.stringify({ ok: true, daemon: store.feishuDaemonAlive() }, null, 2));
  else { out(JSON.stringify({ ok: false, error: "daemon 目前只有 status；启动用 tools/restart-feishu-daemon.ps1" })); process.exit(2); }
} else if (command === "list") {
  const pending = store.listPending();
  out(JSON.stringify({ pendingCount: pending.length, pending }, null, 2));
} else {
  out("未知命令: " + command);
  process.exit(2);
}
