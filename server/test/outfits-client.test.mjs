import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { serverRoot } from '../src/config.js';
import { clientHarness } from './client-harness.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
const event=dataset=>({currentTarget:{dataset}});
const ok=(request,data)=>request.success({statusCode:200,data:{data}});
const fail=(request,status=500)=>request.success({statusCode:status,data:{error:{code:status===404?'NOT_FOUND':'INTERNAL_ERROR',message:'读取失败'}}});
const child=id=>({id,name:'单品'+id,imagePath:'users/99/00000000-0000-0000-0000-'+String(id).padStart(12,'0')+'.jpg',isArchived:id===20});
const summary=(id=1,count=5)=>({id,name:'搭配'+id,occasion:'日常',isArchived:false,clothingCount:count,previewItems:Array.from({length:Math.min(count,4)},(_,i)=>child(i+1))});
const detail=(count=5,isArchived=false)=>({id:35,name:'完整组合',occasion:'日常',note:'第一行\n第二行',isArchived,items:Array.from({length:count},(_,i)=>child(i+1)),createdAt:'2026-11-17T00:00:00.000Z',updatedAt:'2026-11-17T00:00:00.000Z'});
const pageResult=(items=[],total=items.length,page=1,pageSize=12)=>({items,total,page,pageSize});
function setup(relative='pages/outfits/index.js') {
  const requests=[],images=[];
  const h=clientHarness(options=>requests.push(options),{downloadFile:options=>images.push(options)});
  h.wx.pageScrollTo=options=>h.calls.push(['scroll',options]);
  h.wx.showToast=options=>h.calls.push(['toast',options]);
  h.setApp({authReady:Promise.resolve()});
  h.session.adopt({token:'x'.repeat(43),expiresAt:'2027-01-01T00:00:00.000Z',user:{id:99}});
  const page=h.load(relative);page.onLoad({id:relative.includes('clothes/detail')?'123':'35'});
  return {h,page,requests,images,list:()=>requests.filter(row=>row.url.endsWith('/outfits')),facets:()=>requests.filter(row=>row.url.endsWith('/outfits/facets'))};
}
async function showDetail(count=5) {
  const env=setup('pages/outfits/detail/index.js');await env.page.onShow();ok(env.requests[0],detail(count));await flush();return env;
}

