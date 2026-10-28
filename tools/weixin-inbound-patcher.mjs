#!/usr/bin/env node
/**
 * weixin-inbound-patcher.mjs — openclaw-weixin 入站游标补丁核心（幂等）。
 *
 * 修什么（2026-10-28 13:25 实测）：
 *   monitor 先 saveGetUpdatesBuf 再 processOneMessage。处理抛异常
 *   （SqliteSessionMutationConflictError: while preparing session-entry.patch）被外层 catch
 *   当成「轮询失败」，按已推进的游标重拉；服务端认为消息已投递 → 该消息永久丢失。
 *
 * 补丁后行为：
 *   1) 游标只在本批消息处理完成（成功，或已重试并记录丢弃）之后才推进；
 *   2) 单条消息最多尝试 INBOUND_MAX_ATTEMPTS 次（1 次原始 + 2 次重试），仍失败则跳过，
 *      并写 inbound-dropped 日志（含 sessionId / seq / msgId / 错误类型）；
 *   3) 不静默丢弃：任何被跳过的入站消息都在日志里有一行 inbound-dropped。
 *
 * 幂等：文件里已含 marker cursor-advanced-after-processing 即跳过。
 * 守卫：锚点结构与预期不符（官方包升级改了循环体）时不写入，退出码 2。
 * 回滚：写入后 node --check 失败 → 从备份恢复。
 *
 * 用法：
 *   node weixin-inbound-patcher.mjs --check
 *   node weixin-inbound-patcher.mjs
 *   node weixin-inbound-patcher.mjs --extension-dir C:\path\to\openclaw-weixin
 */
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const MARKER = "cursor-advanced-after-processing";
const NODE_BIN = process.env.OPENCLAW_NODE ?? "C:\\openclaw-runtime\\node.exe";
const CONST_ANCHOR = "const RETRY_DELAY_MS = 2_000;";

function parseArgs(argv) {
  const out = { check: false, extensionDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--extension-dir") out.extensionDir = argv[++i];
  }
  return out;
}

/** 生成补丁后的循环块 + 游标后置块。isTs 只影响一处类型注解。 */
function buildBlock(ind, bodyLines, saveBlockLines, isTs) {
  const pad = "  ";
  const inner = ind + pad;
  const deep = inner + pad;
  const typedErr = isTs ? "let __wxInboundError: unknown = null;" : "let __wxInboundError = null;";
  // TS 的 catch 变量是 unknown，取 stack 需断言；JS 版本用普通判空。两者都要过 node --check。
  const stackExpr = isTs
    ? "String((err as { stack?: string })?.stack ?? err)"
    : "String(err && err.stack ? err.stack : err)";
  const lines = [];
  lines.push(ind + "const list = resp.msgs ?? [];");
  lines.push(ind + "for (const full of list) {");
  lines.push(inner + "let __wxInboundDone = false;");
  lines.push(inner + typedErr);
  lines.push(inner + "for (let __wxAttempt = 1; __wxAttempt <= INBOUND_MAX_ATTEMPTS; __wxAttempt += 1) {");
  lines.push(deep + "try {");
  for (const line of bodyLines) lines.push(line);
  lines.push(deep + pad + "__wxInboundDone = true;");
  lines.push(deep + pad + "break;");
  lines.push(deep + "} catch (err) {");
  lines.push(deep + "__wxInboundError = err;");
  lines.push(deep + "if (abortSignal?.aborted) throw err;");
  lines.push(deep + "const __wxClassified = classifyFetchError(err);");
  lines.push(
    deep +
      'errLog("weixin inbound processing failed (" + __wxAttempt + "/" + INBOUND_MAX_ATTEMPTS + "): sessionId=" + (full.session_id ?? "none") + " seq=" + (full.seq ?? "none") + " msgId=" + (full.message_id ?? "none") + " type=" + __wxClassified.type + " err=" + String(err));',
  );
  lines.push(
    deep +
      'aLog.error("inbound processing failed attempt=" + __wxAttempt + "/" + INBOUND_MAX_ATTEMPTS + " sessionId=" + (full.session_id ?? "none") + " seq=" + (full.seq ?? "none") + " msgId=" + (full.message_id ?? "none") + " type=" + __wxClassified.type + " detail=" + ' + stackExpr + ");",
  );
  lines.push(deep + "if (__wxAttempt < INBOUND_MAX_ATTEMPTS) await sleep(INBOUND_RETRY_DELAY_MS, abortSignal);");
  lines.push(deep + "}");
  lines.push(inner + "}");
  lines.push(inner + "if (!__wxInboundDone) {");
  lines.push(deep + 'let __wxFinalType = "unknown";');
  lines.push(deep + "try { __wxFinalType = classifyFetchError(__wxInboundError).type; } catch {}");
  lines.push(
    deep +
      'errLog("inbound-dropped: sessionId=" + (full.session_id ?? "none") + " seq=" + (full.seq ?? "none") + " msgId=" + (full.message_id ?? "none") + " from=" + (full.from_user_id ?? "none") + " type=" + __wxFinalType + " attempts=" + INBOUND_MAX_ATTEMPTS + " err=" + String(__wxInboundError));',
  );
  lines.push(
    deep +
      'aLog.error("inbound-dropped sessionId=" + (full.session_id ?? "none") + " seq=" + (full.seq ?? "none") + " msgId=" + (full.message_id ?? "none") + " from=" + (full.from_user_id ?? "none") + " type=" + __wxFinalType + " attempts=" + INBOUND_MAX_ATTEMPTS);',
  );
  lines.push(inner + "}");
  lines.push(ind + "}");
  lines.push(ind + "// " + MARKER + ": 本批消息处理完成（成功，或已重试并记录丢弃）后才推进游标。");
  lines.push(ind + "// 旧实现先存游标再处理，处理抛异常被外层 catch 当成轮询失败，按已推进的游标重拉，");
  lines.push(ind + "// 服务端认为已投递 → 该条消息永久丢失（2026-10-28 13:25 实测丢了一条审批回复）。");
  for (const line of saveBlockLines) lines.push(line);
  return lines;
}

