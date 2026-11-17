// 从server目录显式运行；只读复用Batch 2夹具，不登录、不归档、不上传。
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../../../../server/src/config.js';
import { createDatabase } from '../../../../server/src/db.js';
import { createOutfitService } from '../../../../server/src/services/outfits.js';
import { start } from '../../../../server/src/index.js';
import { captureSnapshot, compareCumulative, loadManifests } from '../../../../server/scripts/verify-outfits.mjs';

const directory=new URL('./',import.meta.url);
const write=(name,value)=>fs.writeFile(new URL(name,directory),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const fixture=JSON.parse(await fs.readFile(new URL('../run-20261117-b2-http2/fixture-map.json',directory),'utf8'));
const baseline=JSON.parse(await fs.readFile(new URL('../run-20261116-b1-baseline/baseline.json',directory),'utf8'));
const config=readConfig(),database=createDatabase(config),service=createOutfitService(database,config);
const checks=[];
let runtime;
try {
  const before=await captureSnapshot(database,config.uploadRoot);
  compareCumulative(baseline,before,await loadManifests());
  const a=fixture.accounts.a.id,b=fixture.accounts.b.id;
  for(const [key,count] of [['A1',1],['A2',4],['A3',5],['A4',20]]) {
    const entry=fixture.outfits[key],value=await service.detail(a,entry.id);
    assert.equal(value.items.length,count);assert.deepEqual(value.items.map(item=>item.id),entry.clothingIds);
    const connection=await database.getConnection();
    let rows;
    try { [rows]=await connection.execute('SELECT clothing_id,sort_order FROM outfit_items WHERE outfit_id=? ORDER BY sort_order',[entry.id]); }
    finally { connection.release(); }
    assert.deepEqual(rows.map(row=>row.clothing_id),entry.clothingIds);
    checks.push({kind:'real SQL and production service',outfitId:entry.id,count,orderedIds:value.items.map(item=>item.id),passed:true});
  }
  const list=page=>service.list(a,{page,pageSize:12,offset:(page-1)*12,archived:'active'});
  const first=await list(1),second=await list(2);
  assert.equal(first.total,13);assert.equal(first.items.length,12);assert.equal(second.total,13);assert.equal(second.items.length,1);
  for(const item of [...first.items,...second.items]) {
    const value=await service.detail(a,item.id);
    assert.equal(item.clothingCount,value.items.length);assert.deepEqual(item.previewItems,value.items.slice(0,4));
  }
  checks.push({kind:'real SQL and production service',activeTotal:first.total,pages:[12,1],previewsMatchFullDetails:true,passed:true});
  for(const archived of ['active','archived','all']) {
    const facets=await service.facets(a,archived),values=await service.list(a,{page:1,pageSize:50,offset:0,archived});
    assert.deepEqual([...facets.occasions].sort(),[...new Set(values.items.map(item=>item.occasion))].sort());
    checks.push({kind:'real SQL and production service',archived,total:values.total,occasions:facets.occasions,passed:true});
  }
  await assert.rejects(service.detail(b,fixture.outfits.A4.id),error=>error.status===404 || error.statusCode===404);
  const connection=await database.getConnection();
  let accounts;
  try { [accounts]=await connection.execute('SELECT id,auth_token_hash IS NULL AS loggedOut FROM users WHERE id IN (?,?)',[a,b]); }
  finally { connection.release(); }
  assert.ok(accounts.length===2 && accounts.every(row=>row.loggedOut===1));
  checks.push({kind:'real SQL',accounts:accounts.map(row=>({id:row.id,loggedOut:true})),passed:true});
  runtime=await start({...config,port:0});
  const port=runtime.server.address().port;
  for(const [route,status] of [['/health',200],['/outfits',401],['/outfits/facets',401],['/outfits/35',401],['/clothes/123/outfits',401]]) {
    const response=await fetch('http://127.0.0.1:'+port+'/api'+route);assert.equal(response.status,status);
    checks.push({kind:'real anonymous HTTP',method:'GET',route,expected:status,actual:response.status,passed:true});
  }
  await runtime.close();runtime=null;
  const after=await captureSnapshot(database,config.uploadRoot),protection=compareCumulative(baseline,after,await loadManifests());
  assert.deepEqual(before.tables,after.tables);assert.deepEqual(before.images,after.images);
  await write('readonly-results.json',{batch:3,runId:'run-20261117-b3-validation',checkedAt:new Date().toISOString(),checks,protection,allRowsAndImagesUnchangedDuringCheck:true,authenticatedHttpReexecuted:false,authenticationEvidence:'Batch 2 HTTP; unchanged server service/routes/app',sessionsOpened:0,databaseWrites:false,uploadWrites:false,ownedServerClosed:true,developerToolPortOpened:false,stage5Complete:false});
  await write('manifest.json',{version:1,sequence:3,runId:'run-20261117-b3-validation',batch:3,accounts:[],rows:[],images:[],referencedFixtureRunId:fixture.runId,referencedAccountIds:[a,b],sessionsOpened:0,databaseWrites:false,uploadWrites:false,ownedApplicationProcesses:[],ownedApplicationClosed:true});
  console.log(JSON.stringify({passed:true,checks:checks.length,report:fileURLToPath(new URL('readonly-results.json',directory))}));
} finally { if(runtime) await runtime.close();await database.end(); }
