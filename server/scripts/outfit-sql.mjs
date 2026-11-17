import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readConfig,serverRoot} from '../src/config.js';
import {createDatabase} from '../src/db.js';
import {reserveRun,captureSnapshot,compareCumulative,loadManifests} from './verify-outfits.mjs';
import {selectIntegrationManifest} from './outfit-restart.mjs';
const root=path.dirname(serverRoot),hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const write=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n');
export async function verifySql(runId){
 assert.match(runId,/^[a-z0-9][a-z0-9_-]{0,79}$/);
 const directory=await reserveRun(path.join(root,'docs/evidence/P5'),runId),config=readConfig(),prior=await loadManifests();
 const source=selectIntegrationManifest(prior);assert.ok(source,'BATCH6_INTEGRATION_REQUIRED');
 const fixture=JSON.parse(await fs.readFile(path.join(path.dirname(directory),source.runId,'fixture-map.json')));
 const baseline=JSON.parse(await fs.readFile(path.join(root,'docs/evidence/P5/run-20261116-b1-baseline/baseline.json')));
 const database=createDatabase(config),checks=[];
 try{
  const before=await captureSnapshot(database,config.uploadRoot);compareCumulative(baseline,before,prior);
  for(const [key,item]of Object.entries(fixture.outfits)){
   const independent=createDatabase(config);
   try{
    const connection=await independent.getConnection();
    try{
     const [parents]=await connection.execute('SELECT id,user_id,name,occasion,is_archived FROM outfits WHERE id=? AND user_id=?',[item.id,item.userId]);
     const [items]=await connection.execute('SELECT clothing_id,sort_order FROM outfit_items WHERE outfit_id=? ORDER BY sort_order',[item.id]);
     assert.equal(parents.length,1);assert.deepEqual(items.map(i=>i.clothing_id),item.clothingIds);assert.deepEqual(items.map(i=>i.sort_order),item.clothingIds.map((_,i)=>i+1));
     checks.push({key,outfitId:item.id,userId:item.userId,newPhysicalConnection:true,connectionId:connection.threadId,parent:parents[0],items,passed:true});
     await write(path.join(directory,'independent-sql-orders.json'),checks);
    }finally{connection.release();}
   }finally{await independent.end();}
  }
  assert.equal(new Set(checks.map(c=>c.connectionId)).size,checks.length);
  const after=await captureSnapshot(database,config.uploadRoot);assert.deepEqual(after.tables,before.tables);const protection=compareCumulative(baseline,after,prior);
  await write(path.join(directory,'results.json'),{runId,batch:6,passed:true,stage5Complete:false,sourceRunId:source.runId,sqlChecks:checks.length,allSeparatePhysicalConnections:true,allCurrentFixtureOwnersCovered:true,orderedChecksSha256:hash(checks),databaseWrites:false,sessionsOpened:0,uploadWrites:false,protection,correction:'Reconstruct current ordered SQL proof in a new run; earlier overwritten intermediate SQL records are not claimed recovered.'});
 }finally{await database.end();}
}
if(import.meta.main){if(process.argv.length===2||process.argv[2]==='--help')console.log('只读独立SQL补核：--check <唯一runId>；无参数仅帮助。');else{assert.equal(process.argv.length,4);assert.equal(process.argv[2],'--check');await verifySql(process.argv[3]);}}
