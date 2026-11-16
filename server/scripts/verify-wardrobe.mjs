import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readConfig,serverRoot} from '../src/config.js';
import {start} from '../src/index.js';
import {prepareWardrobeFixtures} from './wardrobe-fixtures.mjs';

const root=path.dirname(serverRoot), evidence=path.join(root,'docs/evidence/P4');
const hash=value=>createHash('sha256').update(value).digest('hex');
const write=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n');
export async function verifyOriginals(database) {
  const baseline=JSON.parse(await fs.readFile(path.join(evidence,'baseline.json'),'utf8'));
  const connection=await database.getConnection();
  try {
    for(const [table,expected] of Object.entries(baseline.tables)) {
      const [rows]=await connection.query(`SELECT * FROM ${table}`);
      const actual=new Map(rows.map(row=>[String(row.id??`${row.outfit_id??row.diary_id}:${row.clothing_id}`),hash(JSON.stringify(row))]));
      for(const row of expected.rows) assert.equal(actual.get(String(row.key)),row.sha256,'ORIGINAL_ROW:'+table+':'+row.key);
      const [ddl]=await connection.query(`SHOW CREATE TABLE ${table}`);
      assert.equal(Object.values(ddl[0])[1].replace(/AUTO_INCREMENT=\d+ /g,''),expected.structure,'STRUCTURE:'+table);
    }
    for(const [file,expected] of Object.entries(baseline.protectedFiles)) assert.equal(hash(await fs.readFile(path.join(root,file))),expected,'PROTECTED_FILE:'+file);
    for(const [file,expected] of Object.entries(baseline.images)) assert.equal(hash(await fs.readFile(path.join(serverRoot,'uploads',file))),expected,'ORIGINAL_IMAGE:'+file);
  } finally {connection.release();}
  return {originalRowsUnchanged:true,originalFilesUnchanged:true,originalImagesUnchanged:true};
}

