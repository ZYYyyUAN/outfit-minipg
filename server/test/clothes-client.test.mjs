import test from 'node:test';
import assert from 'node:assert/strict';
import { clientHarness } from './client-harness.mjs';
const flush = () => new Promise(resolve=>setImmediate(resolve));
function formHarness(handle) {
  const harness=clientHarness(handle,{redirectTo:options=>harness.calls.push(['redirectTo',options])});
  harness.setApp({authReady:Promise.resolve()});
  harness.session.adopt({token:'x'.repeat(43),expiresAt:'2027-01-01T00:00:00.000Z',user:{id:99,username:'fixture',nickname:'fixture'}});
  return harness;
}
const valid={name:'针织',categoryId:'tops',imagePath:'users/99/00000000-0000-0000-0000-000000000001.jpg',color:'浅粉色',season:'春秋',note:''};
test('clothes form cancel stays a draft; invalid inputs do not POST',async()=> {
  const sent=[];
  const harness=formHarness(options=>{sent.push(options);options.success({statusCode:200,data:{data:{items:[{id:'tops',name:'上装'}]}}});});
  const page=harness.load('pages/clothes/edit/index.js');await page.onLoad({});await flush();
  page.setData({form:{...valid,name:'a'.repeat(41)}});page.syncFields();await page.save();
  assert.equal(page.data.focusField,'name');assert.equal(sent.filter(row=>row.method==='POST').length,0);
  page.cancel();const modal=harness.calls.find(row=>row[0]==='modal')[1];
  modal.success({confirm:false});assert.equal(harness.calls.filter(row=>row[0]==='navigateBack').length,0);
  modal.success({confirm:true});assert.equal(harness.calls.filter(row=>row[0]==='navigateBack').length,1);
});
test('clothes form failed save preserves stable image and dirty draft',async()=> {
  const harness=formHarness(options=> {
    if(options.method==='POST') options.success({statusCode:500,data:{error:{code:'INTERNAL_ERROR',message:'保存失败'}}});
    else options.success({statusCode:200,data:{data:{items:[{id:'tops',name:'上装'}]}}});
  });
  const page=harness.load('pages/clothes/edit/index.js');await page.onLoad({});await flush();
  page.setData({form:{...valid}});page.syncFields();await page.save();
  assert.equal(page.data.error,'保存失败');assert.equal(page.data.form.imagePath,valid.imagePath);assert.equal(page.data.dirty,true);assert.equal(page.data.busy,false);
  assert.equal(harness.calls.filter(row=>row[0]==='redirectTo').length,0);
});
test('clothes late successful save after unloading never navigates',async()=> {
  let pending;
  const harness=formHarness(options=> {
    if(options.method==='POST') pending=options;
    else options.success({statusCode:200,data:{data:{items:[{id:'tops',name:'上装'}]}}});
  });
  const page=harness.load('pages/clothes/edit/index.js');await page.onLoad({});await flush();
  page.setData({form:{...valid}});page.syncFields();const saved=page.save();page.onUnload();
  pending.success({statusCode:201,data:{data:{id:123,...valid}}});await saved;
  assert.equal(harness.calls.filter(row=>['redirectTo','navigateBack'].includes(row[0])).length,0);
});

