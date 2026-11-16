import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {readConfig,serverRoot} from '../src/config.js';
import {createDatabase} from '../src/db.js';
const folder=path.join(serverRoot,'../docs/evidence/P4/run-20261115-ui'),config=readConfig(),database=createDatabase(config);
const manifest=JSON.parse(await fs.readFile(path.join(folder,'accounts.json'),'utf8'));
const baseline=JSON.parse(await fs.readFile(path.join(serverRoot,'../docs/evidence/P4/baseline.json'),'utf8'));
const connection=await database.getConnection(),files=[],states=[];
try {
  for(const account of manifest.accounts) {
    const [[row]]=await connection.execute('SELECT id,auth_token_hash,auth_expires_at FROM users WHERE username=?',[account.username]);
    assert.ok(row,'MANUAL_ACCOUNT_MISSING:'+account.username);
    assert.ok(!baseline.tables.users.rows.some(original=>String(original.key)===String(row.id)));
    if(account.id!==null) assert.equal(account.id,row.id);
    assert.equal(row.auth_token_hash,null,'MANUAL_ACCOUNT_STILL_LOGGED_IN:'+account.username);assert.equal(row.auth_expires_at,null);
    const [clothes]=await connection.execute('SELECT id,image_path,is_archived FROM clothes WHERE user_id=? ORDER BY id',[row.id]);
    assert.equal(clothes.length,account.role==='manual'?15:0);
    account.id=row.id;account.loggedOut=true;
    const directory=path.join(config.uploadRoot,'users',String(row.id));
    const entries=await fs.readdir(config.uploadRoot+'/users',{withFileTypes:true});
    if(entries.some(entry=>entry.name===String(row.id) && entry.isDirectory())) for(const filename of await fs.readdir(directory)) {
      assert.match(filename,/^[0-9a-f-]{36}\.(jpg|png)$/);
      const bytes=await fs.readFile(path.join(directory,filename)),metadata=await sharp(bytes).metadata();
      assert.ok(['jpeg','png'].includes(metadata.format));await sharp(bytes,{failOn:'warning'}).raw().toBuffer();
      const imagePath=`users/${row.id}/${filename}`;
      files.push({userId:row.id,imagePath,mimeType:'image/'+metadata.format,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),retained:true,source:'manual successful upload; locally selected image',clothingIds:clothes.filter(item=>item.image_path===imagePath).map(item=>item.id)});
    }
    states.push({id:row.id,username:account.username,loggedOut:true,clothingCount:clothes.length,activeCount:clothes.filter(item=>!item.is_archived).length});
  }
  await fs.writeFile(path.join(folder,'accounts.json'),JSON.stringify(manifest,null,2)+'\n');
  await fs.writeFile(path.join(folder,'files-manifest.json'),JSON.stringify({runId:'run-20261115-ui',files},null,2)+'\n');
  await fs.writeFile(path.join(folder,'manual-data-check.json'),JSON.stringify({checkedAt:new Date().toISOString(),states,registeredImages:files.length,passed:true},null,2)+'\n');
  console.log(JSON.stringify({passed:true,states,registeredImages:files.length}));
} finally {connection.release();await database.end();}
