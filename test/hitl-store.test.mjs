import { test } from "node:test";
import assert from "node:assert/strict";
import { matchReply, pickOption, normalizeReply, createRequest, markAnswered, listPending, buildContinuationPrompt, formatAsk, toWechatText, formatTurnEnd, outboxTag, outboxEntryDisposition, CONTEXT_HOLD_MS, parsePushCommand, getResultPush, setResultPush, isResultPushEnabled, describeResultPush, setControl, getSessionNotificationLimits, setSessionNotificationLimits, clearSessionNotificationLimits, applyOneLineRecap, limitNotificationText, stripWechatNoise, trimForFeishu, cutAtBoundary, wrapCjk, turnEndHint, extractSessionTitle, readSessionTitle, sessionDisplayName }  from "../lib/hitl-store.js";

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
test("回合结束版式符合微信渲染：recap 首行、单换行、无行首缩进、宽度受控", () => {
  // 依据 2026-10-27「换行不友好」与 2026-11-08「one-line-recap + caveman + 多级列表」两次反馈：
  // 微信会把连续空行压掉、行首空格 trim 不一致、气泡仅 ~17 汉字宽。
  const out = formatTurnEnd({
    sessionId: "session-24a3d4b5-eac8-4bcf-b153-a22f51be8321",
    durationMs: 40000,
    summary: "按五个一级任务归类并给建议",
    text: "## 一、srs处理\n| 二级 | 状态 |\n|---|---|\n| 外部需求 | 部分解决 |\n\n结论：已闭环。",
  });
  const lines = out.split("\n");
  assert.match(lines[0], /^(?:待定|阻塞|答|无变更)[：:。]/, "首行必须是 recap（结论一眼可见）");
  assert.match(lines[0], /^答：已闭环。$/, "recap 取结论句而不是会话号");
  assert.equal(lines[1], "────────────", "recap 后接分隔线");
  assert.match(lines[2], /^【回合结束】40 秒$/, "标题与秒数紧随其后");
  assert.ok(!/^\u3000/m.test(out), "微信侧不得使用全角空格做行首缩进");
  assert.equal((out.match(/\n\n/g) ?? []).length, 1, "全篇只允许 1 处空行（微信会压掉连续空行）");
  assert.match(out, /^・任务：/m, "任务要点保留");
  // 会话码由 handle 分配，隔离状态里通常是 1；断言「抬头与尾部提示的码一致」而不是写死数字
  const tagged = outboxTag({ text: out, sessionId: "session-24a3d4b5-eac8-4bcf-b153-a22f51be8321" });
  const codeMatch = tagged.match(/^【会话码 (\d+) · [0-9a-f]{8}】/);
  assert.ok(codeMatch, "outbox 抬头必须带会话码");
  assert.match(out, new RegExp("回 " + codeMatch[1] + " 内容 可继续"), "尾部提示的码要与抬头一致");
  const width = (line) => [...line].reduce((n, ch) => (n + (/[\u2E80-\uFFE6]/.test(ch) ? 2 : 1)), 0);
  const widest = Math.max(...lines.map(width));
  // 允许 +2 的避头尾溢出：行首标点会被并回上一行（2026-11-06），最多多占一个全角字符。
  assert.ok(widest <= 36, "单行显示宽度应 ≤36（含避头尾溢出），实际 " + widest);
});

