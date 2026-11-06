const rootUrl = new URL('../', import.meta.url);
const $ = selector => document.querySelector(selector);
const pages = [...document.querySelectorAll('main > .page:not(#subview)')];
const labels = { wardrobe: '衣橱', outfits: '搭配', diary: '日记', me: '我的' };
const state = { activeTab: 'wardrobe', keyword: '', category: 'all', occasion: 'all', month: '', date: '' };
let sourceData;
let data;
let clothingById;
let categoryById;
let diaryByDate;
let diaryById;
const DEMO_TODAY = '2026-11-06';
const recentStartDate = new Date(`${DEMO_TODAY}T00:00:00Z`);
recentStartDate.setUTCDate(recentStartDate.getUTCDate()-29);
const RECENT_START = recentStartDate.toISOString().slice(0,10);
let statisticsMonth = '2026-11';
let diarySequence = 0;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const resource = path => new URL(path, rootUrl).href;
const image = (path, name, className = '') => `<figure class="image-frame ${className}"><img src="${escape(resource(path))}" alt="${escape(name)}"></figure>`;

function clothingTile(clothing, interactive = false) {
  const content = `${image(clothing.imagePath, clothing.name)}<span class="clothing-name">${escape(clothing.name)}</span><span class="clothing-meta">${escape(clothing.color)}</span>${clothing.isArchived ? '<span class="archive-label">已归档</span>' : ''}`;
  return interactive ? `<button class="clothing-tile" data-clothing="${clothing.id}" aria-label="预览${escape(clothing.name)}">${content}</button>` : `<div class="clothing-tile" data-item="${clothing.id}">${content}</div>`;
}

function renderClothes() {
  const clothes = data.clothes.filter(c => inScope(c, clothesScope) && (state.category === 'all' || c.categoryId === state.category) && c.name.toLowerCase().includes(state.keyword.trim().toLowerCase()));
  $('#clothes-grid').innerHTML = clothes.map(c => clothingTile(c, true)).join('');
  $('#result-label').textContent = state.category === 'all' ? '全部单品' : categoryById.get(state.category).name;
  $('#result-count').textContent = state.keyword || state.category !== 'all' ? `找到 ${clothes.length} 件` : `${clothes.length} 件`;
  $('#empty-clothes').hidden = clothes.length !== 0;
  const filtered = state.keyword.trim() !== '' || state.category !== 'all';
  $('#empty-clothes p').textContent = filtered ? '没有找到匹配的衣物' : clothesScope === 'archived' ? '暂无已归档衣物' : '没有在用衣物，可从上方新增';
  $('#reset-filters').hidden = !filtered;
  $('#clear-search').hidden = state.keyword.length === 0;
  for (const button of $('#categories').children) button.setAttribute('aria-pressed', String(button.dataset.category === state.category));
}

function renderOutfits() {
  const outfits = data.outfits.filter(o => inScope(o, outfitsScope) && (state.occasion === 'all' || o.occasion === state.occasion));
  $('#outfit-list').innerHTML = outfits.map(o => `<button class="outfit-row" data-outfit="${o.id}" aria-label="预览搭配${escape(o.name)}"><span class="outfit-images">${o.clothingIds.slice(0, 4).map(id => { const c = clothingById.get(id); return image(c.imagePath, c.name); }).join('')}</span><span class="outfit-copy"><h3>${escape(o.name)}</h3><span class="occasion">${escape(o.occasion)}</span><span class="outfit-count">共 ${o.clothingIds.length} 件单品</span><span class="outfit-arrow" aria-hidden="true">↗</span></span></button>`).join('');
  for (const button of $('#occasions').children) button.setAttribute('aria-pressed', String(button.dataset.occasion === state.occasion));
  $('#empty-outfits').hidden = outfits.length !== 0;
  $('#empty-outfits p').textContent = state.occasion !== 'all' ? '当前场景没有搭配，请清除筛选' : outfitsScope === 'archived' ? '暂无已归档搭配' : '没有在用搭配，可从上方新增';
  $('#reset-occasions').hidden = state.occasion === 'all';
}