/** body 里有多行模板字符串时不做再缩进，避免改变字符串内容。 */
function canReindent(bodyLines) {
  let open = false;
  for (const line of bodyLines) {
    let count = 0;
    let escaped = false;
    for (const ch of line) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === String.fromCharCode(96)) count += 1;
    }
    if (count % 2 === 1) open = !open;
  }
  return !open;
}

/** 从 startLine 起做括号配平，返回该块的闭合行下标。 */
function findBlockEnd(lines, startLine) {
  let depth = 0;
  let started = false;
  for (let i = startLine; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === "{") { depth += 1; started = true; }
      else if (ch === "}") { depth -= 1; }
    }
    if (started && depth === 0) return i;
    if (depth < 0) return -1;
  }
  return -1;
}

function analyze(text, isTs) {
  if (text.includes(MARKER)) return { status: "already-patched" };
  const lines = text.split(/\r?\n/);
  const findIdx = (re, from, to) => {
    for (let i = from; i < (to ?? lines.length); i += 1) if (re.test(lines[i])) return i;
    return -1;
  };

  const iSave = findIdx(/^\s*if \(resp\.get_updates_buf != null && resp\.get_updates_buf !== ""\) \{$/, 0);
  if (iSave < 0) return { status: "anchor-miss", detail: "未找到处理前的游标保存判断块" };
  const saveOk =
    /^\s*saveGetUpdatesBuf\(syncFilePath, resp\.get_updates_buf\);$/.test(lines[iSave + 1] ?? "") &&
    /^\s*getUpdatesBuf = resp\.get_updates_buf;$/.test(lines[iSave + 2] ?? "") &&
    (lines[iSave + 3] ?? "").includes("Saved new get_updates_buf") &&
    /^\s*\}$/.test(lines[iSave + 4] ?? "");
  if (!saveOk) return { status: "anchor-miss", detail: "处理前的游标保存块结构不符（第 " + (iSave + 1) + " 行起）" };

  const iList = findIdx(/^\s*const list = resp\.msgs \?\? \[\];$/, iSave + 5, iSave + 8);
  if (iList < 0) return { status: "anchor-miss", detail: "游标保存块后未紧跟 const list = resp.msgs ?? []" };

  // catch 锚点有两种排版：TS 源文件是 "} catch (err) {"，tsc 产出的 dist 是 "}" 换行再 "catch (err) {"。
  // 所以不依赖 catch 行定位，改用大括号配平找 for 循环的真实结束行。
  const forRe = /^(\s*)for \(const full of list\) \{$/;
  let iFor = -1;
  let forInd = "";
  for (let i = iList + 1; i < lines.length; i += 1) {
    const m = forRe.exec(lines[i]);
    if (m) { iFor = i; forInd = m[1]; break; }
  }
  if (iFor < 0) return { status: "anchor-miss", detail: "未找到 for (const full of list) 循环" };

  const iClose = findBlockEnd(lines, iFor);
  if (iClose < 0) return { status: "anchor-miss", detail: "for 循环大括号未配平" };
  if (lines[iClose] !== forInd + "}") {
    return { status: "anchor-miss", detail: "循环闭合行缩进不符（第 " + (iClose + 1) + " 行）" };
  }
  const afterClose = lines.slice(iClose + 1, iClose + 4).map((l) => l.trim());
  if (!afterClose.some((l) => l.startsWith("} catch (err)") || l.startsWith("catch (err)"))) {
    return { status: "anchor-miss", detail: "循环闭合后 3 行内没有 catch (err) 锚点" };
  }
  const iConst = findIdx(/^const RETRY_DELAY_MS = 2_000;$/, 0, iSave);
  if (iConst < 0) return { status: "anchor-miss", detail: "未找到重试常量锚点 " + CONST_ANCHOR };

  const rawBody = lines.slice(iFor + 1, iClose);
  if (!rawBody.some((l) => l.includes("processOneMessage("))) {
    return { status: "anchor-miss", detail: "循环体内没有 processOneMessage 调用，可能版本已变" };
  }
  const reindent = canReindent(rawBody);
  const bodyLines = rawBody.map((l) => (reindent && l.trim() ? "    " + l : l));
  const saveBlockLines = lines.slice(iSave, iSave + 5);

  // 组装：前面保留（常量处插入新常量）→ 重建循环块 → 循环之后的 try 收尾 / catch 整段原样保留
  const head = lines.slice(0, iSave);
  const withConst = [];
  for (let i = 0; i < head.length; i += 1) {
    withConst.push(head[i]);
    if (i === iConst) {
      withConst.push("const INBOUND_MAX_ATTEMPTS = 3;   // 1 次原始尝试 + 2 次重试（失败后跳过并记 inbound-dropped）");
      withConst.push("const INBOUND_RETRY_DELAY_MS = 2_000;");
    }
  }
  const block = buildBlock(forInd, bodyLines, saveBlockLines, isTs);
  const result = withConst.concat(block, lines.slice(iClose + 1));
  return { status: "patchable", text: result.join("\n"), reindent };
}

/**
 * 语法体检：node --check。
 * 不用 stdio:"pipe"：DSH 沙箱禁止程序打开命名管道，pipe 会直接 EPERM（本机实测）。
 * 改用文件描述符接子进程输出，沙箱内外都成立。
 */
function syntaxCheck(file) {
  const logFile = file + ".check-" + process.pid + ".log";
  let fd;
  try {
    fd = openSync(logFile, "w");
  } catch (error) {
    return { ok: false, detail: "open-check-log-failed: " + String(error) };
  }
  let code = null;
  let spawnError = null;
  try {
    execFileSync(NODE_BIN, ["--check", file], { stdio: ["ignore", fd, fd] });
    code = 0;
  } catch (error) {
    code = typeof error?.status === "number" ? error.status : null;
    if (code === null) spawnError = String(error && error.message ? error.message : error);
  } finally {
    try { closeSync(fd); } catch {}
  }
  let output = "";
  try { output = readFileSync(logFile, "utf8"); } catch {}
  try { unlinkSync(logFile); } catch {}
  if (code === 0) return { ok: true };
  return { ok: false, detail: (spawnError ? spawnError + " | " : "") + output.slice(-800) };
}

function patchTarget(target, opts, stamp) {
  const file = target.file;
  if (!existsSync(file)) return { file, status: "missing" };
  const text = readFileSync(file, "utf8");
  const res = analyze(text, target.isTs);
  if (res.status === "already-patched") return { file, status: "already-patched" };
  if (res.status !== "patchable") return { file, status: res.status, detail: res.detail };
  if (opts.check) return { file, status: "patchable", detail: res.reindent ? "可缩进" : "保留原缩进" };

  const backup = file + ".bak-" + stamp;
  copyFileSync(file, backup);
  const tmp = file + ".tmp-" + process.pid;
  try {
    writeFileSync(tmp, res.text, "utf8");
    renameSync(tmp, file);
    const check = syntaxCheck(file);
    if (!check.ok) {
      copyFileSync(backup, file);
      try { unlinkSync(tmp); } catch {}
      return { file, status: "syntax-failed-rolled-back", backup, detail: check.detail };
    }
    return { file, status: "patched", backup };
  } catch (error) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    copyFileSync(backup, file);
    return { file, status: "write-failed-rolled-back", backup, detail: String(error).slice(0, 400) };
  }
}

