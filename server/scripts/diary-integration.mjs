import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readConfig,serverRoot} from '../src/config.js';
import {createDatabase} from '../src/db.js';
import {start} from '../src/index.js';
import {createDiaryService} from '../src/services/diaries.js';
import {createStatisticsService} from '../src/services/statistics.js';
import {shanghaiDate} from '../src/utils/diary-input.js';
import {snapshot} from './verify-diaries.mjs';

const root=path.dirname(serverRoot),hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const save=(file,v)=>fs.writeFile(file,JSON.stringify(v,null,2)+'\n');
export async function integrate(runId){
 assert.match(runId,/^[a-z0-9][a-z0-9_-]{0,79}$/);
 const dir=path.join(root,'docs/evidence/P6',runId);await fs.mkdir(dir);
 const config={...readConfig(),port:3016,publicBaseUrl:'http://127.0.0.1:3016'},db=createDatabase(config),before=await snapshot(db,config.uploadRoot);
 await save(path.join(dir,'baseline.json'),before);
 const accounts=[],events=[],checks=[],requests=[],registered={users:[],clothes:[],outfits:[],diaries:[],images:[],deleted:[]};
 const privateDir=path.join(serverRoot,'.p6-private');await fs.mkdir(privateDir,{recursive:true});
 let runtime,previous=before;
 async function sql(query,args=[]){const c=await db.getConnection();try{return (await c.execute(query,args))[0];}finally{c.release();}}
 async function record(label){
  const next=await snapshot(db,config.uploadRoot),changes=[];
  for(const [table,value]of Object.entries(next.tables)){
   assert.equal(value.structure,before.tables[table].structure,'DDL:'+table);
   for(const [key,sha]of Object.entries(before.tables[table].rows))assert.equal(value.rows[key],sha,'ORIGINAL_ROW:'+table+':'+key);
   const old=previous.tables[table].rows;
   for(const key of new Set([...Object.keys(old),...Object.keys(value.rows)]))if(old[key]!==value.rows[key])changes.push({table,key,before:old[key]??null,after:value.rows[key]??null});
  }
  for(const [file,sha]of Object.entries(before.files))assert.equal(next.files[file],sha,'ORIGINAL_FILE:'+file);
  events.push({label,at:new Date().toISOString(),changes});previous=next;await save(path.join(dir,'events.json'),events);return next;
 }
 async function call(route,{account,method='GET',body,status=200,code,raw}={}){
  const response=await fetch(config.publicBaseUrl+'/api'+route,{method,headers:{...(account?{Authorization:'Bearer '+account.token}:{}),...(body!==undefined||raw!==undefined?{'Content-Type':'application/json'}:{})},...(raw!==undefined?{body:raw}:body!==undefined?{body:JSON.stringify(body)}:{})});
  const value=await response.json();requests.push({route,method,status:response.status,code:value.error?.code??null,expectedStatus:status});await save(path.join(dir,'http.json'),requests);
  assert.equal(response.status,status,method+' '+route+':'+JSON.stringify(value));if(code)assert.equal(value.error.code,code);return value.data??value.error;
 }
 async function create(form,account=accounts[0]){const d=await call('/diaries',{account,method:'POST',body:form,status:201});registered.diaries.push({id:d.id,userId:account.id});await record('create diary '+d.id);return d;}
 async function remove(d,account=accounts[0]){assert.ok(registered.diaries.some(x=>x.id===d.id&&x.userId===account.id));const rows=await sql('SELECT * FROM diaries WHERE id=? AND user_id=?',[d.id,account.id]);registered.deleted.push({id:d.id,userId:account.id,beforeSha256:hash(rows),reason:'P6 explicit test cleanup'});await call('/diaries/'+d.id,{account,method:'DELETE'});await record('delete diary '+d.id);}
 async function independentStats(account,month,clock){
  const asOf=shanghaiDate(clock??new Date()),first=new Date(asOf+'T00:00:00Z');first.setUTCDate(first.getUTCDate()-29);const from=first.toISOString().slice(0,10);
  const clothes=await sql('SELECT id,name,category_id FROM clothes WHERE user_id=? AND is_archived=0 ORDER BY id',[account.id]);
  const diaries=await sql('SELECT id,wear_date FROM diaries WHERE user_id=?',[account.id]),items=await sql('SELECT i.diary_id,i.clothing_id FROM diary_items i JOIN diaries d ON d.id=i.diary_id WHERE d.user_id=?',[account.id]),categories=await sql('SELECT id,name FROM categories ORDER BY sort_order');
  const rows=clothes.map(c=>{const dates=items.filter(i=>i.clothing_id===c.id).map(i=>diaries.find(d=>d.id===i.diary_id).wear_date).filter(d=>d<=asOf).sort();return {id:c.id,name:c.name,wearCount:dates.length,lastWornDate:dates.at(-1)??null,recent:dates.some(d=>d>=from)};});
  const get=clock?createStatisticsService(db,()=>clock).get(account.id,{month,page:1,pageSize:12}):call('/statistics?month='+month,{account});const value=await get;
  assert.equal(value.asOf,asOf);assert.equal(value.activeClothesCount,clothes.length);assert.equal(value.monthDiaryDays,diaries.filter(d=>d.wear_date.startsWith(month)).length);
  assert.deepEqual(value.categoryDistribution,categories.map(k=>({...k,count:clothes.filter(c=>c.category_id===k.id).length})));
  assert.deepEqual(value.mostWorn,rows.filter(r=>r.wearCount>0).sort((a,b)=>b.wearCount-a.wearCount||a.id-b.id).slice(0,5).map(({recent,...r})=>r));
  const unworn=rows.filter(r=>!r.recent).map(({id,name,lastWornDate})=>({id,name,lastWornDate}));assert.equal(value.notWornRecently.total,unworn.length);assert.deepEqual(value.notWornRecently.items,unworn.slice(0,12));
  checks.push({type:'independent JS from SQL rows',userId:account.id,month,asOf,active:clothes.length,days:value.monthDiaryDays,top:value.mostWorn,unworn});await save(path.join(dir,'statistics-sql.json'),checks);return value;
 }
 try{
  runtime=await start(config);
  for(const suffix of ['a','b','empty']){
   const credentials={username:'p6_'+runId.slice(-8)+'_'+suffix,password:randomBytes(20).toString('base64url'),nickname:'P6验收'+suffix};
   const user=await call('/auth/register',{method:'POST',body:credentials,status:201});registered.users.push(user.id);await record('register '+user.id);
   const login=await call('/auth/login',{method:'POST',body:{username:credentials.username,password:credentials.password}});
   accounts.push({id:user.id,token:login.token,credentials});await save(path.join(privateDir,runId+'.json'),accounts.map(({id,credentials})=>({id,...credentials})));await record('login '+user.id);
  }
  const [a,b,empty]=accounts;
  await independentStats(empty,'2026-11');
  for(const account of [a,b]){
   const bytes=await sharp({create:{width:24,height:24,channels:3,background:'#A34F69'}}).png().toBuffer(),form=new FormData();form.set('file',new Blob([bytes],{type:'image/png'}),'p6.png');
   const response=await fetch(config.publicBaseUrl+'/api/uploads',{method:'POST',headers:{Authorization:'Bearer '+account.token},body:form});assert.equal(response.status,201);account.photo=(await response.json()).data.imagePath;registered.images.push({userId:account.id,path:account.photo,sha256:createHash('sha256').update(bytes).digest('hex')});await record('upload '+account.id);
   account.clothes=[];
   for(let i=0;i<(account===a?21:1);i++){const item=await call('/clothes',{account,method:'POST',status:201,body:{name:'P6单品'+i,categoryId:'tops',imagePath:account.photo,color:'白',season:'四季',note:''}});account.clothes.push(item.id);registered.clothes.push({id:item.id,userId:account.id});await record('clothing '+item.id);}
  }
  const today=shanghaiDate(new Date()),ids=a.clothes.slice(0,20),form={wearDate:today,sourceOutfitId:null,clothingIds:ids,occasion:'衣'.repeat(20),mood:'😀'.repeat(12),photoPath:a.photo,note:'😀'.repeat(1000)};
  const outfit=await call('/outfits',{account:a,method:'POST',status:201,body:{name:'P6来源',occasion:'通勤',note:'',clothingIds:ids.slice(0,3)}});registered.outfits.push({id:outfit.id,userId:a.id});await record('source outfit');form.sourceOutfitId=outfit.id;
  for(const route of ['/diaries','/diaries/by-date','/diaries/1','/statistics'])await call(route,{method:'POST',raw:'{',status:401,code:'UNAUTHENTICATED'});
  for(const route of ['/diaries?month=2026-11&month=2026-12','/diaries?month[x]=x','/diaries?month=2026-02&extra=x','/diaries/by-date?date=2026-02-29','/diaries/4294967296','/statistics?month=2026-11&asOf=2026-11-06','/statistics?month=2026-11&notWornPageSize=51'])await call(route,{account:a,status:400,code:'INVALID_INPUT'});
  for(const month of ['1000-01','9999-12','2024-02'])await call('/diaries?month='+month,{account:a});
  const d=await create(form);assert.deepEqual(d.items.map(i=>i.id),ids);assert.equal(d.note,form.note);assert.match(d.createdAt,/Z$/);
  const month=today.slice(0,7),list=await call('/diaries?month='+month,{account:a});assert.equal(list.items[0].previewItems.length,3);assert.equal(list.items[0].clothingCount,20);
  assert.equal((await call('/diaries/by-date?date='+today,{account:a})).diary.id,d.id);
  assert.equal((await call('/diaries/by-date?date=9999-12-31',{account:a})).diary,null);
  await call('/diaries/'+d.id,{account:b,status:404,code:'NOT_FOUND'});
  for(const [patch,code]of [[{clothingIds:[]},'INVALID_SELECTION'],[{clothingIds:[ids[0],ids[0]]},'INVALID_SELECTION'],[{clothingIds:a.clothes},'INVALID_SELECTION'],[{clothingIds:b.clothes},'INVALID_SELECTION'],[{sourceOutfitId:4294967295},'NOT_FOUND'],[{photoPath:b.photo},'INVALID_IMAGE_REF'],[{photoPath:'https://example.com/a.png'},'INVALID_IMAGE_REF'],[{photoPath:'wxfile://tmp/a.png'},'INVALID_IMAGE_REF'],[{photoPath:a.photo.replace(/[^/]+$/,'00000000-0000-0000-0000-000000000000.png')},'INVALID_IMAGE_REF'],[{wearDate:'9999-12-31'},'INVALID_INPUT']])await call('/diaries',{account:a,method:'POST',body:{...form,...patch},status:code==='NOT_FOUND'?404:400,code});
  const conflict=await call('/diaries',{account:a,method:'POST',body:form,status:409,code:'DATE_OCCUPIED'});assert.deepEqual(conflict.details,{wearDate:today,existingDiaryId:d.id});
  const other=await create({...form,sourceOutfitId:null,photoPath:b.photo,clothingIds:b.clothes},b);
  await call('/diaries/'+d.id,{account:b,method:'PUT',body:{...form,sourceOutfitId:null,photoPath:b.photo,clothingIds:b.clothes},status:404});
  await call('/diaries/'+d.id,{account:b,method:'DELETE',status:404});
  await independentStats(a,month);
  await call('/outfits/'+outfit.id,{account:a,method:'PUT',body:{name:'P6来源已改',occasion:'休闲',note:'',clothingIds:[ids[19]]}});await record('change source independent');
  assert.deepEqual((await call('/diaries/'+d.id,{account:a})).items.map(i=>i.id),ids);
  const edited={...form,clothingIds:[ids[1],ids[0]],note:'',mood:null,photoPath:null};await call('/diaries/'+d.id,{account:a,method:'PUT',body:edited});await record('full update with null/empty');
  await independentStats(a,month);
  const raceForm={...edited,wearDate:'2026-10-09'};
  const race=await Promise.all([1,2].map(async()=>{const response=await fetch(config.publicBaseUrl+'/api/diaries',{method:'POST',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},body:JSON.stringify(raceForm)});return {status:response.status,value:await response.json()};}));
  assert.deepEqual(race.map(r=>r.status).sort(),[201,409]);const raced=race.find(r=>r.status===201).value.data;registered.diaries.push({id:raced.id,userId:a.id});assert.equal(race.find(r=>r.status===409).value.error.details.existingDiaryId,raced.id);await save(path.join(dir,'competition.json'),race);await record('real simultaneous HTTP race');
  await call('/diaries/'+d.id,{account:a,method:'PUT',body:raceForm,status:409,code:'DATE_OCCUPIED'});
  const rollback=[];
  for(const operation of ['create','update','remove']){
   const baseline=await snapshot(db,config.uploadRoot),point=operation==='create'?'item-inserted':operation==='update'?'updated':'deleted';let triggered=false,same;
   const wrapped={async getConnection(){const c=await db.getConnection();return {beginTransaction:()=>c.beginTransaction(),execute:(...v)=>c.execute(...v),commit:()=>c.commit(),release:()=>c.release(),async rollback(){await c.rollback();const [rows]=await c.execute('SELECT * FROM diaries WHERE user_id=? ORDER BY id',[a.id]);const [items]=await c.execute('SELECT i.* FROM diary_items i JOIN diaries d ON d.id=i.diary_id WHERE d.user_id=? ORDER BY i.diary_id,i.sort_order',[a.id]);same={connectionId:c.threadId,rowsSha256:hash(rows),itemsSha256:hash(items)};}};}};
   const service=createDiaryService(wrapped,config,()=>new Date(),async(event,c,id)=>{if(event===point){triggered=true;const [during]=await c.execute('SELECT COUNT(*) count FROM diaries WHERE id=?',[id]);rollback.push({operation,point,id,duringCount:Number(during[0].count)});throw Object.assign(new Error('P6_CONTROLLED_FAILURE'),{code:'P6_CONTROLLED_FAILURE'});}});
   await assert.rejects(()=>operation==='create'?service.create(a.id,{...edited,wearDate:'2026-10-10'}):operation==='update'?service.update(a.id,d.id,{...edited,wearDate:'2026-10-10'}):service.remove(a.id,d.id),e=>e.code==='P6_CONTROLLED_FAILURE');assert.equal(triggered,true);
   const fresh=createDatabase(config);try{const c=await fresh.getConnection();try{const [rows]=await c.execute('SELECT * FROM diaries WHERE user_id=? ORDER BY id',[a.id]);const [items]=await c.execute('SELECT i.* FROM diary_items i JOIN diaries d ON d.id=i.diary_id WHERE d.user_id=? ORDER BY i.diary_id,i.sort_order',[a.id]);assert.notEqual(c.threadId,same.connectionId);assert.equal(hash(rows),same.rowsSha256);assert.equal(hash(items),same.itemsSha256);rollback.at(-1).sameConnectionId=same.connectionId;rollback.at(-1).freshConnectionId=c.threadId;}finally{c.release();}}finally{await fresh.end();}
   assert.deepEqual((await snapshot(db,config.uploadRoot)).tables,baseline.tables);
  }
  await save(path.join(dir,'rollback.json'),rollback);
  const clock=new Date('2026-11-06T04:00:00Z');
  const boundaryA=await create({...edited,wearDate:'2026-10-07',sourceOutfitId:null,clothingIds:[ids[0]]});
  const boundaryB=await create({...edited,wearDate:'2026-10-08',sourceOutfitId:null,clothingIds:[ids[1]]});
  await independentStats(a,'2026-11',clock);await independentStats(a,'2026-10',clock);
  const fixture=await create({...edited,wearDate:'2026-11-06',clothingIds:ids.slice(0,7)});await independentStats(a,'2026-11',clock);
  await call('/diaries/'+fixture.id,{account:a,method:'PUT',body:{...edited,wearDate:'2026-10-11',clothingIds:[ids[1]]}});await record('move month and remove A');await independentStats(a,'2026-11',clock);await independentStats(a,'2026-10',clock);
  await remove(fixture);await independentStats(a,'2026-11',clock);
  await call('/clothes/'+ids[1]+'/archive',{account:a,method:'PATCH',body:{isArchived:true}});await record('archive ranked item');await independentStats(a,'2026-11',clock);
  await create({...edited,wearDate:'2026-10-12',clothingIds:[ids[1]]});
  await call('/clothes/'+ids[1]+'/archive',{account:a,method:'PATCH',body:{isArchived:false}});await record('restore ranked item');await independentStats(a,'2026-11',clock);
  const page=await call('/statistics?month='+month+'&notWornPage=2',{account:a});assert.equal(page.notWornRecently.page,2);await call('/statistics?month='+month+'&notWornPage=99',{account:a}).then(v=>assert.deepEqual(v.notWornRecently.items,[]));
  await independentStats(a,month);await independentStats(b,month);
  const photoDiary=await create({...edited,wearDate:'2026-10-13',photoPath:a.photo});
  const persist=await call('/diaries/'+photoDiary.id,{account:a}),stats=await call('/statistics?month='+month,{account:a});
  const bytes=await fetch(config.publicBaseUrl+'/api/media/'+a.photo.split('/').at(-1),{headers:{Authorization:'Bearer '+a.token}}).then(r=>r.arrayBuffer());
  await runtime.close();runtime=null;
  const pids=[];
  for(let n=0;n<2;n++){
   const child=spawn(process.execPath,['--env-file-if-exists=.env','src/index.js'],{cwd:serverRoot,env:{...process.env,PORT:'3016',PUBLIC_BASE_URL:config.publicBaseUrl},windowsHide:true,stdio:['ignore','pipe','pipe']});pids.push(child.pid);
   try{await new Promise((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(Error('RESTART_TIMEOUT')),15000);child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('http-listening')){clearTimeout(timeout);resolve();}});child.once('exit',()=>{clearTimeout(timeout);reject(Error('RESTART_CHILD_EXIT'));});});assert.deepEqual(await call('/diaries/'+photoDiary.id,{account:a}),persist);assert.deepEqual(await call('/statistics?month='+month,{account:a}),stats);const afterBytes=await fetch(config.publicBaseUrl+'/api/media/'+a.photo.split('/').at(-1),{headers:{Authorization:'Bearer '+a.token}}).then(r=>r.arrayBuffer());assert.equal(Buffer.compare(Buffer.from(bytes),Buffer.from(afterBytes)),0);}finally{child.kill();await once(child,'exit');}
  }
  assert.notEqual(pids[0],pids[1]);await save(path.join(dir,'restart.json'),{pids,differentPids:true,diaryId:photoDiary.id,detailAndOrderAndStatisticsAndPhotoBytesEqual:true});
  runtime=await start(config);
  await remove(raced);await call('/diaries/'+raced.id,{account:a,method:'DELETE',status:404});
  await remove(other,b);
  await save(path.join(dir,'fixture-map.json'),{accounts:accounts.map(a=>({id:a.id,username:a.credentials.username})),registered,mainDiaryId:d.id,photoDiaryId:photoDiary.id,outfitId:outfit.id,boundaryDiaryIds:[boundaryA.id,boundaryB.id]});
 }finally{
  if(runtime){for(const a of accounts)await call('/auth/logout',{account:a,method:'POST'});await runtime.close();}
  else for(const a of accounts){const {createAccountService}=await import('../src/services/account.js');await createAccountService(db,config).logout({userId:a.id,tokenHash:createHash('sha256').update(a.token).digest('hex')});}
  const final=await record('final logout and protection');await save(path.join(dir,'final-snapshot.json'),final);await save(path.join(dir,'registry.json'),registered);await db.end();
 }
 await save(path.join(dir,'results.json'),{passed:true,stage6Complete:false,requests:requests.length,checks:checks.length,accounts:accounts.map(a=>a.id),originalRowsAndFilesUnchanged:true,allAccountsLoggedOut:true,pending:['native UI and screenshot acceptance','remaining parameter/client checks','final dual review and publication']});
 console.log(JSON.stringify({runId,passed:true,http:requests.length,statisticsChecks:checks.length}));
}
if(import.meta.main){if(process.argv.length===2||process.argv[2]==='--help')console.log('写入/删除登记的新日记：--run <唯一runId>，自有3016端口，凭据仅server/.p6-private/，不操作原生工具。');else{assert.equal(process.argv.length,4);assert.equal(process.argv[2],'--run');await integrate(process.argv[3]);}}
