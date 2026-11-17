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
export async function verifyEdit(runId){
 assert.match(runId,/^[a-z0-9][a-z0-9_-]{0,79}$/);
 const directory=await reserveRun(path.join(root,'docs/evidence/P5'),runId),config=readConfig();
 const prior=await loadManifests(),baseline=JSON.parse(await fs.readFile(path.join(root,'docs/evidence/P5/run-20261116-b1-baseline/baseline.json')));
 const database=createDatabase(config);
 const reports=[],sql=[],manifest={version:1,sequence:Math.max(...prior.map(m=>m.sequence))+1,runId,batch:4,accounts:[],rows:[],images:[],referencedFixtureRunId:'run-20261117-b2-http2',referencedAccountIds:[37,38],sessionsOpened:0,allAccountsLoggedOut:false,processClosed:false};
 let runtime,token,beforeUser,newId,checksPassed=false;
 const rows=async(query,params=[])=>{const c=await database.getConnection();try{return (await c.execute(query,params))[0];}finally{c.release();}};
 const call=async(label,method,url,status,data)=>{
  const response=await fetch('http://127.0.0.1:'+runtime.server.address().port+'/api'+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(data?{body:JSON.stringify(data)}:{})});const body=await response.json();reports.push({label,method,path:url,expected:status,actual:response.status});assert.equal(response.status,status,label);return body.data;
 };
 try{
  const preflight=await captureSnapshot(database,config.uploadRoot);compareCumulative(baseline,preflight,prior);await write(path.join(directory,'preflight.json'),preflight);
  [beforeUser]=await rows('SELECT * FROM users WHERE id=?',[37]);assert.equal(beforeUser.auth_token_hash,null);assert.equal(beforeUser.auth_expires_at,null);
  await write(path.join(directory,'write-plan.json'),{batch:4,gitBase:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),reuseAccount:37,accountCreatedBy:'run-20261117-b2-http2',beforeUserSha256:hash(beforeUser),allowedExistingFields:['users.37.updated_at (after login/logout only)'],newOutfits:1,clothingIds:[123,124,125,126,142],previousOutfitsMutable:false,diariesMutable:false});
  const history=await rows('SELECT * FROM diaries ORDER BY id'),historyItems=await rows('SELECT * FROM diary_items ORDER BY diary_id,sort_order');
  runtime=await start({...config,port:0});
  const privateData=JSON.parse(await fs.readFile(path.join(serverRoot,'.p5-private/run-20261117-b2-http2.json'))),account=privateData.accounts.find(a=>a.id===37);
  token=(await call('reuse A login','POST','/auth/login',200,{username:account.username,password:account.password})).token;manifest.sessionsOpened=1;
  const statsBefore=await call('C03 before save','GET','/clothes/123',200);
  const form={name:'Batch4 有序组合',occasion:'组合编辑',note:'第一行\n第二行',clothingIds:[123,124,125,126,142]};
  const created=await call('O04 create five including archived','POST','/outfits',201,form);newId=created.id;assert.ok(Number.isInteger(newId));
  assert.deepEqual(created.items.map(i=>i.id),form.clothingIds);assert.equal(created.items.at(-1).isArchived,true);
  await write(path.join(directory,'created-outfit.json'),{id:newId,userId:37,clothingIds:form.clothingIds,createdByRunId:runId});
  const verifySql=async(label,ids)=>{const fresh=createDatabase(config),c=await fresh.getConnection();try{const [parents]=await c.execute('SELECT * FROM outfits WHERE id=?',[newId]);const [items]=await c.execute('SELECT * FROM outfit_items WHERE outfit_id=? ORDER BY sort_order',[newId]);assert.equal(parents[0].user_id,37);assert.deepEqual(items.map(i=>i.clothing_id),ids);assert.deepEqual(items.map(i=>i.sort_order),ids.map((_,i)=>i+1));sql.push({label,outfitId:newId,ownerId:37,clothingIds:ids,sortOrders:items.map(i=>i.sort_order),parentSha256:hash(parents),itemsSha256:hash(items),newConnection:true,passed:true});}finally{c.release();await fresh.end();}};
  await verifySql('after create',form.clothingIds);
  const reopened=await call('O03 reopen complete items','GET','/outfits/'+newId,200);assert.deepEqual(reopened.items.map(i=>i.id),form.clothingIds);
  const edited={...form,name:'Batch4 已编辑组合',note:'',clothingIds:[142,125,123]};const updated=await call('O05 reorder remove and retain archived','PUT','/outfits/'+newId,200,edited);assert.deepEqual(updated.items.map(i=>i.id),edited.clothingIds);
  await verifySql('after edit',edited.clothingIds);
  assert.deepEqual((await call('O03 reopen persisted order','GET','/outfits/'+newId,200)).items.map(i=>i.id),edited.clothingIds);
  await call('O05 reject zero selection','PUT','/outfits/'+newId,400,{...edited,clothingIds:[]});await verifySql('invalid save leaves order',edited.clothingIds);
  const statsAfter=await call('C03 after save','GET','/clothes/123',200);assert.equal(statsAfter.wearCount,statsBefore.wearCount);assert.equal(statsAfter.lastWornDate,statsBefore.lastWornDate);
  assert.deepEqual(await rows('SELECT * FROM diaries ORDER BY id'),history);assert.deepEqual(await rows('SELECT * FROM diary_items ORDER BY diary_id,sort_order'),historyItems);
  await write(path.join(directory,'historical-independence.json'),{diariesSha256:hash(history),diaryItemsSha256:hash(historyItems),unchanged:true,clothingId:123,wearCountBefore:statsBefore.wearCount,wearCountAfter:statsAfter.wearCount,lastWornDateBefore:statsBefore.lastWornDate,lastWornDateAfter:statsAfter.lastWornDate});
  manifest.fixture={outfitId:newId,ownerId:37,clothingIds:edited.clothingIds,createdByRunId:runId};checksPassed=true;
 }finally{
  try{
   try{
  if(token){await call('A03 final logout','POST','/auth/logout',200);token=null;}
   }finally{if(runtime){await runtime.close();manifest.processClosed=true;}}
  const [afterUser]=await rows('SELECT * FROM users WHERE id=?',[37]);
  if(manifest.sessionsOpened){const proof=sessionTransitionProof(afterUser,beforeUser.updated_at);assert.equal(proof.beforeSha256,hash(beforeUser),'UNEXPECTED_EXISTING_ACCOUNT_CHANGE');manifest.rows.push({table:'users',ownerId:37,row:{key:37,sha256:hash(afterUser)},beforeSha256:hash(beforeUser),transition:'logged-out-session',proof,allowedFields:['updated_at'],changedFields:beforeUser.updated_at===afterUser.updated_at?[]:['updated_at']});}
  manifest.allAccountsLoggedOut=(await rows('SELECT auth_token_hash,auth_expires_at FROM users WHERE id IN (37,38)')).every(r=>r.auth_token_hash===null&&r.auth_expires_at===null);
  if(newId){
   const [parent]=await rows('SELECT * FROM outfits WHERE id=?',[newId]),items=await rows('SELECT * FROM outfit_items WHERE outfit_id=? ORDER BY sort_order',[newId]);
   assert.equal(parent.user_id,37);if(manifest.fixture)assert.deepEqual(items.map(i=>i.clothing_id),manifest.fixture.clothingIds);
   manifest.rows.push({table:'outfits',ownerId:37,row:{key:newId,sha256:hash(parent),userId:37},beforeSha256:null,allowedFields:['name','occasion','note','is_archived','updated_at'],changedFields:[]});
   for(const row of items)manifest.rows.push({table:'outfit_items',ownerId:37,row:{key:row.outfit_id+':'+row.clothing_id,sha256:hash(row)},beforeSha256:null,allowedFields:['clothing_id','sort_order'],changedFields:[]});
  }
  await write(path.join(directory,'manifest.json'),manifest);await write(path.join(directory,'http-results.json'),reports);await write(path.join(directory,'sql-results.json'),sql);
  const final=await captureSnapshot(database,config.uploadRoot);await write(path.join(directory,'final-snapshot.json'),final);const protection=compareCumulative(baseline,final,[...prior,manifest]);
  await write(path.join(directory,'results.json'),{runId,batch:4,checkedAt:new Date().toISOString(),stage5Complete:false,passed:checksPassed&&reports.length===9&&sql.length===3,authenticatedHttpChecks:reports.length,newConnectionSqlChecks:sql.length,manifest:'manifest.json',protection,allAccountsLoggedOut:manifest.allAccountsLoggedOut,ownedApplicationClosed:manifest.processClosed,developerToolPortOpened:false,pending:['Batch5 full linkage and diary source','Batch6 full integration/restart','Batch7 native/manual/visual']});
  }finally{await database.end();}
 }
}
if(import.meta.main){if(process.argv.length===2||process.argv[2]==='--help')console.log('Batch4定向保存验证：node --env-file-if-exists=.env scripts/verify-outfit-edit.mjs --write <唯一runId>；显式写1套新搭配，复用37并最终退出，保留成功数据。');else {assert.equal(process.argv[2],'--write');assert.equal(process.argv.length,4);await verifyEdit(process.argv[3]);}}
