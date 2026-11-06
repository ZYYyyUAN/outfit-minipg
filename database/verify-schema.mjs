import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tables = ['users', 'categories', 'clothes', 'outfits', 'outfit_items', 'diaries', 'diary_items'];
const db = 'wardrobe_demo';
const coll = 'utf8mb4_0900_as_cs';
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex');
const indexes = {
  users: { PRIMARY: [0, 'id'], uq_users_username: [0, 'username'], uq_users_auth_token_hash: [0, 'auth_token_hash'] },
  categories: { PRIMARY: [0, 'id'], uq_categories_name: [0, 'name'] },
  clothes: { PRIMARY: [0, 'id'], idx_clothes_user_archived_id: [1, 'user_id', 'is_archived', 'id'], idx_clothes_category: [1, 'category_id'] },
  outfits: { PRIMARY: [0, 'id'], idx_outfits_user_archived_id: [1, 'user_id', 'is_archived', 'id'] },
  outfit_items: { PRIMARY: [0, 'outfit_id', 'clothing_id'], uq_outfit_items_order: [0, 'outfit_id', 'sort_order'], idx_outfit_items_clothing: [1, 'clothing_id', 'outfit_id'] },
  diaries: { PRIMARY: [0, 'id'], uq_diaries_user_date: [0, 'user_id', 'wear_date'], idx_diaries_source_outfit: [1, 'source_outfit_id'] },
  diary_items: { PRIMARY: [0, 'diary_id', 'clothing_id'], uq_diary_items_order: [0, 'diary_id', 'sort_order'], idx_diary_items_clothing: [1, 'clothing_id', 'diary_id'] },
};
const fks = [
  ['fk_clothes_user', 'clothes', 'user_id', 'users'], ['fk_clothes_category', 'clothes', 'category_id', 'categories'],
  ['fk_outfits_user', 'outfits', 'user_id', 'users'], ['fk_outfit_items_outfit', 'outfit_items', 'outfit_id', 'outfits'],
  ['fk_outfit_items_clothing', 'outfit_items', 'clothing_id', 'clothes'], ['fk_diaries_user', 'diaries', 'user_id', 'users'],
  ['fk_diaries_source', 'diaries', 'source_outfit_id', 'outfits'], ['fk_diary_items_diary', 'diary_items', 'diary_id', 'diaries'],
  ['fk_diary_items_clothing', 'diary_items', 'clothing_id', 'clothes'],
];
const checks = {
  ck_users_auth_pair: ['users', '(auth_token_hash IS NULL AND auth_expires_at IS NULL) OR (auth_token_hash IS NOT NULL AND auth_expires_at IS NOT NULL)'],
  ck_categories_sort: ['categories', 'sort_order BETWEEN 1 AND 7'],
  ck_clothes_archived: ['clothes', 'is_archived IN (0,1)'],
  ck_clothes_season: ['clothes', "season IN ('春','夏','秋','冬','春夏','春秋','秋冬','四季')"],
  ck_outfits_archived: ['outfits', 'is_archived IN (0,1)'],
  ck_outfit_items_sort: ['outfit_items', 'sort_order>=1'],
  ck_diary_items_sort: ['diary_items', 'sort_order>=1'],
};

// The reviewed field dictionary is the authority, rather than the created database or SQL file.
function fieldDictionary() {
  const text = fs.readFileSync(path.join(root, 'docs/数据库设计.md'), 'utf8');
  const result = Object.fromEntries(tables.map(t => [t, []]));
  let tableIndex = -1;
  for (const line of text.split(/\r?\n/)) {
    if (line === '| 字段 | 类型 | 可空 | 默认/生成 | 语义 |') tableIndex++;
    if (!/^\| \w+ \| (INT|VARCHAR|CHAR|DATE|TINYINT|SMALLINT)/.test(line)) continue;
    const [name, type, nullable, def] = line.split('|').slice(1, -1).map(s => s.trim());
    result[tables[tableIndex]].push({ name, type: type.toLowerCase(), nullable: nullable === '是', def });
  }
  assert.equal(Object.values(result).flat().length, 47, 'field dictionary must contain 47 columns');
  return result;
}

