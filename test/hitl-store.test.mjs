import { test } from "node:test";
import assert from "node:assert/strict";
import { matchReply, pickOption, normalizeReply, createRequest, markAnswered, listPending, buildContinuationPrompt, formatAsk, toWechatText, formatTurnEnd, outboxEntryDisposition, CONTEXT_HOLD_MS, parsePushCommand, getResultPush, setResultPush, isResultPushEnabled, describeResultPush, setControl }  from "../lib/hitl-store.js";

const mk = (over = {}) => ({
  id: "req-test-" + Math.random().toString(16).slice(2, 6),
  mode: "inject",
  kind: "manual",
  title: "t",
  question: "q",
  options: [{ key: "1", label: "允许" , aliases: [] }, { key: "2", label: "拒绝", aliases: [] }],
  status: "pending",
  createdAt: Date.now(),
  expiresAt: Date.now() + 60000,
  answer: null,
  ...over,
});

test("normalizeReply 全角转半角并去 #", () => {
  assert.equal(normalizeReply("  １． "), "1.");
  assert.equal(normalizeReply("#a1b2 1"), "#a1b2 1");
});

test("pickOption 数字键优先", () => {
  assert.deepEqual(pickOption(mk(), "1"), { key: "1", label: "允许" });
  assert.deepEqual(pickOption(mk(), "2."), { key: "2", label: "拒绝" });
});

test("pickOption 标签/别名模糊匹配", () => {
  assert.deepEqual(pickOption(mk(), "允许"), { key: "1", label: "允许" });
  assert.deepEqual(pickOption(mk(), "我允许这一次"), { key: "1", label: "允许" });
});

test("单一待确认请求：自由文本算答复（inject）", () => {
  const req = mk();
  const hit = matchReply("方案 B 更好，按 B 做", [req]);
  assert.equal(hit.ok, true);
  assert.equal(hit.request.id, req.id);
  assert.equal(hit.option.key, "");
});

test("审批类请求：自由文本不得当成放行", () => {
  const req = mk({ mode: "approval" });
  const hit = matchReply("今天天气不错", [req]);
  assert.equal(hit.ok, false);
  assert.equal(hit.reason, "ambiguous");
});

test("多个待确认请求：裸数字歧义必须报歧义而不是猜", () => {
  const a = mk({ id: "req-a" }), b = mk({ id: "req-b" });
  const hit = matchReply("1", [a, b]);
  assert.equal(hit.ok, false);
  assert.equal(hit.reason, "ambiguous");
  assert.equal(hit.candidates.length, 2);
});

test("显式指定请求号可消歧", () => {
  const a = mk({ id: "req-aaaa" }), b = mk({ id: "req-bbbb" });
  const hit = matchReply("#bbbb 2", [a, b]);
  assert.equal(hit.ok, true);
  assert.equal(hit.request.id, "req-bbbb");
  assert.equal(hit.option.key, "2");
});

test("formatAsk 含编号选项与有效期", () => {
  const text = formatAsk(mk({ id: "req-1234" }));
  assert.match(text, /1\) 允许/);
  assert.match(text, /有效期/);
  // 识别码改到首行行首、纯数字（不再是被方括号包住的 hex 短号）
  assert.match(text.split("\n")[0], /识别码 1234/, "首行应含识别码: " + text.split("\n")[0]);
  assert.equal(/^[*#>-]/m.test(text), false, "不应出现 Markdown 行首标记");
});

test("buildContinuationPrompt 自述请求号与选择", () => {
  const req = mk({ id: "req-xyz9", answer: { key: "1", label: "允许", raw: "1", via: "wechat", at: Date.now() } });
  const prompt = buildContinuationPrompt(req);
  assert.match(prompt, /req-xyz9/);
  assert.match(prompt, /1\) 允许/);
});
test("toWechatText 去掉微信不渲染的 Markdown 噪音", () => {
  const raw = "## 标题\n\n| 项 | 状态 |\n|---|---|\n| 网关 | **通过** |\n\n- 要点一\n> 引用\n\n---\n\n见 [文档](https://x.y/z)，行内 `code`。";
  const out = toWechatText(raw);
  assert.ok(!out.includes("##"), "标题标记必须去掉: " + out);
  assert.ok(!out.includes("**"), "粗体标记必须去掉: " + out);
  assert.ok(!/\|/.test(out), "表格竖线必须去掉: " + out);
  assert.ok(!out.includes(">"), "引用标记必须去掉: " + out);
  assert.ok(!out.includes("`"), "行内代码标记必须去掉: " + out);
  assert.ok(!/^---$/m.test(out), "分割线必须去掉");
  assert.match(out, /■ 标题/);
  assert.match(out, /网关/);
  assert.match(out, /文档/);
});

