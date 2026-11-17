import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { serverRoot } from '../src/config.js';
import { start } from '../src/index.js';
import { createDatabase } from '../src/db.js';
import { createOutfitService } from '../src/services/outfits.js';
import { utcSql } from '../src/services/account.js';

const root = path.dirname(serverRoot), hash = value => createHash('sha256').update(value).digest('hex');
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const keyOf = row => row.id ?? `${row.outfit_id ?? row.diary_id}:${row.clothing_id}`;
const permissions = {
  users: ['nickname', 'avatar_path', 'auth_token_hash', 'auth_expires_at', 'updated_at'],
  clothes: ['category_id', 'name', 'image_path', 'color', 'season', 'note', 'is_archived', 'updated_at'],
  outfits: ['name', 'occasion', 'note', 'is_archived', 'updated_at'],
  outfit_items: ['clothing_id', 'sort_order'], diaries: [], diary_items: [],
};

export function fixtureManifestRows(all, fixture) {
  const owners = new Set(Object.values(fixture.accounts).map(account => account.id));
  const expected = {
    users: new Set([...owners].map(String)), clothes: new Set(Object.values(fixture.clothes).map(row => String(row.id))),
    outfits: new Set(Object.values(fixture.outfits).map(row => String(row.id))),
    diaries: new Set(Object.values(fixture.diaries).map(row => String(row.id))),
    outfit_items: new Set(Object.values(fixture.outfits).flatMap(row => row.clothingIds.map(id => row.id + ':' + id))),
    diary_items: new Set(Object.values(fixture.diaries).flatMap(row => row.clothingIds.map(id => row.id + ':' + id))),
  };
  const parentOwners = new Map([...all.outfits, ...all.diaries].map(row => [row.id + ':' + (Object.hasOwn(row, 'wear_date') ? 'diary' : 'outfit'), row.user_id]));
  const rows = [], unknownRows = [], missingRows = [];
  for (const [table, allowed] of Object.entries(expected)) {
    const seen = new Set();
    for (const row of all[table]) {
      const ownerId = table === 'users' ? row.id : row.user_id ?? parentOwners.get((row.outfit_id ?? row.diary_id) + ':' + (row.outfit_id ? 'outfit' : 'diary'));
      if (!owners.has(ownerId)) continue;
      const key = String(keyOf(row));
      if (!allowed.has(key)) { unknownRows.push({ table, key, ownerId }); continue; }
      seen.add(key);
      if (table.endsWith('_items')) {
        const registry = table === 'outfit_items' ? fixture.outfits : fixture.diaries, parentId = row.outfit_id ?? row.diary_id;
        const parent = Object.values(registry).find(value => value.id === parentId);
        if (row.sort_order !== parent.clothingIds.indexOf(row.clothing_id) + 1) { unknownRows.push({ table, key, ownerId, reason: 'UNREGISTERED_ORDER' }); continue; }
      }
      rows.push({ table, ownerId, row: { key: keyOf(row), sha256: hash(JSON.stringify(row)), ...(row.user_id === undefined ? {} : { userId: row.user_id }) },
        beforeSha256: null, allowedFields: permissions[table], changedFields: [] });
    }
    for (const key of allowed) if (!seen.has(key)) missingRows.push({ table, key });
  }
  return { rows, unknownRows, missingRows };
}

async function outfitRows(connection, userId, id) {
  const [parents] = await connection.execute('SELECT * FROM outfits WHERE user_id=? AND id=?', [userId, id]);
  const [items] = await connection.execute('SELECT i.* FROM outfit_items i JOIN outfits p ON p.id=i.outfit_id WHERE p.user_id=? AND p.id=? ORDER BY i.sort_order', [userId, id]);
  return { parents, items };
}

