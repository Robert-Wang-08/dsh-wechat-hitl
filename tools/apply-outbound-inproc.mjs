#!/usr/bin/env node
/**
 * apply-outbound-inproc.mjs — 把 dsh-bridge 的微信出站从「spawn openclaw message send」
 * 改为「网关进程内直接调用 openclaw-weixin 的 sendMessageWeixin」。
 *
 * 为什么要改（已查明，不重复踩）：
 *   drainOutbox 起独立进程 openclaw message send，该进程自开 openclaw-agent.sqlite，
 *   与网关 getUpdates 抢写；实测 2026-10-28 13:25:10 触发
 *   SqliteSessionMutationConflictError: while preparing session-entry.patch。
 *   进程内发送不碰 openclaw-agent.sqlite（只走 ilink HTTPS + 账号 token + contextToken 文件）。
 *
 * 用到的进程内接口（都在 openclaw-weixin 官方包里，网关加载的就是这份 dist）：
 *   src/messaging/send.ts:103          sendMessageWeixin({ to, text, opts })
 *   src/auth/accounts.ts:164           loadWeixinAccount(accountId) -> { token, baseUrl, userId }
 *   src/messaging/inbound.ts:109       getContextToken(accountId, userId)
 *
 * 开关：DSH_BRIDGE_EGRESS=inproc（默认）| cli（退回旧子进程路径）。
 * 幂等：已含 marker inproc-egress-v1 即跳过。写前备份，node --check 失败自动回滚。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const MARKER = "inproc-egress-v1";
const NODE_BIN = process.env.OPENCLAW_NODE ?? "C:\\openclaw-runtime\\node.exe";
const BRIDGE = "C:\\openclaw-runtime\\plugins\\dsh-bridge\\index.js";
const STORE = "D:\\src\\dsh\\dsh-wechat-hitl\\lib\\hitl-store.js";
const check = process.argv.includes("--check");

const BRIDGE_CONST_ANCHOR = "const OUTBOX_POLL_MS = 2000;";
const BRIDGE_CONST_ADD = [
  "",
  "// ── 出站出口：进程内发送（默认） / CLI 子进程（回退） ──────────────────────",
  "// " + MARKER + "：网关进程内直接调用 openclaw-weixin 的 sendMessageWeixin，",
  "// 不再 spawn openclaw message send（那个子进程会自开 openclaw-agent.sqlite，",
  "// 与网关 getUpdates 抢写，实测触发 SqliteSessionMutationConflictError）。",
  "const EGRESS = String(process.env.DSH_BRIDGE_EGRESS ?? \"inproc\").toLowerCase() === \"cli\" ? \"cli\" : \"inproc\";",
  "const WEIXIN_EXT_DIST = \"C:/Users/wwm_1/.openclaw/extensions/openclaw-weixin/dist\";",
  "const WEIXIN_ACCOUNT_ID = \"66b3a3ae4579-im-bot\";",
  "const WEIXIN_DEFAULT_BASE = \"https://ilinkai.weixin.qq.com\";",
  "",
  "async function loadWeixinEgress() {",
  "  const send = await import(\"file:///\" + WEIXIN_EXT_DIST + \"/src/messaging/send.js\");",
  "  const accounts = await import(\"file:///\" + WEIXIN_EXT_DIST + \"/src/auth/accounts.js\");",
  "  const inbound = await import(\"file:///\" + WEIXIN_EXT_DIST + \"/src/messaging/inbound.js\");",
  "  if (typeof send.sendMessageWeixin !== \"function\") throw new Error(\"sendMessageWeixin not exported by weixin dist\");",
  "  if (typeof accounts.loadWeixinAccount !== \"function\") throw new Error(\"loadWeixinAccount not exported by weixin dist\");",
  "  if (typeof inbound.getContextToken !== \"function\") throw new Error(\"getContextToken not exported by weixin dist\");",
  "  return {",
  "    sendMessageWeixin: send.sendMessageWeixin,",
  "    loadWeixinAccount: accounts.loadWeixinAccount,",
  "    getContextToken: inbound.getContextToken,",
  "  };",
  "}",
  "",
  "let weixinEgress = null;",
  "const weixinEgressReady = EGRESS === \"inproc\"",
  "  ? loadWeixinEgress()",
  "      .then((mod) => { weixinEgress = mod; dbg({ egress: \"inproc-ready\" }); return mod; })",
  "      .catch((error) => { weixinEgress = null; dbg({ egress: \"inproc-unavailable\", error: String(error).slice(0, 300) }); return null; })",
  "  : Promise.resolve(null);",
  "",
  "/** 进程内直发：与网关同进程、同模块实例，不开 openclaw-agent.sqlite。 */",
  "async function egressSend(target, text) {",
  "  if (!weixinEgress) return { ok: false, output: \"inproc-unavailable\" };",
  "  try {",
  "    const account = weixinEgress.loadWeixinAccount(WEIXIN_ACCOUNT_ID);",
  "    const token = account && typeof account.token === \"string\" ? account.token : null;",
  "    if (!token) return { ok: false, output: \"inproc: no account token for \" + WEIXIN_ACCOUNT_ID };",
  "    const contextToken = weixinEgress.getContextToken(WEIXIN_ACCOUNT_ID, target);",
  "    if (!contextToken) return { ok: false, output: \"contextToken missing for \" + target };",
  "    const sent = await weixinEgress.sendMessageWeixin({",
  "      to: target,",
  "      text,",
  "      opts: {",
  "        baseUrl: (account && account.baseUrl) || WEIXIN_DEFAULT_BASE,",
  "        token,",
  "        contextToken,",
  "        accountId: WEIXIN_ACCOUNT_ID,",
  "      },",
  "    });",
  "    dbg({ egress: \"inproc-sent\", target, messageId: sent && sent.messageId, serverMessageId: sent && sent.serverMessageId, chars: String(text ?? \"\").length });",
  "    return { ok: true, output: \"inproc-ok\" };",
  "  } catch (error) {",
  "    dbg({ egress: \"inproc-error\", target, error: String(error).slice(0, 300) });",
  "    return { ok: false, output: \"inproc-error: \" + String(error) };",
  "  }",
  "}",
].join("\n");

