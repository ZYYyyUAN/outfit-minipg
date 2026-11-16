import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readConfig,serverRoot} from '../src/config.js';
import {createDatabase,probe} from '../src/db.js';
import {verifyOriginals} from './verify-wardrobe.mjs';
const root=path.dirname(serverRoot),evidence=path.join(root,'docs/evidence/P4');
const hash=value=>createHash('sha256').update(value).digest('hex');
export async function auditWardrobe(database,output) {
  const baseline=JSON.parse(await fs.readFile(path.join(evidence,'baseline.json'),'utf8'));
  const sealed=JSON.parse(await fs.readFile(path.join(evidence,'sealed-automatic-rows.json'),'utf8'));
  await verifyOriginals(database);
  const accounts=[],clothes=[],files=[],fixtures=[];
  for(const entry of await fs.readdir(evidence,{withFileTypes:true})) {
    if(!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
    const folder=path.join(evidence,entry.name),names=await fs.readdir(folder);
    for(const [filename,list,key] of [['accounts.json',accounts,'accounts'],['clothes-manifest.json',clothes,'clothes'],['files-manifest.json',files,'files']]) if(names.includes(filename)) list.push(...JSON.parse(await fs.readFile(path.join(folder,filename),'utf8'))[key]);
    if(names.includes('fixture-map.json')) {const fixture=JSON.parse(await fs.readFile(path.join(folder,'fixture-map.json'),'utf8'));assert.equal(fixture.state,'committed');fixtures.push(fixture);}
  }
  const connection=await database.getConnection();
  const counts={},newRowHashes={};
  try {
    const identity=await probe(connection);
    for(const key of ['hostname','port','db','version','account']) assert.equal(identity[key],baseline.identity[key],'INSTANCE:'+key);
    for(const table of Object.keys(baseline.tables)) {
      const [rows]=await connection.query(`SELECT * FROM ${table}`);counts[table]=rows.length;
      const original=new Set(baseline.tables[table].rows.map(row=>String(row.key)));
      const extra=rows.filter(row=>!original.has(String(row.id??`${row.outfit_id??row.diary_id}:${row.clothing_id}`)));
      let expected=[];
      if(table==='users') expected=accounts.filter(account=>account.id!==null).map(account=>String(account.id));
      if(table==='clothes') expected=clothes.map(item=>String(item.id));
      if(table==='outfits') expected=fixtures.flatMap(fixture=>Object.values(fixture.outfits).map(String));
      if(table==='diaries') expected=fixtures.flatMap(fixture=>Object.values(fixture.diaries).map(String));
      if(table==='outfit_items') expected=fixtures.flatMap(fixture=>[['O1',['C2','C3','C4','C5','C1']],['O2',['C1','C2']],['O3',['C1']]].flatMap(([parent,keys])=>keys.map(key=>`${fixture.outfits[parent]}:${fixture.clothes[key]}`)));
      if(table==='diary_items') expected=fixtures.flatMap(fixture=>[['D1',['C1','C4','C3']],['D2',['C1']],['D3',['C1','C2']]].flatMap(([parent,keys])=>keys.map(key=>`${fixture.diaries[parent]}:${fixture.clothes[key]}`)));
      const keyOf=row=>String(row.id??`${row.outfit_id??row.diary_id}:${row.clothing_id}`);
      assert.equal(new Set(expected).size,expected.length,'DUPLICATE_MANIFEST:'+table);
      assert.deepEqual(extra.map(keyOf).sort(),expected.sort(),'UNEXPLAINED_ROWS:'+table);
      if(table==='users') for(const row of extra) {
        const account=accounts.find(item=>item.id===row.id);assert.equal(account.username,row.username);assert.equal(row.auth_token_hash,null,'FINAL_LOGOUT:'+row.id);assert.equal(row.auth_expires_at,null);
      }
      if(table==='clothes') for(const row of extra) assert.equal(row.user_id,clothes.find(item=>item.id===row.id).userId,'CLOTHING_OWNER');
      if(table==='outfits' || table==='diaries') for(const row of extra) assert.equal(row.user_id,fixtures.find(fixture=>Object.values(table==='outfits'?fixture.outfits:fixture.diaries).includes(row.id)).userId,'HISTORY_OWNER');
      newRowHashes[table]=extra.map(row=>({key:keyOf(row),sha256:hash(JSON.stringify(row))}));
      const currentHashes=new Map(newRowHashes[table].map(row=>[row.key,row.sha256]));
      for(const row of sealed[table]) assert.equal(currentHashes.get(row.key),row.sha256,'SEALED_AUTOMATIC_ROW:'+table+':'+row.key);
    }
    for(const fixture of fixtures) {
      for(const [table,parent,groups] of [['outfit_items','outfit_id',[['O1',['C2','C3','C4','C5','C1']],['O2',['C1','C2']],['O3',['C1']]]],['diary_items','diary_id',[['D1',['C1','C4','C3']],['D2',['C1']],['D3',['C1','C2']]]]]) {
        for(const [key,keys] of groups) {
          const id=(table==='outfit_items'?fixture.outfits:fixture.diaries)[key];
          const [rows]=await connection.execute(`SELECT clothing_id,sort_order FROM ${table} WHERE ${parent}=? ORDER BY sort_order`,[id]);
          assert.deepEqual(rows,keys.map((key,index)=>({clothing_id:fixture.clothes[key],sort_order:index+1})));
        }
      }
    }
  } finally {connection.release();}
  const actualImages={};
  async function walk(folder) {for(const entry of await fs.readdir(folder,{withFileTypes:true})) {const file=path.join(folder,entry.name);if(entry.isDirectory()) await walk(file);else actualImages[path.relative(path.join(serverRoot,'uploads'),file).replaceAll('\\','/')]=hash(await fs.readFile(file));}}
  await walk(path.join(serverRoot,'uploads'));
  const expectedImages={...baseline.images};
  for(const file of files) {assert.ok(!Object.hasOwn(expectedImages,file.imagePath),'DUPLICATE_IMAGE_MANIFEST');assert.equal(Number(file.imagePath.split('/')[1]),file.userId);expectedImages[file.imagePath]=file.sha256;}
  assert.deepEqual(actualImages,expectedImages,'UNKNOWN_OR_CHANGED_UPLOAD');
  const pending=accounts.filter(account=>account.id===null).map(account=>account.username);
  const report={checkedAt:new Date().toISOString(),passed:pending.length===0,pendingManualAccounts:pending,counts,registeredAccounts:accounts.length-pending.length,registeredClothes:clothes.length,registeredImages:files.length,totalImages:Object.keys(actualImages).length,originalProtection:true,allAddedRowsExplained:true,allTestAccountsLoggedOut:true,orderedAssociationsVerified:true,sealedAutomaticRowsUnchanged:true,newRowHashes};
  await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');return report;
}
if(import.meta.main) {
  const config=readConfig(),database=createDatabase(config);
  try {const result=await auditWardrobe(database,path.join(evidence,'audit-latest.json'));console.log(JSON.stringify({passed:result.passed,counts:result.counts,totalImages:result.totalImages}));}
  finally {await database.end();}
}