const args = parseArgs(process.argv.slice(2));
const extDir = args.extensionDir ?? path.join(process.env.USERPROFILE ?? "C:\\Users\\wwm_1", ".openclaw", "extensions", "openclaw-weixin");
const targets = [
  { file: path.join(extDir, "src", "monitor", "monitor.ts"), isTs: true, role: "source-ts" },
  { file: path.join(extDir, "dist", "src", "monitor", "monitor.js"), isTs: false, role: "runtime-dist" },
];
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "").slice(0, 14);
const results = targets.map((t) => ({ role: t.role, ...patchTarget(t, args, stamp) }));

for (const r of results) {
  const detail = r.detail ? " | " + r.detail : "";
  const backup = r.backup ? " | 备份 " + path.basename(r.backup) : "";
  console.log("[" + r.role + "] " + path.basename(r.file) + ": " + r.status + detail + backup);
}

const bad = results.filter((r) => ["anchor-miss", "syntax-failed-rolled-back", "write-failed-rolled-back"].includes(r.status));
const patched = results.filter((r) => r.status === "patched");
const pending = results.filter((r) => r.status === "patchable");
const present = results.filter((r) => r.status !== "missing");

if (bad.length > 0) {
  console.log("失败：" + bad.length + " 个目标无法安全修补（未写入或已回滚），需人工核对锚点。");
  process.exit(2);
}
if (present.length === 0) {
  console.log("失败：目标文件都不存在，检查 --extension-dir。");
  process.exit(1);
}
if (args.check) {
  console.log(pending.length > 0
    ? "可以打补丁（未写入）：" + pending.length + " 个目标待修补。"
    : "已是最新：present=" + present.length + "，无需修补。");
  process.exit(0);
}
console.log(patched.length > 0
  ? "已打补丁：" + patched.length + " 个目标。"
  : "已是最新：present=" + present.length + "，无需修补。");
process.exit(0);
