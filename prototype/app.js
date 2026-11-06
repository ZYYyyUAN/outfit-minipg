const rootUrl = new URL('../', import.meta.url);
const $ = selector => document.querySelector(selector);
const pages = [...document.querySelectorAll('.page')];
const labels = { wardrobe: '衣橱', outfits: '搭配', diary: '日记', me: '我的' };
const state = { activeTab: 'wardrobe', keyword: '', category: 'all', occasion: 'all', month: '', date: '' };
let data;
let clothingById;
let categoryById;
let diaryByDate;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const resource = path => new URL(path, rootUrl).href;
const image = (path, name, className = '') => `<figure class="image-frame ${className}"><img src="${escape(resource(path))}" alt="${escape(name)}"></figure>`;

function clothingTile(clothing, interactive = false) {
  const content = `${image(clothing.imagePath, clothing.name)}<span class="clothing-name">${escape(clothing.name)}</span><span class="clothing-meta">${escape(clothing.color)}</span>`;
  return interactive ? `<button class="clothing-tile" data-clothing="${clothing.id}" aria-label="预览${escape(clothing.name)}">${content}</button>` : `<div class="clothing-tile" data-item="${clothing.id}">${content}</div>`;
}

function renderClothes() {
  const clothes = data.clothes.filter(c => (state.category === 'all' || c.categoryId === state.category) && c.name.toLowerCase().includes(state.keyword.trim().toLowerCase()));
  $('#clothes-grid').innerHTML = clothes.map(c => clothingTile(c, true)).join('');
  $('#result-label').textContent = state.category === 'all' ? '全部单品' : categoryById.get(state.category).name;
  $('#result-count').textContent = state.keyword || state.category !== 'all' ? `找到 ${clothes.length} 件` : `${clothes.length} 件`;
  $('#empty-clothes').hidden = clothes.length !== 0;
  $('#clear-search').hidden = state.keyword.length === 0;
  for (const button of $('#categories').children) button.setAttribute('aria-pressed', String(button.dataset.category === state.category));
}

function renderOutfits() {
  const outfits = data.outfits.filter(o => state.occasion === 'all' || o.occasion === state.occasion);
  $('#outfit-list').innerHTML = outfits.map(o => `<button class="outfit-row" data-outfit="${o.id}" aria-label="预览搭配${escape(o.name)}"><span class="outfit-images">${o.clothingIds.slice(0, 4).map(id => { const c = clothingById.get(id); return image(c.imagePath, c.name); }).join('')}</span><span class="outfit-copy"><h3>${escape(o.name)}</h3><span class="occasion">${escape(o.occasion)}</span><span class="outfit-count">共 ${o.clothingIds.length} 件单品</span><span class="outfit-arrow" aria-hidden="true">↗</span></span></button>`).join('');
  for (const button of $('#occasions').children) button.setAttribute('aria-pressed', String(button.dataset.occasion === state.occasion));
}

function renderDiarySummary() {
  const diary = diaryByDate.get(state.date);
  const [, month, day] = state.date.split('-');
  let content = `<h3 class="diary-date">${Number(month)}月${Number(day)}日</h3>`;
  if (!diary) {
    $('#diary-summary').innerHTML = `${content}<p class="empty-day">这一天暂无穿搭记录</p>`;
    return;
  }
  content += `<div class="diary-meta"><span>${escape(diary.occasion)}</span>${diary.mood ? `<span>${escape(diary.mood)}</span>` : ''}</div><p class="diary-note">${escape(diary.note)}</p><div class="diary-clothes">${diary.clothingIds.map(id => clothingTile(clothingById.get(id))).join('')}</div>`;
  if (diary.photoPath) content += `<figure class="diary-photo"><img src="${escape(resource(diary.photoPath))}" alt="同款针织穿着参考"><figcaption>同款穿着参考 · 非真实用户自拍</figcaption></figure>`;
  $('#diary-summary').innerHTML = content;
}

function renderCalendar() {
  const [year, month] = state.month.split('-').map(Number);
  const offset = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  $('#month-title').textContent = `${year}年${month}月`;
  $('#month-count').textContent = `本月记录 ${data.diaries.filter(d => d.wearDate.startsWith(state.month)).length} 天`;
  $('#calendar').innerHTML = Array.from({ length: 42 }, (_, index) => {
    const day = index - offset + 1;
    if (day < 1 || day > days) return '<span aria-hidden="true"></span>';
    const date = `${state.month}-${String(day).padStart(2, '0')}`;
    const hasRecord = diaryByDate.has(date);
    return `<button data-date="${date}" class="${hasRecord ? 'has-record' : ''}" aria-label="${date}${hasRecord ? '，有穿搭记录' : '，无记录'}" aria-pressed="${date === state.date}">${day}</button>`;
  }).join('');
  renderDiarySummary();
}

function changeMonth(delta) {
  const [year, month] = state.month.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1 + delta, 1));
  state.month = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
  state.date = data.diaries.map(d => d.wearDate).filter(date => date.startsWith(state.month)).sort()[0] || `${state.month}-01`;
  renderCalendar();
  $('#diary').scrollTop = 0;
}