async function run(runId) {
  const directory=path.join(evidence,runId);await fs.mkdir(directory);
  const config={...readConfig(),port:0}, runtime=await start(config);
  config.publicBaseUrl='http://127.0.0.1:'+runtime.server.address().port;
  const accounts=[],files=[],clothes=[],checks=[];
  const save=()=>Promise.all([write(path.join(directory,'accounts.json'),{runId,accounts:accounts.map(({token,password,...publicFields})=>publicFields)}),write(path.join(directory,'files-manifest.json'),{runId,files}),write(path.join(directory,'clothes-manifest.json'),{runId,clothes}),write(path.join(directory,'http-results.json'),{runId,checks})]);
  let activeCheck='preflight';
  async function call(label,method,url,expected,account,body) {
    activeCheck=label;
    const response=await fetch(config.publicBaseUrl+'/api'+url,{method,headers:{...(account?{Authorization:'Bearer '+account.token}:{}),...(body && !(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
    const value=await response.json();
    checks.push({id:'HTTP-'+String(checks.length+1).padStart(3,'0'),label,method,path:url,expectedStatus:expected,actualStatus:response.status,passed:response.status===expected,errorCode:value.error?.code});
    assert.equal(response.status,expected,label);await save();return value.data??value.error;
  }
  try {
    await verifyOriginals(runtime.database);
    const batch=randomBytes(4).toString('hex');
    for(const role of ['a','b']) {
      const account={username:'p4_'+batch+'_'+role,password:randomBytes(20).toString('hex'),role,id:null,token:null,loggedOut:false};accounts.push(account);await save();
      const registered=await call('register '+role,'POST','/auth/register',201,null,{username:account.username,password:account.password,nickname:'P4测试'+role});account.id=registered.id;await save();
      const login=await call('login '+role,'POST','/auth/login',200,null,{username:account.username,password:account.password});account.token=login.token;await save();
      const bytes=await fs.readFile(path.join(root,'assets/clothes/clothing-001.jpg')),form=new FormData();form.append('file',new Blob([bytes],{type:'image/jpeg'}),'fixture.jpg');
      const upload=await call('own upload '+role,'POST','/uploads',201,account,form);
      files.push({userId:account.id,imagePath:upload.imagePath,mimeType:upload.mimeType,size:upload.size,sha256:hash(bytes),retained:true});account.imagePath=upload.imagePath;await save();
    }
    const [a,b]=accounts;
    await call('anonymous clothes','GET','/clothes',401);
    assert.equal((await call('new owner empty','GET','/clothes',200,a)).total,0);
    const body={name:'P4针织_%!Alpha',categoryId:'tops',imagePath:a.imagePath,color:'浅粉色',season:'春秋',note:''};
    const created=await call('create clothing','POST','/clothes',201,a,body);clothes.push({id:created.id,userId:a.id,role:'primary'});await save();
    const id=created.id;
    assert.equal(created.wearCount,0);assert.equal(created.lastWornDate,null);assert.equal(created.isArchived,false);
    await call('create same name allowed','POST','/clothes',201,a,body).then(value=>{clothes.push({id:value.id,userId:a.id,role:'duplicate-name'});});await save();
    assert.equal((await call('literal search','GET','/clothes?keyword='+encodeURIComponent('_%!alpha'),200,a)).total,2);
    assert.equal((await call('season AND exact color','GET','/clothes?season='+encodeURIComponent('秋')+'&color='+encodeURIComponent('浅粉色')+'&categoryId=tops',200,a)).total,2);
    assert.equal((await call('no partial color','GET','/clothes?color='+encodeURIComponent('粉色'),200,a)).total,0);
    assert.equal((await call('other owner empty','GET','/clothes',200,b)).total,0);
    for(const route of ['', '/outfits','/diaries']) await call('foreign read '+route,'GET','/clothes/'+id+route,404,b);
    await call('foreign edit','PUT','/clothes/'+id,404,b,{...body,imagePath:b.imagePath});
    await call('foreign archive','PATCH','/clothes/'+id+'/archive',404,b,{isArchived:true});
    await call('foreign image reference','POST','/clothes',400,b,body);
    for(const suffix of ['?page=0','?pageSize=51','?page=1e2','?page=1&page=2','?sort=id','?season='+encodeURIComponent('春秋'),'?asOf=2026-11-06']) await call('reject query '+suffix,'GET','/clothes'+suffix,400,a);
    await call('extra POST query','POST','/clothes?extra=1',400,a,body);
    await call('partial PUT rejected','PUT','/clothes/'+id,400,a,{name:'不完整'});
    for(const patch of [{name:'a'.repeat(41)},{note:null},{categoryId:'bad'},{imagePath:'wxfile://tmp.jpg'},{season:'全部'},{userId:b.id}]) await call('reject form '+Object.keys(patch)[0],'PUT','/clothes/'+id,400,a,{...body,...patch});
    const updated=await call('edit persisted','PUT','/clothes/'+id,200,a,{...body,name:'P4已编辑',note:'第一行\n第二行'});
    assert.equal(updated.note,'第一行\n第二行');assert.equal(updated.createdAt,created.createdAt);
    await call('same PUT allowed','PUT','/clothes/'+id,200,a,{...body,name:'P4已编辑',note:'第一行\n第二行'});
    const archived=await call('archive','PATCH','/clothes/'+id+'/archive',200,a,{isArchived:true});
    const repeated=await call('repeat archive','PATCH','/clothes/'+id+'/archive',200,a,{isArchived:true});assert.equal(archived.updatedAt,repeated.updatedAt);
    assert.equal((await call('active excludes archive','GET','/clothes',200,a)).total,1);
    assert.equal((await call('archive scope','GET','/clothes?archived=archived',200,a)).total,1);
    assert.equal((await call('all scope','GET','/clothes?archived=all',200,a)).total,2);
    assert.equal((await call('archived detail readable','GET','/clothes/'+id,200,a)).isArchived,true);
    await call('restore','PATCH','/clothes/'+id+'/archive',200,a,{isArchived:false});
    assert.equal((await call('own facets','GET','/clothes/facets',200,a)).colors[0],'浅粉色');
    assert.equal((await call('other facets','GET','/clothes/facets',200,b)).colors.length,0);
    for(const kind of ['outfits','diaries']) assert.equal((await call('own empty history '+kind,'GET','/clothes/'+id+'/'+kind,200,a)).total,0);
    for(const account of accounts) {
      const response=await fetch(config.publicBaseUrl+'/api/media/'+account.imagePath.split('/').at(-1),{headers:{Authorization:'Bearer '+account.token}});
      assert.equal(response.status,200);assert.equal(hash(Buffer.from(await response.arrayBuffer())),files.find(file=>file.userId===account.id).sha256);
    }
    await prepareWardrobeFixtures(runtime.database,config,b,path.join(directory,'fixture-rollback.json'),{rollbackCheck:true});
    const fixture=await prepareWardrobeFixtures(runtime.database,config,b,path.join(directory,'fixture-map.json'));
    const first=await call('fixture first page 12','GET','/clothes',200,b),second=await call('fixture second page 1','GET','/clothes?page=2',200,b);
    assert.equal(first.total,13);assert.equal(first.items.length,12);assert.equal(second.items.length,1);assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,13);
    const primary=fixture.clothes.C1;
    const history=await call('fixture outfits page one','GET','/clothes/'+primary+'/outfits?pageSize=2',200,b);
    const history2=await call('fixture outfits page two','GET','/clothes/'+primary+'/outfits?pageSize=2&page=2',200,b);
    assert.equal(history.total,3);assert.equal(history.items.length,2);assert.equal(history2.items.length,1);
    const five=history2.items[0];assert.equal(five.id,fixture.outfits.O1);assert.equal(five.clothingCount,5);assert.deepEqual(five.previewItems.map(item=>item.id),['C2','C3','C4','C5'].map(key=>fixture.clothes[key]));
    const diaryPage1=await call('fixture diary page one','GET','/clothes/'+primary+'/diaries?pageSize=2',200,b),diaryPage2=await call('fixture diary page two','GET','/clothes/'+primary+'/diaries?pageSize=2&page=2',200,b);
    assert.equal(diaryPage1.total,3);assert.equal(diaryPage1.items[1].mood,null);assert.equal(diaryPage1.items[1].photoUrl,null);
    assert.deepEqual(diaryPage2.items[0].previewItems.map(item=>item.id),['C1','C4','C3'].map(key=>fixture.clothes[key]));
    const stats=await call('fixture wear aggregate','GET','/clothes/'+primary,200,b);assert.equal(stats.wearCount,3);assert.equal(stats.lastWornDate,'2026-11-05');
    await call('fixture archive preserves graph','PATCH','/clothes/'+primary+'/archive',200,b,{isArchived:true});
    const archivedHistory=await call('fixture archived history','GET','/clothes/'+primary+'/diaries',200,b);assert.equal(archivedHistory.total,3);
    await call('fixture restore','PATCH','/clothes/'+primary+'/archive',200,b,{isArchived:false});
    for(const key of Object.keys(fixture.clothes)) clothes.push({id:fixture.clothes[key],userId:b.id,role:'fixture-'+key});await save();
    const protection=await verifyOriginals(runtime.database);await write(path.join(directory,'protection.json'),protection);
    await write(path.join(directory,'run-state.json'),{runId,status:'http-and-fixture-passed',checks:checks.length,remaining:'process restart, native UI and final audit'});
  } catch(error) {
    await write(path.join(directory,'run-state.json'),{runId,status:'failed',at:activeCheck,errorName:error.name,errorCode:error.code??null});throw error;
  } finally {
    for(const account of accounts) if(account.token) {
      const response=await fetch(config.publicBaseUrl+'/api/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+account.token}});account.loggedOut=response.status===200;
    }
    await save();await runtime.close();
  }
  console.log(JSON.stringify({runId,httpCases:checks.length,allExpectedStatuses:checks.every(check=>check.passed),accountsRetained:accounts.length,imagesRetained:files.length,accountsLoggedOut:accounts.every(account=>account.loggedOut)}));
}

if(import.meta.main) {
  const [mode,runId,...extra]=process.argv.slice(2);
  if(mode===undefined) console.log('Usage: --run-id <unique-run-id> | --prepare-ui <run-id> | --audit <run-id>');
  else if(!['--run-id','--prepare-ui','--audit'].includes(mode) || !/^[a-zA-Z0-9-]{1,70}$/.test(runId??'') || extra.length) {console.error('INVALID_ARGUMENTS');process.exitCode=1;}
  else if(mode==='--run-id') await run(runId);
  else if(mode==='--prepare-ui') await (await import('./prepare-wardrobe-ui.mjs')).prepareUI(runId);
  else {
    const {createDatabase}=await import('../src/db.js'),database=createDatabase(readConfig());
    try {const report=await (await import('./audit-wardrobe.mjs')).auditWardrobe(database,path.join(evidence,runId,'audit-results.json'));console.log(JSON.stringify({passed:report.passed,counts:report.counts,totalImages:report.totalImages}));}
    finally {await database.end();}
  }
}
