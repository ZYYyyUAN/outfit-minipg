import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import {serverRoot} from '../src/config.js';
const hash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const write=(p,v)=>fs.writeFile(p,JSON.stringify(v,null,2)+'\n');
export function selectIntegrationManifest(manifests){return manifests.findLast(m=>m.batch===6&&m.accounts.length===2&&m.images.length>=2&&m.allowedFields?.outfits);}
export async function verifyRestart({runId,directory,baselineFile,config,database,gitState,verification}){
 const {captureSnapshot,compareCumulative,loadManifests,sessionTransitionProof}=verification;
 const baseline=JSON.parse(await fs.readFile(baselineFile)),prior=await loadManifests();
 const source=selectIntegrationManifest(prior);assert.ok(source,'RUN_BATCH6_HTTP_FIRST');
 const fixture=JSON.parse(await fs.readFile(path.join(path.dirname(directory),source.runId,'fixture-map.json')));
 const credentials=JSON.parse(await fs.readFile(path.join(serverRoot,'.p5-private',source.runId+'.json'))).accounts;
 const processes=[],checks=[],active=new Map(),beforeUsers=[];let child,passed=false;
 const rows=async(sql,args=[])=>{const c=await database.getConnection();try{return(await c.execute(sql,args))[0];}finally{c.release();}};
 const snapshot=await captureSnapshot(database,config.uploadRoot);compareCumulative(baseline,snapshot,prior);await write(path.join(directory,'preflight.json'),snapshot);
 const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin='http://127.0.0.1:'+port;
 async function listen(){
  child=spawn(process.execPath,[path.join(serverRoot,'src/index.js')],{cwd:serverRoot,env:{...process.env,PORT:String(port),PUBLIC_BASE_URL:origin},windowsHide:true,stdio:['ignore','pipe','pipe']});
  const owned=child;processes.push({pid:owned.pid,origin,startedAt:new Date().toISOString()});
  await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('STARTUP_TIMEOUT')),15000);owned.once('error',e=>{clearTimeout(timer);reject(e);});owned.once('exit',()=>{clearTimeout(timer);reject(new Error('STARTUP_FAILED'));});owned.stderr.resume();owned.stdout.on('data',b=>{output+=b.toString();if(output.includes('"event":"http-listening"')){clearTimeout(timer);resolve();}});});
 }
 async function close(){if(!child||child.exitCode!==null)return;const owned=child;await new Promise((resolve,reject)=>{owned.once('exit',resolve);owned.once('error',reject);owned.kill('SIGTERM');});Object.assign(processes.find(p=>p.pid===owned.pid),{stoppedAt:new Date().toISOString(),stopMode:'owned child terminated; Windows graceful shutdown not claimed'});}
 async function call(label,url,i=0,method='GET',body,status=200){const r=await fetch(origin+'/api'+url,{method,headers:{'Content-Type':'application/json',...(active.has(i)?{Authorization:'Bearer '+active.get(i)}:{})},...(body?{body:JSON.stringify(body)}:{})});const v=await r.json();checks.push({label,method,url,status:r.status,expected:status});assert.equal(r.status,status,label);return v.data;}
 async function image(i,status){const name=source.images[i].path.split('/').at(-1);const r=await fetch(origin+'/api/media/'+name,{headers:{Authorization:'Bearer '+active.get(0)}});assert.equal(r.status,status);if(status===200)assert.equal(hash(Buffer.from(await r.arrayBuffer())),source.images[i].sha256);checks.push({label:'authenticated image '+i,status,sha256Preserved:status===200});}
 try{
  for(const a of credentials){const [u]=await rows('SELECT * FROM users WHERE id=?',[a.id]);assert.equal(u.auth_token_hash,null);beforeUsers.push(u);}
  await write(path.join(directory,'write-plan.json'),{batch:6,sourceRunId:source.runId,accountIds:credentials.map(a=>a.id),allowedExistingFields:['users.updated_at via login/logout only'],businessWrites:false});
  await listen();for(const [i,a]of credentials.entries())active.set(i,(await call('login '+i,'/auth/login',i,'POST',{username:a.username,password:a.password})).token);
  const id=fixture.outfits.A4.id,before=await call('20 ordered items before restart','/outfits/'+id);assert.equal(before.items.length,20);await image(0,200);await image(1,404);
  const sessions=await rows('SELECT id,auth_expires_at FROM users WHERE id IN (?,?)',credentials.map(a=>a.id));
  await close();await listen();assert.notEqual(processes[0].pid,processes[1].pid);
  const after=await call('same session same full outfit after actual process restart','/outfits/'+id);assert.deepEqual(after,before);await image(0,200);await image(1,404);
  assert.deepEqual(await rows('SELECT id,auth_expires_at FROM users WHERE id IN (?,?)',credentials.map(a=>a.id)),sessions);
  await call('B cannot read A after restart','/outfits/'+id,1,'GET',undefined,404);
  const ordered=await rows('SELECT clothing_id,sort_order FROM outfit_items WHERE outfit_id=? ORDER BY sort_order',[id]);assert.deepEqual(ordered.map(r=>r.clothing_id),before.items.map(i=>i.id));
  await write(path.join(directory,'restart-proof.json'),{sourceRunId:source.runId,outfitId:id,orderedClothingIds:ordered.map(r=>r.clothing_id),beforeSha256:hash(before),afterSha256:hash(after),sessionsSurvived:true,expiryUnchanged:true,pooledConnectionSql:true,imagesPreserved:true,processes});passed=true;
 }finally{
  try{
   try{for(const [i]of active){await call('final logout '+i,'/auth/logout',i,'POST');active.delete(i);}}finally{await close();}
  }finally{
   const manifest={version:1,sequence:Math.max(...prior.map(m=>m.sequence))+1,runId,batch:6,accounts:[],rows:[],images:[],referencedFixtureRunId:source.runId,processes,allAccountsLoggedOut:false};
   for(const old of beforeUsers){const [u]=await rows('SELECT * FROM users WHERE id=?',[old.id]);const proof=sessionTransitionProof(u,old.updated_at);assert.equal(proof.beforeSha256,hash(old));manifest.rows.push({table:'users',ownerId:u.id,row:{key:u.id,sha256:hash(u)},beforeSha256:hash(old),transition:'logged-out-session',proof});}
   manifest.allAccountsLoggedOut=active.size===0;await write(path.join(directory,'manifest.json'),manifest);await write(path.join(directory,'http-results.json'),checks);await write(path.join(directory,'processes.json'),processes);
   const final=await captureSnapshot(database,config.uploadRoot),protection=compareCumulative(baseline,final,[...prior,manifest]);await write(path.join(directory,'final-snapshot.json'),final);
   await write(path.join(directory,'results.json'),{runId,batch:6,gitBase:gitState.startCommit,passed,stage5Complete:false,protection,processesClosed:processes.every(p=>p.stoppedAt),accountsLoggedOut:manifest.allAccountsLoggedOut,httpCases:checks.length,developerToolPortOpened:false});
  }
 }
}
