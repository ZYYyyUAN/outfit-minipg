import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {serverRoot,readConfig} from '../src/config.js';
import {createDatabase} from '../src/db.js';
import {prepareWardrobeFixtures} from './wardrobe-fixtures.mjs';
export async function prepareUI(runId) {
  const config=readConfig(),database=createDatabase(config),folder=path.join(serverRoot,'../docs/evidence/P4',runId);
  const manifest=JSON.parse(await fs.readFile(path.join(folder,'accounts.json'),'utf8')),account=manifest.accounts.find(account=>account.role==='manual');
  assert.ok(account);assert.equal(account.id,null,'UI_ALREADY_PREPARED');
  const connection=await database.getConnection();
  try {
    const [[user]]=await connection.execute('SELECT id FROM users WHERE username=?',[account.username]);assert.ok(user,'REGISTER_UI_ACCOUNT_FIRST');
    const baseline=JSON.parse(await fs.readFile(path.join(serverRoot,'../docs/evidence/P4/baseline.json'),'utf8'));assert.ok(!baseline.tables.users.rows.some(row=>String(row.key)===String(user.id)));
    const [rows]=await connection.execute('SELECT * FROM clothes WHERE user_id=? ORDER BY id',[user.id]);assert.equal(rows.length,2,'CREATE_EXACTLY_TWO_UI_CLOTHES_FIRST');
    const first=rows.find(row=>row.name==='P4针织_%!Alpha'),second=rows.find(row=>row.name==='P4牛仔裤Beta');assert.ok(first);assert.ok(second);
    account.id=user.id;account.imagePath=first.image_path;
    const fixture=await prepareWardrobeFixtures(database,config,account,path.join(folder,'fixture-map.json'),{existingClothes:[first,second]});
    await fs.writeFile(path.join(folder,'accounts.json'),JSON.stringify(manifest,null,2)+'\n');
    const clothes=Object.entries(fixture.clothes).map(([key,id])=>({id,userId:user.id,role:'manual-'+key}));
    await fs.writeFile(path.join(folder,'clothes-manifest.json'),JSON.stringify({runId,clothes},null,2)+'\n');
    const files=[];
    for(const filename of await fs.readdir(path.join(config.uploadRoot,'users',String(user.id)))) {
      const bytes=await fs.readFile(path.join(config.uploadRoot,'users',String(user.id),filename));
      files.push({userId:user.id,imagePath:`users/${user.id}/${filename}`,mimeType:filename.endsWith('.png')?'image/png':'image/jpeg',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),retained:true});
    }
    await fs.writeFile(path.join(folder,'files-manifest.json'),JSON.stringify({runId,files},null,2)+'\n');
    console.log(JSON.stringify({prepared:true,userId:user.id,active:13,archived:2,total:15,relatedOutfits:3,relatedDiaries:3}));
  } finally {connection.release();await database.end();}
}
