import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutfitService } from '../src/services/outfits.js';

const parent = { id: 91, user_id: 7, name: '日常', occasion: '通勤', note: '', is_archived: 0, created_at: '2026-11-17 01:02:03.004', updated_at: '2026-11-17 01:02:03.004' };
const item = { parentId: 91, id: 4, name: '针织', category_id: 'tops', color: '白色', season: '四季', image_path: 'users/7/own.jpg', is_archived: 1 };
const config = { publicBaseUrl: 'http://127.0.0.1:3000' }, now = () => new Date('2026-11-17T02:03:04.005Z');
const form = { name: '新版', occasion: '日常', note: '两行\n备注', clothingIds: [4, 2] };

function fixture(execute, { commitError } = {}) {
  const events = [];
  const connection = {
    async query(sql) { events.push({ sql }); }, async beginTransaction() { events.push({ sql: 'BEGIN' }); },
    async execute(sql, values) { events.push({ sql, values }); return [await execute(sql, values)]; },
    async commit() { events.push({ sql: 'COMMIT' }); if (commitError) throw commitError; },
    async rollback() { events.push({ sql: 'ROLLBACK' }); }, release() { events.push({ sql: 'RELEASE' }); },
  };
  return { service: createOutfitService({ getConnection: async () => connection }, config, now), events };
}
test('outfit list shares one consistent read snapshot and one batched owner-scoped child query', async () => {
  const { service, events } = fixture((sql, values) => {
    if (sql.startsWith('SELECT COUNT')) { assert.deepEqual(values, [7, 0, '%alpha!_!%!!%', '通勤']); return [{ total: '2' }]; }
    if (sql.startsWith('SELECT *')) return [parent, { ...parent, id: 90 }];
    assert.match(sql, /p.user_id=\? AND c.user_id=\?/); assert.deepEqual(values, [7, 7, 91, 90]);
    return Array.from({ length: 5 }, (_, i) => ({ ...item, id: i + 1 }));
  });
  const result = await service.list(7, { archived: 'active', keyword: 'Alpha_%!', occasion: '通勤', page: 1, pageSize: 12, offset: 0 });
  assert.equal(result.total, 2); assert.equal(result.items[0].clothingCount, 5); assert.equal(result.items[0].previewItems.length, 4);
  assert.equal(result.items[1].clothingCount, 0); assert.equal(result.items[0].previewItems[0].isArchived, true);
  assert.equal(events.filter(event => event.values).length, 3);
  assert.deepEqual(events.slice(0, 2).map(event => event.sql), ['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY']);
  assert.deepEqual(events.slice(-2).map(event => event.sql), ['COMMIT', 'RELEASE']);
});
test('empty outfit page does not issue a child query and facets use only owner/archive scope', async () => {
  const empty = fixture(sql => sql.startsWith('SELECT COUNT') ? [{ total: 0 }] : []);
  assert.deepEqual((await empty.service.list(7, { archived: 'all', keyword: '', page: 9, pageSize: 1, offset: 8 })).items, []);
  assert.equal(empty.events.filter(event => event.values).length, 2);
  const facets = fixture((sql, values) => { assert.match(sql, /SELECT DISTINCT occasion.*ORDER BY occasion/); assert.deepEqual(values, [7, 1]); return [{ occasion: '通勤' }]; });
  assert.deepEqual(await facets.service.facets(7, 'archived'), { occasions: ['通勤'] });
});
test('create validates ownership once and persists input order with actual insert ID before commit', async () => {
  const { service, events } = fixture((sql, values) => {
    if (sql.startsWith('SELECT id FROM clothes')) { assert.deepEqual(values, [7, 4, 2]); return [{ id: 2 }, { id: 4 }]; }
    if (sql.startsWith('INSERT INTO outfits ')) return { insertId: 91 };
    if (sql.startsWith('INSERT INTO outfit_items ')) return {};
    if (sql.startsWith('SELECT * FROM outfits')) return [parent];
    return [item, { ...item, id: 2 }];
  });
  const result = await service.create(7, form); assert.equal(result.id, 91); assert.deepEqual(result.items.map(value => value.id), [4, 2]);
  assert.deepEqual(events.filter(event => event.sql.startsWith('INSERT INTO outfit_items ')).map(event => event.values), [[91, 4, 1], [91, 2, 2]]);
  assert.equal(events.filter(event => event.sql.startsWith('SELECT id FROM clothes')).length, 1);
  assert.deepEqual(events.slice(-2).map(event => event.sql), ['COMMIT', 'RELEASE']);
});
test('update locks owned parent before any selection lookup, then replaces only that ordered relation', async () => {
  const { service, events } = fixture(sql => {
    if (sql.startsWith('SELECT * FROM outfits')) return [parent];
    if (sql.startsWith('SELECT id FROM clothes')) return [{ id: 4 }, { id: 2 }];
    if (sql.startsWith('SELECT i.')) return [item];
    return {};
  });
  await service.update(7, 91, form);
  assert.equal(events[1].sql, 'SELECT * FROM outfits WHERE id=? AND user_id=? FOR UPDATE'); assert.deepEqual(events[1].values, [91, 7]);
  const writes = events.filter(event => /^(UPDATE|DELETE|INSERT)/.test(event.sql));
  assert.match(writes[0].sql, /WHERE id=\? AND user_id=\?$/); assert.deepEqual(writes[1], { sql: 'DELETE FROM outfit_items WHERE outfit_id=?', values: [91] });
  assert.deepEqual(writes.slice(2).map(event => event.values), [[91, 4, 1], [91, 2, 2]]);
});
test('foreign or missing parent returns 404 before looking at selected clothing', async () => {
  for (const operation of ['update', 'archive']) {
    const { service, events } = fixture(sql => { assert.match(sql, /SELECT \* FROM outfits.*FOR UPDATE/); return []; });
    await assert.rejects(operation === 'update' ? service.update(7, 91, form) : service.archive(7, 91, true), { code: 'NOT_FOUND', status: 404 });
    assert.equal(events.filter(event => event.values).length, 1); assert.deepEqual(events.slice(-2).map(event => event.sql), ['ROLLBACK', 'RELEASE']);
  }
});
test('missing clothing rejects whole selection before any write and never discloses another owner', async () => {
  const { service, events } = fixture(() => [{ id: 4 }]);
  await assert.rejects(service.create(7, form), error => error.code === 'INVALID_SELECTION' && error.status === 400 && Object.keys(error.fields).join() === 'clothingIds');
  assert.equal(events.some(event => /^(INSERT|UPDATE|DELETE)/.test(event.sql)), false);
});
test('archive locks parent; repeated target never writes a timestamp and returns complete detail', async () => {
  const { service, events } = fixture(sql => sql.startsWith('SELECT * FROM outfits') ? [{ ...parent, is_archived: 1 }] : [item]);
  const result = await service.archive(7, 91, true);
  assert.equal(result.updatedAt, '2026-11-17T01:02:03.004Z'); assert.equal(result.items.length, 1);
  assert.match(events[1].sql, /FOR UPDATE$/); assert.equal(events.some(event => event.sql.startsWith('UPDATE')), false);
});
test('unknown query or commit failure propagates unchanged after rollback and releases the connection', async () => {
  const error = new Error('controlled database failure');
  for (const commitError of [undefined, error]) {
    const { service, events } = fixture(() => { if (!commitError) throw error; return []; }, { commitError });
    await assert.rejects(service.facets(7, 'all'), actual => actual === error);
    assert.deepEqual(events.slice(-2).map(event => event.sql), ['ROLLBACK', 'RELEASE']);
  }
});
