import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readConfig,serverRoot} from '../src/config.js';
import {start} from '../src/index.js';
import {createDatabase} from '../src/db.js';
import {reserveRun,captureSnapshot,compareCumulative,loadManifests,sessionTransitionProof} from './verify-outfits.mjs';
const root=path.dirname(serverRoot),hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const write=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n');
export async function verifyLinkage(runId){
 assert.match(runId,/^[a-z0-9][a-z0-9_-]{0,79}$/);
 const directory=await reserveRun(path.join(root,'docs/evidence/P5'),runId),config=readConfig();
 const prior=await loadManifests(),baseline=JSON.parse(await fs.readFile(path.join(root,'docs/evidence/P5/run-20261116-b1-baseline/baseline.json')));
 const database=createDatabase(config);
 const reports=[],sql=[],manifest={version:1,sequence:Math.max(...prior.map(m=>m.sequence))+1,runId,batch:5,accounts:[],rows:[],images:[],referencedFixtureRunId:'run-20261117-b2-http2',referencedAccountIds:[37,38],sessionsOpened:0,allAccountsLoggedOut:false,processClosed:false};
 let runtime,token,beforeUser,checksPassed=false;
 const rows=async(query,params=[])=>{const c=await database.getConnection();try{return (await c.execute(query,params))[0];}finally{c.release();}};
 const call=async(label,method,url,status,data)=>{
  const response=await fetch('http://127.0.0.1:'+runtime.server.address().port+'/api'+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(data?{body:JSON.stringify(data)}:{})});const body=await response.json();reports.push({label,method,path:url,expected:status,actual:response.status});assert.equal(response.status,status,label);return body.data;
 };
 try{
  const preflight=await captureSnapshot(database,config.uploadRoot);compareCumulative(baseline,preflight,prior);await write(path.join(directory,'preflight.json'),preflight);
  [beforeUser]=await rows('SELECT * FROM users WHERE id=?',[37]);assert.equal(beforeUser.auth_token_hash,null);assert.equal(beforeUser.auth_expires_at,null);
  await write(path.join(directory,'write-plan.json'),{batch:5,gitBase:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),reuseAccount:37,allowedExistingFields:['users.37.updated_at (login/logout only)'],businessWrites:false});
  const history=await rows('SELECT * FROM diaries ORDER BY id'),historyItems=await rows('SELECT * FROM diary_items ORDER BY diary_id,sort_order');
  runtime=await start({...config,port:0});
  const privateData=JSON.parse(await fs.readFile(path.join(serverRoot,'.p5-private/run-20261117-b2-http2.json'))),account=privateData.accounts.find(a=>a.id===37);
  token=(await call('reuse A login','POST','/auth/login',200,{username:account.username,password:account.password})).token;manifest.sessionsOpened=1;
  const statsBefore=await call('C03 before source entry','GET','/clothes/123',200);
  const outfit=await call('O03 source and current full clothes','GET','/outfits/49',200);
  assert.equal(outfit.id,49);assert.deepEqual(outfit.items.map(i=>i.id),[142,125,123]);
  const related=await call('C07 current outfit relation','GET','/clothes/123/outfits?pageSize=50',200);assert.ok(related.items.some(i=>i.id===49));
  await call('O01 current previews','GET','/outfits?archived=all',200);await call('O02 facets','GET','/outfits/facets?archived=all',200);
  const fresh=createDatabase(config);
  try{
    const connection=await fresh.getConnection();
    try{
    const [items]=await connection.execute('SELECT clothing_id,sort_order FROM outfit_items WHERE outfit_id=49 ORDER BY sort_order');
    assert.deepEqual(items.map(i=>i.clothing_id),outfit.items.map(i=>i.id));
    for(const item of outfit.items){const [rows]=await connection.execute('SELECT name,image_path,is_archived FROM clothes WHERE id=? AND user_id=37',[item.id]);assert.equal(item.name,rows[0].name);assert.equal(item.imagePath,rows[0].image_path);assert.equal(item.isArchived,Boolean(rows[0].is_archived));}
    sql.push({label:'O03 current attributes and ordered relation',newConnection:true,outfitId:49,clothingIds:items.map(i=>i.clothing_id),passed:true});
      }finally{connection.release();}
  }finally{await fresh.end();}
  const {clientHarness}=await import('../test/client-harness.mjs');const requests=[];const h=clientHarness(o=>requests.push(o),{pageScrollTo:()=>{}});h.setApp({authReady:Promise.resolve()});h.session.adopt({token:'x'.repeat(43),expiresAt:'2027-01-01T00:00:00.000Z',user:{id:37}});
  const page=h.load('pages/outfits/detail/index.js');page.onLoad({id:'49'});await page.onShow();requests[0].success({statusCode:200,data:{data:outfit}});await new Promise(resolve=>setImmediate(resolve));
  const count=requests.length;const source=page.recordWear();assert.equal(source.sourceOutfitId,outfit.id);assert.equal(Number.isInteger(source.sourceOutfitId),true);assert.equal(requests.length,count);const modal=h.calls.at(-1)[1];assert.ok(modal.content.includes('sourceOutfitId=49'));assert.ok(modal.content.includes(outfit.name));assert.ok(modal.content.includes('尚未生成穿着记录'));page.onUnload();
  await write(path.join(directory,'source-entry.json'),{sourceOutfitId:source.sourceOutfitId,sourceOutfitName:outfit.name,feedback:modal.content,additionalRequests:0,diaryRequests:0,method:'client callback with authenticated O03 response',passed:true});
  const statsAfter=await call('C03 after source entry','GET','/clothes/123',200);assert.equal(statsAfter.wearCount,statsBefore.wearCount);assert.equal(statsAfter.lastWornDate,statsBefore.lastWornDate);
  assert.deepEqual(await rows('SELECT * FROM diaries ORDER BY id'),history);assert.deepEqual(await rows('SELECT * FROM diary_items ORDER BY diary_id,sort_order'),historyItems);
  await write(path.join(directory,'historical-independence.json'),{diariesSha256:hash(history),diaryItemsSha256:hash(historyItems),unchanged:true,clothingId:123,wearCountBefore:statsBefore.wearCount,wearCountAfter:statsAfter.wearCount,lastWornDateBefore:statsBefore.lastWornDate,lastWornDateAfter:statsAfter.lastWornDate});
  checksPassed=true;
 }finally{
  try{
   try{
  if(token){await call('A03 final logout','POST','/auth/logout',200);token=null;}
   }finally{if(runtime){await runtime.close();manifest.processClosed=true;}}
  const [afterUser]=await rows('SELECT * FROM users WHERE id=?',[37]);
  if(manifest.sessionsOpened){const proof=sessionTransitionProof(afterUser,beforeUser.updated_at);assert.equal(proof.beforeSha256,hash(beforeUser),'UNEXPECTED_EXISTING_ACCOUNT_CHANGE');manifest.rows.push({table:'users',ownerId:37,row:{key:37,sha256:hash(afterUser)},beforeSha256:hash(beforeUser),transition:'logged-out-session',proof,allowedFields:['updated_at'],changedFields:beforeUser.updated_at===afterUser.updated_at?[]:['updated_at']});}
  manifest.allAccountsLoggedOut=(await rows('SELECT auth_token_hash,auth_expires_at FROM users WHERE id IN (37,38)')).every(r=>r.auth_token_hash===null&&r.auth_expires_at===null);
  await write(path.join(directory,'manifest.json'),manifest);await write(path.join(directory,'http-results.json'),reports);await write(path.join(directory,'sql-results.json'),sql);
  const final=await captureSnapshot(database,config.uploadRoot);await write(path.join(directory,'final-snapshot.json'),final);const protection=compareCumulative(baseline,final,[...prior,manifest]);
  await write(path.join(directory,'results.json'),{runId,batch:5,checkedAt:new Date().toISOString(),stage5Complete:false,passed:checksPassed&&reports.length===8&&sql.length===1,authenticatedHttpChecks:reports.length,newConnectionSqlChecks:sql.length,manifest:'manifest.json',protection,allAccountsLoggedOut:manifest.allAccountsLoggedOut,ownedApplicationClosed:manifest.processClosed,developerToolPortOpened:false,pending:['Batch6 full integration/restart','Batch7 native/manual/visual']});
  }finally{await database.end();}
 }
}
if(import.meta.main){if(process.argv.length===2||process.argv[2]==='--help')console.log('Batch5只读业务联动验证：--check <唯一runId>；复用37登录并退出，不写业务数据。');else{assert.equal(process.argv[2],'--check');assert.equal(process.argv.length,4);await verifyLinkage(process.argv[3]);}}