const BRIDGE_SEND_ANCHOR = [
  "function sendAsync(target, text) {",
  "  if (!target || !text) { dbg({ asyncSend: \"skip\", target: !!target, hasText: !!text }); return; }",
].join("\n");
const BRIDGE_SEND_ADD = BRIDGE_SEND_ANCHOR + "\n" + [
  "  if (EGRESS === \"inproc\" && weixinEgress) {",
  "    egressSend(target, text).then((r) => dbg({ asyncSend: \"done\", via: \"inproc\", ok: r.ok, output: String(r.output).slice(-200) }));",
  "    return;",
  "  }",
].join("\n");

const BRIDGE_BOOT_ANCHOR = "    dbg({ boot: \"dsh-bridge 0.4.0\", outboxPollMs: OUTBOX_POLL_MS, pumpStartDelayMs: 45000 });";
const BRIDGE_BOOT_ADD = BRIDGE_BOOT_ANCHOR + "\n" + [
  "    dbg({ boot: \"dsh-bridge 0.4.1-inproc\", egress: EGRESS });",
  "    if (EGRESS === \"inproc\") {",
  "      Promise.all([hitlReady, weixinEgressReady]).then(([mod]) => {",
  "        if (!mod || !weixinEgress) { dbg({ egress: \"fallback-cli\", reason: !mod ? \"hitl-unavailable\" : \"weixin-unavailable\" }); return; }",
  "        if (typeof mod.setOutboxSender !== \"function\") { dbg({ egress: \"fallback-cli\", reason: \"setOutboxSender-missing\" }); return; }",
  "        mod.setOutboxSender(egressSend);",
  "        dbg({ egress: \"sender-registered\", mode: \"inproc\" });",
  "      }).catch((error) => dbg({ egress: \"sender-register-failed\", error: String(error).slice(0, 300) }));",
  "    }",
].join("\n");

const STORE_HOOK_ANCHOR = "export async function drainOutbox() {";
const STORE_HOOK_ADD = [
  "// ── 出站出口注入：" + MARKER + " ──────────────────────────────────────────────",
  "/**",
  " * 网关插件（dsh-bridge）在网关进程内直接调用 openclaw-weixin 的 sendMessageWeixin，",
  " * 从而不再 spawn 独立子进程发消息（子进程会自开 openclaw-agent.sqlite，",
  " * 与网关 getUpdates 抢写，实测引发 SqliteSessionMutationConflictError）。",
  " *",
  " * DSH_BRIDGE_EGRESS=cli 强制退回旧的子进程路径；未注入发送器时也自动退回 CLI。",
  " */",
  "let outboxSender = null;",
  "export function setOutboxSender(fn) {",
  "  outboxSender = typeof fn === \"function\" ? fn : null;",
  "  log({ op: \"outbox-sender\", mode: outboxSender ? \"set\" : \"cleared\" });",
  "}",
  "export function getOutboxEgressMode() {",
  "  return String(process.env.DSH_BRIDGE_EGRESS ?? \"inproc\").toLowerCase() === \"cli\" ? \"cli\" : \"inproc\";",
  "}",
  "",
  STORE_HOOK_ANCHOR,
].join("\n");

