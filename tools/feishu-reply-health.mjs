#!/usr/bin/env node
/** feishu-reply-health.mjs - 只读查询 superagent orchestrator.sqlite 里卡住的 reply 效果（2026-11-14） */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const dbPath = process.argv[2];
if (!dbPath) { console.log(JSON.stringify({ ok: false, error: "missing-db-path" })); process.exit(0); }
if (!existsSync(dbPath)) { console.log(JSON.stringify({ ok: false, error: "db-not-found", db: dbPath })); process.exit(0); }

let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare("SELECT count(*) AS pending, coalesce(max(attempts),0) AS maxAttempts FROM effect WHERE kind='reply' AND attempts>0").get();
  const sample = db.prepare("SELECT since, attempts, substr(error,1,160) AS error FROM effect WHERE kind='reply' AND attempts>0 ORDER BY attempts DESC LIMIT 1").get();
  console.log(JSON.stringify({ ok: true, db: dbPath, pending: Number(row?.pending ?? 0), maxAttempts: Number(row?.maxAttempts ?? 0), sample: sample ?? null }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error), db: dbPath }));
} finally {
  try { db?.close(); } catch {}
}