function checkExpression(text) {
  const tokens = text.replaceAll('`', '').replace(/_utf8mb4/gi, '').match(/'[^']*'|\w+|>=|<=|<>|[=<>(),]/g);
  return tokens.filter(t => t !== '(' && t !== ')').map(t => t.startsWith("'") ? t : t.toLowerCase()).join(' ');
}

export async function inspect(c) {
  const [identity] = await c.query('SELECT VERSION() version, @@version_comment product, @@hostname hostname, @@port port, CURRENT_USER() account, CURRENT_ROLE() roles, CONNECTION_ID() connectionId, @@session.sql_mode sqlMode, @@session.foreign_key_checks fkChecks, @@session.time_zone timeZone, @@character_set_client clientCharset, @@character_set_connection connectionCharset, @@character_set_results resultsCharset, @@collation_connection connectionCollation');
  const [grants] = await c.query('SHOW GRANTS FOR CURRENT_USER()');
  const [engines] = await c.query('SHOW ENGINES');
  const [collations] = await c.query('SHOW COLLATION WHERE Collation = ?', [coll]);
  const [schemas] = await c.query('SELECT * FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME=?', [db]);
  const [objects] = await c.query('SELECT TABLE_NAME,TABLE_TYPE,ENGINE,TABLE_COLLATION,AUTO_INCREMENT FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME', [db]);
  const extras = {};
  for (const [type, column] of [['TRIGGERS', 'TRIGGER_SCHEMA'], ['ROUTINES', 'ROUTINE_SCHEMA'], ['EVENTS', 'EVENT_SCHEMA']]) {
    const [rows] = await c.query(`SELECT * FROM INFORMATION_SCHEMA.${type} WHERE ${column}=?`, [db]);
    extras[type] = rows;
  }
  return { identity: identity[0], grants, engines, collations, schemas, objects, extras };
}

export function validateEnvironment(e) {
  assert.match(e.identity.version, /^8\./, 'target must be MySQL 8');
  const version = e.identity.version.split('.').map(Number);
  assert(version[1] > 0 || version[2] >= 16, 'enforced CHECK needs MySQL >=8.0.16');
  assert.equal(e.identity.port, Number(process.env.DB_PORT));
  assert.equal(e.identity.fkChecks, 1);
  assert.match(e.identity.sqlMode, /STRICT_(TRANS|ALL)_TABLES/);
  for (const key of ['clientCharset', 'connectionCharset', 'resultsCharset']) assert.equal(e.identity[key], 'utf8mb4');
  assert.equal(e.identity.connectionCollation, coll);
  assert(e.engines.some(r => r.Engine === 'InnoDB' && ['DEFAULT', 'YES'].includes(r.Support)));
  assert.equal(e.collations.length, 1);
  // Stop for manual privilege review when roles or restricted grants require interpretation.
  assert.equal(e.identity.roles, 'NONE');
  const grants = e.grants.map(r => Object.values(r)[0]);
  assert(!grants.some(g => g.startsWith('REVOKE')));
  const globalGrant = grants.find(g => / ON \*\.\* TO /.test(g) && g.startsWith('GRANT SELECT,'));
  assert(globalGrant, 'expected directly reviewed global grant; otherwise review required');
  for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'REFERENCES', 'SHOW DATABASES']) assert(globalGrant.includes(p), `missing ${p}`);
}

async function counts(c) {
  const result = {};
  for (const table of tables) result[table] = Number((await c.query(`SELECT COUNT(*) n FROM ${db}.${table}`))[0][0].n);
  return result;
}

