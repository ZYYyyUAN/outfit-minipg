import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readConfig} from '../src/config.js';
import {createDatabase,probe} from '../src/db.js';

const root=path.resolve(import.meta.dirname,'../..');
const hash=v=>createHash('sha256').update(v).digest('hex');
export async function snapshot(database,uploadRoot){
  const c=await database.getConnection(),tables={};
  let identity;
  try{
    identity=await probe(c);
    await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    for(const t of ['users','categories','clothes','outfits','outfit_items','diaries','diary_items']){
      const [rows]=await c.query(`SELECT * FROM ${t}`),[ddl]=await c.query(`SHOW CREATE TABLE ${t}`);
      tables[t]={structure:Object.values(ddl[0])[1].replace(/AUTO_INCREMENT=\d+ /g,''),rows:Object.fromEntries(rows.map(r=>[r.id??`${r.outfit_id??r.diary_id}:${r.clothing_id}`,hash(JSON.stringify(r))]))};
    }
    await c.commit();
  }finally{c.release();}
  const files={};
  async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())await walk(f);else files[path.relative(root,f).replaceAll('\\','/')]=hash(await fs.readFile(f));}}
  await walk(uploadRoot);
  const tracked=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
  for(const f of tracked.filter(f=>/^(assets\/|data\/|prototype\/|database\/|docs\/evidence\/P[1-5])/.test(f)))files[f]=hash(await fs.readFile(path.join(root,f)));
  return {capturedAt:new Date().toISOString(),identity,tables,files};
}
if(import.meta.main){
  const [mode,runId,...extra]=process.argv.slice(2);
  if(!mode||mode==='--help')console.log('只读基线：node --env-file-if-exists=.env scripts/verify-diaries.mjs --preflight <唯一runId>；不覆盖已有目录，不写业务数据。');
  else{
    if(mode!=='--preflight'||!runId||!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(runId)||extra.length)throw Error('INVALID_ARGUMENTS');
    const output=path.join(root,'docs/evidence/P6',runId);await fs.mkdir(path.dirname(output),{recursive:true});await fs.mkdir(output);
    const config=readConfig(),db=createDatabase(config);
    try{const s=await snapshot(db,config.uploadRoot);await fs.writeFile(path.join(output,'baseline.json'),JSON.stringify(s,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({runId,counts:Object.fromEntries(Object.entries(s.tables).map(([t,v])=>[t,Object.keys(v.rows).length])),files:Object.keys(s.files).length}));}finally{await db.end();}
  }
}
