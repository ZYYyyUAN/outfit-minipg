import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomBytes,createHash} from 'node:crypto';
import {serverRoot,readConfig} from '../src/config.js';
const config=readConfig(),root=path.dirname(serverRoot),runId='run-20261115-restart',folder=path.join(root,'docs/evidence/P4',runId);
await fs.mkdir(folder);
const write=(name,value)=>fs.writeFile(path.join(folder,name),JSON.stringify(value,null,2)+'\n');
const hash=value=>createHash('sha256').update(value).digest('hex');
const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));const origin='http://127.0.0.1:'+port;
const account={username:'p4_'+randomBytes(4).toString('hex')+'_a',id:null,role:'restart',loggedOut:false},password=randomBytes(20).toString('hex');
const files=[],clothes=[],report={runId,processes:[],passed:false};let child,token;
async function save() {await Promise.all([write('accounts.json',{runId,accounts:account.id?[account]:[]}),write('files-manifest.json',{runId,files}),write('clothes-manifest.json',{runId,clothes}),write('restart-results.json',report)]);}
async function listen() {
  child=spawn(process.execPath,[path.join(serverRoot,'src/index.js')],{cwd:serverRoot,env:{...process.env,PORT:String(port),PUBLIC_BASE_URL:origin},windowsHide:true,stdio:['ignore','pipe','pipe']});
  report.processes.push({pid:child.pid,startedAt:new Date().toISOString(),origin});await save();
  await new Promise((resolve,reject)=> {
    let output='';const timer=setTimeout(()=>reject(new Error('CHILD_START_TIMEOUT')),10000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('CHILD_EXITED'));});
    child.stdout.on('data',data=> {output+=data.toString();if(output.includes('http-listening')) {clearTimeout(timer);resolve();}});
  });
}
async function close() {
  if(!child || child.exitCode!==null) return;
  const current=child;await new Promise((resolve,reject)=>{current.once('exit',resolve);current.once('error',reject);current.kill('SIGTERM');});
  const processRecord=report.processes.find(record=>record.pid===current.pid);processRecord.stoppedAt=new Date().toISOString();processRecord.stopMode='owned child termination; not a graceful shutdown claim';await save();
}
async function call(method,url,status,body) {
  const response=await fetch(origin+'/api'+url,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body && !(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
  assert.equal(response.status,status,url);return (await response.json()).data;
}
try {
  await save();await listen();
  const user=await call('POST','/auth/register',201,{username:account.username,password,nickname:'P4重启验证'});account.id=user.id;await save();
  token=(await call('POST','/auth/login',200,{username:account.username,password})).token;
  const bytes=await fs.readFile(path.join(root,'assets/clothes/clothing-012.jpg')),form=new FormData();form.append('file',new Blob([bytes],{type:'image/jpeg'}),'jeans.jpg');
  const upload=await call('POST','/uploads',201,form);files.push({userId:account.id,imagePath:upload.imagePath,mimeType:upload.mimeType,size:upload.size,sha256:hash(bytes),retained:true});await save();
  const input={name:'P4重启后仍在的牛仔裤',categoryId:'bottoms',imagePath:upload.imagePath,color:'水洗蓝',season:'四季',note:'独立进程持久读取验证'};
  const created=await call('POST','/clothes',201,input);clothes.push({id:created.id,userId:account.id,role:'restart'});await save();
  const before=await call('GET','/clothes/'+created.id,200);
  await close();await listen();assert.notEqual(report.processes[0].pid,report.processes[1].pid);
  const after=await call('GET','/clothes/'+created.id,200);assert.deepEqual(after,before);
  const image=await fetch(origin+'/api/media/'+upload.imagePath.split('/').at(-1),{headers:{Authorization:'Bearer '+token}});assert.equal(image.status,200);assert.equal(hash(Buffer.from(await image.arrayBuffer())),hash(bytes));
  report.passed=true;report.clothingId=created.id;report.detailPersisted=true;report.imagePersisted=true;report.tokenSurvivedRestart=true;
} finally {
  if(token && child.exitCode===null) {account.loggedOut=(await call('POST','/auth/logout',200)).loggedOut;}
  await save();await close();
}
console.log(JSON.stringify({runId,passed:report.passed,distinctProcesses:report.processes.length,loggedOut:account.loggedOut}));