test('outfits first-page failure remains retryable; empty success is a business state',async()=> {
  const {page,list}=setup();await page.onShow();fail(list()[0]);await flush();
  assert.equal(page.data.page,0);assert.equal(page.data.busy,false);assert.equal(page.data.error,'读取失败');
  page.retry();assert.equal(list()[1].data.page,1);ok(list()[1],pageResult());await flush();
  assert.equal(page.data.page,1);assert.equal(page.data.items.length,0);assert.equal(page.data.error,'');
});
test('outfits keyword changes only on search confirmation; Unicode length and clear are explicit',async()=> {
  const {page,list}=setup();await page.onShow();ok(list()[0],pageResult());await flush();
  page.keywordInput({detail:{value:'  日常  '}});assert.equal(list().length,1);assert.equal(page.data.keyword,'');
  page.search();assert.equal(list()[1].data.keyword,'日常');ok(list()[1],pageResult());await flush();
  page.keywordInput({detail:{value:'😀'.repeat(41)}});page.search();assert.equal(list().length,2);assert.match(page.data.error,/40/);
  page.keywordInput({detail:{value:'😀'.repeat(40)}});page.search();assert.equal(list()[2].data.keyword,'😀'.repeat(40));
  page.clearSearch();assert.equal(list()[3].data.keyword,undefined);assert.equal(page.data.keywordDraft,'');
});
test('outfits panel drafts never query list until applied; cancel and reset have separate semantics',async()=> {
  const {page,list,facets}=setup();await page.onShow();ok(list()[0],pageResult());await flush();
  page.setData({keyword:'针织',keywordDraft:'针织',occasion:'日常'});page.openPanel();
  page.chooseOccasion(event({value:'通勤'}));page.chooseScope(event({id:'archived'}));
  assert.equal(list().length,1);assert.equal(page.data.occasion,'日常');assert.equal(page.data.archived,'active');assert.equal(facets().at(-1).data.archived,'archived');
  page.closePanel();assert.equal(page.data.occasion,'日常');assert.equal(page.data.archived,'active');assert.equal(list().length,1);
  page.openPanel();assert.equal(page.data.draftOccasion,'日常');page.chooseOccasion(event({value:'通勤'}));page.chooseScope(event({id:'all'}));page.applyPanel();
  assert.deepEqual(JSON.parse(JSON.stringify(list().at(-1).data)),{page:1,pageSize:12,archived:'all',keyword:'针织',occasion:'通勤'});
  page.openPanel();page.resetPanel();assert.equal(page.data.archived,'all');assert.equal(page.data.draftArchived,'active');page.closePanel();assert.equal(page.data.archived,'all');
  page.clearFilters();assert.equal(page.data.keyword,'');assert.equal(page.data.keywordDraft,'');assert.equal(page.data.occasion,'');assert.equal(list().at(-1).data.archived,'active');
});
test('outfits facets ignore old scopes and can retry the current draft scope',async()=> {
  const {page,facets}=setup();await page.onShow();page.openPanel();page.chooseScope(event({id:'archived'}));
  ok(facets()[2],{occasions:['归档场景']});ok(facets()[0],{occasions:['旧场景']});await flush();
  assert.deepEqual([...page.data.occasions],['归档场景']);
  page.chooseScope(event({id:'all'}));fail(facets()[3]);await flush();assert.equal(page.data.facetError,'读取失败');
  page.retryFacets();assert.equal(facets()[4].data.archived,'all');ok(facets()[4],{occasions:['全部场景']});await flush();assert.equal(page.data.facetError,'');
});
test('outfits pagination retains 12 rows on failure and retries page 2 without duplicate appends',async()=> {
  const {page,list}=setup();await page.onShow();ok(list()[0],pageResult(Array.from({length:12},(_,i)=>summary(i+1)),13));await flush();
  page.more();page.more();assert.equal(list().length,2);assert.equal(list()[1].data.page,2);
  list()[1].fail({errMsg:'request:fail timeout'});await flush();assert.equal(page.data.page,1);assert.equal(page.data.items.length,12);
  page.retry();assert.equal(list()[2].data.page,2);ok(list()[2],pageResult([summary(13)],13,2));await flush();
  assert.equal(page.data.items.length,13);assert.equal(new Set(page.data.items.map(row=>row.id)).size,13);assert.equal(page.data.page,2);
  page.more();assert.equal(list().length,3);
});
test('outfits obsolete list responses cannot replace a newer filter',async()=> {
  const {page,list}=setup();await page.onShow();page.setData({keywordDraft:'新查询'});page.search();
  ok(list()[1],pageResult());ok(list()[0],pageResult([summary()]));await flush();assert.equal(page.data.items.length,0);assert.equal(page.data.keyword,'新查询');
});
test('outfits pending first-page images remain valid when an appended page fails',async()=> {
  const {page,list,images}=setup();await page.onShow();ok(list()[0],pageResult([summary(1,1)],2));await flush();assert.equal(images.length,1);
  page.more();list()[1].fail({errMsg:'request:fail timeout'});await flush();images[0].success({statusCode:200,tempFilePath:'wxfile://retained'});await flush();
  assert.equal(page.data.items[0].previewItems[0].src,'wxfile://retained');assert.equal(page.data.items[0].previewItems[0].imageState,'ready');assert.equal(page.data.page,1);assert.equal(images.length,1);
});
test('outfits uses real preview count, total clothing count, and authenticated local media paths',async()=> {
  const {page,list,images}=setup();await page.onShow();ok(list()[0],pageResult([summary(1,1),summary(2,20)]));await flush();
  assert.equal(page.data.items[0].previewItems.length,1);assert.equal(page.data.items[1].previewItems.length,4);assert.equal(page.data.items[1].clothingCount,20);assert.equal(images.length,5);
  assert.equal(images[0].header.Authorization,'Bearer '+'x'.repeat(43));images[0].success({statusCode:200,tempFilePath:'wxfile://single'});await flush();
  assert.equal(page.data.items[0].previewItems[0].src,'wxfile://single');
});
test('outfits image retry ignores earlier downloads and obsolete render errors',async()=> {
  const {h,page,list,images}=setup();await page.onShow();ok(list()[0],pageResult([summary(1,1)]));await flush();
  page.retryImage(event({parent:1,id:1}));images[1].success({statusCode:200,tempFilePath:'wxfile://new'});images[0].fail({errMsg:'downloadFile:fail timeout'});await flush();
  assert.equal(page.data.items[0].previewItems[0].src,'wxfile://new');page.imageFailed(event({parent:1,id:1,src:'wxfile://old'}));assert.equal(page.data.items[0].previewItems[0].src,'wxfile://new');
  page.imageFailed(event({parent:1,id:1,src:'wxfile://new'}));assert.equal(page.data.items[0].previewItems[0].imageState,'failed');assert.equal(h.calls.filter(row=>row[0]==='navigateTo').length,0);
});
test('outfits no-write return keeps filters, both pages, and scroll without another list read',async()=> {
  const {h,page,list,facets}=setup();await page.onShow();ok(list()[0],pageResult(Array.from({length:12},(_,i)=>summary(i+1,1)),13));ok(facets()[0],{occasions:['日常']});await flush();
  page.more();ok(list()[1],pageResult([summary(13,1)],13,2));await flush();page.setData({keyword:'日常',keywordDraft:'日常'});page.onPageScroll({scrollTop:820});page.onHide();await page.onShow();
  assert.equal(list().length,2);assert.equal(page.data.page,2);assert.equal(page.data.items.length,13);assert.equal(page.data.keyword,'日常');assert.equal(h.calls.at(-1)[1].scrollTop,820);
});
test('outfits revision refresh starts page 1 and facets at top, retaining applied conditions',async()=> {
  const {h,page,list,facets}=setup();await page.onShow();ok(list()[0],pageResult([summary()]));await flush();page.setData({keyword:'组合',occasion:'通勤',archived:'all'});page.onPageScroll({scrollTop:900});page.onHide();h.load('utils/outfit-state.js').changed();await page.onShow();
  assert.equal(list()[1].data.page,1);assert.equal(list()[1].data.keyword,'组合');assert.equal(list()[1].data.occasion,'通勤');assert.equal(facets().at(-1).data.archived,'all');assert.equal(page.data.items.length,0);assert.equal(h.calls.at(-1)[1].scrollTop,0);
});
test('outfits hidden, unloaded, and different-account callbacks cannot populate current data',async()=> {
  const {h,page,list,facets,images}=setup();await page.onShow();page.onHide();ok(list()[0],pageResult([summary()]));ok(facets()[0],{occasions:['旧账号']});await flush();assert.equal(page.data.items.length,0);assert.equal(page.data.occasions.length,0);
  await page.onShow();ok(list()[1],pageResult([summary(1,1)]));await flush();page.onUnload();images[0].success({statusCode:200,tempFilePath:'wxfile://old'});await flush();assert.equal(page.data.items[0].previewItems[0].src,'');
  h.session.adopt({token:'y'.repeat(43),user:{id:100}});await page.onShow();assert.equal(page.data.items.length,0);assert.equal(page.data.keyword,'');ok(list()[2],pageResult());await flush();assert.equal(page.data.total,0);
});
test('outfits pending onShow guard cannot run an older visibility cycle',async()=> {
  const {h,page,list}=setup();let resolve;h.setApp({authReady:new Promise(done=>resolve=done)});
  const first=page.onShow();page.onHide();const second=page.onShow();resolve();await Promise.all([first,second]);assert.equal(list().length,1);
});
for(const count of [1,4,5,20]) test('outfit detail renders all '+count+' ordered clothes, independent of preview',async()=> {
  const {page,images}=await showDetail(count);assert.deepEqual(page.data.outfit.items.map(row=>row.id),Array.from({length:count},(_,i)=>i+1));assert.equal(images.length,count);assert.equal(page.data.outfit.note,'第一行\n第二行');if(count===20) assert.equal(page.data.outfit.items[19].isArchived,true);
});
test('outfit detail 404 is a unified inaccessible state; temporary failure can retry',async()=> {
  const {page,requests}=setup('pages/outfits/detail/index.js');await page.onShow();fail(requests[0],404);await flush();assert.equal(page.data.notFound,true);assert.equal(page.data.error,'搭配不存在或无法访问');
  const pending=page.load();fail(requests[1]);await pending;assert.equal(page.data.notFound,false);const retry=page.load();ok(requests[2],detail());await retry;assert.equal(page.data.error,'');assert.equal(page.data.outfit.id,35);
});
test('outfit archive cancellation does not write or invalidate; duplicate confirmation is blocked',async()=> {
  const {h,page,requests}=await showDetail();const state=h.load('utils/outfit-state.js');page.archive();page.archive();assert.equal(h.calls.filter(row=>row[0]==='modal').length,1);
  await h.calls.find(row=>row[0]==='modal')[1].success({confirm:false});assert.equal(requests.length,1);assert.equal(state.current(),0);assert.equal(page.data.acting,false);
});
test('outfit archive and restore update detail and invalidate list/facets on next show',async()=> {
  const {h,page,requests}=await showDetail(20);const state=h.load('utils/outfit-state.js');page.archive();const archive=h.calls.find(row=>row[0]==='modal')[1].success({confirm:true});
  assert.equal(requests[1].method,'PATCH');assert.equal(requests[1].data.isArchived,true);assert.equal(state.current(),0);ok(requests[1],detail(20,true));await archive;
  assert.equal(page.data.outfit.isArchived,true);assert.equal(page.data.outfit.items.length,20);assert.equal(state.current(),1);assert.equal(h.calls.at(-1)[1].title,'已归档');
  page.archive();const restore=h.calls.filter(row=>row[0]==='modal').at(-1)[1].success({confirm:true});assert.equal(requests[2].data.isArchived,false);ok(requests[2],detail(20));await restore;assert.equal(page.data.outfit.isArchived,false);assert.equal(state.current(),2);assert.equal(h.calls.at(-1)[1].title,'已恢复');
  const list=h.load('pages/outfits/index.js');list.onLoad();await list.onShow();const reads=requests.filter(row=>row.method==='GET');assert.ok(reads.some(row=>row.url.endsWith('/outfits/facets')));assert.ok(reads.some(row=>row.url.endsWith('/outfits') && row.data.page===1));
});
test('outfit failed archive keeps detail and permits retry without success feedback',async()=> {
  const {h,page,requests}=await showDetail();page.archive();const saved=h.calls.find(row=>row[0]==='modal')[1].success({confirm:true});fail(requests[1]);await saved;
  assert.equal(page.data.outfit.isArchived,false);assert.equal(page.data.outfit.items.length,5);assert.equal(page.data.acting,false);assert.equal(page.data.error,'读取失败');assert.equal(h.load('utils/outfit-state.js').current(),0);assert.equal(h.calls.filter(row=>row[0]==='toast').length,0);page.archive();assert.equal(h.calls.filter(row=>row[0]==='modal').length,2);
});
test('outfit late archive completion after hiding only invalidates the same session',async()=> {
  const {h,page,requests}=await showDetail();page.archive();const saved=h.calls.find(row=>row[0]==='modal')[1].success({confirm:true});page.onHide();ok(requests[1],detail(5,true));await saved;
  assert.equal(page.data.outfit.isArchived,false);assert.equal(h.calls.filter(row=>row[0]==='toast').length,0);assert.equal(h.load('utils/outfit-state.js').current(),1);
  await page.onShow();assert.equal(requests.at(-1).url.endsWith('/outfits/35'),true);
});
test('outfit old modal and old archive responses never write into a different account',async()=> {
  const {h,page,requests}=await showDetail();page.archive();const modal=h.calls.find(row=>row[0]==='modal')[1];h.session.adopt({token:'y'.repeat(43),user:{id:100}});await modal.success({confirm:true});assert.equal(requests.length,1);
  await page.onShow();ok(requests[1],detail());await flush();page.archive();const saved=h.calls.filter(row=>row[0]==='modal').at(-1)[1].success({confirm:true});h.session.adopt({token:'z'.repeat(43),user:{id:101}});ok(requests[2],detail(5,true));await saved;
  assert.equal(h.load('utils/outfit-state.js').current(),0);assert.equal(h.calls.filter(row=>row[0]==='toast').length,0);await page.onShow();assert.equal(page.data.outfit,null);
});
test('late archive completion refreshes an already visible list after its older read',async()=> {
  const {h,page,requests}=await showDetail();page.archive();const saved=h.calls.find(row=>row[0]==='modal')[1].success({confirm:true});page.onHide();
  const list=h.load('pages/outfits/index.js');list.onLoad();await list.onShow();const old=requests.find(row=>row.url.endsWith('/outfits'));
  ok(old,pageResult([summary(35)]));await flush();assert.equal(list.data.items.length,1);ok(requests[1],detail(5,true));await saved;
  assert.equal(list.data.items.length,0);assert.equal(requests.at(-1).data.page,1);assert.equal(requests.filter(row=>row.url.endsWith('/outfits/facets')).length,2);
  list.onHide();const before=requests.length;h.load('utils/outfit-state.js').changed();assert.equal(requests.length,before);
});
test('detail reshown during archive waits for settlement before rereading; hidden callback stays invisible',async()=> {
  const {h,page,requests}=await showDetail();page.archive();const saved=h.calls.find(row=>row[0]==='modal')[1].success({confirm:true});page.onHide();const shown=page.onShow();await flush();assert.equal(requests.length,2);assert.equal(page.data.acting,true);
  ok(requests[1],detail(5,true));await saved;await shown;assert.equal(requests.length,3);assert.equal(h.calls.filter(row=>row[0]==='toast').length,0);ok(requests[2],detail(5,true));await flush();assert.equal(page.data.outfit.isArchived,true);assert.equal(page.data.acting,false);
});
test('new account immediately clears old outfit while the old account archive is still pending',async()=> {
  const {h,page,requests}=await showDetail();page.archive();const saved=h.calls.find(row=>row[0]==='modal')[1].success({confirm:true});page.onHide();h.session.adopt({token:'y'.repeat(43),user:{id:100}});
  const shown=page.onShow();assert.equal(page.data.outfit,null);await shown;assert.equal(requests.length,3);assert.equal(page.data.outfit,null);
  ok(requests[2],{...detail(1),name:'B的搭配'});await flush();ok(requests[1],detail(5,true));await saved;assert.equal(page.data.outfit.name,'B的搭配');assert.equal(h.load('utils/outfit-state.js').current(),0);assert.equal(h.calls.filter(row=>row[0]==='toast').length,0);
});
test('detail pending archive failure while returning reloads actual state without rejecting onShow',async()=> {
  const {h,page,requests}=await showDetail();page.archive();const saved=h.calls.find(row=>row[0]==='modal')[1].success({confirm:true});page.onHide();const shown=page.onShow();await flush();fail(requests[1]);await Promise.all([saved,shown]);assert.equal(requests.length,3);ok(requests[2],detail());await flush();assert.equal(page.data.outfit.isArchived,false);assert.equal(page.data.acting,false);
});
test('outfit detail no-write clothing round trip keeps full data and scroll; image retries stay local',async()=> {
  const {h,page,requests,images}=await showDetail();page.onPageScroll({scrollTop:1450});page.clothing(event({id:3}));assert.equal(h.calls.at(-1)[1].url,'/pages/clothes/detail/index?id=3');page.onHide();await page.onShow();assert.equal(requests.length,1);assert.equal(h.calls.at(-1)[1].scrollTop,1450);
  images[0].success({statusCode:200,tempFilePath:'wxfile://old'});await flush();assert.equal(page.data.outfit.items[0].src,'');
  page.retryImage(event({id:1}));images.at(-1).success({statusCode:200,tempFilePath:'wxfile://retry'});await flush();assert.equal(page.data.outfit.items[0].src,'wxfile://retry');assert.equal(h.calls.filter(row=>row[0]==='navigateTo').length,1);
  h.setPages([{},{}]);page.back();assert.equal(h.calls.at(-1)[0],'navigateBack');h.setPages([{}]);page.back();assert.equal(h.calls.at(-1)[1].url,'/pages/outfits/index');
});
test('outfit hidden detail response and same-ID old media cannot replace newer data',async()=> {
  const {page,requests,images}=setup('pages/outfits/detail/index.js');await page.onShow();page.onHide();ok(requests[0],detail());await flush();assert.equal(page.data.outfit,null);
  await page.onShow();ok(requests[1],detail(1));await flush();page.retryImage(event({id:1}));images[1].success({statusCode:200,tempFilePath:'wxfile://latest'});images[0].fail({errMsg:'downloadFile:fail timeout'});await flush();assert.equal(page.data.outfit.items[0].src,'wxfile://latest');page.imageFailed(event({id:1,src:'wxfile://old'}));assert.equal(page.data.outfit.items[0].src,'wxfile://latest');
});

