import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = path.join(root, 'docs/evidence/P5');
const tables = ['users', 'categories', 'clothes', 'outfits', 'outfit_items', 'diaries', 'diary_items'];
const hash = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
export const help = `阶段5验证（从server目录运行，私有配置使用 --env-file-if-exists=.env）
  node --env-file-if-exists=.env scripts/verify-outfits.mjs
  node --env-file-if-exists=.env scripts/verify-outfits.mjs --preflight <唯一runId>
  node --env-file-if-exists=.env scripts/verify-outfits.mjs --audit <唯一runId>
无参数/--help：仅帮助，不读取配置、不连接数据库、不写输出。
preflight：首次建立阶段基线，以后核对同一基线；audit：核对已有基线。
两者只读数据库/上传图，独占创建P5批次目录，拒绝覆盖。
Batch 1只允许零业务增量；Batch 2写入前须扩展累计manifest审计。
--http / --prepare-ui / --restart 尚未实现，明确拒绝，不执行写操作。
`;
export function parseArgs(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) return { mode: 'help' };
  if (['--http', '--prepare-ui', '--restart'].includes(args[0])) throw Object.assign(new Error('此批次尚未实现该模式'), { code: 'UNSUPPORTED_MODE' });
  if (args.length !== 2 || !['--preflight', '--audit'].includes(args[0]) || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(args[1])) throw Object.assign(new Error('请使用帮助中的模式及安全唯一runId'), { code: 'INVALID_ARGUMENTS' });
  return { mode: args[0].slice(2), runId: args[1] };
}
export async function reserveRun(directory, runId) {
  await fs.mkdir(directory, { recursive: true });
  const output = path.join(directory, runId);
  await fs.mkdir(output);
  return output;
}
const protectedPath = file => /^(assets\/|data\/|prototype\/|database\/|docs\/evidence\/P[1-4](?:[-/])|docs\/P[1-4])/.test(file) || file === 'server/package-lock.json';
async function historicalReleaseHashes() {
  const files = git('ls-files', '--others', '--ignored', '--exclude-standard', '-z', 'docs/evidence').split('\0').filter(file => /^docs\/evidence\/P[1-4](?:[-/])/.test(file));
  const hashes = {};
  for (const file of files) hashes[file] = hash(await fs.readFile(path.join(root, file)));
  return hashes;
}

export async function captureSnapshot(database, uploadRoot) {
  const connection = await database.getConnection();
  let identity, grants, columns, tableData;
  try {
    const { probe } = await import('../src/db.js');
    identity = await probe(connection);
    [grants] = await connection.query('SHOW GRANTS FOR CURRENT_USER');
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    [columns] = await connection.query('SELECT TABLE_NAME tableName,COLUMN_NAME columnName,COLUMN_TYPE columnType,IS_NULLABLE nullable,COLUMN_DEFAULT defaultValue FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION');
    tableData = {};
    for (const table of tables) {
      const [rows] = await connection.query(`SELECT * FROM ${table}`);
      const [ddl] = await connection.query(`SHOW CREATE TABLE ${table}`);
      tableData[table] = { count: rows.length, structure: Object.values(ddl[0])[1].replace(/AUTO_INCREMENT=\d+ /g, ''),
        rows: rows.map(row => ({ key: row.id ?? `${row.outfit_id ?? row.diary_id}:${row.clothing_id}`, sha256: hash(JSON.stringify(row)),
          ...(row.user_id === undefined ? {} : { userId: row.user_id }) })).sort((a, b) => String(a.key).localeCompare(String(b.key))) };
    }
    await connection.commit();
  } finally { connection.release(); }
  const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
  const protectedFiles = {};
  for (const file of tracked.filter(protectedPath)) protectedFiles[file] = hash(await fs.readFile(path.join(root, file)));
  const images = {};
  async function walk(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      const bytes = await fs.readFile(file);
      images[path.relative(uploadRoot, file).replaceAll('\\', '/')] = { size: bytes.length, sha256: hash(bytes),
        mimeType: bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'image/jpeg' : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : 'application/octet-stream' };
    }
  }
  await walk(uploadRoot);
  return { capturedAt: new Date().toISOString(), identity, grants: grants.map(row => Object.values(row)[0]), columns,
    U0: tableData.users.count, tables: tableData, protectedFiles, images, nodeVersion: process.version };
}
export function compareSnapshots(baseline, current) {
  for (const field of ['version', 'hostname', 'port', 'account', 'db', 'timeZone', 'connectionCollation']) assert.equal(current.identity[field], baseline.identity[field], 'INSTANCE:' + field);
  assert.deepEqual(current.grants, baseline.grants, 'GRANTS');
  assert.deepEqual(current.columns, baseline.columns, 'COLUMNS');
  assert.deepEqual(current.tables, baseline.tables, 'CHANGED_OR_UNEXPLAINED_ROWS_OR_STRUCTURE');
  assert.deepEqual(current.protectedFiles, baseline.protectedFiles, 'CHANGED_OR_UNEXPLAINED_PROTECTED_FILES');
  assert.deepEqual(current.images, baseline.images, 'CHANGED_OR_UNEXPLAINED_UPLOAD');
  return { allRowsUnchanged: true, allStructuresUnchanged: true, allProtectedFilesUnchanged: true, allImagesUnchanged: true, unexpectedRows: 0, unexpectedImages: 0 };
}