export async function structure(c, e) {
  const dictionary = fieldDictionary();
  assert.equal(e.schemas.length, 1);
  assert.equal(e.schemas[0].DEFAULT_CHARACTER_SET_NAME, 'utf8mb4');
  assert.equal(e.schemas[0].DEFAULT_COLLATION_NAME, coll);
  assert.deepEqual(e.objects.map(o => o.TABLE_NAME).sort(), [...tables].sort());
  for (const obj of e.objects) { assert.equal(obj.TABLE_TYPE, 'BASE TABLE'); assert.equal(obj.ENGINE, 'InnoDB'); assert.equal(obj.TABLE_COLLATION, coll); }
  for (const rows of Object.values(e.extras)) assert.equal(rows.length, 0);
  const [columns] = await c.query('SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,ORDINAL_POSITION', [db]);
  assert.equal(columns.length, 47);
  const columnComparisons = [];
  for (const table of tables) {
    const actual = columns.filter(x => x.TABLE_NAME === table);
    assert.equal(actual.length, dictionary[table].length);
    for (const [i, f] of dictionary[table].entries()) {
      const a = actual[i];
      assert.equal(a.COLUMN_NAME, f.name);
      assert.equal(a.COLUMN_TYPE.toLowerCase().replace(/\b(int|smallint|tinyint)\(\d+\)/g, '$1'), f.type);
      assert.equal(a.IS_NULLABLE, f.nullable ? 'YES' : 'NO');
      const def = f.def === "''" ? '' : f.def === '0' ? '0' : null;
      assert.equal(a.COLUMN_DEFAULT === null ? null : String(a.COLUMN_DEFAULT), def);
      assert.equal(a.EXTRA, f.def === 'AUTO_INCREMENT' ? 'auto_increment' : '');
      if (f.type.startsWith('datetime')) assert.equal(a.DATETIME_PRECISION, 3);
      if (/^(var)?char/.test(f.type)) { assert.equal(a.CHARACTER_SET_NAME, 'utf8mb4'); assert.equal(a.COLLATION_NAME, coll); assert.equal(a.CHARACTER_MAXIMUM_LENGTH, Number(f.type.match(/\d+/)[0])); }
      columnComparisons.push({ table, expected: f, actual: a, status: 'passed' });
    }
  }
  const [stats] = await c.query('SELECT * FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX', [db]);
  const actualIndexes = {};
  for (const r of stats) {
    assert.equal(r.INDEX_TYPE, 'BTREE'); assert.equal(r.SUB_PART, null); assert.equal(r.EXPRESSION, null); assert.equal(r.IS_VISIBLE, 'YES');
    actualIndexes[r.TABLE_NAME] ??= {};
    actualIndexes[r.TABLE_NAME][r.INDEX_NAME] ??= [r.NON_UNIQUE];
    actualIndexes[r.TABLE_NAME][r.INDEX_NAME].push(r.COLUMN_NAME);
  }
  assert.deepEqual(actualIndexes, indexes);
  const [relations] = await c.query('SELECT k.CONSTRAINT_NAME,k.TABLE_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_SCHEMA,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,k.ORDINAL_POSITION,r.UPDATE_RULE,r.DELETE_RULE FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME WHERE k.TABLE_SCHEMA=? ORDER BY k.CONSTRAINT_NAME,k.ORDINAL_POSITION', [db]);
  assert.equal(relations.length, 9);
  for (const [name, table, column, parent] of fks) {
    const a = relations.find(r => r.CONSTRAINT_NAME === name);
    assert(a, name); assert.equal(a.TABLE_NAME, table); assert.equal(a.COLUMN_NAME, column); assert.equal(a.REFERENCED_TABLE_SCHEMA, db); assert.equal(a.REFERENCED_TABLE_NAME, parent); assert.equal(a.REFERENCED_COLUMN_NAME, 'id'); assert.equal(a.ORDINAL_POSITION, 1);
    assert.equal(a.UPDATE_RULE, 'RESTRICT'); assert.equal(a.DELETE_RULE, name === 'fk_diary_items_diary' ? 'CASCADE' : 'RESTRICT');
    const child = columns.find(x => x.TABLE_NAME === table && x.COLUMN_NAME === column), p = columns.find(x => x.TABLE_NAME === parent && x.COLUMN_NAME === 'id');
    for (const key of ['COLUMN_TYPE', 'CHARACTER_SET_NAME', 'COLLATION_NAME']) assert.equal(child[key], p[key]);
  }
  const [actualChecks] = await c.query('SELECT t.TABLE_NAME,t.CONSTRAINT_NAME,t.ENFORCED,c.CHECK_CLAUSE FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS t JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME WHERE t.TABLE_SCHEMA=? AND t.CONSTRAINT_TYPE=\'CHECK\' ORDER BY t.CONSTRAINT_NAME', [db]);
  assert.equal(actualChecks.length, 7);
  const create = {};
  for (const table of tables) create[table] = (await c.query(`SHOW CREATE TABLE ${db}.${table}`))[0][0]['Create Table'];
  for (const [name, [table, expression]] of Object.entries(checks)) {
    const a = actualChecks.find(r => r.CONSTRAINT_NAME === name); assert(a, name); assert.equal(a.TABLE_NAME, table); assert.equal(a.ENFORCED, 'YES');
    // CHECK_CLAUSE on this 8.0.28 instance escapes non-ASCII literals differently from SHOW CREATE.
    const match = create[table].match(new RegExp('CONSTRAINT `' + name + '` CHECK \\((.+)\\)(?:,|$)', 'm'));
    assert(match, `${name}: missing SHOW CREATE expression`);
    assert.equal(checkExpression(match[1]), checkExpression(expression));
    a.verifiedExpression = match[1]; a.expectedExpression = expression;
  }
  return { status: 'passed', columns: columnComparisons, indexes: stats, relations, checks: actualChecks, showCreate: create };
}

