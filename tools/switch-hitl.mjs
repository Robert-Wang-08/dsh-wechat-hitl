#!/usr/bin/env node
/**
 * switch-hitl.mjs — 微信自动推送的三态开关（软开关 + 硬开关）。
 *
 * 用法：
 *   node switch-hitl.mjs --state running            # 开启：写 control.json + 把插件挂回 web/headless patch
 *   node switch-hitl.mjs --state paused             # 暂停发送：只写 control.json（插件仍加载，但不再发、审批立即委派）
 *   node switch-hitl.mjs --state stopped            # 关闭服务：写 control.json + 从 web/headless patch 摘掉插件（硬关）
 *   node switch-hitl.mjs --state paused --soft      # 不碰 patch，只改开关文件
 *   node switch-hitl.mjs --show                     # 只打印当前状态
 *
 * 目标 patch 路径：DSH_HOME 优先，缺省 ~/.dsh；目标 profile 用 --profiles 覆盖
 *   node switch-hitl.mjs --state running --profiles web,headless,packed
 * （换设备只改环境，不改代码）
 *
 * 为什么两套：
 *   - 软开关（control.json）立即生效、无需重启，但只对**已加载新代码**的进程有效
 *     （Cordis 的 patchReload=live 只重放 patch，不重载模块缓存）。
 *   - 硬开关（改 profile patch 的 insert 块）会让宿主**卸载/重新挂载**插件，
 *     对「宿主要是跑着旧模块代码」这种情况是唯一可靠的停法，同时顺带刷新模块缓存。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setControl, getControl, describeControl, CONTROL_STATES } from "../lib/hitl-store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * 目标 patch 路径不写死本机用户名：DSH_HOME 优先（与宿主同口径），否则 ~/.dsh。
 * 目标 profile 可用 --profiles web,headless 覆盖，默认沿用本机实际挂载的两份。
 */
function resolvePatches(profileArg) {
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : join(homedir(), ".dsh");
  const names = (profileArg && String(profileArg).trim() ? String(profileArg).split(",") : ["web", "headless"])
    .map((s) => s.trim())
    .filter(Boolean);
  return names.map((name) => join(dshHome, "profiles", name, "cordis.patch.yml"));
}
const BEGIN = "# >>> dsh-wechat-hitl BEGIN（由 tools/switch-hitl.mjs 管理，勿手改）";
const END = "# <<< dsh-wechat-hitl END";

const BLOCK = [
  BEGIN,
  "- insert:",
  "    - id: wechat-hitl",
  "      name: dsh-wechat-hitl",
  "      config:",
  "        enabled: true",
  "        notifyOnTurnEnd: true",
  "        minTurnMs: 3000",
  "        pollMs: 1500",
  "        approval:",
  "          enabled: true",
  "          timeoutMs: 300000",
  "          options: [\"允许一次\", \"拒绝\"]",
  "        excludeSessionIdPrefixes: [\"wx-\"]",
  END,
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

/** 去掉已有的 wechat-hitl 块（带标记的 / 早期不带标记的追加块都认）。 */
function stripBlock(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === BEGIN || line.trim() === END) continue;
    if (line.trim() === "- insert:") {
      let end = i;
      let found = false;
      for (let j = i + 1; j < lines.length; j += 1) {
        const raw = lines[j];
        const trimmed = raw.trim();
        if (trimmed === "") { end = j; continue; }
        if (/^\s/.test(raw) || trimmed.startsWith("#")) {
          end = j;
          if (trimmed.includes("id: wechat-hitl")) found = true;
          continue;
        }
        break;
      }
      if (found) { i = end; continue; }
    }
    out.push(line);
  }
  return out;
}

function rewritePatch(path, mount) {
  if (!existsSync(path)) return { path, action: "missing" };
  const original = readFileSync(path, "utf8");
  const lines = stripBlock(original.split(/\r?\n/));
  let next = lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "\n");
  if (mount) next += "\n" + BLOCK.join("\n") + "\n";
  if (next === original) return { path, action: "unchanged" };
  copyFileSync(path, path + ".bak-before-switch-" + Date.now());
  writeFileSync(path, next, "utf8");
  return { path, action: mount ? "mounted" : "unmounted" };
}

const args = parseArgs(process.argv.slice(2));
const PATCHES = resolvePatches(args.profiles);

if (args.show || !args.state) {
  const control = getControl();
  const mounted = PATCHES.map((p) => ({ path: p, present: existsSync(p) && readFileSync(p, "utf8").includes("id: wechat-hitl") }));
  process.stdout.write(JSON.stringify({ switch: describeControl(control), state: control.state, patchMounted: mounted }, null, 2) + "\n");
  process.exit(0);
}

const wanted = String(args.state).trim().toLowerCase();
if (!CONTROL_STATES.includes(wanted)) {
  process.stdout.write("state 必须是 running|paused|stopped\n");
  process.exit(2);
}

const record = setControl(wanted, { by: args.by ? String(args.by) : "switch-hitl.mjs", reason: args.reason ? String(args.reason) : "" });

// 软开关总是写；硬开关：running -> 挂载，stopped -> 摘除，paused -> 保持现状（--soft/--hard 可覆盖）
const soft = args.soft === true;
const mount = wanted === "running" ? true : (wanted === "stopped" ? false : null);
const patchResults = [];
if (!soft && mount !== null) {
  for (const path of PATCHES) patchResults.push(rewritePatch(path, mount));
}

process.stdout.write(JSON.stringify({
  ok: true,
  state: record.state,
  describe: describeControl(record),
  hard: soft ? "skipped(--soft)" : (mount === null ? "n/a(paused 保持挂载)" : (mount ? "mounted" : "unmounted")),
  patches: patchResults,
  note: wanted === "running" ? "硬开关会重新挂载插件；宿主重新 import 模块后才会用上最新代码" : "",
}, null, 2) + "\n");
