// Independent, bounded CLI egress; no monitored daemon/outbox dependency.
import {readFileSync} from 'node:fs';
import {feishuSend, getControl} from '../lib/hitl-store.js';
const {text}=JSON.parse(readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/,''));
if(getControl('feishu').state!=='running'){console.log(JSON.stringify({suppressed:'channel-not-running'}));process.exit(2)}
const result=await feishuSend(null,text);
console.log(JSON.stringify(result));
process.exit(result.code===0?0:1);