test("飞书回合结束是多级列表：任务 / 结果 两层，决策项排最前（2026-11-08）", () => {
  const previous = process.env.DSH_HITL_CHANNEL;
  process.env.DSH_HITL_CHANNEL = "feishu";
  try {
    const out = formatTurnEnd({
      sessionId: "session-24a3d4b5-eac8-4bcf-b153-a22f51be8321",
      durationMs: 94000,
      summary: "把发布清单整理成一份可核对的表格，标出风险项和待确认项。",
      text: [
        "## 发布清单整理",
        "",
        "已完成：整理 12 个待发布项并按风险分级。",
        "",
        "### 待确认",
        "- 灰度顺序是否按部门分批",
        "- 回滚窗口是否保留 30 分钟",
        "",
        "### 风险",
        "- 配置目录不一致会导致清单漏项",
        "",
        "### 下一步",
        "- 生成对照表并抽检 5 项",
      ].join("\n"),
    });
    assert.match(out, /^一、任务$/m, "第一层：任务");
    assert.match(out, /^　・把发布清单整理成一份可核对的表格，标出风险项和待确认项$/m, "任务要点保留用户目标");
    assert.match(out, /^二、结果$/m, "第一层：结果");
    assert.match(out, /^　・待定：/m, "二级条目用全角缩进 + ・");
    assert.match(out, /^　・已做：/m);
    assert.match(out, /^　・阻塞：配置目录不一致会导致清单漏项$/m, "风险小标题下归阻塞");
    assert.ok(out.indexOf("　・待定：") < out.indexOf("　・已做："), "决策项必须排在已做之前");
    assert.ok(out.indexOf("　・已做：") < out.indexOf("　・进度："), "已做排在进度之前");
    assert.ok(!/^会话 [0-9a-f]{8}$/m.test(out), "不再重复会话短号（抬头已由 outboxTag 提供）");
    assert.ok(!/^结果：$/m.test(out), "旧的平铺「结果：」标题被两级结构取代");
  } finally {
    if (previous === undefined) delete process.env.DSH_HITL_CHANNEL; else process.env.DSH_HITL_CHANNEL = previous;
  }
});

test("Markdown 小标题决定归类：已确认 → 已做，风险 → 阻塞（2026-11-08）", () => {
  const previous = process.env.DSH_HITL_CHANNEL;
  process.env.DSH_HITL_CHANNEL = "feishu";
  try {
    const out = formatTurnEnd({
      sessionId: "session-24a3d4b5-eac8-4bcf-b153-a22f51be8321",
      durationMs: 1000,
      summary: "检查配置",
      text: "### 已确认\n- 输入输出字段已定。\n\n### 风险\n- 配置目录不一致会漏记。",
    });
    assert.match(out, /^　・已做：输入输出字段已定。$/m, "已确认小标题下归已做");
    assert.match(out, /^　・阻塞：配置目录不一致会漏记。$/m, "风险小标题下归阻塞");
    assert.ok(out.indexOf("　・阻塞：") < out.indexOf("　・已做："), "阻塞排在已做前");
  } finally {
    if (previous === undefined) delete process.env.DSH_HITL_CHANNEL; else process.env.DSH_HITL_CHANNEL = previous;
  }
});

test("applyOneLineRecap 对已带 recap 的回合摘要幂等，不再重复一条", () => {
  const sessionId = "session-24a3d4b5-eac8-4bcf-b153-a22f51be8321";
  const body = formatTurnEnd({ sessionId, durationMs: 1000, summary: "看配置", text: "结论：配置项已补齐。" });
  const once = applyOneLineRecap(body, sessionId, "result");
  const twice = applyOneLineRecap(once, sessionId, "result");
  assert.equal(once, body, "已有 recap 的消息原样返回");
  assert.equal(twice, once, "重复调用不叠加");
  assert.equal((once.match(/^(?:待定|阻塞|答|无变更)[：:]/gm) ?? []).length, 1);
});

test("recap 不把会话号/标题当摘要，且 caveman 去填充词（2026-11-08）", () => {
  const text = "【回合结束】94 秒\n会话 1a2b3c4d\n────────────\n任务：补清单\n结果：\n・已完成：发布清单方案已给出。";
  const out = applyOneLineRecap(text, "session-1a2b3c4d-0000-0000-0000-000000000000", "result");
  const recap = out.split("\n")[0];
  assert.doesNotMatch(recap, /会话 [0-9a-f]{8}/, "recap 不得是会话号");
  assert.match(recap, /^答：发布清单方案已给出。$/, "去完成度宣告，只留动作与对象");
});

test("简单结果轮 recap 取动作句，不取「任务已完成」这类宣告", () => {
  const out = applyOneLineRecap("任务已完成。结果已写入文件。", "session-recap-test", "result");
  assert.match(out.split("\n")[0], /^答：结果已写入文件。$/, "recap 应为动作句");
});