function renderDiarySummary() {
  const diary = diaryByDate.get(state.date);
  const [, month, day] = state.date.split('-');
  let content = `<h3 class="diary-date">${Number(month)}月${Number(day)}日</h3>`;
  if (!diary) {
    $('#diary-summary').innerHTML = `${content}<p class="empty-day">${state.date > DEMO_TODAY ? '未来日期暂不能记录' : '这一天暂无穿搭记录'}</p>${state.date <= DEMO_TODAY ? '<button class="primary-button" data-new-diary>记一笔</button>' : ''}`;
    return;
  }
  content += `<div class="diary-meta"><span>${escape(diary.occasion)}</span>${diary.mood ? `<span>${escape(diary.mood)}</span>` : ''}</div><p class="diary-note">${escape(diary.note)}</p><div class="diary-clothes">${diary.clothingIds.map(id => clothingTile(clothingById.get(id))).join('')}</div>`;
  content += diaryPhoto(diary);
  content += `<button class="primary-button" data-diary="${diary.id}">查看详情</button>`;
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

function openPreview(kind, id) { pushView({ kind, id, mode: 'detail' }); }

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
  sourceData = source;
  data = structuredClone(sourceData);
  clothingById = new Map(data.clothes.map(c => [c.id, c]));
  categoryById = new Map(data.categories.map(c => [c.id, c]));
  diaryByDate = new Map(data.diaries.map(d => [d.wearDate, d]));
  diaryById = new Map(data.diaries.map(d => [d.id, d]));
  state.date = data.diaries.map(d => d.wearDate).sort().at(-1);
  state.month = state.date.slice(0, 7);
  $('#wardrobe-total').textContent = `共 ${data.clothes.length} 件单品`;
  $('#outfits-total').textContent = `${data.outfits.length} 套示例搭配`;
  $('#categories').innerHTML = [{ id: 'all', name: '全部' }, ...[...data.categories].sort((a, b) => a.sortOrder - b.sortOrder)].map(c => `<button data-category="${c.id}" aria-pressed="false">${escape(c.name)}</button>`).join('');
  $('#occasions').innerHTML = ['all', ...new Set(data.outfits.map(o => o.occasion))].map(o => `<button data-occasion="${escape(o)}" aria-pressed="false">${o === 'all' ? '全部' : escape(o)}</button>`).join('');
  $('#avatar').textContent = Array.from(data.demoProfile.nickname)[0];
  $('#nickname').textContent = data.demoProfile.nickname;
  $('#profile-counts').innerHTML = [[data.clothes.length, '件衣物'], [data.outfits.length, '套搭配'], [data.diaries.length, '篇日记']].map(([n, label]) => `<div><strong>${n}</strong><span>${label}</span></div>`).join('');
  refreshViews();
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
$('#reset-occasions').addEventListener('click', () => { state.occasion = 'all'; renderOutfits(); $('#outfits').scrollTop = 0; });
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

let clothesScope = 'active', outfitsScope = 'active';
let stack = [], draft = null, initialDraft = '', pendingImage = null, picker = null;
let clothingSequence = 0, outfitSequence = 0;
const ownedUrls = new Set();
const inScope = (record, scope) => scope === 'all' || record.isArchived === (scope === 'archived');
const dirty = () => draft !== null && JSON.stringify(draft) !== initialDraft;
const unloadWarning = event => { event.preventDefault(); event.returnValue = ''; };
function trackDirty() { window.removeEventListener('beforeunload', unloadWarning); if (dirty()) window.addEventListener('beforeunload', unloadWarning); }
function cleanUrls() {
  const used = new Set(data.clothes.map(c => c.imagePath));
  for (const d of data.diaries) if (d.photoPath) used.add(d.photoPath);
  if (draft?.imagePath) used.add(draft.imagePath);
  if (draft?.photoPath) used.add(draft.photoPath);
  if (pendingImage) used.add(pendingImage);
  for (const url of ownedUrls) if (!used.has(url)) { URL.revokeObjectURL(url); ownedUrls.delete(url); }
}
function refreshViews() {
  const scrolls = pages.map(p => p.scrollTop);
  clothingById = new Map(data.clothes.map(c => [c.id, c]));
  diaryByDate = new Map(data.diaries.map(d => [d.wearDate, d]));
  diaryById = new Map(data.diaries.map(d => [d.id, d]));
  const scenes = [...new Set([...data.outfits.filter(o => inScope(o, outfitsScope)).map(o => o.occasion), ...(state.occasion === 'all' ? [] : [state.occasion])])];
  $('#occasions').innerHTML = ['all', ...scenes].map(s => `<button data-occasion="${escape(s)}" aria-pressed="false">${s === 'all' ? '全部' : escape(s)}</button>`).join('');
  $('#wardrobe-total').textContent = `${data.clothes.filter(c => inScope(c, clothesScope)).length} 件单品`;
  $('#outfits-total').textContent = `${data.outfits.filter(o => inScope(o, outfitsScope)).length} 套搭配`;
  $('#profile-counts').innerHTML = [[data.clothes.filter(c => !c.isArchived).length, '在用衣物'], [data.outfits.filter(o => !o.isArchived).length, '在用搭配'], [data.diaries.length, '篇日记']].map(([n, label]) => `<div><strong>${n}</strong><span>${label}</span></div>`).join('');
  renderClothes(); renderOutfits(); renderCalendar();
  pages.forEach((p, i) => p.scrollTop = scrolls[i]);
}
function pushView(frame) {
  if (stack.length) stack.at(-1).scroll = $('#subview').scrollTop;
  stack.push(frame); renderView();
}
function leaveEditor() {
  if (dirty() && !confirm('放弃未保存的修改？')) return false;
  draft = null; pendingImage = null; trackDirty(); cleanUrls(); return true;
}
function backView() {
  if (draft && !leaveEditor()) return;
  stack.pop(); renderView();
}
function renderView() {
  const frame = stack.at(-1);
  $('#subview').hidden = !frame;
  $('.bottom-nav').hidden = !!frame;
  $('#view-back').hidden = !frame;
  $('#editor-actions').hidden = !frame || frame.mode !== 'edit';
  for (const page of pages) page.hidden = !!frame || page.id !== state.activeTab;
  if (!frame) { $('#page-title').textContent = labels[state.activeTab]; $('#subview').innerHTML=''; $('#subview').removeAttribute('data-record-id'); return; }
  $('#subview').dataset.recordId = frame.id || '';
  if (frame.kind === 'statistics') { $('#page-title').textContent='衣橱统计'; renderStatistics(); $('#subview').scrollTop=frame.scroll || 0; return; }
  if (frame.kind === 'diary') { $('#page-title').textContent=frame.mode === 'edit' ? `${frame.id ? '编辑' : '新增'}日记` : '日记详情'; if(frame.mode==='edit') renderDiaryEditor(); else renderDiaryDetail(frame); return; }
  const isClothing = frame.kind === 'clothing';
  $('#page-title').textContent = frame.mode === 'edit' ? `${frame.id ? '编辑' : '新增'}${isClothing ? '衣物' : '搭配'}` : `${isClothing ? '衣物' : '搭配'}详情`;
  if (frame.mode === 'edit') { renderEditor(frame); return; }
  const record = isClothing ? clothingById.get(frame.id) : data.outfits.find(o => o.id === frame.id);
  let content = `<div class="detail-top"><span class="status-label">${record.isArchived ? '已归档' : '在用'}</span><div><button data-action="edit">编辑</button><button data-action="archive">${record.isArchived ? '恢复' : '归档'}</button></div></div><h2 class="detail-title">${escape(record.name)}</h2>`;
  if (isClothing) {
    const diaries = data.diaries.filter(d => d.clothingIds.includes(record.id)).sort((a, b) => b.wearDate.localeCompare(a.wearDate));
    const outfits = data.outfits.filter(o => o.clothingIds.includes(record.id));
    content += `${image(record.imagePath, record.name)}<dl class="attributes"><div><dt>分类</dt><dd>${escape(categoryById.get(record.categoryId).name)}</dd></div><div><dt>颜色</dt><dd>${escape(record.color)}</dd></div><div><dt>季节</dt><dd>${escape(record.season)}</dd></div></dl><p class="preview-note">${escape(record.note)}</p><h3 class="detail-section">穿着记录 · ${diaries.length} 次</h3><p class="muted">最近穿着：${diaries[0]?.wearDate || '尚未记录'}</p><div class="history">${diaries.map(d => `<button class="related-row" data-diary="${d.id}">${d.wearDate} · ${escape(d.occasion)}<span>›</span></button>`).join('')}</div><h3 class="detail-section">相关搭配</h3>${outfits.map(o => `<button class="related-row" data-related="${o.id}"><span class="related-label">${escape(o.name)}${o.isArchived ? ' · 已归档' : ''}</span><span>›</span></button>`).join('') || '<p class="muted">尚未加入搭配</p>'}`;
  } else {
    content += `<p class="preview-subtitle">${escape(record.occasion)} · 共 ${record.clothingIds.length} 件单品</p><p class="preview-note">${escape(record.note)}</p><button class="primary-button" data-record-outfit="${record.id}">记录穿着</button><div class="preview-outfit-grid">${record.clothingIds.map(id => clothingTile(clothingById.get(id), true)).join('')}</div>`;
  }
  $('#subview').innerHTML = content;
  $('#subview').scrollTop = frame.scroll || 0;
}
function startEditor(kind, id = null) {
  if (kind === 'diary') { startDiaryEditor(id); return; }
  const record = id ? (kind === 'clothing' ? clothingById.get(id) : data.outfits.find(o => o.id === id)) : null;
  draft = kind === 'clothing' ? { name: record?.name || '', categoryId: record?.categoryId || '', color: record?.color || '', season: record?.season || '', note: record?.note || '', imagePath: record?.imagePath || '' } : { name: record?.name || '', occasion: record?.occasion || '', note: record?.note || '', clothingIds: [...(record?.clothingIds || [])] };
  initialDraft = JSON.stringify(draft); trackDirty(); pushView({ kind, id, mode: 'edit' });
}
function field(name, label, limit, multiline = false) {
  const control = multiline ? `<textarea rows="3" name="${name}">${escape(draft[name])}</textarea>` : `<input type="text" name="${name}">`;
  return `<label class="field">${label}${control}<small data-counter="${name}" data-limit="${limit}">${Array.from(draft[name]).length}/${limit}</small><span class="field-error" data-error="${name}"></span></label>`;
}
function renderEditor(frame) {
  let content = '<p class="editor-hint">仅本次演示生效，刷新恢复样例</p><form id="entity-form" novalidate>';
  if (frame.kind === 'clothing') {
    content += `<div id="draft-image">${draft.imagePath ? image(draft.imagePath, '衣物预览') : '<div class="image-placeholder">选择一张衣物图片</div>'}</div><label class="file-button">${draft.imagePath ? '更换图片' : '选择图片'}<input id="file-input" type="file" accept="image/jpeg,image/png"></label><p class="muted">JPEG / PNG · 最大5MiB · 仅本地预览</p><p class="field-error" data-error="imagePath"></p>${field('name', '衣物名称 *', 40)}<label class="field">分类 *<select name="categoryId"><option value="">请选择分类</option>${data.categories.map(c => `<option value="${c.id}">${escape(c.name)}</option>`).join('')}</select><span class="field-error" data-error="categoryId"></span></label>${field('color', '颜色 *', 20)}<label class="field">季节 *<select name="season"><option value="">请选择季节</option>${['春','夏','秋','冬','春夏','春秋','秋冬','四季'].map(s => `<option>${s}</option>`).join('')}</select><span class="field-error" data-error="season"></span></label>${field('note', '备注', 500, true)}`;
  } else content += `${field('name', '搭配名称 *', 40)}${field('occasion', '场景 *', 20)}<div class="scene-shortcuts">${[...new Set(data.outfits.map(o => o.occasion))].map(s => `<button type="button" data-scene="${escape(s)}">${escape(s)}</button>`).join('')}</div>${field('note', '备注', 500, true)}<div class="section-line"><h3>已选单品</h3><button type="button" data-action="picker" class="text-button">选择衣物</button></div><div id="selected-list"></div><p class="field-error" data-error="clothingIds"></p>`;
  content += '</form>';
  $('#subview').innerHTML = content;
  for (const control of $('#entity-form').querySelectorAll('[name]')) control.value = draft[control.name];
  if (frame.kind === 'outfit') renderSelected();
  $('#subview').scrollTop = 0;
  $('#save-edit').disabled = false;
}
function renderSelected() {
  $('#selected-list').innerHTML = `<p class="muted">已选 ${draft.clothingIds.length}/20 件</p>` + draft.clothingIds.map((id, i) => {
    const c = clothingById.get(id);
    return `<div class="selected-row" data-selected="${id}">${image(c.imagePath,c.name)}<div><strong>${escape(c.name)}</strong><small>${c.isArchived ? '已归档' : c.color}</small><div><button type="button" data-move="${i}" data-delta="-1" ${i === 0 ? 'disabled' : ''}>上移</button><button type="button" data-move="${i}" data-delta="1" ${i === draft.clothingIds.length - 1 ? 'disabled' : ''}>下移</button><button type="button" data-remove="${id}">移除</button></div></div></div>`;
  }).join('');
}
async function selectImage(file) {
  if (!file) return;
  const key = stack.at(-1).kind === 'diary' ? 'photoPath' : 'imagePath';
  const error = $(`[data-error=${key}]`);
  if (!['image/jpeg','image/png'].includes(file.type)) { error.textContent='请选择JPEG或PNG图片'; return; }
  if (file.size > 5*1024*1024) { error.textContent='图片不能超过5MiB'; return; }
  const activeDraft=draft, url=URL.createObjectURL(file);
  ownedUrls.add(url); pendingImage=url;
  $('#save-edit').disabled=true; $('#file-input').disabled=true;
  const img=new Image(); img.src=url;
  let decoded=true;
  try { await img.decode(); } catch { decoded=false; }
  if (draft !== activeDraft) { URL.revokeObjectURL(url); ownedUrls.delete(url); return; }
  pendingImage=null; $('#save-edit').disabled=false; $('#file-input').disabled=false;
  if (!decoded) { URL.revokeObjectURL(url); ownedUrls.delete(url); error.textContent='图片无法读取，请重新选择'; return; }
  draft[key]=url; error.textContent='';
  $('#draft-image').innerHTML=image(url,'本地临时预览');
  if ($('#remove-photo')) $('#remove-photo').hidden=false;
  trackDirty(); cleanUrls();
}
function saveEditor() {
  if (stack.at(-1).kind === 'diary') { saveDiary(); return; }
  const frame = stack.at(-1), errors = {};
  const values = { ...draft, name: draft.name.trim(), ...(frame.kind === 'clothing' ? { color: draft.color.trim() } : { occasion: draft.occasion.trim() }) };
  for (const [key, max] of Object.entries(frame.kind === 'clothing' ? { name:40, color:20, note:500 } : { name:40, occasion:20, note:500 })) {
    const size = Array.from(values[key]).length;
    if ((key !== 'note' && size === 0) || size > max) errors[key] = key === 'note' ? `最多${max}字符` : `请填写1～${max}字符`;
  }
  if (frame.kind === 'clothing') {
    if (!draft.imagePath || pendingImage) errors.imagePath = '请选择有效图片';
    if (!categoryById.has(draft.categoryId)) errors.categoryId = '请选择分类';
    if (!['春','夏','秋','冬','春夏','春秋','秋冬','四季'].includes(draft.season)) errors.season = '请选择季节';
  } else if (!draft.clothingIds.length || draft.clothingIds.length > 20 || new Set(draft.clothingIds).size !== draft.clothingIds.length || draft.clothingIds.some(id => !clothingById.has(id))) errors.clothingIds = '请选择1～20件不重复衣物';
  for (const e of document.querySelectorAll('#subview [data-error]')) e.textContent = errors[e.dataset.error] || '';
  if (Object.keys(errors).length) { $(`[data-error="${Object.keys(errors)[0]}"]`).scrollIntoView({ block:'center' }); return; }
  const rows = frame.kind === 'clothing' ? data.clothes : data.outfits;
  let id = frame.id;
  if (id) Object.assign(rows.find(r => r.id === id), values);
  else {
    id = frame.kind === 'clothing' ? `TMP-CLO-${String(++clothingSequence).padStart(4,'0')}` : `TMP-OUT-${String(++outfitSequence).padStart(4,'0')}`;
    rows.unshift({ ...values, id, userId:data.demoProfile.id, isArchived:false, origin:'prototype' });
  }
  draft = null; pendingImage = null; trackDirty(); refreshViews();
  stack.pop();
  if (!(stack.at(-1)?.id === id && stack.at(-1)?.kind === frame.kind)) stack.push({ kind:frame.kind, id, mode:'detail' });
  renderView(); cleanUrls();
  $('#subview').insertAdjacentHTML('afterbegin','<p class="save-message" role="status">已保存到本次演示</p>');
}
function showPicker() {
  picker = { ids:[...draft.clothingIds], keyword:'', category:'all', archived:false };
  $('#preview-title').textContent = '选择衣物';
  $('#preview .eyebrow').textContent = '多选衣物';
  $('#preview-body').innerHTML = '<input id="picker-search" type="search" placeholder="搜索衣物" aria-label="选择器搜索"><select id="picker-category" aria-label="选择器分类"><option value="all">全部分类</option>'+data.categories.map(c=>`<option value="${c.id}">${escape(c.name)}</option>`).join('')+'</select><label class="checkbox-label"><input id="picker-archived" type="checkbox">包含已归档</label><div id="picker-selection"></div><p id="picker-message" role="status"></p><div id="picker-grid" class="clothes-grid"></div>';
  $('#preview').insertAdjacentHTML('beforeend','<div id="picker-footer"><button id="picker-cancel">取消</button><span id="picker-count"></span><button id="picker-confirm" class="primary-button">确定</button></div>');
  $('#picker-selection').insertAdjacentHTML('beforebegin', '<button id="picker-reset" class="text-button">清除筛选</button>');
  renderPicker(); $('#preview').showModal();
}
function renderPicker() {
  $('#picker-count').textContent = `已选 ${picker.ids.length}/20`;
  $('#picker-selection').innerHTML = picker.ids.map(id=>`<button class="picked-chip" data-unpick="${id}">${escape(clothingById.get(id).name)}${clothingById.get(id).isArchived ? ' · 已归档' : ''} ×</button>`).join('');
  $('#picker-grid').innerHTML = data.clothes.filter(c => (picker.archived || !c.isArchived) && (picker.category === 'all' || c.categoryId === picker.category) && c.name.includes(picker.keyword.trim())).map(c=>`<button class="clothing-tile" data-pick="${c.id}" aria-pressed="${picker.ids.includes(c.id)}">${image(c.imagePath,c.name)}<span class="clothing-name">${picker.ids.includes(c.id) ? '✓ ' : ''}${escape(c.name)}</span></button>`).join('');
  if (!$('#picker-grid').children.length) $('#picker-grid').innerHTML = '<p class="empty-day">没有匹配的衣物，已选单品仍保留</p>';
}
$('#view-back').addEventListener('click',backView);
$('#cancel-edit').addEventListener('click',backView);
$('#save-edit').addEventListener('click',saveEditor);
$('#subview').addEventListener('input',event=>{
  if (!draft || !event.target.name) return;
  draft[event.target.name] = event.target.value;
  const counter = $(`[data-counter="${event.target.name}"]`);
  if (counter) counter.textContent = `${Array.from(event.target.value).length}/${counter.dataset.limit}`;
  trackDirty();
});
$('#subview').addEventListener('change',event=>{ if(event.target.id==='file-input') selectImage(event.target.files[0]); });
$('#subview').addEventListener('submit',event=>{event.preventDefault();saveEditor();});
$('#subview').addEventListener('click',event=>{
  const button = event.target.closest('button'); if(!button) return;
  const frame = stack.at(-1);
  if(button.dataset.diary) pushView({kind:'diary',id:button.dataset.diary,mode:'detail'});
  if(button.dataset.recordOutfit) startDiaryEditor(null,button.dataset.recordOutfit);
  if(button.dataset.action === 'delete-diary') deleteDiary(frame.id);
  if(button.dataset.conflict) openConflict(button.dataset.conflict,button.dataset.conflictMode);
  if(button.id === 'remove-photo') { draft.photoPath=null; $('#draft-image').innerHTML='<p class="muted">未添加照片，将展示所选衣物</p>';button.hidden=true;trackDirty();cleanUrls(); }
  if(button.dataset.mood) {draft.mood=button.dataset.mood;$('[name=mood]').value=draft.mood;$('[data-counter=mood]').textContent=`${Array.from(draft.mood).length}/12`;trackDirty();}
  if(button.dataset.statsMonth) { statisticsMonth=shiftMonth(statisticsMonth,Number(button.dataset.statsMonth));renderStatistics();$('#subview').scrollTop=0; }
  if(button.dataset.action === 'edit') startEditor(frame.kind,frame.id);
  if(button.dataset.action === 'archive') {
    const record = frame.kind === 'clothing' ? clothingById.get(frame.id) : data.outfits.find(o=>o.id===frame.id);
    record.isArchived = !record.isArchived; refreshViews(); renderView();
  }
  if(button.dataset.related) pushView({kind:'outfit',id:button.dataset.related,mode:'detail'});
  if(button.dataset.clothing) pushView({kind:'clothing',id:button.dataset.clothing,mode:'detail'});
  if(button.dataset.action === 'picker') showPicker();
  if(button.dataset.scene) {draft.occasion=button.dataset.scene;$('[name=occasion]').value=draft.occasion;$('[data-counter=occasion]').textContent=`${Array.from(draft.occasion).length}/20`;trackDirty();}
  if(button.dataset.remove) {draft.clothingIds=draft.clothingIds.filter(id=>id!==button.dataset.remove);renderSelected();trackDirty();}
  if(button.dataset.move !== undefined) { const i=Number(button.dataset.move),j=i+Number(button.dataset.delta);[draft.clothingIds[i],draft.clothingIds[j]]=[draft.clothingIds[j],draft.clothingIds[i]];renderSelected();trackDirty();const row=$(`[data-selected="${draft.clothingIds[j]}"]`);row.querySelector('[data-remove]').focus({preventScroll:true});row.scrollIntoView({block:'nearest'}); }
});
$('#preview').addEventListener('close',()=>{picker=null;$('#picker-footer')?.remove();$('#preview-body').innerHTML='';});
$('#preview').addEventListener('input',event=>{
  if(event.target.id==='picker-search') picker.keyword=event.target.value;
  else if(event.target.id==='picker-category') picker.category=event.target.value;
  else if(event.target.id==='picker-archived') picker.archived=event.target.checked;
  else return;
  renderPicker();
});
$('#preview').addEventListener('click',event=>{
  const b=event.target.closest('button');if(!b||!picker)return;
  if(b.id==='picker-reset'){picker.keyword='';picker.category='all';$('#picker-search').value='';$('#picker-category').value='all';renderPicker();}
  const id=b.dataset.pick||b.dataset.unpick;
  if(id) {
    if(picker.ids.includes(id))picker.ids=picker.ids.filter(x=>x!==id);
    else if(picker.ids.length===20){$('#picker-message').textContent='最多选择20件，请先移除一件';return;}
    else picker.ids.push(id);
    $('#picker-message').textContent='';renderPicker();
  }
  if(b.id==='picker-cancel')$('#preview').close();
  if(b.id==='picker-confirm'){draft.clothingIds=[...picker.ids];renderSelected();trackDirty();$('#preview').close();}
});
for(const [pageId,kind] of [['wardrobe','clothing'],['outfits','outfit']]) {
  $(`#${pageId} .page-intro`).insertAdjacentHTML('afterend',`<div class="management-bar"><select id="${kind}-scope" aria-label="${kind==='clothing'?'衣物':'搭配'}范围"><option value="active">在用</option><option value="archived">已归档</option><option value="all">全部</option></select><button id="new-${kind}" class="add-button">＋ 新增${kind==='clothing'?'衣物':'搭配'}</button></div>`);
  $(`#new-${kind}`).addEventListener('click',()=>startEditor(kind));
  $(`#${kind}-scope`).addEventListener('change',event=>{if(kind==='clothing')clothesScope=event.target.value;else outfitsScope=event.target.value;refreshViews();$(`#${pageId}`).scrollTop=0;});
}
function shiftMonth(month, delta) {
  const [y,m]=month.split('-').map(Number), date=new Date(Date.UTC(y,m-1+delta,1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`;
}
function diaryPhoto(d) {
  if (!d.photoPath) return '';
  const caption=d.photoPath.startsWith('assets/') ? '同款穿着参考 · 非真实用户自拍' : '本地临时预览';
  return `<figure class="diary-photo"><button data-photo="${escape(d.photoPath)}" aria-label="放大照片"><img src="${escape(resource(d.photoPath))}" alt="${caption}"></button><figcaption>${caption}</figcaption></figure>`;
}
function renderDiaryDetail(frame) {
  const d=diaryById.get(frame.id), source=d.sourceOutfitId ? data.outfits.find(o=>o.id===d.sourceOutfitId) : null;
  $('#subview').innerHTML=`<div class="detail-top"><span class="status-label">穿搭记录</span><div><button data-action="edit">编辑</button><button data-action="delete-diary">删除</button></div></div><h2 class="detail-title">${d.wearDate}</h2><div class="diary-meta"><span>${escape(d.occasion)}</span>${d.mood ? `<span>${escape(d.mood)}</span>` : ''}</div><p class="diary-note">${escape(d.note)}</p>${diaryPhoto(d)}<h3 class="detail-section">当次单品 · ${d.clothingIds.length} 件</h3><div class="preview-outfit-grid">${d.clothingIds.map(id=>clothingTile(clothingById.get(id),true)).join('')}</div><h3 class="detail-section">记录来源</h3>${source ? `<button class="related-row" data-related="${source.id}"><span class="related-label">${escape(source.name)}${source.isArchived ? ' · 已归档' : ''}</span><span>›</span></button><p class="muted">由此搭配发起，实际单品以本篇记录为准</p>` : '<p class="muted">直接选衣记录</p>'}`;
  $('#subview').scrollTop=frame.scroll || 0;
}
function startDiaryEditor(id=null, sourceId=null) {
  const d=id ? diaryById.get(id) : null, o=sourceId ? data.outfits.find(o=>o.id===sourceId) : null;
  draft={wearDate:d ? d.wearDate : o ? DEMO_TODAY : state.date,sourceOutfitId:d ? d.sourceOutfitId : o ? o.id : null,clothingIds:[...(d ? d.clothingIds : o ? o.clothingIds : [])],occasion:d ? d.occasion : o ? o.occasion : '',mood:d?.mood || '',note:d?.note || '',photoPath:d?.photoPath || null};
  initialDraft=JSON.stringify(draft);trackDirty();pushView({kind:'diary',id,mode:'edit'});
}
function renderDiaryEditor() {
  const source=draft.sourceOutfitId ? data.outfits.find(o=>o.id===draft.sourceOutfitId) : null;
  $('#subview').innerHTML=`<p class="editor-hint">仅本次演示生效，刷新恢复样例</p><p class="muted">演示基准日：${DEMO_TODAY}</p><form id="entity-form" novalidate><label class="field">穿着日期 *<input name="wearDate" type="date" max="${DEMO_TODAY}"><span class="field-error" data-error="wearDate"></span><div id="date-conflict"></div></label><p class="source-note">${source ? `由${escape(source.name)}${source.isArchived ? "（已归档）" : ""}发起，实际单品以本篇记录为准` : '直接选衣记录'}</p>${field('occasion','场景 *',20)}${field('mood','心情（选填）',12)}<div class="scene-shortcuts">${['轻松','专注','愉快','从容','放松','平静','满意'].map(m=>`<button type="button" data-mood="${m}">${m}</button>`).join('')}</div>${field('note','穿搭文字（选填）',1000,true)}<h3 class="detail-section">照片（选填）</h3><div id="draft-image">${draft.photoPath ? image(draft.photoPath,'日记照片预览') : '<p class="muted">未添加照片，将展示所选衣物</p>'}</div><label class="file-button">选择或更换照片<input id="file-input" type="file" accept="image/jpeg,image/png"></label><p class="muted">JPEG / PNG · 最大5MiB · 仅本地预览</p><button type="button" id="remove-photo" class="text-button" ${draft.photoPath ? '' : 'hidden'}>移除照片</button><span class="field-error" data-error="photoPath"></span><div class="section-line"><h3>当次单品</h3><button type="button" data-action="picker" class="text-button">选择衣物</button></div><div id="selected-list"></div><span class="field-error" data-error="clothingIds"></span></form>`;
  for(const c of $('#entity-form').querySelectorAll('[name]')) c.value=draft[c.name];
  renderSelected();$('#save-edit').disabled=false;$('#subview').scrollTop=0;
}
function validWearDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date=new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10)===value && value<=DEMO_TODAY;
}
function saveDiary() {
  const frame=stack.at(-1), errors={}, values={...draft,occasion:draft.occasion.trim(),mood:draft.mood.trim() || null,clothingIds:[...draft.clothingIds]};
  if (!validWearDate(values.wearDate)) errors.wearDate='请选择不晚于演示基准日的真实日期';
  if (!values.occasion || Array.from(values.occasion).length>20) errors.occasion='请填写1～20字符';
  if (values.mood && Array.from(values.mood).length>12) errors.mood='最多12字符';
  if (Array.from(values.note).length>1000) errors.note='最多1000字符';
  if (!values.clothingIds.length || values.clothingIds.length>20 || new Set(values.clothingIds).size!==values.clothingIds.length || values.clothingIds.some(id=>!clothingById.has(id)||clothingById.get(id).userId!==data.demoProfile.id)) errors.clothingIds='请选择1～20件不重复衣物';
  if (pendingImage) errors.photoPath='图片正在读取，请稍候';
  const conflict=data.diaries.find(d=>d.userId===data.demoProfile.id && d.wearDate===values.wearDate && d.id!==frame.id);
  if (!errors.wearDate && conflict) errors.wearDate='该日期已有穿搭记录';
  for(const e of $('#subview').querySelectorAll('[data-error]')) e.textContent=errors[e.dataset.error] || '';
  $('#date-conflict').innerHTML=conflict ? `<button type="button" data-conflict="${conflict.id}" data-conflict-mode="detail">查看已有记录</button><button type="button" data-conflict="${conflict.id}" data-conflict-mode="edit">编辑已有记录</button>` : '';
  if(Object.keys(errors).length){$(`[data-error="${Object.keys(errors)[0]}"]`).scrollIntoView({block:'center'});return;}
  let id=frame.id;
  if(id) Object.assign(diaryById.get(id),values);
  else {id=`TMP-DIA-${String(++diarySequence).padStart(4,'0')}`;data.diaries.push({...values,id,userId:data.demoProfile.id,origin:'prototype'});}
  draft=null;trackDirty();state.date=values.wearDate;state.month=values.wearDate.slice(0,7);refreshViews();$('#diary').scrollTop=0;
  stack.pop();if(stack.at(-1)?.kind!=='diary'||stack.at(-1)?.id!==id)stack.push({kind:'diary',id,mode:'detail'});else stack.at(-1).scroll=0;
  renderView();cleanUrls();$('#subview').insertAdjacentHTML('afterbegin','<p class="save-message" role="status">已保存到本次演示</p>');
}
function openConflict(id,mode) {
  if(!leaveEditor())return;
  stack.pop();if(stack.at(-1)?.kind!=='diary'||stack.at(-1)?.id!==id)stack.push({kind:'diary',id,mode:'detail'});
  renderView();if(mode==='edit')startDiaryEditor(id);
}
function deleteDiary(id) {
  const d=diaryById.get(id);
  if(!confirm(`删除${d.wearDate}的穿搭记录？仅本次演示生效`))return;
  data.diaries=data.diaries.filter(d=>d.id!==id);state.date=d.wearDate;state.month=d.wearDate.slice(0,7);stack=[];state.activeTab='diary';
  for(const b of document.querySelectorAll('[data-tab]')){if(b.dataset.tab==='diary')b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}
  refreshViews();renderView();$('#diary').scrollTop=0;cleanUrls();
}
function wearMetrics(id) {
  const dates=data.diaries.filter(d=>d.wearDate<=DEMO_TODAY && d.clothingIds.includes(id)).map(d=>d.wearDate).sort();
  return {count:dates.length,last:dates.at(-1)||null,recent:dates.some(d=>d>=RECENT_START)};
}
function renderStatistics() {
  const active=data.clothes.filter(c=>!c.isArchived), rows=active.map(c=>({...c,...wearMetrics(c.id)}));
  const top=rows.filter(c=>c.count>0).sort((a,b)=>b.count-a.count||(a.id<b.id?-1:1)).slice(0,5), unworn=rows.filter(c=>!c.recent).sort((a,b)=>a.id<b.id?-1:1);
  const row=c=>`<button class="stat-row" data-clothing="${c.id}">${image(c.imagePath,c.name)}<span><strong>${escape(c.name)}</strong><small>${c.count}次 · 最近：${c.last || '尚未记录'}</small></span></button>`;
  $('#subview').innerHTML=`<p class="editor-hint">演示基准日：${DEMO_TODAY}</p><p class="muted">最近30天：${RECENT_START} ～ ${DEMO_TODAY}（含首尾）</p><div class="stat-total"><strong id="stat-total">${active.length}</strong><span>件在用衣物</span></div><h3>分类分布</h3><div id="stat-categories">${data.categories.map(c=>{const count=active.filter(x=>x.categoryId===c.id).length;return `<div class="category-stat" data-stat-category="${c.id}"><span>${escape(c.name)}</span><div><i style="width:${active.length ? count/active.length*100 : 0}%"></i></div><strong>${count}</strong></div>`;}).join('')}</div><h3 class="detail-section">月度记录</h3><div class="month-line"><button data-stats-month="-1" aria-label="统计上月">‹</button><span id="stats-month">${statisticsMonth}</span><button data-stats-month="1" aria-label="统计下月">›</button></div><p class="month-days">本月记录 <strong id="stat-days">${data.diaries.filter(d=>d.wearDate.startsWith(statisticsMonth)).length}</strong> 天</p><h3 class="detail-section">累计常穿 Top5</h3><p class="muted">截至演示基准日，按穿着次数排序</p><div id="stat-top">${top.map(row).join('')||'<p class="empty-day">暂无穿着记录</p>'}</div><h3 class="detail-section">最近30天未穿 · ${unworn.length} 件</h3><div id="stat-unworn">${unworn.map(row).join('')||'<p class="empty-day">暂无符合条件的衣物</p>'}</div>`;
}
function openInfo(title,content) {
  $('#preview .eyebrow').textContent='演示说明';$('#preview-title').textContent=title;$('#preview-body').innerHTML=content;$('#preview').showModal();
}
document.addEventListener('click',event=>{
  const b=event.target.closest('button');if(!b)return;
  if(b.hasAttribute('data-new-diary'))startDiaryEditor();
  if(b.dataset.diary && !event.composedPath().includes($('#subview')))pushView({kind:'diary',id:b.dataset.diary,mode:'detail'});
  if(b.id==='demo-today'){state.date=DEMO_TODAY;state.month=DEMO_TODAY.slice(0,7);renderCalendar();$('#diary').scrollTop=0;}
  if(b.id==='open-statistics')pushView({kind:'statistics',mode:'detail'});
  if(b.dataset.photo)openInfo('照片预览',`<img class="enlarged-photo" src="${escape(resource(b.dataset.photo))}" alt="日记照片">`);
  if(b.id==='profile-info')openInfo('个人资料（示意）',`<p>${escape(data.demoProfile.nickname)}</p><p class="muted">资料编辑将在后续版本提供</p>`);
  if(b.id==='login-info')openInfo('登录说明（示意）','<p>当前使用演示身份，登录与注册将在后续版本提供</p>');
});
loadData();