const STORE_SEND_ANCHOR = [
  "    const run = await runToFile(PATHS.node, [PATHS.openclawMjs, \"message\", \"send\", \"--channel\", PATHS.channel, \"--target\", entry.target || PATHS.target, \"-m\", payload], {",
  "      cwd: PATHS.workdir,",
  "      timeoutMs: 90000,",
  "    });",
  "    const ok = run.code === 0;",
].join("\n");
const STORE_SEND_ADD = [
  "    const sendTo = entry.target || PATHS.target;",
  "    const egressMode = getOutboxEgressMode();",
  "    let run;",
  "    if (egressMode === \"inproc\" && typeof outboxSender === \"function\") {",
  "      try {",
  "        const r = await outboxSender(sendTo, payload);",
  "        run = { code: r && r.ok ? 0 : 1, output: String((r && r.output) ?? \"\"), mode: \"inproc\" };",
  "      } catch (error) {",
  "        run = { code: 1, output: \"inproc-error: \" + String(error), mode: \"inproc\" };",
  "      }",
  "    } else {",
  "      run = await runToFile(PATHS.node, [PATHS.openclawMjs, \"message\", \"send\", \"--channel\", PATHS.channel, \"--target\", sendTo, \"-m\", payload], {",
  "        cwd: PATHS.workdir,",
  "        timeoutMs: 90000,",
  "      });",
  "      run.mode = \"cli\";",
  "    }",
  "    log({ op: \"outbox-egress\", id: entry.id, mode: run.mode });",
  "    const ok = run.code === 0;",
].join("\n");

function syntaxCheck(file) {
  const logFile = file + ".check-" + process.pid + ".log";
  let fd;
  try { fd = openSync(logFile, "w"); } catch (error) { return { ok: false, detail: "open-log: " + String(error) }; }
  let code = null;
  let spawnError = null;
  try { execFileSync(NODE_BIN, ["--check", file], { stdio: ["ignore", fd, fd] }); code = 0; }
  catch (error) { code = typeof error?.status === "number" ? error.status : null; if (code === null) spawnError = String(error?.message ?? error); }
  finally { try { closeSync(fd); } catch {} }
  let output = "";
  try { output = readFileSync(logFile, "utf8"); } catch {}
  try { unlinkSync(logFile); } catch {}
  if (code === 0) return { ok: true };
  return { ok: false, detail: (spawnError ? spawnError + " | " : "") + output.slice(-600) };
}

function patch(file, edits, label) {
  if (!existsSync(file)) return { label, status: "missing", file };
  const original = readFileSync(file, "utf8");
  if (original.includes(MARKER)) return { label, status: "already-patched", file };
  for (const e of edits) {
    if (!original.includes(e.anchor)) return { label, status: "anchor-miss", file, detail: "未匹配：" + e.anchor.split("\n")[0].slice(0, 90) };
  }
  let text = original;
  for (const e of edits) text = text.replace(e.anchor, e.replacement);
  if (check) return { label, status: "patchable", file };
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "").slice(0, 14);
  const backup = file + ".bak-" + stamp;
  let tmp = file + ".tmp-" + process.pid;
  try {
    copyFileSync(file, backup);
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
    const c = syntaxCheck(file);
    if (!c.ok) { copyFileSync(backup, file); try { unlinkSync(tmp); } catch {} return { label, status: "syntax-failed-rolled-back", file, backup, detail: c.detail }; }
    return { label, status: "patched", file, backup };
  } catch (error) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    if (existsSync(backup)) { try { copyFileSync(backup, file); } catch {} }
    return { label, status: existsSync(backup) ? "write-failed-rolled-back" : "write-denied", file, detail: String(error).slice(0, 300) };
  }
}

const results = [
  patch(BRIDGE, [
    { anchor: BRIDGE_CONST_ANCHOR, replacement: BRIDGE_CONST_ANCHOR + "\n" + BRIDGE_CONST_ADD },
    { anchor: BRIDGE_SEND_ANCHOR, replacement: BRIDGE_SEND_ADD },
    { anchor: BRIDGE_BOOT_ANCHOR, replacement: BRIDGE_BOOT_ADD },
  ], "dsh-bridge/index.js"),
  patch(STORE, [
    { anchor: STORE_HOOK_ANCHOR, replacement: STORE_HOOK_ADD },
    { anchor: STORE_SEND_ANCHOR, replacement: STORE_SEND_ADD },
  ], "lib/hitl-store.js"),
];

for (const r of results) {
  const detail = r.detail ? " | " + r.detail : "";
  const backup = r.backup ? " | 备份 " + path.basename(r.backup) : "";
  console.log("[" + r.label + "] " + r.status + detail + backup);
}
const bad = results.filter((r) => !["patched", "already-patched", "patchable"].includes(r.status));
if (bad.length > 0) { console.log("失败：" + bad.length + " 个目标未写入或已回滚。"); process.exit(2); }
if (check) { console.log("可以打补丁（未写入）。"); process.exit(0); }
console.log(results.every((r) => r.status === "already-patched") ? "已是最新，无需修补。" : "补丁完成。重启网关生效。");
process.exit(0);
