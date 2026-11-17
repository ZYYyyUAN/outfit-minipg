import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {readConfig,serverRoot} from '../src/config.js';
import {createDatabase} from '../src/db.js';
import {reserveRun,captureSnapshot,compareCumulative,loadManifests,sessionTransitionProof} from './verify-outfits.mjs';
import {rowHash} from './outfit-business-proof.mjs';
const root=path.dirname(serverRoot),read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const write=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n');
const key=(table,row)=>table==='outfit_items'?row.outfit_id+':'+row.clothing_id:row.id;
export async function manualCheckpoint(mode,runId){
  assert.ok(['begin','finish'].includes(mode));assert.match(runId,/^[a-z0-9][a-z0-9_-]{0,79}$/);
  const config=readConfig(),directory=path.join(root,'docs/evidence/P5',runId),privateFile=path.join(serverRoot,'.p5-private',runId+'.json');
  if(mode==='begin')await reserveRun(path.join(root,'docs/evidence/P5'),runId);
  else await fs.mkdir(path.join(directory,'finish'));
  const database=createDatabase(config);
  try{
    const prior=await loadManifests(),baseline=await read(path.join(root,'docs/evidence/P5/run-20261116-b1-baseline/baseline.json'));
    const connection=await database.getConnection();let users,business;
    try{
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      [users]=await connection.query('SELECT * FROM users');business={};
      for(const table of ['clothes','outfits','outfit_items'])[business[table]]=await connection.query('SELECT * FROM '+table);
      await connection.commit();
    }finally{connection.release();}
    if(mode==='begin'){
      const snapshot=await captureSnapshot(database,config.uploadRoot);const protection=compareCumulative(baseline,snapshot,prior);
      assert.ok(users.every(row=>row.auth_token_hash===null&&row.auth_expires_at===null),'ACCOUNTS_MUST_START_LOGGED_OUT');
      await write(privateFile,{users});
      await write(path.join(directory,'before-business.json'),business);
      await write(path.join(directory,'before-snapshot.json'),snapshot);
      await write(path.join(directory,'write-plan.json'),{runId,batch:7,manualScope:{ownerIds:[44,45],clothingIds:Array.from({length:21},(_,i)=>167+i),outfitIds:[69,70]},newAccountPrefix:'p5_b7_',allowedFields:{clothes:['name','image_path','is_archived','updated_at'],outfits:['name','occasion','note','is_archived','updated_at']},relationReplacement:'explicit full before/after proof; no parent deletion',diariesMutable:false,protection});
      console.log(JSON.stringify({runId,mode,passed:true,databaseWrites:false}));return;
    }
    const before=await read(path.join(directory,'before-business.json')),snapshotBefore=await read(path.join(directory,'before-snapshot.json')),plan=await read(path.join(directory,'write-plan.json')),secret=await read(privateFile);
    assert.ok(users.every(row=>row.auth_token_hash===null&&row.auth_expires_at===null),'ACCOUNTS_MUST_FINISH_LOGGED_OUT');
    const manifest={version:1,sequence:Math.max(...prior.map(m=>m.sequence))+1,runId,batch:7,accounts:[],rows:[],images:[],businessEvents:[],manualScope:plan.manualScope,allAccountsLoggedOut:true};
    for(const user of users){
      const old=secret.users.find(row=>row.id===user.id);
      if(!old){assert.ok(user.username.startsWith(plan.newAccountPrefix),'UNEXPECTED_NEW_ACCOUNT');manifest.accounts.push({id:user.id,username:user.username});manifest.manualScope.ownerIds.push(user.id);manifest.rows.push({table:'users',ownerId:user.id,row:{key:user.id,sha256:rowHash(user)},beforeSha256:null});continue;}
      if(rowHash(old)===rowHash(user))continue;
      assert.ok([44,45].includes(user.id),'UNEXPECTED_ACCOUNT_CHANGE');const proof=sessionTransitionProof(user,old.updated_at);assert.equal(proof.beforeSha256,rowHash(old),'UNEXPECTED_ACCOUNT_FIELD_CHANGE');
      manifest.rows.push({table:'users',ownerId:user.id,row:{key:user.id,sha256:rowHash(user)},beforeSha256:rowHash(old),transition:'logged-out-session',proof});
    }
    for(const table of ['clothes','outfits','outfit_items']){
      const current=new Map(business[table].map(row=>[key(table,row),row])),oldRows=new Map(before[table].map(row=>[key(table,row),row]));
      for(const [id,old]of oldRows){const next=current.get(id)||null;if(rowHash(old)===rowHash(next))continue;
        const ownerId=table==='outfit_items'?before.outfits.find(row=>row.id===old.outfit_id).user_id:old.user_id;
        manifest.businessEvents.push({table,ownerId,before:old,after:next,changedFields:next?Object.keys(old).filter(field=>JSON.stringify(old[field])!==JSON.stringify(next[field])):['relationship deleted']});}
      for(const [id,row]of current)if(!oldRows.has(id)){
        const ownerId=table==='outfit_items'?business.outfits.find(parent=>parent.id===row.outfit_id).user_id:row.user_id;
        assert.ok(manifest.manualScope.ownerIds.includes(ownerId),'NEW_ROW_OWNER');
        if(table==='outfit_items'&&before.outfits.some(parent=>parent.id===row.outfit_id))assert.ok(manifest.manualScope.outfitIds.includes(row.outfit_id),'NEW_RELATION_PARENT_SCOPE');
        manifest.rows.push({table,ownerId,row:{key:id,sha256:rowHash(row),...(row.user_id===undefined?{}:{userId:row.user_id})},beforeSha256:null});
      }
    }
    // Persist only after validating the complete candidate chain; snapshot uses existing session proof metadata.
    const snapshot=await captureSnapshot(database,config.uploadRoot);
    for(const entry of manifest.rows.filter(row=>row.transition==='logged-out-session'))snapshot.ownership.users[entry.ownerId].sessionProofs=[...(snapshot.ownership.users[entry.ownerId].sessionProofs||[]),entry.proof];
    for(const [image,metadata]of Object.entries(snapshot.images))if(!Object.hasOwn(snapshotBefore.images,image)){
      const ownerId=Number(image.split('/')[1]);assert.ok(manifest.manualScope.ownerIds.includes(ownerId),'NEW_IMAGE_OWNER');manifest.images.push({path:image,userId:ownerId,...metadata});
    }
    const protection=compareCumulative(baseline,snapshot,[...prior,manifest]);
    await write(path.join(directory,'manifest.json'),manifest);await write(path.join(directory,'finish/snapshot.json'),snapshot);
    await write(path.join(directory,'finish/results.json'),{runId,batch:7,passed:true,stage5Complete:false,protection,allAccountsLoggedOut:true,nativeAcceptance:'requires separate actual manual record and screenshots'});
    console.log(JSON.stringify({runId,mode,passed:true,events:manifest.businessEvents.length,newRows:manifest.rows.length,images:manifest.images.length}));
  }finally{await database.end();}
}
if(import.meta.main){if(process.argv.length===2||process.argv[2]==='--help')console.log('仅帮助。人工操作前 --begin <唯一runId>，全部退出后 --finish <同runId>；只读数据库、记录字段/关系差异，不代表人工通过。');else{assert.equal(process.argv.length,4);assert.ok(['--begin','--finish'].includes(process.argv[2]));await manualCheckpoint(process.argv[2].slice(2),process.argv[3]);}}
