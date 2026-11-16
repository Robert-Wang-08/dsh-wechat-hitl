#!/usr/bin/env node
// Pure decisions: never stop processes; only an unambiguous, stale, missing daemon permits start.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const normal = p => String(p || '').replace(/\\/g, '/').toLowerCase();
function entry(command) {
  // Windows launchers may emit doubled quotes. Only argv[1] counts, never a string inside a runner prompt.
  const args = String(command || '').replace(/""/g, '"').match(/"[^"]*"|[^\s]+/g) || [];
  return args.slice(0, 2).map(s => s.replace(/^"|"$/g, ''));
}
export function evaluateDaemon(input = {}) {
  const now = input.nowMs ?? Date.now();
  const beat = input.beat;
  const maxAge = input.maxAgeMs ?? 30000;
  const expected = normal(input.daemonPath);
  const rows = input.processes;
  const result = (state, reason, action = 'none') => ({ state, reason, action });
  if (!expected || !Array.isArray(rows)) return result('unknown', 'process-enumeration-unknown');
  const candidates = [];
  for (const p of rows) {
    if (!/^(node|bun)(\.exe)?$/i.test(p.Name || '')) continue;
    if (!p.CommandLine || !p.CreationDate) return result('unknown', 'process-identity-unreadable');
    const [exe, script] = entry(p.CommandLine);
    if (!/\/(node|bun)(\.exe)?$/i.test(normal(exe)) && !/^(node|bun)(\.exe)?$/i.test(exe)) continue;
    if (normal(script) === expected) candidates.push(p);
    else if (/feishu-daemon\.mjs$/i.test(script || '')) return result('unknown', 'other-daemon-entry');
  }
  if (candidates.length > 1) return result('unhealthy', 'multiple-daemon-instances');
  if (!beat || !Number.isSafeInteger(beat.pid) || beat.pid <= 0 || !Number.isFinite(beat.startedAt) || !Number.isFinite(beat.tickAt)) return result('unknown', 'heartbeat-invalid');
  if (beat.switchState && beat.switchState !== 'running') return result('unknown', 'channel-not-running');
  if (beat.stoppedAt) return result('unknown', 'intentional-stop');
  if (now < beat.tickAt - 5000) return result('unknown', 'clock-skew');
  const age = now - beat.tickAt;
  if (candidates.length === 0) {
    // PID reuse is not evidence that the old daemon still exists. Never signal that PID.
    return age > maxAge ? result('unhealthy', 'daemon-process-missing', 'repair') : result('unknown', 'recent-heartbeat-process-missing');
  }
  const p = candidates[0];
  const start = typeof p.CreationDate === 'number' ? p.CreationDate : Date.parse(p.CreationDate);
  if (p.ProcessId !== beat.pid || !Number.isFinite(start) || Math.abs(start - beat.startedAt) > 10000) return result('unknown', 'pid-or-creation-time-mismatch');
  if (age > maxAge) return result('unknown', 'heartbeat-stale-process-alive');
  if (input.previousBeat && (beat.seq <= input.previousBeat.seq || beat.tickAt <= input.previousBeat.tickAt)) return result('unknown', 'heartbeat-not-advancing');
  if (!['running', 'ready'].includes(beat.inbound)) return result('unhealthy', 'inbound-not-ready-process-alive');
  if (!Number.isSafeInteger(beat.childPid) || !rows.some(r => r.ProcessId === beat.childPid && r.ParentProcessId === beat.pid && /\bevent\s+consume\b/.test(r.CommandLine || ''))) return result('unhealthy', 'inbound-child-missing');
  return { ...result('ready', 'daemon-ready'), pid: beat.pid };
}
export function evaluateOverall(input = {}) {
  const daemon = evaluateDaemon(input);
  const orchestrator = input.orchestrator ?? {state:'unknown',reason:'orchestrator-not-checked'};
  const states = [daemon.state, orchestrator.state];
  const state = states.includes('unknown') ? 'unknown' : states.includes('unhealthy') ? 'unhealthy' : 'ready';
  return {state, action: state !== 'unknown' ? daemon.action : 'none', layers:{daemon,orchestrator}};
}
export function transition(prior = {}, report, now = Date.now(), mergeMs = 900000) {
  const incidents = structuredClone(prior.incidents || {});
  const active = new Set(); const events = [];
  for (const [layer, detail] of Object.entries(report.layers)) {
    if (detail.state === 'ready') continue;
    const key = layer + ':' + detail.reason; active.add(key);
    let item = incidents[key];
    if (!item) {
      item = {id:key + ':' + now, firstSeen:now, lastAlert:now, count:1};
      events.push({op:'incident-start',incidentId:item.id,key});
    } else if (now - item.lastAlert >= mergeMs) {
      item.lastAlert=now; item.count++;
      events.push({op:'incident-reminder',incidentId:item.id,key,count:item.count});
    }
    incidents[key]=item;
  }
  // Unknown does not prove recovery. Retain unresolved incidents until that layer is ready.
  for (const [key, item] of Object.entries(incidents)) {
    if (!active.has(key) && report.layers[key.split(':')[0]]?.state === 'ready') {
      events.push({op:'incident-recovered',incidentId:item.id,key}); delete incidents[key];
    }
  }
  return {state:{schemaVersion:1,incidents,lastRunAt:now,lastState:report.state},events};
}
if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url) && process.argv[2] === 'decide') {
  try {
    const input=JSON.parse(readFileSync(process.argv[3],'utf8').replace(/^\uFEFF/,''));
    const report=evaluateOverall(input);
    const changed=transition(input.prior,report,input.nowMs,input.mergeMs);
    const output={...report, persisted:changed.state,events:changed.events};
    // Keep verdict separate from persisted incident state.
    output.verdict=report.state;
    writeFileSync(process.argv[4],JSON.stringify(output,null,2));
    process.exit(report.state==='ready'?0:report.state==='unhealthy'?1:2);
  } catch(e) { console.error(e.message); process.exit(2); }
}
