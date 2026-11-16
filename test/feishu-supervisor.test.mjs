import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {evaluateDaemon,evaluateOverall,transition} from '../feishu/feishu-supervisor.mjs';
const now=Date.now(), path='D:/fake/feishu-daemon.mjs';
const beat={pid:10,startedAt:now-60000,tickAt:now-1000,seq:8,inbound:'running',childPid:11,switchState:'running'};
const proc={ProcessId:10,Name:'node.exe',CreationDate:now-60050,CommandLine:'"C:\\node.exe" "D:\\fake\\feishu-daemon.mjs"'};
const child={ProcessId:11,ParentProcessId:10,Name:'node.exe',CreationDate:now-50000,CommandLine:'node cli.js event consume im.message.receive_v1'};
const good={nowMs:now,daemonPath:path,beat,previousBeat:{...beat,tickAt:now-6000,seq:7},processes:[proc,child],orchestrator:{state:'ready',reason:'orchestrator-ready'}};
const dead={...good,beat:{...beat,tickAt:now-40000},processes:[]};
const cases=[
 ['healthy',good,'ready','none'],
 ['killed confirmed stale',dead,'unhealthy','repair'],
 ['missing but recent heartbeat',{...good,processes:[]},'unknown','none'],
 ['enumeration denied',{...good,processes:null},'unknown','none'],
 ['missing heartbeat',{...good,beat:null},'unknown','none'],
 ['unreadable node command',{...good,processes:[{...proc,CommandLine:''}]},'unknown','none'],
 ['unrelated creation time unreadable',{...good,processes:[proc,child,{ProcessId:99,Name:'node.exe',CommandLine:'node runner.js',CreationDate:null}]},'ready','none'],
 ['daemon creation time unreadable',{...good,processes:[{...proc,CreationDate:null},child]},'unknown','none'],
 ['unreadable command blocks repair',{...dead,processes:[{ProcessId:99,Name:'node.exe',CommandLine:'',CreationDate:null}]},'unknown','none'],
 ['pid reused',{...good,processes:[{...proc,CreationDate:now-1000},child]},'unknown','none'],
 ['entry elsewhere',{...good,beat:{...beat,tickAt:now-40000},processes:[{...proc,CommandLine:'node D:/other/feishu-daemon.mjs'}]},'unknown','none'],
 ['runner mention excluded',{...dead,processes:[{...proc,CommandLine:'node runner.js -- prompt feishu-daemon.mjs'}]},'unhealthy','repair'],
 ['duplicate daemon',{...good,processes:[proc,{...proc,ProcessId:22},child]},'unhealthy','none'],
 ['double quoted Windows launcher',{...good,processes:[{...proc,CommandLine:'""C:\\node.exe"" ""D:\\fake\\feishu-daemon.mjs""'},child]},'ready','none'],
 ['heartbeat stopped moving',{...good,previousBeat:beat},'unknown','none'],
 ['clock rollback',{...good,nowMs:now-100000},'unknown','none'],
 ['stale live process',{...good,nowMs:now+100000},'unknown','none'],
 ['inbound disconnected',{...good,beat:{...beat,inbound:'spawn-failed'}},'unhealthy','none'],
 ['inbound child killed',{...good,processes:[proc]},'unhealthy','none'],
 ['child pid reused',{...good,processes:[proc,{...child,ParentProcessId:20}]},'unhealthy','none'],
 ['3082 not ready',{...good,orchestrator:{state:'unhealthy',reason:'orchestrator-not-ready'}},'unhealthy','none'],
 ['3082 unknown blocks repair',{...dead,orchestrator:{state:'unknown',reason:'orchestrator-unreachable'}},'unknown','none'],
 ['intentional stop',{...dead,beat:{...dead.beat,stoppedAt:now-10000}},'unknown','none'],
 ['channel paused',{...dead,beat:{...dead.beat,switchState:'paused'}},'unknown','none'],
];
for(const [name,input,state,action] of cases)test(name,()=>{const r=evaluateOverall(input);assert.equal(r.state,state);assert.equal(r.action,action)});
test('first alert, 15-minute merge, unknown retains incident, recovery closes it',()=>{
 const bad=evaluateOverall(dead), ready=evaluateOverall(good);
 const a=transition({},bad,now);assert.equal(a.events[0].op,'incident-start');
 const b=transition(a.state,bad,now+300000);assert.equal(b.events.length,0);
 const c=transition(b.state,bad,now+900000);assert.equal(c.events[0].op,'incident-reminder');
 const d=transition(c.state,evaluateOverall({...good,processes:null}),now+910000);
 assert.ok(Object.keys(d.state.incidents).some(k=>k.includes('daemon-process-missing')));
 assert.ok(!d.events.some(e=>e.op==='incident-recovered'));
 const e=transition(d.state,ready,now+920000);assert.ok(e.events.every(e=>e.op==='incident-recovered'));assert.equal(Object.keys(e.state.incidents).length,0);
});
test('isolated runner persists first/reminder/recovery without touching live services',()=>{
 const dir=mkdtempSync(join(tmpdir(),'feishu-supervisor-test-'));
 try{
  const fixture=join(dir,'observation.json'),runner=resolve('tools/feishu-supervisor.ps1');
  const run=input=>{writeFileSync(fixture,JSON.stringify(input));try{execFileSync('pwsh',['-NoProfile','-File',runner,'-Mode','Monitor','-StateDir',dir,'-ObservationFile',fixture,'-NoToast','-NoRemote','-Json'],{stdio:'pipe',timeout:30000})}catch(e){assert.ok([1,2].includes(e.status),String(e.stderr))}return JSON.parse(readFileSync(join(dir,'feishu-supervisor-state.json'),'utf8'))};
  let s=run(dead);assert.equal(Object.keys(s.incidents).length,1);
  s=run({...dead,nowMs:now+300000});assert.equal(s.notifications.length,1);
  s=run({...dead,nowMs:now+900000});assert.equal(s.notifications.length,2);
  s=run({...good,nowMs:now+901000,beat:{...beat,tickAt:now+901000}});assert.equal(Object.keys(s.incidents).length,0);
  const log=readFileSync(join(dir,'feishu-supervisor.log'),'utf8');assert.ok(log.includes('incident-recovered'));assert.ok(!log.includes('repair-attempt'));
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('kernel mutex skips overlapping runner and becomes available after owner exits',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'feishu-supervisor-lock-'));
 const key=createHash('sha256').update(dir.toLowerCase()).digest('hex').toUpperCase();
 const name='Global\\DSH-Feishu-Supervisor-'+key;
 const cmd="$m=[Threading.Mutex]::new($false,'"+name+"');$null=$m.WaitOne();[Console]::WriteLine('READY');$null=[Console]::ReadLine();$m.ReleaseMutex();$m.Dispose()";
 const p=spawn('pwsh',['-NoProfile','-Command',cmd],{stdio:['pipe','pipe','pipe']});
 try{
  await new Promise((ok,fail)=>{p.stdout.once('data',d=>String(d).includes('READY')?ok():fail(Error(String(d))));p.once('error',fail);p.once('exit',c=>fail(Error('mutex holder exited '+c)))});
  const fixture=join(dir,'observation.json');writeFileSync(fixture,JSON.stringify(good));
  const args=['-NoProfile','-File',resolve('tools/feishu-supervisor.ps1'),'-Mode','Monitor','-StateDir',dir,'-ObservationFile',fixture,'-NoToast','-NoRemote','-Json'];
  const skipped=execFileSync('pwsh',args,{encoding:'utf8',timeout:15000});assert.ok(skipped.includes('mutex-held'));
  p.stdin.end('\n');await new Promise(ok=>p.once('exit',ok));
  const ran=execFileSync('pwsh',args,{encoding:'utf8',timeout:15000});assert.equal(JSON.parse(ran).verdict,'ready');
 }finally{if(p.exitCode===null)p.kill();rmSync(dir,{recursive:true,force:true})}
});
test('real isolated child death is reflected in observed process rows',async()=>{
 const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 await new Promise((ok,fail)=>{p.once('spawn',ok);p.once('error',fail)});
 try {
  const observed={...dead,beat:{...dead.beat,pid:p.pid},processes:[{...proc,ProcessId:p.pid}]};
  assert.equal(evaluateDaemon(observed).action,'none');
  p.kill();await new Promise(ok=>p.once('exit',ok));
  let alive=true;try{process.kill(p.pid,0)}catch{alive=false}
  assert.equal(alive,false);
  assert.equal(evaluateDaemon({...observed,processes:alive?observed.processes:[]}).action,'repair');
 }finally{if(p.exitCode===null)p.kill()}
});
test('failed repair persists, merges reminders, includes current count, and recovers',()=>{
 const a=evaluateOverall({...dead,repair:{exit:3}});
 assert.equal(a.layers.repair.consecutiveFailures,1);
 const first=transition({},a,now);
 const failure=first.events.find(e=>e.key==='repair:repair-failed');
 assert.equal(failure.exit,3);assert.equal(failure.consecutiveFailures,1);
 const b=evaluateOverall({...dead,prior:first.state,repair:{exit:124}});
 const merged=transition(first.state,b,now+300000);
 assert.equal(merged.events.length,0);assert.equal(merged.state.repairStatus.consecutiveFailures,2);
 const c=evaluateOverall({...dead,prior:merged.state,repair:{exit:1}});
 const reminded=transition(merged.state,c,now+900000);
 const reminder=reminded.events.find(e=>e.key==='repair:repair-failed');
 assert.equal(reminder.exit,1);assert.equal(reminder.consecutiveFailures,3);
 const unknown=evaluateOverall({...good,processes:null,prior:reminded.state});
 assert.equal(unknown.layers.repair.consecutiveFailures,3);assert.equal(unknown.action,'none');
 const recovered=evaluateOverall({...good,prior:reminded.state});
 assert.equal(recovered.repairStatus.consecutiveFailures,0);
 assert.ok(transition(reminded.state,recovered,now+910000).events.some(e=>e.key==='repair:repair-failed'&&e.op==='incident-recovered'));
 const falseSuccess=evaluateOverall({...dead,repair:{exit:0}});
 assert.equal(falseSuccess.layers.repair.consecutiveFailures,1);
});
test('offline runner persists failed repair details across passes without launching services',()=>{
 const dir=mkdtempSync(join(tmpdir(),'feishu-supervisor-failure-'));
 try{
  const fixture=join(dir,'observation.json');
  const run=input=>{writeFileSync(fixture,JSON.stringify(input));try{execFileSync('pwsh',['-NoProfile','-File',resolve('tools/feishu-supervisor.ps1'),'-Mode','Monitor','-StateDir',dir,'-ObservationFile',fixture,'-NoToast','-NoRemote','-Json'],{timeout:30000})}catch(e){assert.equal(e.status,1,String(e.stderr))}return JSON.parse(readFileSync(join(dir,'feishu-supervisor-state.json'),'utf8'))};
  let s=run({...dead,repair:{exit:3}});assert.equal(s.repairStatus.consecutiveFailures,1);
  assert.equal(s.notifications.find(n=>n.event.key==='repair:repair-failed').event.exit,3);
  s=run({...dead,nowMs:now+900000,repair:{exit:124}});
  assert.equal(s.repairStatus.consecutiveFailures,2);
  assert.equal(s.notifications.filter(n=>n.event.key==='repair:repair-failed').at(-1).event.consecutiveFailures,2);
  s=run(good);assert.equal(s.repairStatus.consecutiveFailures,0);
  assert.ok(s.notifications.some(n=>n.event.key==='repair:repair-failed'&&n.event.op==='incident-recovered'));
 }finally{rmSync(dir,{recursive:true,force:true})}
});
