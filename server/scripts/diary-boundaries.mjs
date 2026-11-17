import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readConfig,serverRoot} from '../src/config.js';
import {createDatabase} from '../src/db.js';
import {start} from '../src/index.js';
import {snapshot} from './verify-diaries.mjs';
import {createDiaryService} from '../src/services/diaries.js';
import {createStatisticsService} from '../src/services/statistics.js';

export async function verify(runId){
 assert.match(runId,/^[a-z0-9][a-z0-9_-]{0,79}$/);const root=path.dirname(serverRoot),dir=path.join(root,'docs/evidence/P6',runId);await fs.mkdir(dir);
 const config={...readConfig(),port:3016,publicBaseUrl:'http://127.0.0.1:3016'},db=createDatabase(config),before=await snapshot(db,config.uploadRoot);let prior=before;
 const events=[],http=[],registry={users:[],clothes:[],outfits:[],diaries:[],images:[],deleted:[]},accounts=[];
 await fs.writeFile(path.join(dir,'baseline.json'),JSON.stringify(before,null,2));
 const write=(file,v)=>fs.writeFile(path.join(dir,file),JSON.stringify(v,null,2)+'\n');
 async function record(label){const after=await snapshot(db,config.uploadRoot),changes=[];for(const [t,value]of Object.entries(after.tables))for(const key of new Set([...Object.keys(prior.tables[t].rows),...Object.keys(value.rows)]))if(prior.tables[t].rows[key]!==value.rows[key])changes.push({table:t,key,before:prior.tables[t].rows[key]??null,after:value.rows[key]??null});events.push({label,changes});prior=after;await write('events.json',events);await write('registry.json',registry);}
 const runtime=await start(config);
 async function call(route,{account=accounts[0],method='GET',body,status=200,code,raw}={}){const r=await fetch(config.publicBaseUrl+'/api'+route,{method,headers:{...(account?{Authorization:'Bearer '+account.token}:{}),...(body!==undefined||raw!==undefined?{'Content-Type':'application/json'}:{})},...(raw!==undefined?{body:raw}:body!==undefined?{body:JSON.stringify(body)}:{})});const v=await r.json();http.push({route,method,actual:r.status,expected:status,code:v.error?.code??null});await write('http.json',http);assert.equal(r.status,status,method+route);if(code)assert.equal(v.error.code,code);return v.data??v.error;}
 try{
  for(const suffix of ['a','b']){const credentials={username:'p6_'+randomBytes(4).toString('hex')+'_'+suffix,password:randomBytes(20).toString('base64url'),nickname:'P6边界'+suffix};const user=await call('/auth/register',{account:null,method:'POST',body:credentials,status:201});registry.users.push(user.id);await record('register');const login=await call('/auth/login',{account:null,method:'POST',body:{username:credentials.username,password:credentials.password}});accounts.push({id:user.id,token:login.token});await record('login');}
  const [a,b]=accounts,fixture=JSON.parse(await fs.readFile(path.join(root,'docs/evidence/P6/run-20261117-integration3/fixture-map.json'))),foreign=fixture.registered.clothes[0].id,photo=fixture.registered.images[0].path;
  const form={wearDate:'2026-11-06',sourceOutfitId:null,clothingIds:[foreign],occasion:'日常',mood:null,photoPath:null,note:''};
  for(const route of ['/diaries','/diaries/by-date?date=2026-11-06','/diaries/1','/statistics?month=2026-11'])for(const method of ['GET','POST'])await call(route,{account:{token:'z'.repeat(43)},method,...(method==='POST'?{raw:'{'}:{}),status:401,code:'UNAUTHENTICATED'});
  for(const month of ['0999-12','10000-01','2026-00','2026-13','2026-1','2026-02-01','', '2026-11&month=2026-10','2026-11&unknown=1'])await call('/diaries?month='+month,{status:400,code:'INVALID_INPUT'});
  for(const date of ['2026-02-29','1900-02-29','2026-04-31','0999-12-31','10000-01-01','2026-01-00','2026-01-32','2026-13-01'])await call('/diaries/by-date?date='+date,{status:400,code:'INVALID_INPUT'});
  for(const date of ['1000-01-01','2000-02-29','2024-02-29','9999-12-31'])assert.equal((await call('/diaries/by-date?date='+date)).diary,null);
  for(const id of ['0','-1','1.5','1e2','4294967296','abc'])for(const method of ['GET','PUT','DELETE'])await call('/diaries/'+id,{method,...(method==='PUT'?{body:form}:{}),status:400,code:'INVALID_INPUT'});
  for(const body of [null,[],{}, {...form,extra:1},{...form,occasion:'x'.repeat(21)},{...form,occasion:'a\nb'},{...form,mood:''},{...form,mood:'x'.repeat(13)},{...form,note:'😀'.repeat(1001)},{...form,sourceOutfitId:'1'},{...form,sourceOutfitId:-1},{...form,photoPath:1},{...form,clothingIds:[0]},{...form,clothingIds:[1.5]},{...form,clothingIds:[4294967296]}])await call('/diaries',{method:'POST',body,status:400,code:'INVALID_INPUT'});
  for(const body of [{...form,clothingIds:[]},{...form,clothingIds:[foreign,foreign]},{...form,clothingIds:Array.from({length:21},(_,i)=>i+1)},{...form,clothingIds:[foreign]}])await call('/diaries',{method:'POST',body,status:400,code:'INVALID_SELECTION'});
  await call('/diaries',{method:'POST',raw:'{',status:400,code:'INVALID_INPUT'});await call('/diaries',{method:'POST',raw:JSON.stringify({note:'x'.repeat(9000)}),status:413,code:'INVALID_INPUT'});
  for(const query of ['notWornPage=0','notWornPage=1.5','notWornPageSize=0','notWornPageSize=51','notWornPage=9007199254740991&notWornPageSize=50','notWornPage=1&notWornPage=2','notWornPage[x]=1','unknown=1'])await call('/statistics?month=2026-11&'+query,{status:400,code:'INVALID_INPUT'});
  for(const route of ['/clothes?archived=all','/clothes/facets?archived=all','/outfits?archived=all','/outfits/facets?archived=all','/categories','/statistics?month=9999-12'])await call(route);
  await call('/diaries/4294967295',{method:'DELETE',body:{anything:true},status:400,code:'INVALID_INPUT'});
  // 内部clock验证未来行口径；只写本轮账号，公共接口仍禁止未来写入。
  const c=await db.getConnection();let ownPhoto;
  try{const [rows]=await c.execute('SELECT image_path FROM clothes WHERE id=?',[foreign]);ownPhoto=rows[0].image_path;}finally{c.release();}
  await call('/diaries',{method:'POST',body:{...form,photoPath:photo},status:400,code:'INVALID_SELECTION'});
  // A/C/O完整回归由现有单测和真实主流程覆盖；这里用空账号确认零态和跨归属。
  const uploadForm=new FormData(),bytes=await fs.readFile(path.join(root,'assets/clothes/clothing-001.jpg'));uploadForm.set('file',new Blob([bytes],{type:'image/jpeg'}),'p6-boundary.jpg');
  const uploaded=await fetch(config.publicBaseUrl+'/api/uploads',{method:'POST',headers:{Authorization:'Bearer '+a.token},body:uploadForm});assert.equal(uploaded.status,201);const image=(await uploaded.json()).data;registry.images.push({userId:a.id,path:image.imagePath,sha256:(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')});await record('own JPEG upload');
  const ids=[];
  for(let n=0;n<8;n++){const item=await call('/clothes',{method:'POST',status:201,body:{name:'P6受控'+n,categoryId:'tops',color:'白',season:'四季',note:'',imagePath:image.imagePath}});ids.push(item.id);registry.clothes.push({id:item.id,userId:a.id});await record('controlled clothing');}
  const valid={...form,clothingIds:[ids[0]]},fixed=createStatisticsService(db,()=>new Date('2026-11-06T04:00:00Z'));
  async function stats(month='2026-11'){return fixed.get(a.id,{month,page:1,pageSize:50});}
  async function create(input,service){const d=service?await service.create(a.id,input):await call('/diaries',{method:'POST',body:input,status:201});registry.diaries.push({id:d.id,userId:a.id});await record('controlled diary create');return d;}
  async function remove(d){registry.deleted.push({id:d.id,userId:a.id,beforeSha256:prior.tables.diaries.rows[d.id],reason:'P6 controlled test cleanup'});await call('/diaries/'+d.id,{method:'DELETE'});await record('controlled diary delete');}
  const da=await create({...valid,wearDate:'2026-10-07'}),dbb=await create({...valid,wearDate:'2026-10-08',clothingIds:[ids[1]]});
  let value=await stats();assert.equal(value.monthDiaryDays,0);assert.ok(value.notWornRecently.items.some(i=>i.id===ids[0]));assert.ok(value.notWornRecently.items.some(i=>i.id===ids[2]));assert.ok(!value.notWornRecently.items.some(i=>i.id===ids[1]));
  const added=await create({...valid,wearDate:'2026-11-06',clothingIds:[ids[0],ids[1]]});value=await stats();assert.equal(value.monthDiaryDays,1);assert.deepEqual(value.mostWorn.map(i=>[i.id,i.wearCount]),[[ids[0],2],[ids[1],2]]);
  await call('/diaries/'+added.id,{method:'PUT',body:{...valid,wearDate:'2026-10-09',clothingIds:[ids[1]]}});await record('controlled move month remove A');value=await stats();assert.equal(value.monthDiaryDays,0);assert.equal((await stats('2026-10')).monthDiaryDays,3);assert.equal(value.mostWorn.find(i=>i.id===ids[0]).lastWornDate,'2026-10-07');assert.equal(value.mostWorn.find(i=>i.id===ids[1]).lastWornDate,'2026-10-09');await remove(added);assert.equal((await stats('2026-10')).monthDiaryDays,2);
  const tie=await create({...valid,wearDate:'2026-11-06',clothingIds:ids.slice(2)});value=await stats();assert.deepEqual(value.mostWorn.map(i=>i.id),ids.slice(0,5));
  await call('/clothes/'+ids[0]+'/archive',{method:'PATCH',body:{isArchived:true}});await record('controlled archive');assert.deepEqual((await stats()).mostWorn.map(i=>i.id),ids.slice(1,6));
  const archived=await create({...valid,wearDate:'2026-10-10'});await call('/clothes/'+ids[0]+'/archive',{method:'PATCH',body:{isArchived:false}});await record('controlled restore');assert.equal((await stats()).mostWorn[0].id,ids[0]);
  const future=await create({...valid,wearDate:'2099-01-01'},createDiaryService(db,config,()=>new Date('2099-01-01T04:00:00Z')));const current=await call('/statistics?month=2099-01');assert.equal(current.monthDiaryDays,1);assert.equal(current.mostWorn.find(i=>i.id===ids[0]).wearCount,2);assert.equal((await stats()).mostWorn.find(i=>i.id===ids[0]).wearCount,2);
  await write('controlled-statistics.json',{passed:true,boundary:'2026-10-07 excluded, 10-08 included in recent window',clothes:ids,diaries:[da.id,dbb.id,added.id,tie.id,archived.id,future.id],tieMoreThanFive:true,archiveRestore:true,createMoveRemoveDelete:true,futureExcludedFromCumulativeButMonthCounted:true});
  for(const d of [future,tie,archived,da,dbb])await remove(d);
  const todayService=createDiaryService(db,config,()=>new Date('2026-11-05T15:59:59.999Z'));
  await assert.rejects(()=>todayService.create(a.id,form),e=>e.code==='INVALID_INPUT'&&Boolean(e.fields.wearDate));
  await call('/diaries/'+fixture.mainDiaryId,{account:a,status:404,code:'NOT_FOUND'});
  await call('/outfits/'+fixture.outfitId,{account:a,status:404,code:'NOT_FOUND'});
  await call('/clothes/'+foreign,{account:a,status:404,code:'NOT_FOUND'});
  await call('/media/'+ownPhoto.split('/').at(-1),{account:b,status:404,code:'NOT_FOUND'});
  await write('results.json',{passed:true,http:http.length,midnightWriteRejection:true,originalRecordsNotTouched:true,stage6Complete:false});
 }finally{for(const account of accounts)await call('/auth/logout',{account,method:'POST'});await record('final logout');await write('final-snapshot.json',await snapshot(db,config.uploadRoot));await runtime.close();await db.end();}
 console.log(JSON.stringify({runId,passed:true,http:http.length}));
}
if(import.meta.main){if(process.argv.length===2||process.argv[2]==='--help')console.log('参数/隔离补验 --run <唯一runId>；创建两个专用空账号并退出，不写原账号。');else{assert.equal(process.argv.length,4);assert.equal(process.argv[2],'--run');await verify(process.argv[3]);}}