test("formatTurnEnd 先清洗再截行，不把 Markdown 抬头当摘要", () => {
  const text = "## 根任务与目标\n\n本会话未建根任务，直接执行。\n\n| # | 动作 |\n|---|---|\n| 1 | 重启网关 |\n\n**结论**：已闭环。";
  const out = formatTurnEnd({ sessionId: "session-4c0dcb1b-bfcf-4ddf-a5b7-9ea8fbedcc0e", durationMs: 15000, summary: "## 用户任务", text });
  assert.ok(!out.includes("##"), "回合结束文案不得含 # 标题: " + out);
  assert.ok(!out.includes("|"), "回合结束文案不得含表格竖线: " + out);
  assert.ok(!out.includes("**"), "回合结束文案不得含粗体: " + out);
  assert.match(out, /直接执行/, "必须保留正文，而不是只剩标题");
  assert.ok(!/结果　\n　\n/.test(out), "结果行后不应紧跟空行");
});
test("全角缩进行（formatTurnEnd 前缀「　」）下的标题/表格也必须清洗", () => {
  // 真实回归：2026-10-27 会话码 14/8 的回合结束推送仍带 ## 与 | 表格。
  // 根因是 formatTurnEnd 给每行加了 U+3000 前缀，而清洗规则只认行首 # 和 |。
  const raw = ["\u3000## 一、srs处理", "\u3000| 二级 | 覆盖 |", "\u3000|---|---|", "\u3000| 1 外部需求 | 部分解决 |", "\u3000---", "\u3000**结论**：已闭环。"].join("\n");
  const out = toWechatText(raw);
  assert.ok(!out.includes("##"), "全角缩进下的标题仍漏: " + out);
  assert.ok(!out.includes("|"), "全角缩进下的表格仍漏: " + out);
  assert.ok(!out.includes("**"), "全角缩进下的粗体仍漏: " + out);
  assert.ok(!/^\u3000---$/m.test(out), "全角缩进下的分割线仍漏");
  assert.match(out, /■ 一、srs处理/);
});
test("扁平化文本（换行被压成空格）里的标题与表格也要清洗", () => {
  // 真实回归：2026-10-27 会话码 5 的 out-…33db0f，正文被压成一行，
  // 只有首个 ## 命中行首规则，其余 ## 与 | 表格全部逃逸。
  const flat = "## 一、srs处理 | 二级 | 覆盖 | 状态 | |---|---|---| 下面归类。 ## 但现在有个更紧急的问题 出站断了。 **结论**：好。";
  const out = toWechatText(flat);
  assert.ok(!/#/.test(out), "行内标题仍漏: " + out);
  assert.ok(!/\|/.test(out), "行内表格竖线仍漏: " + out);
  assert.ok(!/\*\*/.test(out), "粗体仍漏: " + out);
  assert.match(out, /■ 但现在有个更紧急的问题/, "第二个标题必须也被转成 ■");
});
test("回合结束版式符合微信渲染：单换行、无行首缩进、宽度受控", () => {
  // 依据 2026-10-27 用户反馈「换行不友好」后的重写：
  // 微信会把连续空行压掉、行首空格 trim 不一致、气泡仅 ~17 汉字宽。
  const out = formatTurnEnd({
    sessionId: "session-24a3d4b5-eac8-4bcf-b153-a22f51be8321",
    durationMs: 40000,
    summary: "按五个一级任务归类并给建议",
    text: "## 一、srs处理\n| 二级 | 状态 |\n|---|---|\n| 外部需求 | 部分解决 |",
  });
  const lines = out.split("\n");
  assert.match(lines[0], /^【回合结束】40 秒$/, "首行只放标题与秒数");
  assert.match(lines[1], /^码 \d+ · 会话 [0-9a-f]{8}$/, "第二行放码与会话短号");
  assert.equal(lines[2], "────────────", "分隔线固定 12 个 ─");
  assert.ok(!/^\u3000/m.test(out), "不得使用全角空格做行首缩进");
  assert.equal((out.match(/\n\n/g) ?? []).length, 1, "全篇只允许 1 处空行（微信会压掉连续空行）");
  assert.match(out, /结果：/);
  // 会话码由 handle 分配，隔离状态里通常是 1；断言「两处码一致」而不是写死数字
  const codeMatch = lines[1].match(/^码 (\d+) · /);
  assert.ok(codeMatch, "第二行必须带会话码");
  assert.match(out, new RegExp("回复 " + codeMatch[1] + " <内容> 可继续"));
  const width = (line) => [...line].reduce((n, ch) => (n + (/[\u2E80-\uFFE6]/.test(ch) ? 2 : 1)), 0);
  const widest = Math.max(...lines.map(width));
  assert.ok(widest <= 34, "单行显示宽度应 ≤34（约 17 汉字），实际 " + widest);
});

test("ISSUE-001：等 token 的条目豁免 30 分钟 TTL，超 24h 才丢弃", () => {
  const now = Date.now();
  const plain = { id: "p", createdAt: now - 31 * 60 * 1000 };
  assert.equal(outboxEntryDisposition(plain, now), "drop-ttl", "普通积压 31 分钟按 TTL 丢弃");
  const held = { id: "h", createdAt: now - 31 * 60 * 1000, needsContext: true, contextMissingAt: now - 31 * 60 * 1000 };
  assert.equal(outboxEntryDisposition(held, now), "hold-context", "等 token 的条目不得被 30 分钟 TTL 删掉");
  const expired = { id: "e", createdAt: now - CONTEXT_HOLD_MS - 1000, needsContext: true, contextMissingAt: now - CONTEXT_HOLD_MS - 1000 };
  assert.equal(outboxEntryDisposition(expired, now), "drop-context-expired", "超过 24h 保留窗口才丢");
  assert.equal(outboxEntryDisposition({ id: "n", createdAt: now - 60000 }, now), "send");
});

test("REQ-002：微信侧推送指令只认整条短指令", () => {
  assert.deepEqual(parsePushCommand("推送 关"), { action: "off" });
  assert.deepEqual(parsePushCommand("推送开"), { action: "on" });
  assert.deepEqual(parsePushCommand("结果推送 on"), { action: "on" });
  assert.deepEqual(parsePushCommand("推送"), { action: "status" });
  assert.equal(parsePushCommand("1 帮我跑测试"), null, "会话驱动不得被误判");
  assert.equal(parsePushCommand("推送 关 谢谢"), null, "整条匹配才生效");
});

test("REQ-001：结果推送与总开关取交集", () => {
  setControl("running", { by: "test" });
  setResultPush(true, { by: "test" });
  assert.equal(isResultPushEnabled(), true);
  setResultPush(false, { by: "test" });
  assert.equal(getResultPush(), false);
  assert.equal(isResultPushEnabled(), false, "关闭后不推结果");
  assert.match(describeResultPush(), /结果推送：关/);
  setResultPush(true, { by: "test" });
  setControl("paused", { by: "test" });
  assert.equal(isResultPushEnabled(), false, "paused 一票否决，即使结果推送开着");
  setControl("running", { by: "test" });
  assert.equal(isResultPushEnabled(), true);
});
