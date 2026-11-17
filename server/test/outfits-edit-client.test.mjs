import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {clientHarness} from './client-harness.mjs';
const flush=()=>new Promise(r=>setImmediate(r));
const event=dataset=>({currentTarget:{dataset}});
const child=id=>({id,name:'衣物'+id,imagePath:'users/99/00000000-0000-0000-0000-'+String(id).padStart(12,'0')+'.jpg',isArchived:id===20});
const value=(items,total=items.length,page=1)=>({items,total,page,pageSize:12});
const ok=(req,data)=>req.success({statusCode:200,data:{data}});
function setup(){
 const requests=[],images=[];const h=clientHarness(o=>requests.push(o),{downloadFile:o=>images.push(o),redirectTo:o=>h.calls.push(['redirectTo',o]),pageScrollTo:o=>h.calls.push(['scroll',o])});
 h.setApp({authReady:Promise.resolve()});h.session.adopt({token:'x'.repeat(43),expiresAt:'2027-01-01T00:00:00.000Z',user:{id:99}});
 const picker=h.load('components/clothes-picker/index.js');picker.properties={epoch:h.session.snapshot().epoch,selected:[]};
 const page=h.load('pages/outfits/edit/index.js');page.selectComponent=()=>picker;
 return {h,page,picker,requests,images,clothes:()=>requests.filter(r=>r.url.endsWith('/clothes'))};
}
async function edit(count=5){const env=setup();env.page.onLoad({id:'35'});await env.page.onShow();ok(env.requests[0],{id:35,name:'原名',occasion:'日常',note:'一\n二',isArchived:true,items:Array.from({length:count},(_,i)=>child(i+1))});await flush();return env;}
async function create(){const env=setup();env.page.onLoad({});await env.page.onShow();await flush();return env;}
function fill(env){env.page.input({currentTarget:{dataset:{field:'name'}},detail:{value:' 新组合 '}});env.page.input({currentTarget:{dataset:{field:'occasion'}},detail:{value:' 通勤 '}});env.page.picked({detail:{epoch:env.h.session.snapshot().epoch,items:[child(1),child(2)]}});}
test('picker copies parent draft including archived items; cancellation and reopening isolate objects',()=>{
 const {picker,h}=setup();const parent=[child(20),child(1)];picker.properties.selected=parent;picker.open();picker.move(event({index:0,step:1}));picker.remove(event({id:1}));picker.data.chosen[0].name='草稿';picker.cancel();assert.equal(parent[0].name,'衣物20');assert.equal(parent.length,2);assert.equal(h.calls.filter(c=>c[0]==='event')[0][1].name,'cancel');picker.open();assert.deepEqual([...picker.data.selectedIds],[20,1]);assert.equal(picker.data.chosen[0].isArchived,true);
});
test('picker keeps first-selection order across 12+1 pages, filters and confirmed search; deduplicates toggles',async()=>{
 const {picker,clothes}=setup();picker.open();ok(clothes()[0],value(Array.from({length:12},(_,i)=>child(i+1)),13));await flush();picker.toggle(event({id:2}));picker.toggle(event({id:1}));picker.more();ok(clothes()[1],value([child(13)],13,2));await flush();picker.toggle(event({id:13}));picker.filter(event({field:'archived',value:'all'}));ok(clothes()[2],value([child(20)]));await flush();picker.toggle(event({id:20}));picker.input({detail:{value:' 名称 '}});assert.equal(clothes().length,3);picker.search();assert.equal(clothes()[3].data.keyword,'名称');ok(clothes()[3],value([child(2)]));await flush();assert.deepEqual([...picker.data.selectedIds],[2,1,13,20]);assert.equal(picker.data.items[0].selected,true);picker.toggle(event({id:2}));picker.toggle(event({id:2}));assert.deepEqual([...picker.data.selectedIds],[1,13,20,2]);
});
test('picker 20 limit still permits deselection; boundaries do not wrap; zero confirmation emits once',async()=>{
 const {picker,h,clothes}=setup();picker.properties.selected=Array.from({length:20},(_,i)=>child(i+1));picker.open();ok(clothes()[0],value([child(21),child(1)]));await flush();picker.toggle(event({id:21}));assert.equal(picker.data.chosen.length,20);assert.match(picker.data.error,/20/);picker.move(event({index:0,step:-1}));picker.move(event({index:19,step:1}));assert.equal(picker.data.chosen[0].id,1);picker.toggle(event({id:1}));picker.toggle(event({id:21}));assert.equal(picker.data.chosen.at(-1).id,21);for(const item of [...picker.data.chosen])picker.remove(event({id:item.id}));picker.confirm();picker.cancel();const emitted=h.calls.filter(c=>c[0]==='event');assert.equal(emitted.length,1);assert.equal(emitted[0][1].name,'confirm');assert.equal(emitted[0][1].detail.items.length,0);
});
test('picker append failure retries original page; obsolete search responses are ignored',async()=>{
 const {picker,clothes}=setup();picker.open();ok(clothes()[0],value([child(1)],2));await flush();picker.toggle(event({id:1}));picker.more();clothes()[1].fail({errMsg:'timeout'});await flush();assert.equal(picker.data.page,1);assert.equal(picker.data.items.length,1);picker.retry();assert.equal(clothes()[2].data.page,2);picker.filter(event({field:'season',value:'冬'}));ok(clothes()[3],value([]));ok(clothes()[2],value([child(2)],2,2));await flush();assert.equal(picker.data.items.length,0);assert.deepEqual([...picker.data.selectedIds],[1]);
});
test('picker close, detach, hide and account switch reject late requests and images',async()=>{
 for(const action of ['cancel','detached','hide','account']){const {picker,h,clothes,images}=setup();picker.properties.selected=[child(20)];picker.open();if(action==='account')h.session.clear();else if(action==='hide')picker.pageLifetimes.hide.call(picker);else picker[action]();ok(clothes()[0],value([child(1)]));images[0].success({statusCode:200,tempFilePath:'wxfile://old'});await flush();assert.equal(picker.data.items.length,0);assert.ok(!picker.data.chosen.some(i=>i.src));}
});
test('picker image retry and stale render errors cannot deselect or overwrite a newer image',async()=>{
 const {picker,clothes,images}=setup();picker.open();ok(clothes()[0],value([child(1)]));await flush();images[0].fail({errMsg:'timeout'});await flush();picker.retryImage(event({id:1}));images[1].success({statusCode:200,tempFilePath:'wxfile://new'});await flush();picker.imageFailed(event({id:1,src:'old'}));assert.equal(picker.data.items[0].src,'wxfile://new');assert.equal(picker.data.chosen.length,0);
});
test('edit initializes all 20 O03 items including archived and multiline note, never a preview',async()=>{const {page}=await edit(20);assert.equal(page.data.items.length,20);assert.equal(page.data.items.at(-1).isArchived,true);assert.equal(page.data.form.note,'一\n二');assert.equal(page.data.dirty,false);});
test('new zero-selection cannot save; Unicode, single-line and note limits scroll to first field',async()=>{
 const env=await create();await env.page.save();assert.equal(env.requests.length,0);assert.equal(env.h.calls.at(-1)[1].selector,'#field-name');fill(env);env.page.input({currentTarget:{dataset:{field:'name'}},detail:{value:'😀'.repeat(41)}});await env.page.save();assert.ok(env.page.data.errors.name);env.page.input({currentTarget:{dataset:{field:'name'}},detail:{value:'😀'.repeat(40)}});env.page.input({currentTarget:{dataset:{field:'occasion'}},detail:{value:'场景\n换行'}});await env.page.save();assert.ok(env.page.data.errors.occasion);env.page.input({currentTarget:{dataset:{field:'occasion'}},detail:{value:'场'.repeat(20)}});env.page.input({currentTarget:{dataset:{field:'note'}},detail:{value:'字'.repeat(501)}});await env.page.save();assert.ok(env.page.data.errors.note);env.page.input({currentTarget:{dataset:{field:'note'}},detail:{value:'字'.repeat(500)}});env.page.picked({detail:{epoch:env.h.session.snapshot().epoch,items:[]}});await env.page.save();assert.ok(env.page.data.errors.clothingIds);
});
test('new POST normalizes fields, keeps note, blocks duplicate saves and mutations, redirects with real id',async()=>{
 const env=await create();fill(env);env.page.input({currentTarget:{dataset:{field:'note'}},detail:{value:'一\n二'}});const saved=env.page.save();env.page.save();env.page.remove(event({id:1}));env.page.input({currentTarget:{dataset:{field:'name'}},detail:{value:'改动'}});assert.equal(env.requests.length,1);assert.deepEqual(JSON.parse(JSON.stringify(env.requests[0].data)),{name:'新组合',occasion:'通勤',note:'一\n二',clothingIds:[1,2]});ok(env.requests[0],{id:88});await saved;assert.equal(env.page.data.dirty,false);assert.equal(env.h.calls.at(-1)[0],'redirectTo');assert.match(env.h.calls.at(-1)[1].url,/id=88$/);assert.equal(env.h.load('utils/outfit-state.js').current(),1);
});
test('edit remove/reorder saves complete PUT and returns to same detail; direct entry redirects',async()=>{
 for(const direct of [false,true]){const env=await edit();if(!direct)env.h.setPages([{route:'pages/outfits/detail/index',options:{id:'35'}},{}]);env.page.remove(event({id:2}));env.page.move(event({index:3,step:-1}));const saved=env.page.save();const req=env.requests.at(-1);assert.equal(req.method,'PUT');assert.deepEqual([...req.data.clothingIds],[1,3,5,4]);ok(req,{id:35});await saved;assert.equal(env.h.calls.at(-1)[0],direct?'redirectTo':'navigateBack');}
});
test('failed save preserves full draft, order, fields and permits manual retry',async()=>{
 const env=await edit();env.page.move(event({index:0,step:1}));const initial=JSON.stringify(env.page.data.items.map(i=>i.id));const saved=env.page.save();env.requests.at(-1).success({statusCode:400,data:{error:{code:'INVALID_INPUT',message:'字段错误',details:{fields:{name:'名称错误'}}}}});await saved;assert.equal(env.page.data.busy,false);assert.equal(JSON.stringify(env.page.data.items.map(i=>i.id)),initial);assert.equal(env.page.data.form.note,'一\n二');assert.ok(env.page.data.errors.name);env.page.save();assert.equal(env.requests.at(-1).method,'PUT');
});
test('page cancel confirms normalized business changes only, modal callback rejected after leave',async()=>{
 const env=await edit();env.page.input({currentTarget:{dataset:{field:'name'}},detail:{value:' 原名 '}});assert.equal(env.page.data.dirty,false);env.page.move(event({index:0,step:1}));env.page.cancel();const modal=env.h.calls.at(-1)[1];modal.success({confirm:false});assert.equal(env.h.calls.at(-1)[0],'modal');env.page.cancel();env.h.calls.at(-1)[1].success({confirm:true});assert.equal(env.h.calls.at(-1)[0],'switchTab');env.page.cancel();const stale=env.h.calls.at(-1)[1];env.page.onHide();const n=env.h.calls.length;stale.success({confirm:true});assert.equal(env.h.calls.length,n);
});
test('hidden save settles without navigation; return waits then handles success or failure',async()=>{
 for(const success of [false,true]){const env=await create();fill(env);const saved=env.page.save();env.page.onHide();const showing=env.page.onShow();await flush();if(success)ok(env.requests[0],{id:89});else env.requests[0].fail({errMsg:'timeout'});await saved;await showing;assert.equal(env.page.data.busy,false);if(success)assert.equal(env.h.calls.at(-1)[0],'redirectTo');else {assert.equal(env.page.data.items.length,2);assert.match(env.page.data.error,/超时/);}}
});
test('old account save cannot invalidate new session, navigate or restore old draft',async()=>{
 const env=await create();fill(env);const saved=env.page.save();env.page.onHide();env.h.session.clear();env.h.session.adopt({token:'y'.repeat(43),expiresAt:'2027-01-01T00:00:00.000Z',user:{id:100}});await env.page.onShow();ok(env.requests[0],{id:99});await saved;assert.equal(env.page.data.form.name,'');assert.equal(env.page.data.items.length,0);assert.equal(env.h.load('utils/outfit-state.js').current(),0);assert.ok(!env.h.calls.some(c=>c[0]==='redirectTo'));
});
test('edit late detail/image and picker confirmation cannot populate hidden or new account page',async()=>{
 const env=await edit();env.page.onHide();env.page.picked({detail:{epoch:env.h.session.snapshot().epoch,items:[child(55)]}});assert.equal(env.page.data.items.length,5);for(const image of env.images)image.success({statusCode:200,tempFilePath:'wxfile://late'});await flush();assert.ok(env.page.data.items.every(i=>!i.src));env.h.session.clear();await env.page.onShow();assert.equal(env.page.data.items.length,0);
});
test('P06 and component registration and event handlers are present; controls encode boundary disabling',()=>{
 const base=new URL('../../miniprogram/',import.meta.url);for(const relative of ['pages/outfits/edit/index','components/clothes-picker/index']){const source=fs.readFileSync(new URL(relative+'.js',base),'utf8');const wxml=fs.readFileSync(new URL(relative+'.wxml',base),'utf8');for(const match of wxml.matchAll(/(?:bind|catch)(?::)?(?:tap|input|confirm|error|scrolltolower|touchmove)="([A-Za-z]+)"/g))assert.match(source,new RegExp('\\b'+match[1]+'\\('));assert.match(wxml,/index === 0/);assert.match(wxml,/mode="aspectFit"/);}assert.equal(JSON.parse(fs.readFileSync(new URL('pages/outfits/edit/index.json',base))).usingComponents['clothes-picker'],'/components/clothes-picker/index');
});