// 用真实连接执行生产服务的SQL，再在已发生写入的位置抛错；不向HTTP/环境配置暴露注入入口。
async function rollbackChecks(database, config, a, form, targetId, directory) {
  const reports = [];
  for (const operation of ['create', 'update']) {
    const beforeConnection = await database.getConnection();
    let before;
    try { before = await outfitRows(beforeConnection, a.id, targetId); } finally { beforeConnection.release(); }
    const expectedError = Object.assign(new Error('P5_CONTROLLED_' + operation.toUpperCase()), { code: 'P5_CONTROLLED_' + operation.toUpperCase() });
    let insertedId, itemWrites = 0, triggered = false, sameConnection;
    const wrapped = { async getConnection() {
      const connection = await database.getConnection();
      return {
        beginTransaction: () => connection.beginTransaction(), query: (...args) => connection.query(...args), commit: () => connection.commit(), release: () => connection.release(),
        async execute(sql, values) {
          const result = await connection.execute(sql, values);
          if (sql.startsWith('INSERT INTO outfits ')) insertedId = result[0].insertId;
          if (operation === 'create' && sql.startsWith('INSERT INTO outfit_items ')) itemWrites++;
          if ((operation === 'create' && itemWrites === 2) || (operation === 'update' && sql.startsWith('DELETE FROM outfit_items '))) {
            triggered = true;
            const during = await outfitRows(connection, a.id, operation === 'create' ? insertedId : targetId);
            assert.equal(during.parents.length, 1);
            assert.equal(during.items.length, operation === 'create' ? 2 : 0);
            if (operation === 'update') assert.equal(during.parents[0].name, form.name);
            throw expectedError;
          }
          return result;
        },
        async rollback() {
          await connection.rollback();
          sameConnection = await outfitRows(connection, a.id, operation === 'create' ? insertedId : targetId);
        },
      };
    } };
    const service = createOutfitService(wrapped, config);
    await assert.rejects(operation === 'create' ? service.create(a.id, form) : service.update(a.id, targetId, form), error => error === expectedError);
    assert.equal(triggered, true);
    const expected = operation === 'create' ? { parents: [], items: [] } : before;
    assert.deepEqual(sameConnection, expected, 'SAME_CONNECTION_ROLLBACK:' + operation);
    const freshDatabase = createDatabase(config), fresh = await freshDatabase.getConnection();
    let newConnection;
    try { newConnection = await outfitRows(fresh, a.id, operation === 'create' ? insertedId : targetId); }
    finally { fresh.release(); await freshDatabase.end(); }
    assert.deepEqual(newConnection, expected, 'NEW_CONNECTION_ROLLBACK:' + operation);
    reports.push({ operation, point: operation === 'create' ? 'parent and two items inserted' : 'parent updated and old items deleted',
      expectedError: expectedError.code, actualError: expectedError.code, userId: a.id, outfitId: operation === 'create' ? insertedId : targetId,
      parentWritesBeforeFailure: 1, itemWritesBeforeFailure: itemWrites, sameConnectionRestored: true, newConnectionRestored: true,
      beforeSha256: hash(JSON.stringify(expected)), sameConnectionSha256: hash(JSON.stringify(sameConnection)), newConnectionSha256: hash(JSON.stringify(newConnection)), passed: true });
  }
  await write(path.join(directory, 'rollback-results.json'), reports);
  return reports;
}

