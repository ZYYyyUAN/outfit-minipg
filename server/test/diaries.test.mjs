import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {dateInput,monthInput,monthRange,shanghaiDate,diaryInput} from '../src/utils/diary-input.js';
import {dateConflict} from '../src/services/diaries.js';
import {createApp} from '../src/app.js';
import {unauthenticated} from '../src/utils/business-error.js';
import {clientHarness} from './client-harness.mjs';

const form={wearDate:'2026-11-06',sourceOutfitId:null,clothingIds:[8,3],occasion:' 上班 ',mood:null,photoPath:null,note:''};
for(const value of ['1000-01-01','2000-02-29','2024-02-29','9999-12-31'])test('real date '+value,()=>assert.equal(dateInput(value),value));
for(const value of ['0999-12-31','0000-01-01','2026-02-29','1900-02-29','2026-04-31','2026-00-01','2026-13-01','2026-1-01','2026-01-00',null,[],{}])test('invalid date '+JSON.stringify(value),()=>assert.throws(()=>dateInput(value),e=>e.code==='INVALID_INPUT'));
test('month upper bound and Shanghai midnight',()=>{assert.equal(monthInput('9999-12'),'9999-12');assert.deepEqual(monthRange('9999-12'),{start:'9999-12-01',end:'9999-12-31',operator:'<='});assert.equal(monthRange('2024-02').end,'2024-03-01');assert.equal(shanghaiDate(new Date('2026-11-05T16:00:00Z')),'2026-11-06');assert.equal(shanghaiDate(new Date('2026-11-05T15:59:59.999Z')),'2026-11-05');});
test('complete diary form preserves ordered independent IDs and Unicode',()=>{const value=diaryInput({...form,occasion:'衣'.repeat(20),mood:'😀'.repeat(12),note:'😀'.repeat(1000)});assert.equal(value.note.length,2000);assert.deepEqual(value.clothingIds,[8,3]);assert.notEqual(value.clothingIds,form.clothingIds);});
for(const patch of [{occasion:'x'.repeat(21)},{mood:''},{mood:'x'.repeat(13)},{note:'😀'.repeat(1001)},{sourceOutfitId:'1'},{sourceOutfitId:0},{photoPath:{}},{clothingIds:[1.5]},{clothingIds:[4294967296]},{clothingIds:[]},{clothingIds:[1,1]},{clothingIds:Array.from({length:21},(_,i)=>i+1)},{extra:1}])test('reject diary '+JSON.stringify(patch).slice(0,70),()=>assert.throws(()=>diaryInput({...form,...patch}),e=>['INVALID_INPUT','INVALID_SELECTION'].includes(e.code)));
test('only named diary unique key maps date conflict',()=>{assert.equal(dateConflict({code:'ER_DUP_ENTRY',errno:1062,sqlMessage:"Duplicate entry '1' for key 'diaries.uq_diaries_user_date'"}),true);for(const e of [{code:'ER_DUP_ENTRY',errno:1062,sqlMessage:"for key 'uq_diary_items_order'"},{code:'ER_DUP_ENTRY',errno:1062,sqlMessage:"for key 'other.uq_diaries_user_date'"},{code:'OTHER',errno:1062,sqlMessage:"for key 'uq_diaries_user_date'"}])assert.equal(dateConflict(e),false);});
test('assembled D/S routes auth before parsing, boundaries and 8KiB valid maximum',async t=>{
 const seen=[],account={authenticate:async token=>{if(token!=='a'.repeat(43))throw unauthenticated();return {userId:91};}},diaries={};
 for(const key of ['list','byDate','detail','create','update','remove'])diaries[key]=async(...args)=>{seen.push([key,...args]);return key==='byDate'?null:{id:7};};
 const server=createServer(createApp(account,null,null,null,diaries,{get:async(...args)=>{seen.push(['statistics',...args]);return {asOf:'2026-11-06'};}}));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url='http://127.0.0.1:'+server.address().port+'/api';
 async function call(route,method='GET',body,auth=true){const r=await fetch(url+route,{method,headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+'a'.repeat(43)}:{})},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});return {status:r.status,value:await r.json()};}
 for(const route of ['/diaries','/diaries/by-date','/diaries/1','/statistics'])assert.equal((await call(route,'POST','{',false)).status,401);
 assert.equal((await call('/diaries?month=9999-12')).status,200);assert.equal((await call('/diaries/by-date?date=2024-02-29')).value.data.diary,null);
 const large={...form,clothingIds:Array.from({length:20},(_,i)=>i+1),note:'😀'.repeat(1000)};assert.ok(Buffer.byteLength(JSON.stringify(large))<8192);assert.equal((await call('/diaries','POST',large)).status,201);
 assert.equal((await call('/diaries/7','PUT',form)).status,200);assert.equal((await call('/diaries/7','DELETE')).status,200);
 for(const route of ['/diaries?month=2026-11&month=2026-12','/diaries?month[x]=a','/diaries?month=2026-00','/diaries?month=2026-11&asOf=2026-11-06','/diaries/0','/diaries/4294967296','/diaries/by-date?date=2026-02-29','/statistics?month=2026-11&asOf=2026-11-06','/statistics?month=2026-11&notWornPageSize=51'])assert.equal((await call(route)).status,400,route);
 assert.equal((await call('/statistics?month=2026-11')).status,200);assert.equal((await call('/unknown')).status,404);
 assert.ok(seen.every(x=>x[1]===91));
});
test('four native pages register existing handlers and authenticated images',()=>{
 const h=clientHarness(()=>{}),root=path.resolve(import.meta.dirname,'../../miniprogram');
 for(const route of ['pages/diary/index','pages/diary/detail/index','pages/diary/edit/index','pages/statistics/index']){
  const p=h.load(route+'.js'),w=fs.readFileSync(path.join(root,route+'.wxml'),'utf8');
  for(const m of w.matchAll(/(?:bind(?:tap|input|change|error)|catchtap)="(\w+)"/g))assert.equal(typeof p[m[1]],'function',route+':'+m[1]);
  assert.doesNotMatch(w,/src="\{\{[^}]*imageUrl/);
 }
});
test('D/S GET reject unknown body and public asOf after authentication',async t=>{
 let invoked=0;const account={authenticate:async()=>({userId:1})},service={list:async()=>{invoked++;},byDate:async()=>{invoked++;},detail:async()=>{invoked++;}},statistics={get:async()=>{invoked++;}};
 const server=createServer(createApp(account,null,null,null,service,statistics));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 for(const route of ['/diaries?month=2026-11','/diaries/by-date?date=2026-11-06','/diaries/1','/statistics?month=2026-11']){
  const body=JSON.stringify({asOf:'2000-01-01',extra:1});
  const result=await new Promise((resolve,reject)=>{const req=httpRequest({host:'127.0.0.1',port:server.address().port,path:'/api'+route,method:'GET',headers:{Authorization:'Bearer '+'a'.repeat(43),'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{let data='';res.on('data',v=>data+=v);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));});req.on('error',reject);req.end(body);});
  assert.equal(result.status,400,route);assert.equal(result.body.error.code,'INVALID_INPUT');
 }
 assert.equal(invoked,0);
});
