import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {readConfig,serverRoot} from '../src/config.js';
import {createDatabase} from '../src/db.js';
import {createDiaryService} from '../src/services/diaries.js';
import {snapshot} from './verify-diaries.mjs';

if(process.argv.length===2||process.argv[2]==='--help')console.log('只读复核既存P6专用记录的真实唯一键异常身份：--check <唯一runId>；插入尝试因唯一键失败并回滚，不修改现存行。');
else{
 assert.equal(process.argv.length,4);assert.equal(process.argv[2],'--check');const runId=process.argv[3];assert.match(runId,/^[a-z0-9][a-z0-9_-]{0,79}$/);
 const root=path.dirname(serverRoot),dir=path.join(root,'docs/evidence/P6',runId);await fs.mkdir(dir);
 const config=readConfig(),db=createDatabase(config),fixture=JSON.parse(await fs.readFile(path.join(root,'docs/evidence/P6/run-20261117-integration3/fixture-map.json'))),before=await snapshot(db,config.uploadRoot);let mysqlError;
 const wrapped={async getConnection(){const c=await db.getConnection();return {beginTransaction:()=>c.beginTransaction(),commit:()=>c.commit(),rollback:()=>c.rollback(),release:()=>c.release(),async execute(...args){try{return await c.execute(...args);}catch(error){if(error.code==='ER_DUP_ENTRY')mysqlError={code:error.code,errno:error.errno,sqlState:error.sqlState,sqlMessage:error.sqlMessage};throw error;}}};}};
 try{
  const userId=fixture.accounts[0].id,c=await db.getConnection();let row;
  try{[row]=(await c.execute('SELECT wear_date FROM diaries WHERE id=? AND user_id=?',[fixture.mainDiaryId,userId]))[0];}finally{c.release();}
  let details;await assert.rejects(()=>createDiaryService(wrapped,config).create(userId,{wearDate:row.wear_date,sourceOutfitId:null,clothingIds:fixture.registered.clothes.slice(0,2).map(i=>i.id),occasion:'唯一键证据',mood:null,photoPath:null,note:''}),e=>{details=e.details;return e.code==='DATE_OCCUPIED'&&e.status===409;});
  assert.equal(mysqlError.errno,1062);assert.equal(mysqlError.code,'ER_DUP_ENTRY');assert.match(mysqlError.sqlMessage,/diaries.uq_diaries_user_date/);assert.equal(details.existingDiaryId,fixture.mainDiaryId);
  const after=await snapshot(db,config.uploadRoot);assert.deepEqual(after.tables,before.tables);assert.deepEqual(after.files,before.files);await fs.writeFile(path.join(dir,'conflict-proof.json'),JSON.stringify({passed:true,mysqlError,details,rolledBack:true,allRowsAndFilesUnchanged:true},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({runId,passed:true,errno:mysqlError.errno,key:'diaries.uq_diaries_user_date'}));
 }finally{await db.end();}
}