test('picker filter parameters and independent option responses are isolated by open generation and scope',async()=>{
 const {picker,requests,clothes}=setup();picker.open();const firstOptions=requests.filter(r=>r.url.endsWith('/clothes/facets'))[0];picker.filter(event({field:'archived',value:'archived'}));picker.filter(event({field:'categoryId',value:7}));picker.filter(event({field:'color',value:'红'}));picker.filter(event({field:'season',value:'冬'}));assert.deepEqual(JSON.parse(JSON.stringify(clothes().at(-1).data)),{page:1,pageSize:12,archived:'archived',categoryId:7,color:'红',season:'冬'});
 ok(firstOptions,{colors:['旧色']});ok(requests.filter(r=>r.url.endsWith('/categories'))[0],{items:[{id:1,name:'旧分类'}]});await flush();assert.equal(picker.data.colors.length,0);
 const lastOptions=requests.filter(r=>r.url.endsWith('/clothes/facets')).at(-1);const lastCategories=requests.filter(r=>r.url.endsWith('/categories')).at(-1);ok(lastOptions,{colors:['新色']});ok(lastCategories,{items:[{id:7,name:'外套'}]});await flush();assert.deepEqual([...picker.data.colors],['新色']);picker.cancel();picker.open();assert.equal(picker.data.archived,'active');assert.equal(picker.data.color,'');
});
test('picker repeated filtering does not strand earlier completed image downloads',async()=>{
 const {picker,clothes,images}=setup();picker.open();ok(clothes()[0],value([child(1)]));await flush();images[0].success({statusCode:200,tempFilePath:'wxfile://first'});await flush();picker.filter(event({field:'season',value:'冬'}));ok(clothes()[1],value([child(1)]));await flush();assert.equal(images.length,2);images[1].success({statusCode:200,tempFilePath:'wxfile://second'});await flush();assert.equal(picker.data.items[0].src,'wxfile://second');
});
test('page receives latest parent selection after cancel, opens picker without becoming dirty',async()=>{
 const env=await edit();env.picker.properties={epoch:env.page.data.epoch,selected:env.page.data.items};env.page.choose();env.picker.remove(event({id:1}));env.picker.cancel();assert.equal(env.page.data.items.length,5);assert.equal(env.page.data.dirty,false);env.page.remove(event({id:2}));env.picker.properties.selected=env.page.data.items;env.page.choose();assert.deepEqual([...env.picker.data.selectedIds],[1,3,4,5]);
});
test('hidden failed save restores server field errors and scroll target on return',async()=>{
 const env=await create();fill(env);const saving=env.page.save();env.page.onHide();env.requests[0].success({statusCode:400,data:{error:{code:'INVALID_SELECTION',message:'组合错误',details:{fields:{clothingIds:'重新选择'}}}}});await saving;await env.page.onShow();assert.equal(env.page.data.errors.clothingIds,'重新选择');assert.ok(env.h.calls.some(c=>c[0]==='scroll'&&c[1].selector==='#field-clothingIds'));assert.equal(env.page.data.items.length,2);
});
