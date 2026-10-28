import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const yamlMod = await import(pathToFileURL("C:/Users/wwm_1/.dsh/profiles/web/node_modules/js-yaml/index.js").href);
const yaml = yamlMod.default ?? yamlMod;
for (const [label, p] of [["web", "C:/Users/wwm_1/.dsh/profiles/web/cordis.patch.yml"], ["headless", "C:/Users/wwm_1/.dsh/profiles/headless/cordis.patch.yml"]]) {
  const text = readFileSync(p, "utf8");
  const lines = text.split(/\r?\n/);
  const b = lines.findIndex((l) => l.includes(">>> dsh-wechat-hitl BEGIN"));
  const e = lines.findIndex((l) => l.includes("<<< dsh-wechat-hitl END"));
  let blockState = "absent(未挂载)";
  if (b >= 0 && e > b) {
    try {
      const parsed = yaml.load(lines.slice(b + 1, e).join("\n"));
      blockState = "mounted/OK " + JSON.stringify(parsed).slice(0, 120);
    } catch (error) { blockState = "mounted/BROKEN " + String(error).slice(0, 200); }
  }
  const sanitized = text.replace(/!!js\s+[^\n]+/g, '"__js__"');
  let full = "OK";
  try { yaml.load(sanitized); } catch (error) { full = "PARSE ERROR: " + String(error).slice(0, 200); }
  console.log("[" + label + "] lines=" + lines.length + " block=" + blockState + " | full=" + full);
}