export async function verifyOutfitHttp({ runId, directory, baselineFile, config, database, gitState, verification }) {
  const { captureSnapshot, compareCumulative, loadManifests, historicalReleaseHashes } = verification;
  const baseline = JSON.parse(await fs.readFile(baselineFile, 'utf8')), priorManifests = await loadManifests();
  const previousReleases = JSON.parse(await fs.readFile(path.join(path.dirname(baselineFile), 'historical-release-hashes.json'), 'utf8'));
  assert.deepEqual(await historicalReleaseHashes(), previousReleases, 'HISTORICAL_LOCAL_RELEASES');
  const before = await captureSnapshot(database, config.uploadRoot);
  const preflight = compareCumulative(baseline, before, priorManifests);
  await write(path.join(directory, 'preflight.json'), { git: gitState, baselineSha256: hash(await fs.readFile(baselineFile)), ...preflight, snapshot: before });
  await write(path.join(directory, 'write-plan.json'), { runId, batch: 2, protectedStageBaseline: path.relative(root, baselineFile).replaceAll('\\', '/'),
    onlyNewDedicatedOwners: true, accountCount: 2, aClothes: 21, bClothes: 1, aOutfits: { active: 13, archived: 2 }, bOutfits: 1,
    directSql: ['one independent diary with two ordered items under A', 'expire B test session then relogin'],
    faultPoints: ['create after two items', 'update after deleting old items'], allowedFieldsForLaterBatches: permissions,
    retention: 'all committed rows and successful uploads retained; failed transactions rolled back; no original rows writable' });
  const accounts = [], images = [], checks = [], fixture = { runId, accounts: {}, clothes: {}, outfits: {}, diaries: {} };
  const saveRegistry = () => write(path.join(directory, 'fixture-map.json'), fixture);
  const manifest = { version: 1, sequence: Math.max(0, ...priorManifests.map(value => value.sequence)) + 1, runId, batch: 2,
    accounts: [], rows: [], images, allowedFields: permissions, allAccountsLoggedOut: false, processClosed: false };
  const saveManifest = async () => {
    const connection = await database.getConnection();
    const all = {};
    try {
      for (const table of Object.keys(permissions)) {
        const [rows] = await connection.query('SELECT * FROM ' + table); all[table] = rows;
      }
    } finally { connection.release(); }
    manifest.accounts = accounts.filter(account => account.id).map(({ id, username, role, loggedOut }) => ({ id, username, role, loggedOut, createdByRunId: runId }));
    const inventory = fixtureManifestRows(all, fixture);
    if (inventory.unknownRows.length || inventory.missingRows.length) {
      await write(path.join(directory, 'fixture-registry-failure.json'), { runId, unknownRows: inventory.unknownRows, missingRows: inventory.missingRows });
      throw Object.assign(new Error('UNREGISTERED_FIXTURE_ROWS'), { code: 'UNREGISTERED_FIXTURE_ROWS' });
    }
    manifest.rows = inventory.rows;
    await write(path.join(directory, 'manifest.json'), manifest);
    await saveRegistry();
  };
  let runtime, base, activeCheck = 'start', rollback;
  async function call(label, method, url, expected, account, body, { raw = false, code } = {}) {
    activeCheck = label;
    const response = await fetch(base + '/api' + url, { method, headers: { ...(account ? { Authorization: 'Bearer ' + account.token } : {}),
      ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : body instanceof FormData ? body : raw ? body : JSON.stringify(body) });
    const value = await response.json();
    checks.push({ id: 'HTTP-' + String(checks.length + 1).padStart(3, '0'), label, method, path: url, expectedStatus: expected, actualStatus: response.status,
      ...(code ? { expectedErrorCode: code } : {}), ...(value.error ? { actualErrorCode: value.error.code } : {}), passed: response.status === expected && (!code || value.error?.code === code) });
    await write(path.join(directory, 'http-results.json'), { runId, checks });
    assert.equal(response.status, expected, label); if (code) assert.equal(value.error?.code, code, label);
    return value.data ?? value.error;
  }
  const get = (label, url, account) => call(label, 'GET', url, 200, account);
  const reject = (label, method, url, account, body, code = 'INVALID_INPUT') => call(label, method, url, 400, account, body, { code });
  async function freshOrder(account, id, ids) {
    const freshDatabase = createDatabase(config), connection = await freshDatabase.getConnection();
    try {
      const state = await outfitRows(connection, account.id, id);
      assert.equal(state.parents.length, 1); assert.deepEqual(state.items.map(row => row.clothing_id), ids);
      assert.deepEqual(state.items.map(row => row.sort_order), ids.map((_, index) => index + 1));
      return state;
    } finally { connection.release(); await freshDatabase.end(); }
  }
  try {
    runtime = await start({ ...config, port: 0 }); base = 'http://127.0.0.1:' + runtime.server.address().port;
    await write(path.join(directory, 'process.json'), { ownership: 'in-process server created by this run', pid: process.pid, address: base, devtoolsUsed: false, devtoolsServicePortChanged: false });
    const privateDirectory = path.join(serverRoot, '.p5-private'); await fs.mkdir(privateDirectory, { recursive: true });
    const suffix = randomBytes(4).toString('hex');
    for (const role of ['a', 'b']) {
      const account = { username: 'p5_' + suffix + '_' + role, password: randomBytes(20).toString('hex'), role, loggedOut: false };
      accounts.push(account);
      // 密码先写本机私有文件，保证后续批次可登录；不保存跨批token。
      await write(path.join(privateDirectory, runId + '.json'), { runId, accounts: accounts.map(({ username, password, role, id }) => ({ username, password, role, id })) });
      const registered = await call('register ' + role, 'POST', '/auth/register', 201, null, { username: account.username, password: account.password, nickname: 'P5测试' + role });
      account.id = registered.id; fixture.accounts[role] = { id: account.id, username: account.username, createdByRunId: runId };
      await saveManifest();
      account.token = (await call('login ' + role, 'POST', '/auth/login', 200, null, { username: account.username, password: account.password })).token;
      const bytes = await fs.readFile(path.join(root, 'assets/clothes/clothing-001.jpg')), form = new FormData();
      form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'p5-fixture.jpg');
      const uploaded = await call('own upload ' + role, 'POST', '/uploads', 201, account, form); account.imagePath = uploaded.imagePath;
      const stored = await fs.readFile(path.join(config.uploadRoot, uploaded.imagePath));
      images.push({ userId: account.id, path: uploaded.imagePath, size: stored.length, mimeType: uploaded.mimeType, sha256: hash(stored), retained: true, references: [] });
      await saveManifest();
    }
    await write(path.join(privateDirectory, runId + '.json'), { runId, accounts: accounts.map(({ username, password, role, id }) => ({ username, password, role, id })) });
    const [a, b] = accounts, paths = [['GET', '/outfits'], ['GET', '/outfits/facets'], ['GET', '/outfits/1'], ['POST', '/outfits'], ['PUT', '/outfits/1'], ['PATCH', '/outfits/1/archive']];
    for (const [method, url] of paths) {
      for (const auth of [null, { token: randomBytes(32).toString('base64url') }]) await call('anonymous or invalid ' + method + url, method, url, 401, auth, undefined, { code: 'UNAUTHENTICATED' });
      if (method === 'GET') continue;
      for (const body of ['{', JSON.stringify({ note: 'x'.repeat(9000) })]) await call('anonymous malformed/oversized ' + method + url, method, url, 401, null, body, { raw: true, code: 'UNAUTHENTICATED' });
    }
    const expire = await database.getConnection();
    try { await expire.execute('UPDATE users SET auth_expires_at=? WHERE id=?', ['2020-01-01 00:00:00.000', b.id]); } finally { expire.release(); }
    for (const [method, url] of paths) await call('expired ' + method + url, method, url, 401, b, undefined, { code: 'UNAUTHENTICATED' });
    b.token = (await call('relogin B after expired test', 'POST', '/auth/login', 200, null, { username: b.username, password: b.password })).token;
    assert.deepEqual(await get('A empty', '/outfits', a), { items: [], page: 1, pageSize: 12, total: 0 });
    assert.deepEqual((await get('B empty facets', '/outfits/facets', b)).occasions, []);
    for (let index = 0; index < 21; index++) {
      const value = await call('create A clothing ' + (index + 1), 'POST', '/clothes', 201, a, { name: 'P5衣物' + (index + 1), categoryId: index < 13 ? 'tops' : index === 19 ? 'outerwear' : 'bottoms', imagePath: a.imagePath, color: '米白色', season: '四季', note: '' });
      fixture.clothes['A' + (index + 1)] = { id: value.id, userId: a.id };
      await saveRegistry();
    }
    const bClothing = await call('create B clothing', 'POST', '/clothes', 201, b, { name: 'B专属衣物', categoryId: 'tops', imagePath: b.imagePath, color: '黑色', season: '四季', note: '' });
    fixture.clothes.B1 = { id: bClothing.id, userId: b.id }; await saveRegistry();
    const ids = Array.from({ length: 21 }, (_, index) => fixture.clothes['A' + (index + 1)].id);
    await call('archive own clothing allowed in selection', 'PATCH', '/clothes/' + ids[19] + '/archive', 200, a, { isArchived: true });
    const definitions = [
      ['Alpha_%!日常', '通勤', ids.slice(0, 1)], ['ALPHA日常', '通勤长', ids.slice(0, 4)], ['P5五件', '休闲', [ids[4], ids[1], ids[19], ids[3], ids[0]]],
      ['P5二十件', '通勤', ids.slice(0, 20).reverse()], ['P5重复', '通勤', [ids[0]]], ['P5重复', '休闲', [ids[1]]],
      ...Array.from({ length: 6 }, (_, index) => ['P5分页' + (index + 1), index % 2 ? '休闲' : '通勤', [ids[index]]]),
      ['🧥'.repeat(40), '🎨'.repeat(20), [ids[19]]], ['P5归档一', '仅归档', ids.slice(0, 4)], ['P5归档二', '通勤', [ids[19]]],
    ];
    for (const [index, [name, occasion, clothingIds]] of definitions.entries()) {
      const note = index === 12 ? '📝'.repeat(500) : index === 2 ? ' 第一行\n第二行 ' : '';
      const value = await call('create outfit A' + (index + 1), 'POST', '/outfits', 201, a, { name: ' ' + name + ' ', occasion: ' ' + occasion + ' ', note, clothingIds });
      assert.equal(value.name, name); assert.equal(value.occasion, occasion); assert.equal(value.note, note); assert.equal(value.isArchived, false);
      assert.match(value.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/); assert.equal(value.createdAt, value.updatedAt);
      assert.deepEqual(Object.keys(value).sort(), ['id', 'name', 'occasion', 'note', 'isArchived', 'items', 'createdAt', 'updatedAt'].sort());
      assert.deepEqual(value.items.map(item => item.id), clothingIds);
      fixture.outfits['A' + (index + 1)] = { id: value.id, userId: a.id, clothingIds, initialName: name, occasion };
      await saveRegistry();
      if (index >= 13) await call('archive fixture A' + (index + 1), 'PATCH', '/outfits/' + value.id + '/archive', 200, a, { isArchived: true });
      await freshOrder(a, value.id, clothingIds);
    }
    const baseForm = { name: 'B隔离搭配', occasion: 'B专属场景', note: '', clothingIds: [bClothing.id] };
    const bOutfit = await call('create B own outfit', 'POST', '/outfits', 201, b, baseForm); fixture.outfits.B1 = { id: bOutfit.id, userId: b.id, clothingIds: [bClothing.id] }; await saveManifest();
    const first = await get('A active page 12', '/outfits', a), second = await get('A active page 1', '/outfits?page=2', a);
    assert.equal(first.total, 13); assert.equal(first.items.length, 12); assert.equal(second.items.length, 1);
    const expectedIds = Object.entries(fixture.outfits).filter(([key]) => /^A(?:[1-9]|1[0-3])$/.test(key)).map(([, value]) => value.id).sort((x, y) => y - x);
    assert.deepEqual([...first.items, ...second.items].map(item => item.id), expectedIds);
    for (const [query, length] of [['pageSize=1', 1], ['pageSize=50', 13], ['page=3', 0]]) { const value = await get('pagination ' + query, '/outfits?' + query, a); assert.equal(value.total, 13); assert.equal(value.items.length, length); }
    for (const [query, count] of [['archived=archived', 2], ['archived=all', 15], ['keyword=alpha', 2], ['keyword=ALPHA', 2], ['keyword=' + encodeURIComponent('_%!'), 1], ['keyword=%25', 1], ['keyword=_', 1], ['keyword=!', 1], ['occasion=' + encodeURIComponent('通勤长'), 1], ['occasion=' + encodeURIComponent('通'), 0], ['keyword=alpha&occasion=' + encodeURIComponent('通勤') + '&archived=active', 1], ['keyword=does-not-exist', 0], ["keyword=' OR 1=1 --", 0], ['keyword=', 13]]) {
      assert.equal((await get('filter ' + query, '/outfits?' + query, a)).total, count);
    }
    const sql = await database.getConnection();
    try {
      for (const scope of ['active', 'archived', 'all']) {
        const [rows] = await sql.execute('SELECT DISTINCT occasion FROM outfits WHERE user_id=?' + (scope === 'all' ? '' : ' AND is_archived=?') + ' ORDER BY occasion', scope === 'all' ? [a.id] : [a.id, scope === 'archived' ? 1 : 0]);
        assert.deepEqual((await get('facets ' + scope, '/outfits/facets?archived=' + scope, a)).occasions, rows.map(row => row.occasion));
      }
    } finally { sql.release(); }
    assert.deepEqual((await get('facets B isolated', '/outfits/facets?archived=all', b)).occasions, ['B专属场景']);
    for (const key of ['A1', 'A2', 'A3', 'A4']) {
      const entry = fixture.outfits[key], detail = await get('detail full ordered ' + key, '/outfits/' + entry.id, a);
      const summary = (await get('summary ' + key, '/outfits?archived=all&pageSize=50', a)).items.find(item => item.id === entry.id);
      assert.deepEqual(detail.items.map(item => item.id), entry.clothingIds); assert.equal(summary.clothingCount, entry.clothingIds.length);
      assert.deepEqual(summary.previewItems, detail.items.slice(0, 4));
      assert.deepEqual(Object.keys(summary).sort(), ['id', 'name', 'occasion', 'isArchived', 'clothingCount', 'previewItems'].sort());
      for (const item of detail.items) {
        assert.equal(typeof item.id, 'number'); assert.equal(typeof item.isArchived, 'boolean'); assert.equal(item.imagePath, a.imagePath);
        assert.equal(item.imageUrl, config.publicBaseUrl + '/api/media/' + a.imagePath.split('/').at(-1));
        assert.deepEqual(Object.keys(item).sort(), ['id', 'name', 'categoryId', 'color', 'season', 'imagePath', 'imageUrl', 'isArchived'].sort());
      }
    }
    for (const account of accounts) {
      const response = await fetch(base + '/api/media/' + account.imagePath.split('/').at(-1), { headers: { Authorization: 'Bearer ' + account.token } });
      assert.equal(response.status, 200); assert.equal(hash(Buffer.from(await response.arrayBuffer())), images.find(image => image.userId === account.id).sha256);
    }
    const target = fixture.outfits.A5, form = { name: '更新后的搭配', occasion: '通勤', note: '修改\n保留换行', clothingIds: [ids[4], ids[2], ids[0]] };
    for (const [account, foreign] of [[b, target.id], [a, bOutfit.id]]) {
      for (const id of [foreign, 4294967295]) {
        const errors = [];
        for (const [method, url, body] of [['GET', '/outfits/' + id], ['PUT', '/outfits/' + id, { ...form, clothingIds: [4294967295] }], ['PATCH', '/outfits/' + id + '/archive', { isArchived: true }]]) errors.push(await call('foreign/missing unified ' + method + id, method, url, 404, account, body, { code: 'NOT_FOUND' }));
        assert.ok(errors.every(error => error.message === '搭配不存在或无法访问' && !error.details));
      }
    }
    assert.equal((await get('B only own', '/outfits?archived=all', b)).total, 1);
    const unchanged = await captureSnapshot(database, config.uploadRoot);
    for (const clothingIds of [[ids[0], bClothing.id], [ids[0], 4294967295]]) for (const method of ['POST', 'PUT']) {
      const error = await reject('invalid selection ownership ' + method, method, '/outfits' + (method === 'PUT' ? '/' + target.id : ''), a, { ...form, clothingIds }, 'INVALID_SELECTION');
      assert.deepEqual(Object.keys(error.details.fields), ['clothingIds']); assert.ok(!JSON.stringify(error).includes('B专属'));
    }
    const afterRejected = await captureSnapshot(database, config.uploadRoot); assert.deepEqual(afterRejected.tables, unchanged.tables, 'INVALID_SELECTION_NO_WRITES');
    const badQueries = [{ page: '' }, { page: '0' }, { page: '-1' }, { page: '1.5' }, { page: '1e2' }, { page: '9007199254740992' }, { page: '9007199254740991', pageSize: '50' }, { pageSize: '' }, { pageSize: '0' }, { pageSize: '51' }, { keyword: '🧥'.repeat(41) }, { occasion: '' }, { occasion: ' ' }, { occasion: 'x'.repeat(21) }, { occasion: 'a\nb' }, { archived: '' }, { archived: 'true' }, { extra: 'x' }];
    for (const query of badQueries) await reject('reject query ' + JSON.stringify(query), 'GET', '/outfits?' + new URLSearchParams(query), a);
    for (const query of ['page=1&page=2', 'keyword=a&keyword=b', 'keyword[x]=a', 'occasion[x]=a', 'archived=active&archived=all']) await reject('reject structured query ' + query, 'GET', '/outfits?' + query, a);
    for (const query of ['keyword=x', 'archived=', 'archived=active&archived=all']) await reject('reject facets query ' + query, 'GET', '/outfits/facets?' + query, a);
    for (const id of ['0', '-1', '1e2', '1.5', '4294967296', 'abc']) for (const [method, body, suffix] of [['GET', undefined, ''], ['PUT', form, ''], ['PATCH', { isArchived: true }, '/archive']]) await reject('reject ID ' + method + id, method, '/outfits/' + id + suffix, a, body);
    for (const [method, url, body] of [['GET', '/outfits/' + target.id + '?x=1'], ['POST', '/outfits?x=1', form], ['PUT', '/outfits/' + target.id + '?x=1', form], ['PATCH', '/outfits/' + target.id + '/archive?x=1', { isArchived: true }]]) await reject('reject extra query ' + method, method, url, a, body);
    for (const [body, status] of [['{', 400], [JSON.stringify({ note: 'x'.repeat(9000) }), 413]]) for (const [method, url] of [['POST', '/outfits'], ['PUT', '/outfits/' + target.id], ['PATCH', '/outfits/' + target.id + '/archive']]) await call('authenticated malformed/oversized ' + method, method, url, status, a, body, { raw: true, code: 'INVALID_INPUT' });
    for (const patch of [{ name: '' }, { name: ' ' }, { name: '🧥'.repeat(41) }, { name: 'a\nb' }, { name: 'a\rb' }, { occasion: '🎨'.repeat(21) }, { occasion: 'a\u2028b' }, { note: '📝'.repeat(501) }, { note: null }, { userId: b.id }, { isArchived: true }, { clothingIds: ['1'] }, { clothingIds: [1.5] }, { clothingIds: [0] }, { clothingIds: [4294967296] }, { clothingIds: null }]) await reject('reject form ' + JSON.stringify(patch), 'PUT', '/outfits/' + target.id, a, { ...form, ...patch });
    for (const key of Object.keys(form)) for (const method of ['POST', 'PUT']) { const body = { ...form }; delete body[key]; await reject('reject missing ' + method + key, method, '/outfits' + (method === 'PUT' ? '/' + target.id : ''), a, body); }
    for (const clothingIds of [[], [ids[0], ids[0]], ids]) for (const method of ['POST', 'PUT']) await reject('selection cardinality ' + method + clothingIds.length, method, '/outfits' + (method === 'PUT' ? '/' + target.id : ''), a, { ...form, clothingIds }, 'INVALID_SELECTION');
    for (const body of [{}, { isArchived: 1 }, { isArchived: 'true' }, { isArchived: null }, { isArchived: false, name: 'x' }]) await reject('archive boolean ' + JSON.stringify(body), 'PATCH', '/outfits/' + target.id + '/archive', a, body);
    const diaryConnection = await database.getConnection();
    try {
      await diaryConnection.beginTransaction(); const time = utcSql(new Date());
      const [result] = await diaryConnection.execute('INSERT INTO diaries (user_id,wear_date,source_outfit_id,occasion,mood,photo_path,note,created_at,updated_at) VALUES (?,?,?,?,?,NULL,?,?,?)', [a.id, '2026-10-09', target.id, '独立历史', '轻松', '实际衣物与来源不同，非D接口', time, time]);
      fixture.diaries.A1 = { id: result.insertId, userId: a.id, sourceOutfitId: target.id, wearDate: '2026-10-09', clothingIds: [ids[19], ids[1]] };
      for (const [index, clothingId] of fixture.diaries.A1.clothingIds.entries()) await diaryConnection.execute('INSERT INTO diary_items (diary_id,clothing_id,sort_order) VALUES (?,?,?)', [result.insertId, clothingId, index + 1]);
      await diaryConnection.commit();
    } catch (error) { await diaryConnection.rollback(); throw error; }
    finally { diaryConnection.release(); }
    await saveManifest();
    const historyBefore = await captureSnapshot(database, config.uploadRoot), statsBefore = [];
    for (const id of ids) { const value = await get('wear before ' + id, '/clothes/' + id, a); statsBefore.push({ id, wearCount: value.wearCount, lastWornDate: value.lastWornDate }); }
    const original = await get('target before edit', '/outfits/' + target.id, a);
    const edited = await call('edit reorder remove reselect', 'PUT', '/outfits/' + target.id, 200, a, form);
    assert.equal(edited.createdAt, original.createdAt); assert.equal(edited.isArchived, original.isArchived);
    assert.deepEqual(edited.items.map(item => item.id), form.clothingIds); target.clothingIds = form.clothingIds;
    const editedSql = await freshOrder(a, target.id, form.clothingIds); assert.equal(editedSql.parents[0].name, form.name); assert.equal(editedSql.parents[0].user_id, a.id);
    const archived = await call('archive target', 'PATCH', '/outfits/' + target.id + '/archive', 200, a, { isArchived: true });
    const repeated = await call('repeat archive is idempotent', 'PATCH', '/outfits/' + target.id + '/archive', 200, a, { isArchived: true }); assert.deepEqual(repeated, archived);
    const archivedSql = await freshOrder(a, target.id, form.clothingIds);
    for (const field of Object.keys(editedSql.parents[0]).filter(field => !['is_archived', 'updated_at'].includes(field))) assert.equal(archivedSql.parents[0][field], editedSql.parents[0][field]);
    assert.deepEqual(archivedSql.items, editedSql.items);
    const archivedEdit = await call('edit archived without implicit restore', 'PUT', '/outfits/' + target.id, 200, a, { ...form, note: '' }); assert.equal(archivedEdit.isArchived, true); assert.equal(archivedEdit.note, '');
    await call('restore target', 'PATCH', '/outfits/' + target.id + '/archive', 200, a, { isArchived: false });
    const restoreRepeat = await call('repeat restore', 'PATCH', '/outfits/' + target.id + '/archive', 200, a, { isArchived: false });
    assert.equal(restoreRepeat.isArchived, false);
    rollback = await rollbackChecks(database, config, a, { ...form, name: '故障必须回滚', clothingIds: ids.slice(0, 5) }, target.id, directory);
    const historyAfter = await captureSnapshot(database, config.uploadRoot);
    assert.deepEqual(historyAfter.tables.diaries, historyBefore.tables.diaries); assert.deepEqual(historyAfter.tables.diary_items, historyBefore.tables.diary_items);
    const statsAfter = [];
    for (const id of ids) { const value = await get('wear after ' + id, '/clothes/' + id, a); statsAfter.push({ id, wearCount: value.wearCount, lastWornDate: value.lastWornDate }); }
    assert.deepEqual(statsAfter, statsBefore);
    await write(path.join(directory, 'sql-results.json'), { freshConnectionOrders: Object.values(fixture.outfits), targetAfterEdit: editedSql,
      archiveAllowedFieldsOnly: true, archivedItemsUnchanged: true, diarySha256Before: hash(JSON.stringify([historyBefore.tables.diaries, historyBefore.tables.diary_items])), diarySha256After: hash(JSON.stringify([historyAfter.tables.diaries, historyAfter.tables.diary_items])),
      statsBefore, statsAfter, diaryFieldsAndItemsUnchanged: true, statisticsUnchanged: true, failedSelectionNoWrites: true });
    for (const url of ['/diaries', '/statistics', '/statistics/overview']) for (const account of [null, a]) await call('unimplemented remains 404 ' + url, 'GET', url, 404, account, undefined, { code: 'NOT_FOUND' });
    await call('wrong password stays credential error', 'POST', '/auth/login', 401, null, { username: a.username, password: 'wrong-password' }, { code: 'INVALID_CREDENTIALS' });
    await write(path.join(directory, 'run-state.json'), { runId, batch: 2, status: 'backend-passed', httpCases: checks.length, stage5Complete: false, pending: ['Batch 3～5原生页面和联动', 'Batch 6完整集成/重启/历史迁移', 'Batch 7工具/视觉/发布'] });
  } catch (error) {
    await write(path.join(directory, 'run-state.json'), { runId, batch: 2, status: 'failed', activeCheck, errorName: error.name, errorCode: error.code ?? null });
    throw error;
  } finally {
    if (runtime) {
      for (const account of accounts.filter(account => account.token)) {
        const response = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + account.token } });
        account.loggedOut = response.status === 200;
      }
      manifest.allAccountsLoggedOut = accounts.every(account => account.loggedOut);
      await runtime.close(); manifest.processClosed = true;
    }
    await saveManifest();
  }
  assert.equal(manifest.allAccountsLoggedOut, true); assert.equal(manifest.processClosed, true);
  const final = await captureSnapshot(database, config.uploadRoot);
  for (const image of images) {
    image.references = Object.entries(fixture.clothes).filter(([, item]) => item.userId === image.userId).map(([key, item]) => ({ clothingId: item.id, key }));
    assert.equal(image.references.length, image.userId === accounts[0].id ? 21 : 1);
  }
  await saveManifest();
  const protection = compareCumulative(baseline, final, [...priorManifests, manifest]);
  assert.deepEqual(await historicalReleaseHashes(), previousReleases, 'HISTORICAL_LOCAL_RELEASES');
  await write(path.join(directory, 'snapshot.json'), final);
  const implementationFiles = ['src/services/outfits.js', 'src/routes/outfits.js', 'src/app.js', 'src/index.js', 'scripts/verify-outfits.mjs', 'scripts/outfit-http.mjs'];
  const implementationSha256 = {};
  for (const file of implementationFiles) implementationSha256['server/' + file] = hash(await fs.readFile(path.join(serverRoot, file)));
  const results = { runId, batch: 2, gitBase: gitState.startCommit, checkedAt: new Date().toISOString(), passed: true, stage5Complete: false,
    httpCases: checks.length, rollbackCases: rollback.length, accountsLoggedOut: true, processClosed: true, protection: { ...protection, historicalLocalReportsUnchanged: true },
    counts: Object.fromEntries(Object.entries(final.tables).map(([table, state]) => [table, state.count])), totalImages: Object.keys(final.images).length,
    baselineSha256: hash(await fs.readFile(baselineFile)), implementationSha256,
    privateLogin: 'server/.p5-private/' + runId + '.json (ignored; passwords only, no tokens)', fixtureMap: 'fixture-map.json',
    verification: 'real local HTTP and MySQL; same/new physical connection rollback; no native UI or real device/public network claim',
    currentHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() };
  await write(path.join(directory, 'results.json'), results);
  console.log(JSON.stringify({ runId, httpCases: results.httpCases, rollbackCases: results.rollbackCases, passed: true, protection }));
}
