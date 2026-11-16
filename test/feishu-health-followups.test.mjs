import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const quote=s=>"'"+s.replace(/'/g,"''")+"'";
for(const [name,change,reason] of [
 ['inbound dies during sampling',"$b.inbound='exited:1';$b.tickAt++;$b|ConvertTo-Json|Set-Content -LiteralPath $f",'inbound-exited'],
 ['resample disappears','Remove-Item -LiteralPath $f','heartbeat-resample-unreadable'],
 ['resample loses inbound',"$b.PSObject.Properties.Remove('inbound');$b.tickAt++;$b|ConvertTo-Json|Set-Content -LiteralPath $f",'inbound-unknown']
])test(name,()=>{
 const dir=mkdtempSync(join(tmpdir(),'feishu-probe-followup-'));
 try{
  const script="$global:f=Join-Path "+quote(dir)+" 'feishu-daemon.json'; @{pid=$PID;startedAt=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-1000);tickAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();inbound='running'}|ConvertTo-Json|Set-Content -LiteralPath $f; function global:Start-Sleep {param($Seconds) $b=Get-Content -LiteralPath $f -Raw|ConvertFrom-Json; "+change+" }; & "+quote(resolve('tools/test-feishu-health.ps1'))+" -StateDir "+quote(dir)+" -SkipProcessCheck -SkipOrchestrator -SkipReply -Json";
  const result=spawnSync('pwsh',['-NoProfile','-Command',script],{encoding:'utf8',timeout:15000});
  const report=JSON.parse(result.stdout);assert.equal(report.layers.find(l=>l.layer==='daemon').reason,reason,result.stderr);assert.notEqual(result.status,0);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('daemon heartbeat test refuses default state before writing',()=>{
 const env={...process.env};delete env.DSH_WECHAT_HITL_STATE;
 const result=spawnSync(process.execPath,['test/feishu-daemon-alive.test.mjs'],{env,encoding:'utf8',timeout:15000});
 assert.notEqual(result.status,0);assert.match(result.stderr,/DSH_WECHAT_HITL_STATE/);
});
test('restart launcher pins StateDir for CIM and fallback without starting a daemon',()=>{
 const dir=mkdtempSync(join(tmpdir(),'feishu state & followup-'));
 try{
  writeFileSync(join(dir,'fake.mjs'),'console.log(process.env.DSH_WECHAT_HITL_STATE);');
  // Extract the launch function with mocked service calls, then execute its exact CIM command against a disposable script.
  const command="$script:captured='';$script:processEnumOk=$true;$stateDir="+quote(dir)+";$daemon=Join-Path $stateDir 'fake.mjs';$stopFile=Join-Path $stateDir 'stop';$outFile=Join-Path $stateDir 'out';$ConfigDir=Join-Path $stateDir 'config & folder';$TimeoutSeconds=0; function Get-DaemonProcesses {$script:processEnumOk=$true;return $null}; function Invoke-CimMethod {param($ClassName,$MethodName,$Arguments) $script:captured=$Arguments.CommandLine;return @{ReturnValue=1}}; function Start-Process {param($FilePath,$ArgumentList,$WindowStyle,$RedirectStandardOutput,$RedirectStandardError) $script:fallback=$env:DSH_WECHAT_HITL_STATE;$script:fallbackArg=$ArgumentList}; function Test-Path {param($LiteralPath) return $LiteralPath -eq $daemon}; $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile("+quote(resolve('tools/restart-feishu-daemon.ps1'))+",[ref]$tokens,[ref]$errors); if($errors.Count){throw $errors[0]};$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Start-DaemonCore'},$true);Invoke-Expression $fn.Extent.Text;$null=Start-DaemonCore; $si=[Diagnostics.ProcessStartInfo]::new();$si.FileName='cmd.exe';$si.Arguments=$script:captured.Substring(8);$si.WorkingDirectory=$stateDir;$si.UseShellExecute=$false;$si.Environment['DSH_WECHAT_HITL_STATE']='wrong-parent-state';$p=[Diagnostics.Process]::Start($si);$p.WaitForExit();$launchExit=$p.ExitCode;$p.Dispose();@{command=$script:captured;fallback=$script:fallback;fallbackArg=$script:fallbackArg;launchExit=$launchExit}|ConvertTo-Json -Compress";
  const result=spawnSync('pwsh',['-NoProfile','-Command',command],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);const output=JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(output.fallbackArg,'"'+join(dir,'fake.mjs')+'"');
  assert.equal(output.fallback,dir);assert.ok(output.command.includes('set "DSH_WECHAT_HITL_STATE='+dir+'"&&'));
  assert.equal(output.launchExit,0,result.stdout+result.stderr+readFileSync(join(dir,'out'),'utf8'));assert.equal(readFileSync(join(dir,'out'),'utf8').trim(),dir);
  writeFileSync(join(dir,'check-env.cmd'),'@echo off\r\nset "DSH_WECHAT_HITL_STATE='+dir+'"&& node -p process.env.DSH_WECHAT_HITL_STATE\r\n');
  const check=spawnSync('cmd.exe',['/d','/c','.\\check-env.cmd'],{cwd:dir,encoding:'utf8',timeout:15000});
  assert.equal(check.status,0,check.stderr);assert.equal(check.stdout.trim(),dir);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
