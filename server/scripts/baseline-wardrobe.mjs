import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readConfig } from '../src/config.js';
import { createDatabase, probe } from '../src/db.js';

const root = path.resolve('..');
const output = path.join(root, 'docs/evidence/P4/baseline.json');
const hash = value => createHash('sha256').update(value).digest('hex');
await fs.mkdir(path.dirname(output), { recursive: true });
const database = createDatabase(readConfig());
const connection = await database.getConnection();
try {
  const identity = await probe(connection);
  await connection.query('START TRANSACTION READ ONLY');
  const tables = {};
  for (const table of ['users','categories','clothes','outfits','outfit_items','diaries','diary_items']) {
    const [rows] = await connection.query(`SELECT * FROM ${table}`);
    const [ddl] = await connection.query(`SHOW CREATE TABLE ${table}`);
    tables[table] = { count: rows.length, rows: rows.map(row => ({ key: row.id ?? `${row.outfit_id ?? row.diary_id}:${row.clothing_id}`, sha256: hash(JSON.stringify(row)) })).sort((a,b)=>String(a.key).localeCompare(String(b.key))), structure: Object.values(ddl[0])[1].replace(/AUTO_INCREMENT=\d+ /g, '') };
  }
  await connection.commit();
  const tracked = execFileSync('git', ['ls-files','-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const protectedFiles = {};
  for (const file of tracked.filter(f=>/^(assets\/|data\/|prototype\/|docs\/evidence\/P[123]-|database\/schema.sql$)/.test(f))) protectedFiles[file] = hash(await fs.readFile(path.join(root,file)));
  const images = {};
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else images[path.relative(path.join(root,'server/uploads'),file).replaceAll('\\','/')] = hash(await fs.readFile(file));
    }
  }
  await walk(path.join(root,'server/uploads'));
  const report = { capturedAt: new Date().toISOString(), startCommit: execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(), identity, tables, protectedFiles, images };
  await fs.writeFile(output, JSON.stringify(report,null,2)+'\n', { flag: 'wx' });
  console.log(JSON.stringify({ baselineSaved: true, tableCounts: Object.fromEntries(Object.entries(tables).map(([k,v])=>[k,v.count])), protectedFiles: Object.keys(protectedFiles).length, images: Object.keys(images).length }));
} finally { connection.release(); await database.end(); }