function openPreview(kind, id) {
  let content;
  if (kind === 'clothing') {
    const c = clothingById.get(id);
    $('#preview-title').textContent = c.name;
    content = `<div class="preview-image">${image(c.imagePath, c.name)}</div><dl class="attributes"><div><dt>分类</dt><dd>${escape(categoryById.get(c.categoryId).name)}</dd></div><div><dt>颜色</dt><dd>${escape(c.color)}</dd></div><div><dt>季节</dt><dd>${escape(c.season)}</dd></div></dl><p class="preview-note">${escape(c.note)}</p>`;
  } else {
    const o = data.outfits.find(o => o.id === id);
    $('#preview-title').textContent = o.name;
    content = `<p class="preview-subtitle">${escape(o.occasion)} · 共 ${o.clothingIds.length} 件单品</p><p class="preview-note">${escape(o.note)}</p><div class="preview-outfit-grid">${o.clothingIds.map(id => clothingTile(clothingById.get(id))).join('')}</div>`;
  }
  $('#preview-body').innerHTML = content;
  $('#preview-body').scrollTop = 0;
  $('#preview').showModal();
}

async function loadData() {
  $('#load-state').hidden = false;
  $('#load-state').innerHTML = '<span class="loader"></span><p>正在打开衣橱…</p>';
  let source;
  try {
    const response = await fetch(new URL('data/demo-data.json', rootUrl));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    source = await response.json();
  } catch (error) {
    $('#load-state').innerHTML = '<h2>载入演示数据失败</h2><p>请检查本地预览服务后重新加载。</p><button class="primary-button" id="reload-data">重新加载</button>';
    $('#reload-data').addEventListener('click', loadData);
    return;
  }
  data = source;
  clothingById = new Map(data.clothes.map(c => [c.id, c]));
  categoryById = new Map(data.categories.map(c => [c.id, c]));
  diaryByDate = new Map(data.diaries.map(d => [d.wearDate, d]));
  state.date = data.diaries.map(d => d.wearDate).sort().at(-1);
  state.month = state.date.slice(0, 7);
  $('#wardrobe-total').textContent = `共 ${data.clothes.length} 件单品`;
  $('#outfits-total').textContent = `${data.outfits.length} 套示例搭配`;
  $('#categories').innerHTML = [{ id: 'all', name: '全部' }, ...[...data.categories].sort((a, b) => a.sortOrder - b.sortOrder)].map(c => `<button data-category="${c.id}" aria-pressed="false">${escape(c.name)}</button>`).join('');
  $('#occasions').innerHTML = ['all', ...new Set(data.outfits.map(o => o.occasion))].map(o => `<button data-occasion="${escape(o)}" aria-pressed="false">${o === 'all' ? '全部' : escape(o)}</button>`).join('');
  $('#avatar').textContent = Array.from(data.demoProfile.nickname)[0];
  $('#nickname').textContent = data.demoProfile.nickname;
  $('#profile-counts').innerHTML = [[data.clothes.length, '件衣物'], [data.outfits.length, '套搭配'], [data.diaries.length, '篇日记']].map(([n, label]) => `<div><strong>${n}</strong><span>${label}</span></div>`).join('');
  renderClothes();
  renderOutfits();
  renderCalendar();
  $('#load-state').hidden = true;
  $(`#${state.activeTab}`).hidden = false;
}

document.querySelector('.bottom-nav').addEventListener('click', event => {
  const button = event.target.closest('[data-tab]');
  if (!button || button.dataset.tab === state.activeTab) return;
  if ($('#preview').open) $('#preview').close();
  state.activeTab = button.dataset.tab;
  for (const page of pages) page.hidden = page.id !== state.activeTab || !data;
  for (const item of document.querySelectorAll('[data-tab]')) {
    if (item === button) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  $('#page-title').textContent = labels[state.activeTab];
});
$('#search').addEventListener('input', event => { state.keyword = event.target.value; renderClothes(); });
$('#clear-search').addEventListener('click', () => { state.keyword = ''; $('#search').value = ''; renderClothes(); $('#search').focus(); });
$('#reset-filters').addEventListener('click', () => { state.keyword = ''; state.category = 'all'; $('#search').value = ''; renderClothes(); $('#wardrobe').scrollTop = 0; });
$('#categories').addEventListener('click', event => {
  const button = event.target.closest('[data-category]');
  if (!button) return;
  state.category = button.dataset.category;
  renderClothes();
  $('#wardrobe').scrollTop = 0;
});
$('#clothes-grid').addEventListener('click', event => { const button = event.target.closest('[data-clothing]'); if (button) openPreview('clothing', button.dataset.clothing); });
$('#occasions').addEventListener('click', event => {
  const button = event.target.closest('[data-occasion]');
  if (!button) return;
  state.occasion = button.dataset.occasion;
  renderOutfits();
  $('#outfits').scrollTop = 0;
});
$('#outfit-list').addEventListener('click', event => { const button = event.target.closest('[data-outfit]'); if (button) openPreview('outfit', button.dataset.outfit); });
$('#previous-month').addEventListener('click', () => changeMonth(-1));
$('#next-month').addEventListener('click', () => changeMonth(1));
$('#calendar').addEventListener('click', event => {
  const button = event.target.closest('[data-date]');
  if (!button) return;
  state.date = button.dataset.date;
  for (const item of $('#calendar').querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === button));
  renderDiarySummary();
});
$('#close-preview').addEventListener('click', () => $('#preview').close());
$('#preview').addEventListener('click', event => {
  if (event.target !== $('#preview')) return;
  const rect = $('#preview').getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('#preview').close();
});
document.addEventListener('error', event => {
  const img = event.target;
  if (!(img instanceof HTMLImageElement)) return;
  img.hidden = true;
  const message = document.createElement('span');
  message.className = 'image-error';
  message.textContent = '图片读取失败';
  img.parentElement.append(message);
}, true);
loadData();
