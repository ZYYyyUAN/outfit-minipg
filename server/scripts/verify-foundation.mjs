import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readConfig, safeError, serverRoot } from '../src/config.js';
import { createDatabase, probe } from '../src/db.js';

const root = path.dirname(serverRoot);
const hash = value => createHash('sha256').update(value).digest('hex');
const json = async p => JSON.parse(await fs.readFile(path.join(root, p), 'utf8'));
const tables = ['users','categories','clothes','outfits','outfit_items','diaries','diary_items'];
export async function snapshot(connection) {
  const counts = {}, rowHashes = {}, structure = {};
  for (const table of tables) {
    const order = table === 'outfit_items' ? 'outfit_id,clothing_id' : table === 'diary_items' ? 'diary_id,clothing_id' : 'id';
    const [rows] = await connection.query(`SELECT * FROM ${table} ORDER BY ${order}`);
    counts[table] = rows.length; rowHashes[table] = hash(JSON.stringify(rows));
    const [ddl] = await connection.query(`SHOW CREATE TABLE ${table}`); structure[table] = hash(ddl[0]['Create Table']);
  }
  return { counts, rowHashes, structure };
}
async function main() {
  const args = process.argv.slice(2);
  if (!args.length) { console.log('Usage: verify-foundation.mjs --run-id <unique-run-id>'); return; }
  assert.ok(args.length === 2 && args[0] === '--run-id' && /^[A-Za-z0-9_-]+$/.test(args[1]), 'INVALID_RUN_ID');
  const runId = args[1]; const dir = path.join(root, 'docs/evidence/P3-01', runId); await fs.mkdir(dir);
  const report = { runId, startedAt: new Date().toISOString(), state: 'started' };
  let database, connection, transaction = false;
  try {
    const config = readConfig(); database = createDatabase(config);
    const a = await database.getConnection(); let b;
    try { b = await database.getConnection(); report.sessions = [await probe(a), await probe(b)]; assert.notEqual(report.sessions[0].connectionId, report.sessions[1].connectionId); }
    finally { a.release(); if (b) b.release(); }
    connection = await database.getConnection(); report.reusedSession = await probe(connection);
    assert.ok(report.sessions.some(s => s.connectionId === report.reusedSession.connectionId));
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY'); transaction = true;
    report.database = await snapshot(connection);
    const baseline = await json('docs/evidence/P3-01/database-baseline.json');
    for (const key of ['hostname','port','db','version','account']) assert.equal(report.reusedSession[key], baseline.identity[key]);
    for (const key of ['counts','rowHashes','structure']) assert.deepEqual(report.database[key], baseline[key]);
    const [columns] = await connection.query('SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION'); assert.equal(columns.length, 47); report.columns = columns;
    const data = await json('data/demo-data.json'); const p203 = await json('docs/evidence/P2-03/acceptance-results.json');
    const { map } = await json(`docs/evidence/P2-03/${p203.refs.apply}/id-map.json`);
    const [categories] = await connection.query('SELECT id,name,sort_order FROM categories ORDER BY sort_order');
    assert.deepEqual(categories, data.categories.map(c=>({id:c.id,name:c.name,sort_order:c.sortOrder}))); report.categories = categories;
    report.relations = { outfits: [], diaries: [] };
    for (const [kind, table, parent] of [['outfits','outfit_items','outfit_id'],['diaries','diary_items','diary_id']]) for (const source of data[kind]) {
      const [items] = await connection.execute(`SELECT clothing_id,sort_order FROM ${table} WHERE ${parent}=? ORDER BY sort_order`, [map[kind][source.id]]);
      assert.deepEqual(items, source.clothingIds.map((id,i)=>({clothing_id:map.clothes[id],sort_order:i+1})));
      report.relations[kind].push({logicalId:source.id,actualId:map[kind][source.id],items});
    }
    const [diary] = await connection.execute('SELECT wear_date,source_outfit_id,photo_path,created_at,updated_at FROM diaries WHERE id=?', [map.diaries.DIA004]);
    assert.equal(diary[0].source_outfit_id, null); assert.equal(diary[0].wear_date, data.diaries[3].wearDate); assert.match(diary[0].created_at,/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/); report.diarySample = diary[0];
    const [months] = await connection.query("SELECT DATE_FORMAT(wear_date,'%Y-%m') month,COUNT(*) days FROM diaries GROUP BY month ORDER BY month");
    assert.deepEqual(months.map(x=>({...x,days:Number(x.days)})), [{month:'2026-10',days:9},{month:'2026-11',days:3}]); report.months = months;
    await connection.commit(); transaction = false; connection.release(); connection = null;
    const baselineFiles = await json('docs/evidence/P3-01/baseline-hashes.json'); const allowed = ['.gitignore','README.md','docs/执行计划.md'];
    report.protection = { checked: 0, allowedExistingChanges: allowed, uploads: { '10': 0, '11': 0 } };
    for (const [file, expected] of Object.entries(baselineFiles.hashes)) if (!allowed.includes(file)) {
      assert.equal(hash(await fs.readFile(path.join(root,file))),expected,file); report.protection.checked++;
      for (const uid of ['10','11']) if (file.startsWith(`server/uploads/users/${uid}/`)) report.protection.uploads[uid]++;
    }
    assert.deepEqual(report.protection.uploads, {'10':25,'11':25});
    const response = await fetch(config.publicBaseUrl+'/api/health'); assert.equal(response.status,200); assert.match(response.headers.get('content-type'),/application\/json/); const body=await response.json(); assert.deepEqual(body,{data:{status:'ok'}});
    const missing=await fetch(config.publicBaseUrl+'/api/clothes'); assert.equal(missing.status,404); assert.equal((await missing.json()).error.code,'NOT_FOUND');
    report.http={url:config.publicBaseUrl+'/api/health',status:response.status,body,unimplementedClothesStatus:missing.status};
    report.hashes={};
    async function add(folder) { for(const entry of await fs.readdir(path.join(root,folder),{withFileTypes:true})) { const file=folder+'/'+entry.name; if(['node_modules','uploads','.env','project.config.json','project.private.config.json'].includes(entry.name)) continue; if(entry.isDirectory()) await add(file); else report.hashes[file]=hash(await fs.readFile(path.join(root,file))); } }
    await add('server'); await add('miniprogram'); report.state='automated-passed';
  } catch(error) { report.state='failed'; report.error=safeError(error); process.exitCode=1; }
  finally { if(connection) { if(transaction) await connection.rollback(); connection.release(); } if(database) await database.end(); report.completedAt=new Date().toISOString(); await fs.writeFile(path.join(dir,'automated-results.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'}); }
  console.log(JSON.stringify({runId,state:report.state,error:report.error,counts:report.database?.counts,protected:report.protection}));
}
if(import.meta.main) { try { await main(); } catch(error) { console.error(JSON.stringify({state:'failed',error:safeError(error)})); process.exitCode=1; } }