async function findBaseline() {
  const matches = [];
  for (const entry of await fs.readdir(evidence, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if ((await fs.readdir(path.join(evidence, entry.name))).includes('baseline.json')) matches.push(path.join(evidence, entry.name, 'baseline.json'));
  }
  assert.ok(matches.length <= 1, 'MULTIPLE_STAGE_BASELINES');
  return matches[0];
}
async function gitPrerequisites() {
  const startCommit = git('rev-parse', 'HEAD');
  const references = ['refs/heads/main', 'refs/tags/p4', 'refs/tags/p4^{}', 'refs/tags/p5-plan', 'refs/tags/p5-plan^{}'];
  const local = Object.fromEntries(references.map(ref => [ref, git('rev-parse', ref)]));
  const remotes = {};
  for (const remote of ['origin', 'gitee']) {
    const refs = Object.fromEntries(git('ls-remote', remote, ...references).split('\n').filter(Boolean).map(line => line.split(/\s+/)).map(([sha, ref]) => [ref, sha]));
    assert.deepEqual(refs, local, 'REMOTE_REFS:' + remote);
    remotes[remote] = refs;
  }
  assert.equal(local['refs/heads/main'], startCommit, 'MAIN_CHECKOUT');
  const p4 = await read(path.join(root, 'docs/evidence/P4/release-verification.local.json'));
  assert.equal(p4.stage4Complete, true, 'P4_INCOMPLETE');
  assert.equal(p4.passed, 38, 'P4_ACCEPTANCE');
  assert.equal(p4.tagObject, local['refs/tags/p4']);
  assert.equal(p4.commit, local['refs/tags/p4^{}']);
  return { startCommit, local, remotes, p4: { stage4Complete: true, passed: p4.passed, commit: p4.commit, tagObject: p4.tagObject }, worktreeAtCapture: git('status', '--porcelain=v1') };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.mode === 'help') { console.log(help); return; }
  const directory = await reserveRun(evidence, options.runId);
  const baselineFile = await findBaseline();
  if (options.mode === 'audit') assert.ok(baselineFile, 'BASELINE_REQUIRED');
  const gitState = await gitPrerequisites();
  const { readConfig } = await import('../src/config.js');
  const { createDatabase } = await import('../src/db.js');
  const config = readConfig(), database = createDatabase(config);
  try {
    if (!baselineFile) {
      // 旧审计只读取业务数据，输出显式放在P5，不改P4证据。
      const { auditWardrobe } = await import('./audit-wardrobe.mjs');
      assert.equal((await auditWardrobe(database, path.join(directory, 'p4-handoff-audit.json'))).passed, true);
    }
    const snapshot = await captureSnapshot(database, config.uploadRoot);
    if (!baselineFile) {
      const p4Baseline = await read(path.join(root, 'docs/evidence/P4/baseline.json'));
      const p4Audit = await read(path.join(root, 'docs/evidence/P4/audit-latest.json'));
      for (const table of tables) {
        const expected = [...p4Baseline.tables[table].rows, ...p4Audit.newRowHashes[table]].map(row => ({ key: String(row.key), sha256: row.sha256 })).sort((a, b) => a.key.localeCompare(b.key));
        assert.deepEqual(snapshot.tables[table].rows.map(row => ({ key: String(row.key), sha256: row.sha256 })), expected, 'P4_HANDOFF_ROWS:' + table);
      }
    }
    const protection = baselineFile ? compareSnapshots(await read(baselineFile), snapshot) : { baselineEstablished: true, p4HandoffVerified: true };
    const historicalReleases = await historicalReleaseHashes();
    const releaseBaseline = path.join(baselineFile ? path.dirname(baselineFile) : directory, 'historical-release-hashes.json');
    if (baselineFile) assert.deepEqual(historicalReleases, await read(releaseBaseline), 'HISTORICAL_LOCAL_RELEASES');
    else await fs.writeFile(releaseBaseline, JSON.stringify(historicalReleases, null, 2) + '\n', { flag: 'wx' });
    const filename = baselineFile ? 'snapshot.json' : 'baseline.json';
    await fs.writeFile(path.join(directory, filename), JSON.stringify({ runId: options.runId, batch: 1, git: gitState, ...snapshot }, null, 2) + '\n', { flag: 'wx' });
    const result = { runId: options.runId, batch: 1, mode: options.mode, checkedAt: new Date().toISOString(), stage5Complete: false, passed: true,
      baseline: path.relative(root, baselineFile ?? path.join(directory, filename)).replaceAll('\\', '/'), baselineSha256: hash(await fs.readFile(baselineFile ?? path.join(directory, filename))),
      counts: Object.fromEntries(tables.map(table => [table, snapshot.tables[table].count])), totalImages: Object.keys(snapshot.images).length, protectedFiles: Object.keys(snapshot.protectedFiles).length,
      protection: { ...protection, historicalLocalReportsUnchanged: true, historicalLocalReportCount: Object.keys(historicalReleases).length },
      historicalReleaseBaselineSha256: hash(await fs.readFile(releaseBaseline)),
      manifest: { accounts: [], rows: [], images: [], sessionsOpened: 0, ownedApplicationProcesses: [], databaseWrites: false, uploadWrites: false },
      pending: ['真实O01～O06服务与事务', '累计增量manifest审计（写入前扩展）', '原生页面/工具/视觉', 'V34阶段发布'] };
    await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(result));
  } finally { await database.end(); }
}
if (import.meta.main) await main();
