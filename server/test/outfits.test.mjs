import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { outfitFilters, outfitInput, outfitsRoutes } from '../src/routes/outfits.js';
import { createApp, internalError } from '../src/app.js';
import { unauthenticated } from '../src/utils/business-error.js';

const form = { name: ' 日常 ', occasion: ' 通勤 ', note: ' 第一行\n第二行 ', clothingIds: [3, 1, 2] };
test('outfit filters retain literal search, exact occasion and safe pagination defaults', () => {
  assert.deepEqual(outfitFilters({}), { page: 1, pageSize: 12, offset: 0, archived: 'active', keyword: '', occasion: undefined });
  assert.deepEqual(outfitFilters({ keyword: ' Alpha_%! ', occasion: ' 通勤 ', archived: 'all', page: '2', pageSize: '50' }), { page: 2, pageSize: 50, offset: 50, archived: 'all', keyword: 'Alpha_%!', occasion: '通勤' });
  assert.equal(outfitFilters({ keyword: '', pageSize: '1' }).keyword, '');
  assert.equal(outfitFilters({ keyword: '🧥'.repeat(40), occasion: '🎨'.repeat(20), archived: 'archived' }).archived, 'archived');
});
for (const query of [{ keyword: 'x'.repeat(41) }, { keyword: null }, { keyword: ['a', 'b'] }, { keyword: { value: 'a' } }, { occasion: '' }, { occasion: '   ' }, { occasion: 'a\nb' }, { occasion: 'a'.repeat(21) }, { occasion: null }, { archived: '' }, { archived: null }, { archived: 'true' }, { page: '' }, { page: '0' }, { page: '-1' }, { page: '1.5' }, { page: '1e2' }, { page: '9007199254740992' }, { page: '9007199254740991', pageSize: '50' }, { pageSize: '0' }, { pageSize: '51' }, { pageSize: ['1', '2'] }, { userId: '7' }, { sort: 'name' }]) {
  test('outfit query rejects ' + JSON.stringify(query), () => assert.throws(() => outfitFilters(query), { status: 400, code: 'INVALID_INPUT' }));
}
test('outfit full form normalizes single lines, preserves note and ordered IDs without sharing arrays', () => {
  const actual = outfitInput(form);
  assert.deepEqual(actual, { name: '日常', occasion: '通勤', note: form.note, clothingIds: [3, 1, 2] });
  actual.clothingIds.reverse(); assert.deepEqual(form.clothingIds, [3, 1, 2]);
  assert.equal(outfitInput({ ...form, name: '🧥'.repeat(40), occasion: '🎨'.repeat(20), note: '📝'.repeat(500), clothingIds: Array.from({ length: 20 }, (_, i) => i + 1) }).clothingIds.length, 20);
  assert.equal(outfitInput({ ...form, note: '', clothingIds: [4294967295] }).note, '');
});
for (const [index, patch] of [{ name: '' }, { name: '  ' }, { name: '🧥'.repeat(41) }, { name: 'a\rb' }, { name: 'a\nb' }, { name: 'a\u2028b' }, { name: 'a\u2029b' }, { name: 1 }, { occasion: '' }, { occasion: '🎨'.repeat(21) }, { occasion: 'a\nb' }, { note: null }, { note: 1 }, { note: '📝'.repeat(501) }, { userId: 7 }, { id: 1 }, { isArchived: false }, { createdAt: '' }, { clothingIds: null }, { clothingIds: '1' }, { clothingIds: {} }, { clothingIds: ['1'] }, { clothingIds: [1.5] }, { clothingIds: [0] }, { clothingIds: [-1] }, { clothingIds: [4294967296] }, { clothingIds: [NaN] }, { clothingIds: [Infinity] }, { clothingIds: [true] }].entries()) {
  test('outfit form rejects malformed ' + Object.keys(patch).join() + ' case ' + (index + 1), () => assert.throws(() => outfitInput({ ...form, ...patch }), { status: 400, code: 'INVALID_INPUT' }));
}
test('outfit full POST/PUT reject missing fields and invalid body shape', () => {
  for (const key of Object.keys(form)) { const body = { ...form }; delete body[key]; assert.throws(() => outfitInput(body), { code: 'INVALID_INPUT' }); }
  for (const body of [undefined, null, [], 'text', 3]) assert.throws(() => outfitInput(body), { code: 'INVALID_INPUT' });
});
for (const clothingIds of [[], [1, 1], Array.from({ length: 21 }, (_, i) => i + 1)]) {
  test('outfit selection cardinality or duplicates ' + clothingIds.length, () => assert.throws(() => outfitInput({ ...form, clothingIds }), error => error.status === 400 && error.code === 'INVALID_SELECTION' && Object.keys(error.fields).join() === 'clothingIds'));
}

