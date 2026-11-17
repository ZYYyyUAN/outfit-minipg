import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { serverRoot } from '../src/config.js';
export function clientHarness(request, extraWx = {}) {
  const cache = new Map(), storage = new Map(), calls = [];
  let app, currentPages = [];
  const wx = { request, uploadFile: o => o.fail({ errMsg: 'fixture unavailable' }), downloadFile: o => o.fail({ errMsg: 'fixture unavailable' }), chooseMedia: o => o.fail({ errMsg: 'chooseMedia:fail cancel' }), getStorageSync: k => storage.get(k), setStorageSync: (k,v) => storage.set(k,v), removeStorageSync: k => storage.delete(k),
    reLaunch: o => calls.push(['reLaunch',o]), switchTab: o => calls.push(['switchTab',o]), navigateTo: o => calls.push(['navigateTo',o]), navigateBack: o => calls.push(['navigateBack',o]),
    showModal: o => calls.push(['modal',o]), enableAlertBeforeUnload: o => calls.push(['enableAlert',o]), disableAlertBeforeUnload: () => calls.push(['disableAlert']), ...extraWx };
  function load(relative) {
    const filename = path.resolve(serverRoot, '../miniprogram', relative);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename,module);
    vm.runInNewContext(fs.readFileSync(filename,'utf8'), { module, exports: module.exports, require: p => load(path.relative(path.resolve(serverRoot,'../miniprogram'),path.resolve(path.dirname(filename),p))), wx,
      getApp: () => app, getCurrentPages: () => currentPages,
      Component: value => { module.exports={...value.methods,data:structuredClone(value.data),properties:{},setData(values){Object.assign(this.data,values);},triggerEvent(name,detail){calls.push(['event',{name,detail}]);},...value.lifetimes,pageLifetimes:value.pageLifetimes}; },
      App: value => { app = value; }, Page: value => { module.exports = { ...value, data: structuredClone(value.data || {}), setData(values){
        for(const [key,value] of Object.entries(values)) {
          const parts=key.replace(/\[(\d+)\]/g,'.$1').split('.');
          let target=this.data;
          for(const part of parts.slice(0,-1)) target=target[part];
          target[parts.at(-1)]=value;
        }
      } }; } }, { filename });
    return module.exports;
  }
  const session = load('utils/session.js'), {request: send} = load('utils/request.js');
  return { wx, load, session, send, storage, calls, setApp: value => { app=value; }, getApp: () => app, setPages: pages => { currentPages=pages; } };
}
