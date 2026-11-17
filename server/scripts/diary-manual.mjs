import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {readConfig,serverRoot} from '../src/config.js';
import {createDatabase} from '../src/db.js';
import {createApp} from '../src/app.js';
import {createAccountService} from '../src/services/account.js';
import {createMediaService} from '../src/services/media.js';
import {createClothesService} from '../src/services/clothes.js';
import {createOutfitService} from '../src/services/outfits.js';
import {createDiaryService} from '../src/services/diaries.js';
import {createStatisticsService} from '../src/services/statistics.js';
import {unauthenticated} from '../src/utils/business-error.js';
import {snapshot} from './verify-diaries.mjs';

export async function prepare(runId){
 assert.match(runId,/^[a-z0-9][a-z0-9_-]{0,79}$/);const root=path.dirname(serverRoot),dir=path.join(root,'docs/evidence/P6',runId),privateDir=path.join(serverRoot,'.p6-private');await fs.mkdir(dir);await fs.mkdir(privateDir,{recursive:true});await fs.mkdir(path.join(dir,'screenshots'));
 const config={...readConfig(),port:3016,publicBaseUrl:'http://127.0.0.1:3016'},db=createDatabase(config),baseline=await snapshot(db,config.uploadRoot);let prior=baseline;
 const write=(file,v)=>fs.writeFile(path.join(dir,file),JSON.stringify(v,null,2)+'\n');await write('baseline.json',baseline);
 const credentials=['a','b'].map(s=>({username:'p6ui_'+randomBytes(4).toString('hex')+'_'+s,password:randomBytes(20).toString('base64url'),nickname:'P6原生验收'+s})),allowedNames=new Set(credentials.map(c=>c.username)),owners=new Set(),registry={users:[],clothes:[],outfits:[],diaries:[],images:[],deleted:[]},events=[],http=[];
 await fs.writeFile(path.join(privateDir,runId+'.json'),JSON.stringify({accounts:credentials},null,2)+'\n',{flag:'wx'});
 let journal=Promise.resolve();
 function record(label){journal=journal.then(async()=>{
  const next=await snapshot(db,config.uploadRoot),changes=[];
  for(const [table,value]of Object.entries(next.tables)){
   assert.equal(value.structure,baseline.tables[table].structure);
   for(const [key,sha]of Object.entries(baseline.tables[table].rows))assert.equal(value.rows[key],sha,'MANUAL_ORIGINAL_ROW:'+table+':'+key);
   for(const key of new Set([...Object.keys(prior.tables[table].rows),...Object.keys(value.rows)]))if(prior.tables[table].rows[key]!==value.rows[key]){
    const before=prior.tables[table].rows[key]??null,after=value.rows[key]??null;
    changes.push({table,key,before,after});
    if(table==='users'&&before===null){assert.ok(owners.has(Number(key)));registry.users.push(Number(key));}
    else if(['clothes','outfits','diaries'].includes(table)&&before===null){registry[table].push({id:Number(key)});}
    if(table==='diaries'&&after===null)registry.deleted.push({id:Number(key),beforeSha256:before,reason:label});
   }
  }
  for(const [file,sha]of Object.entries(baseline.files))assert.equal(next.files[file],sha,'MANUAL_ORIGINAL_FILE:'+file);
  for(const [file,sha]of Object.entries(next.files))if(!Object.hasOwn(baseline.files,file)&&!registry.images.some(i=>'server/uploads/'+i.path===file)){const imagePath=file.slice('server/uploads/'.length),userId=Number(imagePath.split('/')[1]);assert.ok(owners.has(userId));registry.images.push({path:imagePath,userId,sha256:sha,retention:'all successful files retained including cancelled drafts'});}
  events.push({label,at:new Date().toISOString(),changes});prior=next;await write('events.json',events);await write('registry.json',registry);await write('latest-snapshot.json',next);
 });return journal;}
 function instrument(service,methods){for(const name of methods){const original=service[name];service[name]=async(...args)=>{const value=await original(...args);if(name==='register')owners.add(value.id);await record(name);return value;};}return service;}
 const account=instrument(createAccountService(db,config),['register','login','logout','updateProfile']);
 const register=account.register,login=account.login,authenticate=account.authenticate;
 account.register=input=>{if(!allowedNames.has(input.username))throw unauthenticated();return register(input);};
 account.login=input=>{if(!allowedNames.has(input.username))throw unauthenticated();return login(input);};
 account.authenticate=async token=>{const auth=await authenticate(token);if(!owners.has(auth.userId))throw unauthenticated();return auth;};
 const media=instrument(createMediaService(db,config),['upload']),clothes=instrument(createClothesService(db,config),['create','update','archive']),outfits=instrument(createOutfitService(db,config),['create','update','archive']),diaries=instrument(createDiaryService(db,config),['create','update','remove']);
 const app=createApp(account,media,clothes,outfits,diaries,createStatisticsService(db));
 // HTTP只记路径/状态；不记录body、密码、Authorization或响应token。
 app.use((req,res,next)=>next());
 const server=createServer((req,res)=>{res.once('finish',()=>{http.push({at:new Date().toISOString(),method:req.method,path:req.url,status:res.statusCode});fs.writeFile(path.join(dir,'http.json'),JSON.stringify(http,null,2)+'\n');});app(req,res);});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(3016,'127.0.0.1',resolve);});
 const accounts=[];async function call(route,{method='GET',body,account}={}){const response=await fetch(config.publicBaseUrl+'/api'+route,{method,headers:{...(account?{Authorization:'Bearer '+account.token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();assert.ok(response.ok,route+':'+response.status);return value.data;}
 async function upload(account,file){const form=new FormData(),bytes=await fs.readFile(path.join(root,file));form.set('file',new Blob([bytes],{type:'image/jpeg'}),path.basename(file));const res=await fetch(config.publicBaseUrl+'/api/uploads',{method:'POST',headers:{Authorization:'Bearer '+account.token},body:form});assert.equal(res.status,201);return (await res.json()).data.imagePath;}
 let shutting=false;
 async function shutdown(){if(shutting)return;shutting=true;await journal;await new Promise(r=>server.close(r));await write('runtime-stopped.json',{pid:process.pid,at:new Date().toISOString()});await db.end();}
 process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
 try{
  for(const input of credentials){await call('/auth/register',{method:'POST',body:input});const logged=await call('/auth/login',{method:'POST',body:{username:input.username,password:input.password}});accounts.push({id:logged.user.id,token:logged.token,username:input.username});}
  const [a,b]=accounts,data=JSON.parse(await fs.readFile(path.join(root,'data/demo-data.json'))),items=[];
  for(const [index,source]of data.clothes.slice(0,20).entries()){const imagePath=await upload(a,source.imagePath),item=await call('/clothes',{account:a,method:'POST',body:{name:index===0?'用于核对长名称换行与完整单品图片安全区域的穿搭记录测试衣物'.padEnd(40,'衣'):source.name,categoryId:source.categoryId,color:source.color,season:source.season,note:source.note,imagePath}});items.push(item.id);}
  const photoPath=await upload(a,'assets/diaries/diary-004.jpg'),bImage=await upload(b,data.clothes[0].imagePath);await call('/clothes',{account:b,method:'POST',body:{name:'B账号独立衣物',categoryId:'tops',color:'粉',season:'四季',note:'',imagePath:bImage}});
  const source=await call('/outfits',{account:a,method:'POST',body:{name:'P6原生20件来源搭配',occasion:'通勤',note:'原生验收用独立来源',clothingIds:items}}),long=await call('/diaries',{account:a,method:'POST',body:{wearDate:'2026-10-31',sourceOutfitId:source.id,clothingIds:items,occasion:'长清单验收',mood:'平静',photoPath,note:'穿搭记录'.repeat(250)}}),occupied=await call('/diaries',{account:a,method:'POST',body:{wearDate:'2026-11-05',sourceOutfitId:null,clothingIds:items.slice(0,3),occasion:'日期占用验收',mood:null,photoPath:null,note:''}});
  for(const account of accounts)await call('/auth/logout',{method:'POST',account});
  await record('prepared and logged out');
  const fixture={runId,accounts:accounts.map(({id,username})=>({id,username})),sourceOutfitId:source.id,longDiaryId:long.id,occupiedDiaryId:occupied.id,clothingIds:items,photoPath,api:config.publicBaseUrl,pid:process.pid,preparedAt:new Date().toISOString(),nativeAcceptance:'pending'};await write('fixture-map.json',fixture);
  await write('runtime.json',{pid:process.pid,origin:config.publicBaseUrl,allowedAccountIds:[...owners],developerToolServicePortOpened:false,scope:'manual fixture accounts only; instrumented service calls capture row/file events; HTTP is real Express/MySQL'});
  console.log(JSON.stringify({event:'P6_MANUAL_READY',runId,pid:process.pid,accounts:fixture.accounts,sourceOutfitId:source.id,longDiaryId:long.id,occupiedDiaryId:occupied.id,privateFile:'.p6-private/'+runId+'.json'}));
 }catch(error){await shutdown();throw error;}
}
if(import.meta.main){if(process.argv.length===2||process.argv[2]==='--help')console.log('准备并保留原生验收自有3016服务：--prepare <唯一runId>。真实HTTP创建A/B、20衣物/来源/长篇/占用日期；只允许本轮账号，持续登记人工写入。凭据只写server/.p6-private，服务端口不会打开。');else{assert.equal(process.argv.length,4);assert.equal(process.argv[2],'--prepare');await prepare(process.argv[3]);}}