async function fixture(t) {
  const calls = [], app = express();
  const account = { authenticate: async token => { if (token !== 'a'.repeat(43)) throw unauthenticated(); return { userId: 77 }; } };
  const service = Object.fromEntries(['list', 'facets', 'detail', 'create', 'update', 'archive'].map(method => [method, async (...args) => { calls.push({ method, args }); return { stub: method }; }]));
  app.use('/api', outfitsRoutes(account, service)); app.use(internalError);
  const server = createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  async function call(method, suffix, body, token = 'a'.repeat(43), raw = false) {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/outfits' + suffix, { method,
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    return { status: res.status, value: await res.json() };
  }
  return { calls, call };
}
test('six isolated entry routes pass only authenticated identity and normalized parameters to stub services', async t => {
  const { call, calls } = await fixture(t);
  const cases = [['GET', '', undefined, 200, 'list', [77, outfitFilters({})]], ['GET', '/facets?archived=all', undefined, 200, 'facets', [77, 'all']], ['GET', '/0004294967295', undefined, 200, 'detail', [77, 4294967295]], ['POST', '', form, 201, 'create', [77, outfitInput(form)]], ['PUT', '/12', form, 200, 'update', [77, 12, outfitInput(form)]], ['PATCH', '/12/archive', { isArchived: true }, 200, 'archive', [77, 12, true]], ['PATCH', '/12/archive', { isArchived: false }, 200, 'archive', [77, 12, false]]];
  for (const [method, suffix, body, status, service, args] of cases) {
    assert.deepEqual(await call(method, suffix, body), { status, value: { data: { stub: service } } });
    assert.deepEqual(calls.at(-1), { method: service, args });
  }
});
test('anonymous and expired auth precede malformed/oversized JSON on all six isolated routes', async t => {
  const { call, calls } = await fixture(t);
  for (const [method, suffix] of [['GET', ''], ['GET', '/facets'], ['GET', '/1'], ['POST', ''], ['PUT', '/1'], ['PATCH', '/1/archive']]) {
    for (const token of [null, 'b'.repeat(43)]) {
      const response = await call(method, suffix, undefined, token);
      assert.equal(response.status, 401); assert.equal(response.value.error.code, 'UNAUTHENTICATED');
    }
    if (method === 'GET') continue;
    for (const body of ['{', JSON.stringify({ note: 'x'.repeat(9000) })]) {
      const response = await call(method, suffix, body, null, true);
      assert.equal(response.status, 401); assert.equal(response.value.error.code, 'UNAUTHENTICATED');
    }
  }
  assert.equal(calls.length, 0);
});
test('isolated routes reject queries, IDs, complete forms and archive types before stub invocation', async t => {
  const { call, calls } = await fixture(t);
  const cases = [['GET', '?page=1&page=2'], ['GET', '?keyword[x]=a'], ['GET', '?occasion='], ['GET', '?archived='], ['GET', '/facets?keyword=a'], ['GET', '/facets?archived=all&archived=active'], ['GET', '/facets?archived='], ['GET', '/1?extra=x'], ['POST', '?extra=x', form], ['PUT', '/1?extra=x', form], ['PATCH', '/1/archive?extra=x', { isArchived: true }], ['PUT', '/1', { name: '不完整' }], ['POST', '', { ...form, clothingIds: [] }, 'INVALID_SELECTION']];
  for (const id of ['0', '-1', '1e2', '1.5', '4294967296', 'abc']) for (const [method, body, suffix] of [['GET', undefined, ''], ['PUT', form, ''], ['PATCH', { isArchived: false }, '/archive']]) cases.push([method, '/' + id + suffix, body]);
  for (const body of [{}, { isArchived: 'true' }, { isArchived: 1 }, { isArchived: null }, { isArchived: true, name: 'x' }, []]) cases.push(['PATCH', '/1/archive', body]);
  for (const [method, suffix, body, code = 'INVALID_INPUT'] of cases) {
    const response = await call(method, suffix, body);
    assert.equal(response.status, 400, method + suffix); assert.equal(response.value.error.code, code);
  }
  for (const [body, status] of [['{', 400], [JSON.stringify({ note: 'x'.repeat(9000) }), 413]]) {
    const response = await call('POST', '', body, 'a'.repeat(43), true); assert.equal(response.status, status); assert.equal(response.value.error.code, 'INVALID_INPUT');
  }
  assert.equal(calls.length, 0);
});
test('assembled app authenticates outfits before parsing; omitted optional services stay 404', async t => {
  const account = { authenticate: async () => { throw unauthenticated(); } };
  const server = createServer(createApp(account, null, null, {})); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const suffix of ['/outfits', '/outfits/facets', '/outfits/1', '/diaries', '/statistics']) {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/api' + suffix);
    assert.equal(res.status, suffix.startsWith('/outfits') ? 401 : 404);
    assert.equal((await res.json()).error.code, suffix.startsWith('/outfits') ? 'UNAUTHENTICATED' : 'NOT_FOUND');
  }
  const res = await fetch('http://127.0.0.1:' + server.address().port + '/api/outfits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(res.status, 401);
});