function listHarness() {
  const pending=[];
  const harness=formHarness(options=> {
    if(options.url.includes('/clothes/facets')) options.success({statusCode:200,data:{data:{colors:[]}}});
    else if(options.url.includes('/categories')) options.success({statusCode:200,data:{data:{items:[{id:'tops',name:'上装'}]}}});
    else pending.push(options);
  });
  harness.wx.pageScrollTo=options=>harness.calls.push(['scroll',options]);
  const page=harness.load('pages/wardrobe/index.js');page.onLoad();
  return {harness,page,pending};
}
const listResponse=(options,items,total,page=1)=>options.success({statusCode:200,data:{data:{items,total,page,pageSize:12}}});
test('wardrobe obsolete filter response cannot replace current query',async()=> {
  const {page,pending}=listHarness();await page.onShow();
  assert.equal(pending.length,1);page.category({currentTarget:{dataset:{id:'tops'}}});assert.equal(pending.length,2);
  listResponse(pending[1],[],0);await flush();
  listResponse(pending[0],[{id:1,imagePath:'old'}],1);await flush();
  assert.equal(page.data.items.length,0);assert.equal(page.data.categoryId,'tops');assert.equal(page.data.total,0);
});
test('wardrobe failed next page retains data and retries same page',async()=> {
  const {page,pending}=listHarness();await page.onShow();
  listResponse(pending[0],Array.from({length:12},(_,i)=>({id:i+1,imagePath:'fixture'})),13);await flush();
  page.more();page.more();assert.equal(pending.length,2);assert.equal(pending[1].data.page,2);
  pending[1].fail({errMsg:'request:fail timeout'});await flush();
  assert.equal(page.data.page,1);assert.equal(page.data.items.length,12);
  page.retry();assert.equal(pending[2].data.page,2);
  listResponse(pending[2],[{id:13,imagePath:'fixture'}],13,2);await flush();
  assert.equal(page.data.page,2);assert.equal(page.data.items.length,13);
});
test('wardrobe hidden response and older account never populate page',async()=> {
  const {harness,page,pending}=listHarness();await page.onShow();page.onHide();
  listResponse(pending[0],[{id:1,imagePath:'old'}],1);await flush();assert.equal(page.data.items.length,0);
  harness.session.clear();harness.session.adopt({token:'y'.repeat(43),expiresAt:'2027-01-01',user:{id:100}});
  await page.onShow();assert.equal(page.data.keyword,'');assert.equal(page.data.items.length,0);
  listResponse(pending[1],[],0);await flush();assert.equal(page.data.total,0);
});
test('wardrobe filter cancel preserves applied conditions and clear retains archive scope',async()=> {
  const {page}=listHarness();await page.onShow();
  page.setData({color:'浅粉色',season:'秋',archived:'archived'});page.openPanel();page.chooseColor({currentTarget:{dataset:{value:'蓝色'}}});page.closePanel();
  assert.equal(page.data.color,'浅粉色');page.clearFilters();assert.equal(page.data.archived,'archived');assert.equal(page.data.color,'');assert.equal(page.data.season,'');
});

test('clothes successful replacement upload stays a draft and cancel makes no business write',async()=> {
  const sent=[];let uploaded;
  const harness=formHarness(options=>{sent.push(options);options.success({statusCode:200,data:{data:{items:[{id:'tops',name:'上装'}]}}});});
  harness.wx.chooseMedia=options=>options.success({tempFiles:[{size:100,tempFilePath:'wxfile://candidate.jpg'}]});
  harness.wx.uploadFile=options=>{uploaded=options;};
  const page=harness.load('pages/clothes/edit/index.js');await page.onLoad({});await flush();
  page._initial={...valid};page.setData({form:{...valid}});page.syncFields();page.choose();
  assert.equal(page.data.form.imagePath,valid.imagePath);assert.equal(page.data.uploadState,'uploading');
  const imagePath='users/99/00000000-0000-0000-0000-000000000002.jpg';
  uploaded.success({statusCode:201,data:JSON.stringify({data:{imagePath,imageUrl:'http://127.0.0.1:3000/api/media/00000000-0000-0000-0000-000000000002.jpg',mimeType:'image/jpeg',size:100}})});await flush();
  assert.equal(page.data.form.imagePath,imagePath);assert.equal(page.data.dirty,true);
  page.cancel();harness.calls.find(row=>row[0]==='modal')[1].success({confirm:true});
  assert.equal(sent.filter(row=>row.method!=='GET').length,0);assert.equal(harness.calls.filter(row=>row[0]==='navigateBack').length,1);
});
test('clothes replacement save sends stable uploaded path and failed upload can be abandoned',async()=> {
  const sent=[];let uploaded;
  const harness=formHarness(options=>{sent.push(options);options.success({statusCode:options.method==='POST'?201:200,data:{data:options.method==='POST'?{id:200}:{items:[{id:'tops',name:'上装'}]}}});});
  harness.wx.chooseMedia=options=>options.success({tempFiles:[{size:100,tempFilePath:'wxfile://candidate.jpg'}]});harness.wx.uploadFile=options=>{uploaded=options;};
  const page=harness.load('pages/clothes/edit/index.js');await page.onLoad({});await flush();page.setData({form:{...valid}});page.choose();
  uploaded.fail({errMsg:'uploadFile:fail timeout'});await flush();assert.equal(page.data.uploadState,'failed');page.discardCandidate();assert.equal(page.data.form.imagePath,valid.imagePath);
  page.choose();const imagePath='users/99/00000000-0000-0000-0000-000000000003.jpg';
  uploaded.success({statusCode:201,data:JSON.stringify({data:{imagePath,imageUrl:'http://127.0.0.1:3000/api/media/00000000-0000-0000-0000-000000000003.jpg',mimeType:'image/jpeg',size:100}})});await flush();await page.save();
  assert.equal(sent.find(row=>row.method==='POST').data.imagePath,imagePath);assert.equal(page.data.dirty,false);
});
