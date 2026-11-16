import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {readConfig} from '../src/config.js';
import {createDatabase} from '../src/db.js';
import {createClothesService} from '../src/services/clothes.js';
import {filters} from '../src/routes/clothes.js';
const config=readConfig(),database=createDatabase(config);
const fixture=JSON.parse(await fs.readFile('../docs/evidence/P4/run-20261115-02/fixture-map.json','utf8'));
const checks=[];
try {
  const cases=[['2026-10-07T00:00:00Z',1,'2026-10-07'],['2026-10-08T00:00:00Z',2,'2026-10-08'],['2026-11-04T15:59:59.999Z',2,'2026-10-08'],['2026-11-04T16:00:00Z',3,'2026-11-05']];
  for(const [instant,count,last] of cases) {
    const service=createClothesService(database,config,()=>new Date(instant));
    const detail=await service.detail(fixture.userId,fixture.clothes.C1);
    assert.equal(detail.wearCount,count);assert.equal(detail.lastWornDate,last);
    checks.push({id:'DATE-'+checks.length,instant,count,last,passed:true});
  }
  const service=createClothesService(database,config);
  const seasonCases={春:['C1','C2','C6','C8','C9','C12'],夏:['C2','C4','C6','C8','C11'],秋:['C1','C2','C3','C5','C6','C12','C13'],冬:['C2','C5','C6','C7','C10']};
  for(const [season,keys] of Object.entries(seasonCases)) {
    const result=await service.list(fixture.userId,filters({season,pageSize:'50'}));
    assert.deepEqual(result.items.map(item=>item.id).sort((a,b)=>a-b),keys.map(key=>fixture.clothes[key]).sort((a,b)=>a-b));
    checks.push({id:'SEASON-'+season,matchedKeys:keys,passed:true});
  }
  for(const [query,expected] of [[{keyword:'_%!alpha'},['C1']],[{categoryId:'tops',color:'浅粉色',season:'秋'},['C1']],[{categoryId:'tops',color:'浅粉色',season:'秋',archived:'all'},['C1','C14']],[{keyword:'\\'},[]],[{keyword:"' OR 1=1 --"},[]]]) {
    const result=await service.list(fixture.userId,filters(query));
    assert.deepEqual(result.items.map(item=>item.id).sort((a,b)=>a-b),expected.map(key=>fixture.clothes[key]).sort((a,b)=>a-b));
    checks.push({id:'FILTER-'+checks.length,query,matchedKeys:expected,passed:true});
  }
  const never=await service.detail(fixture.userId,fixture.clothes.C5);assert.equal(never.wearCount,0);assert.equal(never.lastWornDate,null);
  const report={checkedAt:new Date().toISOString(),mode:'readonly-service-boundaries-not-public-asOf',passed:true,checks,neverWorn:{id:never.id,count:0,last:null}};
  await fs.writeFile('../docs/evidence/P4/boundary-results.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:true,boundaryCases:checks.length,neverWorn:true}));
} finally {await database.end();}