test("飞书侧保留技术标识符（微信侧仍剔除）2026-11-06", () => {
  const body = "目录串台：`restart-feishu-daemon.ps1 -ConfigDir` 设的是 `LARKSUITE_CLI_CONFIG_DIR`，而 store 只认 `DSH_HITL_LARK_CONFIG_DIR`。";
  const kept = stripWechatNoise(toWechatText(body), { keepTechnical: true });
  assert.match(kept, /LARKSUITE_CLI_CONFIG_DIR/, "飞书侧 env 变量名是信息，不能删");
  assert.match(kept, /DSH_HITL_LARK_CONFIG_DIR/);
  assert.match(kept, /restart-feishu-daemon\.ps1/);
  const stripped = stripWechatNoise(toWechatText(body));
  assert.doesNotMatch(stripped, /LARKSUITE_CLI_CONFIG_DIR/, "微信侧维持原口径：技术标识符剔除");
});

test("trimForFeishu 保留分条结构，不按关键词丢掉整句", () => {
  const body = [
    "1. app1 被飞书侧拦：`cli_aa6697691db89c00` 连查身份都 21001。",
    "2. 目录串台：`restart-feishu-daemon.ps1 -ConfigDir` 设的是 `LARKSUITE_CLI_CONFIG_DIR`。",
    "3. 修法：优先级改成 DSH_HITL_LARK_CONFIG_DIR → LARKSUITE_CLI_CONFIG_DIR。",
  ].join("\n");
  const lines = trimForFeishu(body, { width: 54 });
  const joined = lines.join("\n");
  assert.match(joined, /1\. app1/, "编号分条要保留");
  assert.match(joined, /LARKSUITE_CLI_CONFIG_DIR/, "关键标识符要保留");
  assert.ok(lines.length <= 22, "行预算仍受控，实际 " + lines.length);
});

test("cutAtBoundary 不切在半句，且只补一个省略号", () => {
  const text = "第一句话说完了。第二句话也应该完整显示出来，不要被切断。第三句话超预算。";
  const cut = cutAtBoundary(text, 20);
  assert.ok(cut.endsWith("…"), "截断要显式标省略号");
  assert.equal((cut.match(/…/g) ?? []).length, 1, "只允许一个省略号");
  assert.ok(!/[，、；：]$/.test(cut.replace(/…$/, "")), "不要在逗号后直接截断");
});

test("wrapCjk 不切断英文 token（路径/变量名）", () => {
  // 宽度够：整段 token 不能被拆（回归 2026-11-06「restart-feishu-daemon.\nps1」）
  const wide = wrapCjk("现在执行 LARKSUITE_CLI_CONFIG_DIR 的值", 40);
  assert.ok(wide.some((line) => line.includes("LARKSUITE_CLI_CONFIG_DIR")), "宽度足够时不能拆词：" + JSON.stringify(wide));
  const dotted = wrapCjk("执行 restart-feishu-daemon.ps1 再继续", 24);
  for (const line of dotted) assert.ok(!/^\.ps1/.test(line), "不得把 .ps1 甩到下一行：" + JSON.stringify(dotted));
  // 标点避头：任何一行都不该以收尾标点开头
  const punct = wrapCjk("一、先说结论，再说过程；最后说下一步，以及回滚办法。", 12);
  for (const line of punct) assert.ok(!/^[，。、；：！？）」』】]/.test(line), "行首不得是收尾标点：" + JSON.stringify(punct));
});

test("尾巴提示不再说「细节在本会话」（歧义），飞书/微信各自措辞明确", () => {
  const wide = turnEndHint("session-73eff559-6848-4ed0-a58c-ec58a653cbdd", 100, { wide: true });
  assert.doesNotMatch(wide, /细节在本会话/, "旧措辞已废弃：本会话在飞书里有两种读法");
  assert.match(wide, /回「100 你的话」继续/, "要说清回什么");
  assert.match(wide, /DSH 会话 73eff559/, "要说清回给哪条 DSH 会话");
  assert.match(wide, /摘要/, "要说明这条只是摘要");
  const narrow = turnEndHint("session-73eff559-6848-4ed0-a58c-ec58a653cbdd", 100);
  assert.match(narrow, /^回 100 内容 可继续/);
  assert.doesNotMatch(narrow, /细节在本会话/);
  const noCode = turnEndHint("session-73eff559-6848-4ed0-a58c-ec58a653cbdd", null, { wide: true });
  assert.match(noCode, /本条是摘要/);
});

