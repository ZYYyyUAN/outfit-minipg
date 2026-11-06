const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);

const root = path.resolve(__dirname, '..');
const evidence = path.join(root, 'docs/evidence/P1-01');
fs.mkdirSync(evidence, { recursive: true });
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/demo-data.json')));
const sources = JSON.parse(fs.readFileSync(path.join(root, 'assets/source-manifest.json')));
const photos = JSON.parse(fs.readFileSync(path.join(root, 'assets/diary-photo-manifest.json')));
const files = ['data/demo-data.json', 'data/demo-summary.json', 'assets/source-manifest.json', 'assets/diary-photo-manifest.json', ...sources.map(s => s.file), ...photos.map(s => s.file)];
const hashes = () => Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const before = hashes();
const results = [];
const base = 'http://127.0.0.1:4173';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await context.newPage();
  const errors = [], requests = [], responses = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', r => requests.push({ url: r.url(), method: r.method() }));
  page.on('response', r => responses.push({ url: r.url(), status: r.status() }));
  const tab = async name => page.locator(`[data-tab="${name}"]`).click();
  const ready = async () => page.locator('#clothes-grid button').first().waitFor();
  const screenshot = async name => {
    await page.waitForFunction(() => [...document.querySelectorAll('img')].every(i => i.complete));
    await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect.getTiming().iterations !== Infinity).map(a => a.finished)); });
    await page.screenshot({ path: path.join(evidence, name + '.png') });
  };
  const check = async (id, title, work) => {
    await work();
    results.push({ id, title, status: 'passed' });
    console.log(`${id} passed ${title}`);
  };
  try {
    await page.goto(`${base}/prototype/`);
    await ready();
    await check('V01', '四入口切换', async () => {
      for (const [name, title] of Object.entries({ wardrobe: '衣橱', outfits: '搭配', diary: '日记', me: '我的' })) {
        await tab(name);
        assert.equal(await page.locator('#page-title').textContent(), title);
        assert.equal(await page.locator('.page:visible').count(), 1);
        assert.equal(await page.locator(`[data-tab=${name}]`).getAttribute('aria-current'), 'page');
      }
      await tab('wardrobe');
    });
    await check('V02', '24件及7类数量', async () => {
      assert.equal(await page.locator('#clothes-grid button').count(), 24);
      for (const c of data.categories) {
        await page.locator(`[data-category=${c.id}]`).click();
        assert.equal(await page.locator('#clothes-grid button').count(), data.clothes.filter(x => x.categoryId === c.id).length);
      }
      await page.locator('[data-category=all]').click();
    });
    await check('V03', '组合筛选与清除搜索', async () => {
      await page.locator('[data-category=bottoms]').click();
      await page.locator('#search').fill('牛仔');
      assert.equal(await page.locator('#clothes-grid button').count(), 3);
      await page.locator('#clear-search').click();
      assert.equal(await page.locator('#clothes-grid button').count(), 6);
    });
    await check('V04', '无结果与重置', async () => {
      await page.locator('#search').fill('没有这件衣服');
      assert.equal(await page.locator('#empty-clothes').isVisible(), true);
      await page.locator('#reset-filters').click();
      assert.equal(await page.locator('#clothes-grid button').count(), 24);
    });
    await check('V05', '完整单品及属性预览', async () => {
      for (const id of ['CLO015', 'CLO011', 'CLO018', 'CLO023']) {
        await page.locator(`[data-clothing=${id}]`).click();
        const image = page.locator('#preview-body img');
        await image.evaluate(i => i.decode());
        assert.equal(await image.evaluate(i => getComputedStyle(i).objectFit), 'contain');
        assert.equal(await page.locator('#preview-title').textContent(), data.clothes.find(c => c.id === id).name);
        await screenshot(`375-preview-${id}`);
        await page.locator('#close-preview').click();
      }
    });
    await check('V06', '场景及6件完整搭配', async () => {
      await tab('outfits');
      for (const [scene, count] of [['校园', 3], ['休闲', 4], ['出游', 1]]) {
        await page.locator(`[data-occasion="${scene}"]`).click();
        assert.equal(await page.locator('.outfit-row').count(), count);
      }
      await page.locator('[data-occasion=all]').click();
      await page.locator('[data-outfit=OUT006]').click();
      assert.deepEqual(await page.locator('.preview-outfit-grid [data-item]').evaluateAll(rows => rows.map(r => r.dataset.item)), data.outfits.find(o => o.id === 'OUT006').clothingIds);
      await screenshot('375-outfit-six-items');
      await page.locator('#preview-body').evaluate(e => e.scrollTop = e.scrollHeight);
      assert.equal(await page.locator('#preview-body').evaluate(e => Math.abs(e.scrollHeight - e.clientHeight - e.scrollTop) < 2), true);
      assert.equal(await page.locator('#preview-title').isVisible(), true);
      assert.equal(await page.locator('#close-preview').isVisible(), true);
      await screenshot('375-outfit-six-items-bottom');
      await page.locator('#close-preview').click();
    });
    await check('V07', '弹层关闭及焦点恢复', async () => {
      const trigger = page.locator('[data-outfit=OUT006]');
      await trigger.click(); await page.keyboard.press('Escape');
      assert.equal(await page.locator('#preview').isVisible(), false);
      assert.equal(await trigger.evaluate(e => e === document.activeElement), true);
      await trigger.click(); await page.mouse.click(5, 5);
      assert.equal(await page.locator('#preview').isVisible(), false);
      await trigger.click(); await page.locator('#close-preview').click();
      assert.equal(await page.locator('#preview').isVisible(), false);
    });
    await check('V08', '日记初始11月5日', async () => {
      await tab('diary');
      assert.equal(await page.locator('#month-title').textContent(), '2026年11月');
      assert.equal(await page.locator('#calendar [aria-pressed=true]').getAttribute('data-date'), '2026-11-05');
      assert.equal(await page.locator('#diary-summary [data-item]').count(), 6);
      assert.equal(await page.locator('.diary-photo').count(), 0);
    });
    await check('V09', '跨月9/3篇及选日', async () => {
      await page.locator('#previous-month').click();
      assert.equal(await page.locator('#calendar .has-record').count(), 9);
      assert.equal(await page.locator('#calendar [aria-pressed=true]').getAttribute('data-date'), '2026-10-07');
      await page.locator('#next-month').click();
      assert.equal(await page.locator('#calendar .has-record').count(), 3);
      assert.equal(await page.locator('#calendar [aria-pressed=true]').getAttribute('data-date'), '2026-11-01');
    });
    await check('V10', '月首星期及42格', async () => {
      for (const [month, offset, days] of [['2026-11', 6, 30], ['2026-10', 3, 31]]) {
        if (month === '2026-10') await page.locator('#previous-month').click();
        assert.equal(await page.locator('#calendar > *').count(), 42);
        assert.equal(await page.locator('#calendar > *').nth(offset).getAttribute('data-date'), `${month}-01`);
        assert.equal(await page.locator('#calendar button').count(), days);
      }
    });
    await check('V11', '10月16日附图', async () => {
      await page.locator('[data-date="2026-10-16"]').click();
      assert.deepEqual(await page.locator('#diary-summary [data-item]').evaluateAll(rows => rows.map(r => r.dataset.item)), ['CLO001']);
      await page.locator('.diary-photo img').evaluate(i => i.decode());
      assert.match(await page.locator('.diary-photo figcaption').textContent(), /同款穿着参考/);
      await screenshot('375-diary-october');
      await page.locator('.diary-photo').scrollIntoViewIfNeeded();
      await screenshot('375-diary-photo');
    });
    await check('V12', '重复穿搭的独立日期', async () => {
      for (const date of ['2026-10-07', '2026-10-24']) {
        await page.locator(`[data-date="${date}"]`).click();
        assert.equal(await page.locator('#diary-summary [data-item]').count(), 4);
        assert.match(await page.locator('.diary-date').textContent(), new RegExp(String(Number(date.slice(-2)))));
      }
    });
    await check('V13', '空日期与空月份', async () => {
      await page.locator('#next-month').click();
      await page.locator('[data-date="2026-11-02"]').click();
      assert.equal(await page.locator('.empty-day').textContent(), '这一天暂无穿搭记录');
      await page.locator('#next-month').click();
      assert.equal(await page.locator('#calendar .has-record').count(), 0);
      assert.match(await page.locator('#month-count').textContent(), /0/);
    });
    await check('V14', 'tab切换保留状态与滚动', async () => {
      await tab('wardrobe'); await page.locator('[data-category=tops]').click();
      await page.locator('#search').fill('针织');
      await page.locator('#wardrobe').evaluate(e => e.scrollTop = 250);
      const scroll = await page.locator('#wardrobe').evaluate(e => e.scrollTop);
      await tab('diary');
      assert.equal(await page.locator('#month-title').textContent(), '2026年12月');
      await tab('wardrobe');
      assert.equal(await page.locator('#search').inputValue(), '针织');
      assert.equal(await page.locator('[data-category=tops]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#wardrobe').evaluate(e => e.scrollTop), scroll);
      assert.equal(requests.filter(r => r.url.endsWith('/data/demo-data.json')).length, 1);
      await page.locator('#search').fill(''); await page.locator('[data-category=all]').click();
    });
    await check('V15', '演示身份及数据说明', async () => {
      await tab('me');
      assert.equal(await page.locator('#nickname').textContent(), data.demoProfile.nickname);
      assert.deepEqual(await page.locator('#profile-counts strong').allTextContents(), ['24', '8', '12']);
      await page.locator('#about summary').click();
      assert.equal(await page.locator('#about').evaluate(e => e.open), true);
      await page.locator('#about summary').click();
      assert.equal(await page.locator('#about').evaluate(e => e.open), false);
    });
    await check('V16', '只读范围与控件', async () => {
      assert.equal(await page.getByRole('button', { name: /新增|保存|上传|登录|退出|编辑|删除|记一笔/ }).count(), 0);
      assert.equal(requests.every(r => r.method === 'GET'), true);
    });
    await check('V17', '375及430两尺寸布局', async () => {
      for (const [width, height] of [[375, 812], [430, 932]]) {
        await page.setViewportSize({ width, height });
        for (const name of ['wardrobe', 'outfits', 'diary', 'me']) {
          await tab(name);
          await page.locator(`#${name}`).evaluate(e => e.scrollTop = 0);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          assert.equal(await page.locator(`#${name}`).evaluate(e => e.scrollWidth <= e.clientWidth), true);
          await screenshot(`${width}-${name}`);
          await page.locator(`#${name}`).evaluate(e => e.scrollTop = e.scrollHeight);
          assert.equal(await page.locator(`#${name}`).evaluate(e => Math.abs(e.scrollHeight - e.clientHeight - e.scrollTop) < 2), true);
          assert.equal(await page.evaluate(() => document.querySelector('main').getBoundingClientRect().bottom <= document.querySelector('nav').getBoundingClientRect().top + 1), true);
        }
        await tab('wardrobe');
        await page.locator('[data-clothing=CLO016]').click();
        assert.equal(await page.locator('#preview').evaluate(e => e.getBoundingClientRect().right <= innerWidth), true);
        await screenshot(`${width}-preview-long-name`);
        await page.locator('#close-preview').click();
        // 缩小可用高度检查搜索输入与导航的布局，另核对两种正式验收视口。
        await page.setViewportSize({ width, height: 460 });
        await page.locator('#search').focus();
        assert.equal(await page.locator('#search').isVisible(), true);
        assert.equal(await page.evaluate(() => document.querySelector('main').getBoundingClientRect().bottom <= document.querySelector('nav').getBoundingClientRect().top + 1), true);
      }
      await page.setViewportSize({ width: 375, height: 812 });
    });
    await check('V18', '本地25图与资源路径', async () => {
      for (const file of [...sources, ...photos].map(s => s.file)) {
        const response = await context.request.get(`${base}/${file}`);
        assert.equal(response.status(), 200, file);
        assert.equal(response.headers()['content-type'].startsWith('image/'), true);
      }
      assert.equal(requests.every(r => r.url.startsWith(`${base}/`)), true);
      assert.equal(requests.some(r => r.url.includes('/prototype/assets/') || r.url.includes('/api/')), false);
      assert.equal(responses.every(r => r.status === 200), true);
      assert.deepEqual(errors, []);
    });
    await check('V19', '数据与图片失败及恢复', async () => {
      const failPage = await context.newPage();
      await failPage.route('**/data/demo-data.json', route => route.abort());
      await failPage.goto(`${base}/prototype/`);
      await failPage.getByText('载入演示数据失败').waitFor();
      assert.equal(await failPage.locator('#clothes-grid button').count(), 0);
      await failPage.screenshot({ path: path.join(evidence, 'data-load-error.png') });
      await failPage.unroute('**/data/demo-data.json');
      await failPage.getByRole('button', { name: '重新加载' }).click();
      await failPage.locator('#clothes-grid button').first().waitFor();
      assert.equal(await failPage.locator('#clothes-grid button').count(), 24);
      await failPage.route('**/assets/clothes/clothing-001.jpg', route => route.abort());
      await failPage.reload();
      await failPage.locator('[data-clothing=CLO001] .image-error').waitFor();
      assert.match(await failPage.locator('[data-clothing=CLO001]').textContent(), /粉色绞花针织/);
      await failPage.screenshot({ path: path.join(evidence, 'image-load-error.png') });
      await failPage.unroute('**/assets/clothes/clothing-001.jpg');
      await failPage.reload();
      await failPage.locator('[data-clothing=CLO001] img').evaluate(i => i.decode());
      await failPage.close();
    });
    await check('V20', '刷新重置及源文件不变', async () => {
      await page.reload(); await ready();
      assert.equal(await page.locator('#search').inputValue(), '');
      assert.equal(await page.locator('[data-tab=wardrobe]').getAttribute('aria-current'), 'page');
      await tab('diary');
      assert.equal(await page.locator('#calendar [aria-pressed=true]').getAttribute('data-date'), '2026-11-05');
      assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
      assert.deepEqual(hashes(), before);
      assert.deepEqual(errors, []);
    });
    for (const [width, height] of [[375, 812], [430, 932]]) {
      await page.setViewportSize({ width, height });
      await tab('diary');
      await page.locator('#diary').evaluate(e => e.scrollTop = 0);
      await screenshot(`${width}-diary-november`);
      await tab('me');
      if (!await page.locator('#about').evaluate(e => e.open)) await page.locator('#about summary').click();
      await screenshot(`${width}-me-expanded`);
      assert.equal(await page.locator('#me').evaluate(e => e.scrollWidth <= e.clientWidth), true);
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await tab('wardrobe');
    await page.locator('#wardrobe').evaluate(e => e.scrollTop = 0);
    await screenshot('final-wardrobe');
  } finally {
    fs.writeFileSync(path.join(evidence, 'acceptance-results.json'), JSON.stringify({ status: results.length === 20 ? 'passed' : 'incomplete', baseUrl: `${base}/prototype/`, browser: await browser.version(), results, consoleErrors: errors, requests, responses, sourceHashes: before }, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
