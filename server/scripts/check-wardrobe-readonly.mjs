import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { createDatabase, probe } from '../src/db.js';
import { createClothesService } from '../src/services/clothes.js';
import { filters, pagination } from '../src/routes/clothes.js';

const config=readConfig(),database=createDatabase(config),connection=await database.getConnection();
try {
  const identity=await probe(connection);
  const [[user]]=await connection.execute('SELECT id FROM users WHERE username=?',['demo_user']);
  assert.ok(user);
  const clothes=createClothesService(database,config);
  const list=await clothes.list(user.id,filters({}));
  assert.equal(list.total,24);assert.equal(list.items.length,12);
  const page2=await clothes.list(user.id,filters({page:'2'}));
  assert.equal(page2.items.length,12);
  assert.equal(new Set([...list.items,...page2.items].map(row=>row.id)).size,24);
  assert.equal((await clothes.list(user.id,filters({page:'3'}))).items.length,0);
  const facets=await clothes.facets(user.id,'active');assert.ok(facets.colors.length);
  const details=[];
  for(const item of [...list.items,...page2.items]) {
    const detail=await clothes.detail(user.id,item.id);
    const [[expected]]=await connection.execute('SELECT COUNT(*) n,MAX(d.wear_date) recent FROM diaries d WHERE d.user_id=? AND d.wear_date<=? AND EXISTS (SELECT 1 FROM diary_items i WHERE i.diary_id=d.id AND i.clothing_id=?)',[user.id,new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),item.id]);
    assert.equal(detail.wearCount,Number(expected.n));assert.equal(detail.lastWornDate,expected.recent);
    const outfits=await clothes.related(user.id,item.id,'outfits',pagination({pageSize:'2'}));
    const diaries=await clothes.related(user.id,item.id,'diaries',pagination({pageSize:'2'}));
    assert.ok(outfits.items.every(row=>row.previewItems.length<=4));assert.ok(diaries.items.every(row=>row.previewItems.length<=3));
    details.push({id:item.id,wearCount:detail.wearCount,lastWornDate:detail.lastWornDate,relatedOutfits:outfits.total,relatedDiaries:diaries.total});
  }
  const baseline=JSON.parse(await fs.readFile('../docs/evidence/P4/baseline.json','utf8'));
  for(const [table,expected] of Object.entries(baseline.tables)) {
    const [rows]=await connection.query(`SELECT * FROM ${table}`);
    const actual=rows.map(row=>({key:row.id??`${row.outfit_id??row.diary_id}:${row.clothing_id}`,sha256:createHash('sha256').update(JSON.stringify(row)).digest('hex')})).sort((a,b)=>String(a.key).localeCompare(String(b.key)));
    assert.deepEqual(actual,expected.rows);
  }
  const report={checkedAt:new Date().toISOString(),identity,mode:'database-service-readonly-not-http',listTotal:list.total,pageLengths:[12,page2.items.length,0],facets,details,baselineRowsUnchanged:true};
  await fs.writeFile('../docs/evidence/P4/readonly-service-results.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:true,details:details.length,baselineRowsUnchanged:true,mode:report.mode}));
} finally {connection.release();await database.end();}