async function showClothing() {
  const env=setup('pages/clothes/detail/index.js');await env.page.onShow();ok(env.requests[0],{...child(123),wearCount:2,lastWornDate:'2026-10-09',note:''});await flush();
  ok(env.requests.find(row=>row.url.endsWith('/outfits')),pageResult([summary(35,5)],3,1,2));ok(env.requests.find(row=>row.url.endsWith('/diaries')),pageResult([],0,1,2));await flush();return env;
}
test('clothing related outfits navigate to full detail while paging/retry and diary boundaries remain independent',async()=> {
  const {h,page,requests}=await showClothing();page.outfit(event({id:35}));assert.equal(h.calls.at(-1)[1].url,'/pages/outfits/detail/index?id=35');
  page.moreOutfits();const next=requests.at(-1);assert.equal(next.data.page,2);assert.equal(next.data.pageSize,2);fail(next);await flush();assert.equal(page.data.outfits.items.length,1);page.moreOutfits();assert.equal(requests.at(-1).data.page,2);ok(requests.at(-1),pageResult([summary(36,1),summary(37,1)],3,2,2));await flush();assert.equal(page.data.outfits.items.length,3);assert.equal(page.data.diaries.items.length,0);
  h.setPages([{},{}]);page.back();assert.equal(h.calls.at(-1)[0],'navigateBack');h.setPages([{}]);page.back();assert.equal(h.calls.at(-1)[1].url,'/pages/wardrobe/index');
});
test('clothing related-detail return preserves sections and scroll without rereading business data',async()=> {
  const {h,page,requests,images}=await showClothing();page.onPageScroll({scrollTop:1700});page.onHide();assert.equal(page.data.src,'');assert.equal(page.data.outfits.items[0].previewItems[0].src,'');await page.onShow();assert.equal(requests.length,3);assert.equal(h.calls.at(-1)[1].scrollTop,1700);assert.equal(page.data.outfits.total,3);
  images[0].success({statusCode:200,tempFilePath:'wxfile://old-hero'});await flush();assert.equal(page.data.src,'');page.retryPreview(event({kind:'outfits',parent:35,id:1}));images.at(-1).success({statusCode:200,tempFilePath:'wxfile://new-preview'});await flush();assert.equal(page.data.outfits.items[0].previewItems[0].src,'wxfile://new-preview');assert.equal(h.calls.filter(row=>row[0]==='navigateTo').length,0);
});
test('clothing hidden archive success invalidates wardrobe and rereads the same detail',async()=> {
  const {h,page,requests}=await showClothing();page.archive();const saved=h.calls.find(row=>row[0]==='modal')[1].success({confirm:true});page.onHide();ok(requests[3],{...child(123),isArchived:true});await saved;
  assert.equal(h.load('utils/wardrobe-state.js').current(),1);assert.equal(page.data.clothing.isArchived,false);await page.onShow();assert.equal(requests.length,5);assert.equal(requests[4].url.endsWith('/clothes/123'),true);ok(requests[4],{...child(123),isArchived:true});await flush();assert.equal(page.data.clothing.isArchived,true);
});
test('clothing returned before archive settles waits and reloads; account switch never waits on the previous account',async()=> {
  const {h,page,requests}=await showClothing();page.archive();const saved=h.calls.find(row=>row[0]==='modal')[1].success({confirm:true});page.onHide();const shown=page.onShow();await flush();assert.equal(requests.length,4);ok(requests[3],{...child(123),isArchived:true});await Promise.all([saved,shown]);assert.equal(requests.length,5);ok(requests[4],{...child(123),isArchived:true});await flush();
  page.archive();const old=h.calls.filter(row=>row[0]==='modal').at(-1)[1].success({confirm:true});const patch=requests.at(-1);page.onHide();h.session.adopt({token:'y'.repeat(43),user:{id:100}});const switched=page.onShow();assert.equal(page.data.clothing,null);await switched;assert.equal(requests.at(-1).method,'GET');ok(patch,{...child(123),isArchived:false});await old;assert.equal(h.load('utils/wardrobe-state.js').current(),0);assert.equal(page.data.clothing,null);
});
test('clothing new account and unloaded callbacks clear prior sections and pictures',async()=> {
  const {h,page,requests,images}=await showClothing();page.onUnload();images[0].success({statusCode:200,tempFilePath:'wxfile://old'});await flush();assert.equal(page.data.src,'');h.session.adopt({token:'y'.repeat(43),user:{id:100}});await page.onShow();assert.equal(page.data.clothing,null);assert.equal(page.data.outfits.items.length,0);fail(requests.at(-1),404);await flush();assert.equal(page.data.notFound,true);
});
test('outfit revision is session-only and resets across account epochs',()=> {
  const {h}=setup();const state=h.load('utils/outfit-state.js');state.changed();assert.equal(state.current(),1);h.session.clear();assert.equal(state.current(),0);assert.equal(h.storage.size,0);
});
test('native templates register P05, bind real handlers and keep P06/diary entry unopened',()=> {
  const root=path.resolve(serverRoot,'../miniprogram'),app=JSON.parse(fs.readFileSync(path.join(root,'app.json'),'utf8'));
  assert.ok(app.pages.includes('pages/outfits/detail/index'));assert.ok(app.pages.includes('pages/outfits/edit/index'));
  for(const route of ['pages/outfits/index','pages/outfits/detail/index','pages/clothes/detail/index']) {
    for(const extension of ['js','json','wxml','wxss']) assert.ok(fs.existsSync(path.join(root,route+'.'+extension)));
    const template=fs.readFileSync(path.join(root,route+'.wxml'),'utf8'),{h}=setup(route+'.js'),page=h.load(route+'.js');
    for(const match of template.matchAll(/(?:bind(?:tap|input|confirm|error)|catchtap)="(\w+)"/g)) assert.equal(typeof page[match[1]],'function',route+':'+match[1]);
    assert.doesNotMatch(template,/src="\{\{[^}]*imageUrl/);
  }
  const list=fs.readFileSync(path.join(root,'pages/outfits/index.wxml'),'utf8'),p05=fs.readFileSync(path.join(root,'pages/outfits/detail/index.wxml'),'utf8'),p02=fs.readFileSync(path.join(root,'pages/clothes/detail/index.wxml'),'utf8');
  assert.match(list,/<button[^>]*bindtap="create">新增搭配/);assert.match(p05,/<button[^>]*bindtap="edit"[^>]*>编辑搭配/);assert.match(p05,/bindtap="recordWear"/);assert.match(p05,/wx:for="\{\{outfit.items\}\}"/);assert.match(list,/item.clothingCount/);assert.match(list,/catchtap="retryImage"/);assert.match(p05,/catchtap="retryImage"/);assert.match(p02,/catchtap="retryPreview"/);assert.doesNotMatch(p02,/bindtap="(?:diary|moreDiaries)"[^>]*class="related"/);
});


test('wardrobe mutation refreshes visible list/facets and rejects pending old page and media',async()=>{
 const {h,page,list,facets,images}=setup();await page.onShow();ok(list()[0],pageResult([summary(1,1)],2));await flush();page.more();const old=list().at(-1),oldImage=images[0];page.onPageScroll({scrollTop:777});
 h.load('utils/wardrobe-state.js').changed();assert.equal(list().at(-1).data.page,1);assert.equal(page.data.items.length,0);assert.equal(facets().length,2);ok(old,pageResult([summary(2)],2,2));oldImage.success({statusCode:200,tempFilePath:'wxfile://obsolete'});await flush();assert.equal(page.data.page,0);assert.equal(page._scroll,0);
 const updated=summary(1,1);updated.previewItems[0]={...child(1),name:'新名称',imagePath:child(9).imagePath,isArchived:true};ok(list().at(-1),pageResult([updated]));await flush();assert.equal(page.data.items[0].previewItems[0].name,'新名称');assert.equal(page.data.items[0].previewItems[0].src,'');
});
test('hidden outfit detail rechecks clothes after wardrobe write; no write preserves position',async()=>{
 const {h,page,requests}=await showDetail();page.onPageScroll({scrollTop:666});page.onHide();await page.onShow();assert.equal(requests.length,1);assert.equal(page._scroll,666);page.onHide();h.load('utils/wardrobe-state.js').changed();await page.onShow();assert.equal(requests.length,2);assert.equal(page._scroll,0);const changed=detail();changed.items[0].name='已改名';changed.items[0].isArchived=true;ok(requests[1],changed);await flush();assert.equal(page.data.outfit.items[0].name,'已改名');
});
test('visible detail refreshes late wardrobe commit, hidden and old account callbacks cannot restore data',async()=>{
 const {h,page,requests}=await showDetail();h.load('utils/wardrobe-state.js').changed();assert.equal(requests.length,2);page.onHide();ok(requests[1],detail(20));await flush();assert.equal(page.data.outfit,null);await page.onShow();h.session.clear();ok(requests.at(-1),detail());await flush();assert.equal(page.data.outfit,null);page.onUnload();
});
test('C07 refreshes after outfit save/relation change, retaining no old pages or images',async()=>{
 const {h,page,requests}=setup('pages/clothes/detail/index.js');await page.onShow();ok(requests[0],{...child(123),wearCount:7,lastWornDate:'2026-01-01'});await flush();const old=requests.find(r=>r.url.includes('/123/outfits'));ok(old,pageResult([summary()],3,1,2));await flush();page.onPageScroll({scrollTop:333});page.onHide();h.load('utils/outfit-state.js').changed();await page.onShow();assert.equal(page._scroll,0);assert.equal(page.data.outfits.items.length,0);ok(requests.at(-1),{...child(123),wearCount:7,lastWornDate:'2026-01-01'});await flush();assert.equal(requests.filter(r=>r.url.includes('/123/outfits')).length,2);assert.equal(page.data.clothing.wearCount,7);
});
test('visible C07 invalidates pending old relation when hidden save commits after return',async()=>{
 const {h,page,requests}=setup('pages/clothes/detail/index.js');await page.onShow();ok(requests[0],child(123));await flush();const old=requests.find(r=>r.url.includes('/123/outfits'));h.load('utils/outfit-state.js').changed();ok(old,pageResult([summary()],1));await flush();assert.equal(page.data.outfits.items.length,0);assert.equal(page.data.clothing,null);page.onUnload();const n=requests.length;h.load('utils/outfit-state.js').changed();assert.equal(requests.length,n);
});
test('source entry uses real id/name only, creates no request, refuses hidden/account stale entry',async()=>{
 const {h,page,requests}=await showDetail();const before=requests.length;page.recordWear();assert.equal(h.calls.at(-1)[0],'navigateTo');assert.equal(h.calls.at(-1)[1].url,'/pages/diary/edit/index?sourceOutfitId=35');assert.equal(requests.length,before);page.onHide();const n=h.calls.length;page.recordWear();assert.equal(h.calls.length,n);h.session.clear();page.recordWear();assert.equal(h.calls.length,n);
});
test('wardrobe and outfit revisions reset together for a new session',()=>{
 const {h}=setup();const w=h.load('utils/wardrobe-state.js'),o=h.load('utils/outfit-state.js');w.changed();assert.equal(w.current(),1);assert.equal(o.current(),1);h.session.clear();assert.equal(w.current(),0);assert.equal(o.current(),0);
});


test('visible P05 refreshes late P06 save after native back and rejects old detail response',async()=>{
 const {h,page,requests}=await showDetail();page.onHide();await page.onShow();assert.equal(requests.length,1);h.load('utils/outfit-state.js').changed();assert.equal(requests.length,2);h.load('utils/outfit-state.js').changed();assert.equal(requests.length,3);const saved={...detail(3),name:'迟到保存的新名称'};ok(requests[2],saved);ok(requests[1],detail());await flush();assert.equal(page.data.outfit.name,'迟到保存的新名称');assert.equal(page.data.outfit.items.length,3);assert.equal(page._scroll,0);
});
test('P02 own archive and restore settles acting despite synchronous cross-module refresh',async()=>{
 for(const archived of [false,true]){
  const {h,page,requests}=setup('pages/clothes/detail/index.js');await page.onShow();ok(requests[0],{...child(123),isArchived:archived});await flush();page.archive();const completed=h.calls.at(-1)[1].success({confirm:true});const write=requests.at(-1);assert.equal(write.method,'PATCH');ok(write,{...child(123),isArchived:!archived});await completed;assert.equal(page.data.acting,false);assert.equal(page._archivePending,null);ok(requests.at(-1),{...child(123),isArchived:!archived});await flush();assert.equal(page.data.clothing.isArchived,!archived);assert.equal(page.data.acting,false);page.onUnload();
 }
});
test('source entry navigates with actual integer source ID without persistence',async()=>{
 const {h,page,requests}=await showDetail();const n=requests.length;page.recordWear();assert.equal(h.calls.at(-1)[1].url,'/pages/diary/edit/index?sourceOutfitId=35');assert.equal(requests.length,n);assert.equal([...h.storage.keys()].some(key=>key.toLowerCase().includes('source')),false);page.onUnload();
});