test("出口兜底：旧版宿主文案在 outboxTag 处被改写（不必重启 3080）", () => {
  const legacy = "【回合结束】66 秒\n码 100 · 会话 73eff559\n────────────\n任务：x\n结果：\n・y\n\n回复 100 <内容> 可继续，细节在本会话";
  const tagged = outboxTag({ text: legacy, sessionId: "session-73eff559-6848-4ed0-a58c-ec58a653cbdd" });
  assert.doesNotMatch(tagged, /细节在本会话/, "旧措辞必须被改写");
  assert.match(tagged, /摘要，全文在 DSH/, "要换成新措辞");
  assert.match(tagged, /回 100 内容 可继续/, "沿用旧文案里的码，不重算");
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

test("按会话分别限制结果、权限申请和决策询问长度", () => {
  const sessionId = "session-limit-test";
  clearSessionNotificationLimits(sessionId);
  setSessionNotificationLimits(sessionId, { result: 120, approval: 140, decision: 160 });
  assert.deepEqual(getSessionNotificationLimits(sessionId), { result: 120, approval: 140, decision: 160 });
  const long = "长内容".repeat(200);
  const approval = formatAsk({ ...mk({ sessionId, mode: "approval", kind: "approval", question: long }), sessionId, mode: "approval", kind: "approval" });
  const decision = formatAsk({ ...mk({ sessionId, mode: "inject", kind: "question", question: long }), sessionId, mode: "inject", kind: "question" });
  const result = formatTurnEnd({ sessionId, durationMs: 1000, summary: long, text: long });
  assert.ok(Array.from(approval).length <= 140);
  assert.ok(Array.from(decision).length <= 160);
  assert.ok(Array.from(result).length <= 120);
  clearSessionNotificationLimits(sessionId);
  assert.deepEqual(getSessionNotificationLimits(sessionId), { result: 0, approval: 0, decision: 0 });
});

test("所有出站通知先加入 one-line-recap", () => {
  const result = applyOneLineRecap("任务已完成。结果已写入文件。", "session-recap-test", "result");
  const approval = applyOneLineRecap("危险操作需要批准：删除临时文件。", "session-recap-test", "approval");
  assert.match(result, /^答：/);
  assert.match(approval, /^待定：/);
  assert.match(result, /────────────/);
  assert.match(approval, /危险操作需要批准/);
  assert.ok(Array.from(result.split("\n")[0]).length <= 30);
  assert.ok(Array.from(approval.split("\n")[0]).length <= 30);
});

test("超长通知优先压缩概要而不是直接截断总消息", () => {
  const sessionId = "session-summary-preserve-test";
  clearSessionNotificationLimits(sessionId);
  setSessionNotificationLimits(sessionId, { result: 300, approval: 300, decision: 300 });
  const longResult = "已完成：交易文件已生成。" + "详细字段说明。".repeat(120);
  const compact = limitNotificationText(longResult, sessionId, "result");
  assert.ok(Array.from(compact).length <= 300);
  assert.doesNotMatch(compact, /通知内容已按会话长度限制截断/);
  assert.match(compact, /已完成|交易文件/);
  clearSessionNotificationLimits(sessionId);
});
test("会话显示名优先取 DSH 真实标题", () => {
  const sample = JSON.stringify({
    version: 7,
    record: { rows: { title: { ver: 1, seq: 6024, val: "NCBS翻译与词根｜全量交易" }, titleInput: { ver: 3, seq: 1, val: { text: "x" } } } },
  });
  assert.equal(extractSessionTitle(sample), "NCBS翻译与词根｜全量交易");
  assert.equal(extractSessionTitle(JSON.stringify({ rows: { title: { val: null } } })), "");
  assert.equal(extractSessionTitle("no title here"), "");
  const real = readSessionTitle("session-7e16012b-9fc7-4302-9ad2-e1bad808c3c5");
  assert.equal(typeof real, "string");
  assert.doesNotMatch(sessionDisplayName("session-7e16012b-9fc7-4302-9ad2-e1bad808c3c5"), /^ncbs·/);
});