async function behavior(c, report) {
  await c.query(`USE ${db}`);
  const before = await counts(c);
  assert(Object.values(before).every(n => n === 0), 'constraint tests require seven empty tables');
  const nextValues = async () => {
    const [rows] = await c.query("SELECT TABLE_NAME,AUTO_INCREMENT FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME IN ('users','clothes','outfits','diaries') ORDER BY TABLE_NAME", [db]);
    assert.equal(rows.length, 4);
    return rows;
  };
  report.cleanup = { before, autoIncrementBefore: await nextValues() };
  report.behavior = [];
  const q = async (sql, params = []) => (await c.execute(sql, params))[0];
  const now = '2026-11-06 00:00:00.000';
  const marker = `p202_${crypto.randomBytes(4).toString('hex')}`;
  const insert = async (table, values) => { const keys = Object.keys(values); return (await q(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(values))).insertId; };
  const user = name => insert('users', { username: name, password_hash: 'P202_TEST_ONLY_NOT_A_LOGIN_HASH', nickname: name, created_at: now, updated_at: now });
  const clothing = (uid, cid) => insert('clothes', { user_id: uid, category_id: cid, name: '测试衣物', image_path: `users/${uid}/p202-test.jpg`, color: '粉色', season: '春秋', created_at: now, updated_at: now });
  const outfit = uid => insert('outfits', { user_id: uid, name: '测试搭配', occasion: '校园', created_at: now, updated_at: now });
  const diary = (uid, date, source = null) => insert('diaries', { user_id: uid, wear_date: date, source_outfit_id: source, occasion: '校园', created_at: now, updated_at: now });
  const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async t => [t, await q(`SELECT * FROM ${t} ORDER BY ${indexes[t].PRIMARY.slice(1).join(',')}`)])));
  let steps;
  async function fails(label, errno, key, sql, params = []) {
    const beforeFailure = await snapshot();
    let error;
    try { await q(sql, params); } catch (e) { error = e; }
    assert(error, `${label}: expected failure`); assert.equal(error.errno, errno, label);
    assert.equal(error.sqlState, errno === 3819 ? 'HY000' : '23000');
    assert(error.sqlMessage.includes(key), `${label}: constraint ${key} not reported`);
    assert.deepEqual(await snapshot(), beforeFailure, `${label}: failed statement changed rows`);
    steps.push({ label, status: 'passed', failedStatementPreservedRows: true, error: { code: error.code, errno: error.errno, sqlState: error.sqlState, key } });
  }
  async function test(id, fn) {
    const result = { id, status: 'running', operations: [] }; report.behavior.push(result); steps = result.operations;
    await c.query('SAVEPOINT testcase'); const baseline = await snapshot();
    await fn();
    await c.query('ROLLBACK TO SAVEPOINT testcase'); await c.query('RELEASE SAVEPOINT testcase');
    assert.deepEqual(await snapshot(), baseline, `${id}: savepoint did not restore rows`);
    result.status = 'passed'; result.savepointRestored = true;
  }
  try {
    await c.beginTransaction();
    const a = await user(marker + 'a'), b = await user(marker + 'b');
    await insert('categories', { id: marker, name: marker, sort_order: 1 });
    const c1 = await clothing(a, marker), c2 = await clothing(a, marker), c3 = await clothing(a, marker), o = await outfit(a);
    await insert('outfit_items', { outfit_id: o, clothing_id: c1, sort_order: 1 }); await insert('outfit_items', { outfit_id: o, clothing_id: c2, sort_order: 2 });
    const d1 = await diary(a, '2026-11-05', o), d2 = await diary(a, '2026-11-04', o), d3 = await diary(b, '2026-11-05');
    for (const [d, ci] of [[d1, c1], [d2, c2], [d3, c3]]) await insert('diary_items', { diary_id: d, clothing_id: ci, sort_order: 1 });
    report.fixture = { connectionId: (await q('SELECT CONNECTION_ID() id'))[0].id, ids: { a, b, c1, c2, c3, o, d1, d2, d3 }, marker };
    const token = 'a'.repeat(64), expires = '2026-11-13 00:00:00.000';
    await test('B01', async () => {
      assert.equal((await q('SELECT COUNT(*) n FROM users WHERE auth_token_hash IS NULL'))[0].n, 2);
      steps.push({ label: 'two NULL token hashes allowed', status: 'passed' });
      await fails('username duplicate', 1062, 'uq_users_username', 'INSERT INTO users(username,password_hash,nickname,created_at,updated_at) SELECT username,password_hash,nickname,created_at,updated_at FROM users WHERE id=?', [a]);
      await q('UPDATE users SET auth_token_hash=?,auth_expires_at=? WHERE id=?', [token, expires, a]);
      await fails('non-null token duplicate', 1062, 'uq_users_auth_token_hash', 'UPDATE users SET auth_token_hash=?,auth_expires_at=? WHERE id=?', [token, expires, b]);
      assert.equal((await q('SELECT auth_token_hash FROM users WHERE id=?', [b]))[0].auth_token_hash, null);
    });
    await test('B02', async () => {
      for (const [t, exp] of [[null, null], [token, expires]]) { await q('UPDATE users SET auth_token_hash=?,auth_expires_at=? WHERE id=?', [t, exp, a]); const [r] = await q('SELECT auth_token_hash,auth_expires_at FROM users WHERE id=?', [a]); assert.equal(r.auth_token_hash, t); assert.equal(r.auth_expires_at === null, exp === null); steps.push({ label: t ? 'both present' : 'both NULL', status: 'passed' }); }
      await fails('hash only', 3819, 'ck_users_auth_pair', 'UPDATE users SET auth_token_hash=?,auth_expires_at=NULL WHERE id=?', [token, a]);
      await fails('expiry only', 3819, 'ck_users_auth_pair', 'UPDATE users SET auth_token_hash=NULL,auth_expires_at=? WHERE id=?', [expires, a]);
    });
    await test('B03', async () => {
      await fails('category id', 1062, 'PRIMARY', 'INSERT INTO categories VALUES(?,?,1)', [marker, marker + 'x']);
      await fails('category name', 1062, 'uq_categories_name', 'INSERT INTO categories VALUES(?,?,1)', [marker + 'x', marker]);
      for (const n of [0, 8]) await fails(`category order ${n}`, 3819, 'ck_categories_sort', 'UPDATE categories SET sort_order=? WHERE id=?', [n, marker]);
    });
    await test('B04', async () => {
      await fails('same user same day', 1062, 'uq_diaries_user_date', 'INSERT INTO diaries(user_id,wear_date,occasion,created_at,updated_at) VALUES(?,?,?,?,?)', [a, '2026-11-05', '校园', now, now]);
      assert.equal((await q("SELECT COUNT(*) n FROM diaries WHERE wear_date='2026-11-05'"))[0].n, 2); steps.push({ label: 'different users same day allowed', status: 'passed' });
      await q("UPDATE diaries SET wear_date='2026-11-04' WHERE id=?", [d2]); steps.push({ label: 'edit keeps own date', status: 'passed' });
      await fails('edit occupied date', 1062, 'uq_diaries_user_date', "UPDATE diaries SET wear_date='2026-11-05' WHERE id=?", [d2]);
      assert.equal((await q('SELECT wear_date FROM diaries WHERE id=?', [d2]))[0].wear_date, '2026-11-04');
    });
    await test('B05', async () => {
      for (const [table, parent, id] of [['outfit_items', 'outfit_id', o], ['diary_items', 'diary_id', d1]]) {
        await fails(table, 1062, 'PRIMARY', `INSERT INTO ${table} VALUES(?,?,3)`, [id, c1]);
        const other = table === 'outfit_items' ? await outfit(a) : d2;
        await insert(table, { [parent]: other, clothing_id: c1, sort_order: 3 }); steps.push({ label: `${table} another parent allowed`, status: 'passed' });
      }
    });
    await test('B06', async () => {
      for (const [t, id, key] of [['outfit_items', o, 'uq_outfit_items_order'], ['diary_items', d1, 'uq_diary_items_order']]) await fails(t, 1062, key, `INSERT INTO ${t} VALUES(?,?,1)`, [id, c3]);
    });
    await test('B07', async () => {
      for (const [t, id, key] of [['outfit_items', o, 'ck_outfit_items_sort'], ['diary_items', d1, 'ck_diary_items_sort']]) await fails(t, 3819, key, `INSERT INTO ${t} VALUES(?,?,0)`, [id, c3]);
    });
    await test('B08', async () => {
      const missing = 4294967295;
      for (const t of ['users', 'clothes', 'outfits', 'diaries']) assert.equal((await q(`SELECT COUNT(*) n FROM ${t} WHERE id=?`, [missing]))[0].n, 0);
      await fails('fk_clothes_user', 1452, 'fk_clothes_user', 'UPDATE clothes SET user_id=? WHERE id=?', [missing, c1]);
      assert.equal((await q("SELECT COUNT(*) n FROM categories WHERE id='p202_missing'"))[0].n, 0);
      await fails('fk_clothes_category', 1452, 'fk_clothes_category', "UPDATE clothes SET category_id='p202_missing' WHERE id=?", [c1]);
      await fails('fk_outfits_user', 1452, 'fk_outfits_user', 'UPDATE outfits SET user_id=? WHERE id=?', [missing, o]);
      await fails('fk_outfit_items_outfit', 1452, 'fk_outfit_items_outfit', 'INSERT INTO outfit_items VALUES(?,?,3)', [missing, c3]);
      await fails('fk_outfit_items_clothing', 1452, 'fk_outfit_items_clothing', 'INSERT INTO outfit_items VALUES(?,?,3)', [o, missing]);
      await fails('fk_diaries_user', 1452, 'fk_diaries_user', 'UPDATE diaries SET user_id=? WHERE id=?', [missing, d1]);
      await fails('fk_diaries_source', 1452, 'fk_diaries_source', 'UPDATE diaries SET source_outfit_id=? WHERE id=?', [missing, d1]);
      await fails('fk_diary_items_diary', 1452, 'fk_diary_items_diary', 'INSERT INTO diary_items VALUES(?,?,3)', [missing, c3]);
      await fails('fk_diary_items_clothing', 1452, 'fk_diary_items_clothing', 'INSERT INTO diary_items VALUES(?,?,3)', [d1, missing]);
    });
    await test('B09', async () => {
      const d = await diary(a, '2026-11-03'); await insert('diary_items', { diary_id: d, clothing_id: c3, sort_order: 1 });
      const [row] = await q('SELECT source_outfit_id,mood,photo_path,note FROM diaries WHERE id=?', [d]); assert.deepEqual(row, { source_outfit_id: null, mood: null, photo_path: null, note: '' }); assert.equal((await q('SELECT clothing_id FROM diary_items WHERE diary_id=?', [d]))[0].clothing_id, c3); steps.push({ label: 'NULL fields and independent items', status: 'passed' });
    });
    await test('B10', async () => {
      for (const season of ['春', '夏', '秋', '冬', '春夏', '春秋', '秋冬', '四季']) {
        await q('UPDATE clothes SET season=? WHERE id=?', [season, c1]); assert.equal((await q('SELECT season FROM clothes WHERE id=?', [c1]))[0].season, season); steps.push({ label: `allowed season ${season}`, status: 'passed' });
      }
      await fails('clothing archive', 3819, 'ck_clothes_archived', 'UPDATE clothes SET is_archived=2 WHERE id=?', [c1]);
      await fails('outfit archive', 3819, 'ck_outfits_archived', 'UPDATE outfits SET is_archived=2 WHERE id=?', [o]);
      await fails('season enum', 3819, 'ck_clothes_season', "UPDATE clothes SET season='雨季' WHERE id=?", [c1]);
    });
    await test('B11', async () => {
      const before = await snapshot(); await q('DELETE FROM diaries WHERE id=?', [d1]); const after = await snapshot();
      for (const t of tables) assert.deepEqual(after[t], t === 'diaries' ? before[t].filter(r => r.id !== d1) : t === 'diary_items' ? before[t].filter(r => r.diary_id !== d1) : before[t]);
      steps.push({ label: 'only target diary and its items deleted', status: 'passed' });
    });
    await test('B12', async () => {
      for (const [key, prepare, sql, params] of [
        ['fk_outfit_items_clothing', 'DELETE FROM diary_items WHERE clothing_id=?', 'DELETE FROM clothes WHERE id=?', [c1]],
        ['fk_diary_items_clothing', 'DELETE FROM outfit_items WHERE clothing_id=?', 'DELETE FROM clothes WHERE id=?', [c1]],
        ['fk_diaries_source', 'DELETE FROM outfit_items WHERE outfit_id=?', 'DELETE FROM outfits WHERE id=?', [o]],
      ]) {
        await c.query('SAVEPOINT restrict_case'); await q(prepare, params); const state = await snapshot(); await fails(key, 1451, key, sql, params); assert.deepEqual(await snapshot(), state); await c.query('ROLLBACK TO SAVEPOINT restrict_case'); await c.query('RELEASE SAVEPOINT restrict_case');
      }
    });
    await test('B13', async () => {
      const state = await snapshot();
      for (const archived of [1, 0]) {
        await q('UPDATE clothes SET is_archived=? WHERE id=?', [archived, c1]); await q('UPDATE outfits SET is_archived=? WHERE id=?', [archived, o]); const current = await snapshot();
        assert.equal(current.clothes.find(r => r.id === c1).is_archived, archived); assert.equal(current.outfits.find(r => r.id === o).is_archived, archived);
        for (const t of ['outfit_items', 'diary_items', 'diaries']) assert.deepEqual(current[t], state[t]); steps.push({ label: `archive=${archived}, relations preserved`, status: 'passed' });
      }
    });
    await test('B14', async () => {
      for (const [main, items, parent, id, key] of [['outfits', 'outfit_items', 'outfit_id', o, 'uq_outfit_items_order'], ['diaries', 'diary_items', 'diary_id', d1, 'uq_diary_items_order']]) {
        const state = await snapshot(); await c.query('SAVEPOINT atomic_case'); await q(`UPDATE ${main} SET note='changed',updated_at='2026-11-06 01:00:00.000' WHERE id=?`, [id]); await q(`DELETE FROM ${items} WHERE ${parent}=?`, [id]); await insert(items, { [parent]: id, clothing_id: c3, sort_order: 1 }); await fails(`${main} partial failure`, 1062, key, `INSERT INTO ${items} VALUES(?,?,1)`, [id, c2]); await c.query('ROLLBACK TO SAVEPOINT atomic_case'); await c.query('RELEASE SAVEPOINT atomic_case'); assert.deepEqual(await snapshot(), state);
        await c.query('SAVEPOINT create_case'); const created = main === 'outfits' ? await outfit(a) : await diary(a, '2026-11-02'); await insert(items, { [parent]: created, clothing_id: c3, sort_order: 1 }); await c.query('ROLLBACK TO SAVEPOINT create_case'); await c.query('RELEASE SAVEPOINT create_case'); assert.deepEqual(await snapshot(), state); steps.push({ label: `${main} create/update rollback atomic`, status: 'passed' });
      }
    });
    await test('B15', async () => {
      const [cl] = await q('SELECT note,is_archived FROM clothes WHERE id=?', [c1]); assert.deepEqual(cl, { note: '', is_archived: 0 });
      const [u] = await q('SELECT avatar_path,auth_token_hash,auth_expires_at FROM users WHERE id=?', [a]); assert.deepEqual(u, { avatar_path: null, auth_token_hash: null, auth_expires_at: null });
      await fails('nickname NULL', 1048, 'nickname', 'UPDATE users SET nickname=NULL WHERE id=?', [a]);
      await q('UPDATE clothes SET note=? WHERE id=?', ['中文与🌸', c1]); assert.equal((await q('SELECT note FROM clothes WHERE id=?', [c1]))[0].note, '中文与🌸'); steps.push({ label: 'defaults and utf8mb4 roundtrip', status: 'passed' });
    });
  } finally {
    await c.rollback();
    report.cleanup.afterSameConnection = await counts(c);
    report.cleanup.autoIncrementAfter = await nextValues();
    report.cleanup.rolledBack = true;
  }
  assert(Object.values(report.cleanup.afterSameConnection).every(n => n === 0));
}

