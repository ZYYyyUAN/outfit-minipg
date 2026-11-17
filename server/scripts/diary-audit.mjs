import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {readConfig,serverRoot} from '../src/config.js';
import {createDatabase} from '../src/db.js';
import {snapshot} from './verify-diaries.mjs';

export async function audit(runId){
 assert.match(runId,/^[a-z0-9][a-z0-9_-]{0,79}$/);const root=path.dirname(serverRoot),base=path.join(root,'docs/evidence/P6'),dir=path.join(base,runId);await fs.mkdir(dir);
 const read=async p=>JSON.parse(await fs.readFile(p,'utf8')),initial=await read(path.join(base,'run-20261117-start/baseline.json')),expected=structuredClone(initial.tables),images={},runs=[];
 for(const e of await fs.readdir(base,{withFileTypes:true})){if(!e.isDirectory())continue;const files=await fs.readdir(path.join(base,e.name));if(files.includes('registry.json'))runs.push({name:e.name,baseline:await read(path.join(base,e.name,'baseline.json')),events:await read(path.join(base,e.name,'events.json')),registry:await read(path.join(base,e.name,'registry.json'))});}
 runs.sort((a,b)=>a.baseline.capturedAt.localeCompare(b.baseline.capturedAt));
 const inventory={users:new Set(),clothes:new Set(),outfits:new Set(),diaries:new Set()},deleted=new Set();let events=0,changes=0;
 for(const run of runs){
  for(const key of Object.keys(inventory))for(const item of run.registry[key])inventory[key].add(String(typeof item==='number'?item:item.id));
  for(const item of run.registry.deleted)deleted.add(String(item.id));
  for(const image of run.registry.images){const file='server/uploads/'+image.path;assert.equal(images[file],undefined,'DUPLICATE_IMAGE_REGISTRY');images[file]=image.sha256;}
  for(const event of run.events){events++;for(const change of event.changes){changes++;const {table,key,before,after}=change;assert.equal(expected[table].rows[key]??null,before,'EVENT_BEFORE:'+run.name+':'+table+':'+key);assert.equal(Object.hasOwn(initial.tables[table].rows,key),false,'ORIGINAL_CHANGE_FORBIDDEN');const parent=key.split(':')[0],kind=table==='diary_items'?'diaries':table==='outfit_items'?'outfits':table;assert.ok(inventory[kind]?.has(table.endsWith('_items')?parent:key),'UNREGISTERED_CHANGE:'+table+':'+key);if(after===null){assert.ok(table.endsWith('_items')||(table==='diaries'&&deleted.has(key)),'UNAUTHORIZED_DELETE');delete expected[table].rows[key];}else expected[table].rows[key]=after;}}
 }
 const config=readConfig(),db=createDatabase(config);
 try{
  const current=await snapshot(db,config.uploadRoot);assert.deepEqual(current.tables,expected,'FULL_ROW_SET_OR_STRUCTURE');
  for(const field of ['version','hostname','port','account','db','timeZone','connectionCollation'])assert.equal(current.identity[field],initial.identity[field],'INSTANCE:'+field);
  assert.deepEqual(current.files,{...initial.files,...images},'FULL_FILE_SET');
  const c=await db.getConnection();let sessions;
  try{[sessions]=await c.execute(`SELECT id,auth_token_hash,auth_expires_at FROM users WHERE id IN (${[...inventory.users].map(()=>'?').join(',')})`,[...inventory.users]);}finally{c.release();}
  assert.ok(sessions.every(s=>s.auth_token_hash===null&&s.auth_expires_at===null),'SESSION_STILL_ACTIVE');
  const result={passed:true,stage6Complete:false,runId,sourceRuns:runs.map(r=>r.name),events,changes,counts:Object.fromEntries(Object.entries(current.tables).map(([k,v])=>[k,Object.keys(v.rows).length])),protectedOriginalRows:Object.values(initial.tables).reduce((n,t)=>n+Object.keys(t.rows).length,0),protectedOriginalFiles:Object.keys(initial.files).length,registeredNewImages:Object.keys(images).length,allAccountsLoggedOut:true,accounts:[...inventory.users].map(Number),explicitDeletedDiaries:[...deleted].map(Number),fullExpectedSetMatches:true};await fs.writeFile(path.join(dir,'audit.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));return result;
 }finally{await db.end();}
}
if(import.meta.main){if(process.argv.length===2||process.argv[2]==='--help')console.log('全P6累计只读审计 --audit <唯一runId>；重放所有登记事件，原行禁止修改删除，检查全集和最终退出。');else{assert.equal(process.argv.length,4);assert.equal(process.argv[2],'--audit');await audit(process.argv[3]);}}
