import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {readConfig,serverRoot} from '../src/config.js';
import {createDatabase} from '../src/db.js';
import {createStatisticsService} from '../src/services/statistics.js';
import {snapshot} from './verify-diaries.mjs';

export async function check(runId){
 assert.match(runId,/^[a-z0-9][a-z0-9_-]{0,79}$/);
 const root=path.dirname(serverRoot),dir=path.join(root,'docs/evidence/P6',runId);await fs.mkdir(dir);
 const config=readConfig(),db=createDatabase(config),before=await snapshot(db,config.uploadRoot);
 try{
  const map=JSON.parse(await fs.readFile(path.join(root,'docs/evidence/P2-03/2026-11-06T16-42-33-726Z-apply-5b84797b/id-map.json'))).map;
  const service=createStatisticsService(db,()=>new Date('2026-11-06T04:00:00Z')),oct=await service.get(map.users.DEMO001,{month:'2026-10',page:1,pageSize:50}),nov=await service.get(map.users.DEMO001,{month:'2026-11',page:1,pageSize:50});
  assert.equal(nov.activeClothesCount,24);assert.deepEqual(nov.categoryDistribution.map(c=>c.count),[7,3,1,6,2,2,3]);assert.equal(oct.monthDiaryDays,9);assert.equal(nov.monthDiaryDays,3);
  assert.deepEqual(nov.mostWorn.map(c=>[c.id,c.wearCount]),[['CLO018',6],['CLO020',6],['CLO019',5],['CLO021',5],['CLO001',3]].map(([id,n])=>[map.clothes[id],n]));
  assert.deepEqual(nov.notWornRecently.items.map(c=>c.id),['CLO007','CLO010','CLO011','CLO017'].map(id=>map.clothes[id]));
  const final=await snapshot(db,config.uploadRoot);assert.deepEqual(final.tables,before.tables);assert.deepEqual(final.files,before.files);
  const report={passed:true,readOnly:true,userId:map.users.DEMO001,clock:'2026-11-06 internal only',mapping:'P2-03 committed id-map',oct,nov,allRowsAndFilesUnchanged:true};await fs.writeFile(path.join(dir,'fixed-sample.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({runId,passed:true,active:24,oct:9,nov:3}));
 }finally{await db.end();}
}
if(import.meta.main){if(process.argv.length===2||process.argv[2]==='--help')console.log('只读固定映射核对 --check <唯一runId>；不登录原账号、不更改数据、不公开asOf。');else{assert.equal(process.argv.length,4);assert.equal(process.argv[2],'--check');await check(process.argv[3]);}}