async function main() {
  const mode = process.argv[2];
  if (!mode) { console.log('Usage: node database/verify-schema.mjs --preflight|--structure|--constraints'); return; }
  assert.equal(process.argv.length, 3);
  assert(['--preflight', '--structure', '--constraints'].includes(mode));
  for (const key of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME']) assert(process.env[key], `missing ${key}`);
  assert.equal(process.env.DB_NAME, db); assert.equal(process.env.DB_HOST, '127.0.0.1'); assert.equal(process.env.DB_PORT, '3306');
  assert(process.env.DB_PASSWORD !== undefined, 'DB_PASSWORD must be supplied privately in this process environment');
  const password = process.env.DB_PASSWORD;
  const config = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password, charset: 'utf8mb4', timezone: 'Z', dateStrings: true, multipleStatements: false };
  const runId = process.env.P202_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
  assert.match(runId, /^[a-zA-Z0-9_-]+$/);
  const out = path.join(root, 'docs/evidence/P2-02', runId); fs.mkdirSync(out, { recursive: true });
  const report = { runId, mode, executedAt: new Date().toISOString(), status: 'running', hashes: Object.fromEntries(['database/schema.sql', 'database/verify-schema.mjs', 'database/package-lock.json', 'docs/数据库设计.md'].map(p => [p, hash(p)])) };
  let connection;
  try {
    connection = await mysql.createConnection(config);
    // The handshake collation occupies one byte; select collation 278 after connecting.
    await connection.query('SET NAMES utf8mb4 COLLATE utf8mb4_0900_as_cs');
    await connection.query("SET SESSION time_zone='+00:00'");
    await connection.query('SET SESSION information_schema_stats_expiry=0');
    report.environment = await inspect(connection); validateEnvironment(report.environment);
    if (mode === '--preflight') {
      if (!report.environment.schemas.length) report.decision = 'create database and seven tables after SQL review';
      else {
        assert.equal(report.environment.schemas[0].DEFAULT_COLLATION_NAME, coll);
        for (const rows of Object.values(report.environment.extras)) assert.equal(rows.length, 0);
        if (!report.environment.objects.length) report.decision = 'existing empty database; create tables after ownership review';
        else { report.structure = await structure(connection, report.environment); report.counts = await counts(connection); assert(Object.values(report.counts).every(n => n === 0), 'existing business data; stop writes'); report.decision = 'reuse matching empty structure; no DDL rerun'; }
      }
    } else {
      report.structure = await structure(connection, report.environment);
      if (mode === '--constraints') {
        await behavior(connection, report);
        await connection.end(); connection = undefined;
        connection = await mysql.createConnection(config);
        await connection.query('SET NAMES utf8mb4 COLLATE utf8mb4_0900_as_cs');
        await connection.query("SET SESSION time_zone='+00:00'");
        await connection.query('SET SESSION information_schema_stats_expiry=0');
        report.cleanup.afterReconnect = await counts(connection); assert(Object.values(report.cleanup.afterReconnect).every(n => n === 0));
        report.postStructure = await structure(connection, await inspect(connection));
      }
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.error = { name: error.name, code: error.code, errno: error.errno, sqlState: error.sqlState, message: error.message };
    process.exitCode = 1;
  } finally {
    if (connection) await connection.end();
    report.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, mode.slice(2) + '.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ runId, mode, status: report.status, decision: report.decision, behavior: report.behavior?.map(r => ({ id: r.id, status: r.status })), error: report.error }));
}

if (import.meta.main) await main();
