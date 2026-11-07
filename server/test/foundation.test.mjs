import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readConfig, serverRoot, safeError } from '../src/config.js';
import { createApp, internalError } from '../src/app.js';

const fixture = {PUBLIC_BASE_URL:'http://127.0.0.1:3000',DB_HOST:'127.0.0.1',DB_PORT:'3306',DB_NAME:'wardrobe_demo',DB_USER:'fixture',DB_PASSWORD:'fixture-only',UPLOAD_ROOT:'./uploads'};
test('config defaults and paths are independent of caller cwd',()=>{const c=readConfig(fixture);assert.equal(c.port,3000);assert.equal(c.uploadRoot,path.join(serverRoot,'uploads'));assert.equal(c.publicBaseUrl,'http://127.0.0.1:3000');});
for(const key of Object.keys(fixture)) test('missing config '+key,()=>{const env={...fixture};delete env[key];assert.throws(()=>readConfig(env),e=>e.code==='INVALID_CONFIG'&&e.field===key);});
for(const [key,value] of [['PORT','0'],['PORT','65536'],['PORT',''],['DB_PORT','oops'],['DB_HOST','localhost'],['DB_NAME','other_database'],['PUBLIC_BASE_URL','invalid'],['PUBLIC_BASE_URL','http://127.0.0.1:3000/api'],['PUBLIC_BASE_URL','http://127.0.0.1:3001'],['PUBLIC_BASE_URL','http://user:secret@127.0.0.1:3000'],['UPLOAD_ROOT','../assets']]) test('reject invalid '+key+' variant '+value.replace('user:secret@','redacted@'),()=>assert.throws(()=>readConfig({...fixture,[key]:value}),e=>e.code==='INVALID_CONFIG'&&e.field===key));
test('private values are untrimmed and never included in safe errors',()=>{assert.equal(readConfig({...fixture,DB_PASSWORD:'  marker  '}).db.password,'  marker  ');assert.deepEqual(safeError(Object.assign(new Error('private error'),{code:'EXAMPLE',sql:'private SQL'})),{code:'EXAMPLE'});});
test('Node native env file keeps process environment precedence from another cwd',()=>{const out=execFileSync(process.execPath,['--env-file='+path.join(serverRoot,'.env'),'-e','console.log(process.env.PORT)'],{cwd:os.tmpdir(),env:{...process.env,PORT:'31415'},encoding:'utf8'});assert.equal(out.trim(),'31415');});

async function listen(app) {const server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server;}
const close = server => new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
function child(env, cwd = serverRoot) {
  return new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,[path.join(serverRoot,'src/index.js')],{cwd,env,windowsHide:true});let stdout='',stderr='';
    p.stdout.on('data',b=>{stdout+=b;});p.stderr.on('data',b=>{stderr+=b;});p.once('error',reject);p.once('exit',code=>resolve({code,stdout,stderr}));
  });
}
test('health is anonymous and independent from DB; unsupported paths return JSON 404',async()=>{
  const server=await listen(createApp());try {const url='http://127.0.0.1:'+server.address().port;const ok=await fetch(url+'/api/health');assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{data:{status:'ok'}});for(const route of ['/api/clothes','/api/api/health','/uploads/users/11/file.jpg']){const res=await fetch(url+route);assert.equal(res.status,404);assert.equal((await res.json()).error.code,'NOT_FOUND');}}
  finally {await close(server);}
});
test('unknown request error boundary never serializes SQL, secrets or stack',()=>{let code,body;internalError(new Error('SQL secret'),{}, {status(n){code=n;return this;},json(value){body=value;}},()=>{});assert.equal(code,500);assert.deepEqual(body,{error:{code:'INTERNAL_ERROR',message:'服务暂时无法完成请求'}});});
test('missing configuration exits before binding even from another cwd',async()=>{const env={...process.env};delete env.DB_PASSWORD;const r=await child(env,os.tmpdir());assert.equal(r.code,1);assert.equal(JSON.parse(r.stderr.trim()).error.field,'DB_PASSWORD');assert.equal(r.stdout,'');});
test('real refused DB connection exits and does not leave a listener',async()=>{const reserve=await listen((req,res)=>res.end());const port=reserve.address().port;await close(reserve);const r=await child({...process.env,DB_PORT:String(port)});assert.equal(r.code,1);assert.equal(JSON.parse(r.stderr.trim()).error.code,'ECONNREFUSED');assert.ok(!r.stdout.includes('http-listening'));});
test('occupied HTTP port exits, releases pool, and preserves the occupying fixture',async()=>{const holder=await listen((req,res)=>res.end('holder'));try{const port=holder.address().port;const r=await child({...process.env,PORT:String(port),PUBLIC_BASE_URL:'http://127.0.0.1:'+port});assert.equal(r.code,1);assert.equal(JSON.parse(r.stderr.trim()).error.code,'EADDRINUSE');assert.ok(r.stdout.includes('database-connected'));assert.equal(await(await fetch('http://127.0.0.1:'+port)).text(),'holder');}finally{await close(holder);}});


// Health checks now pass through the common request boundary.
const { clientHarness } = await import('./client-harness.mjs');
function page(request) { const h=clientHarness(request); return h.load('pages/me/index.js'); }
test('page request has one api prefix and disabled checking state',async()=>{let request;const p=page(o=>{request=o;});const done=p.checkConnection();assert.equal(p.data.state,'checking');assert.equal(request.url,'http://127.0.0.1:3000/api/health');assert.equal(request.timeout,5000);assert.equal(request.method,'GET');assert.equal(request.header.Authorization,undefined);request.success({statusCode:200,data:{data:{status:'ok'}}});await done;assert.equal(p.data.state,'success');});
for(const [name,response] of [['HTTP500',{statusCode:500,data:{data:{status:'ok'}}}],['HTML',{statusCode:200,data:'<html>wrong</html>'}],['wrong health',{statusCode:200,data:{data:{status:'wrong'}}}]]) test('page rejects '+name,async()=>{const p=page(o=>o.success(response));await p.checkConnection();assert.equal(p.data.state,'failed');});
for(const errMsg of ['request:fail timeout','request:fail connection refused'])test('page failure restores action '+errMsg,async()=>{const p=page(o=>o.fail({errMsg}));await p.checkConnection();assert.equal(p.data.state,'failed');});
test('page judges real HTTP responses rather than callback success alone',async()=>{let mode='ok';const server=await listen((req,res)=>{res.setHeader('content-type','application/json');res.statusCode=mode==='error'?500:200;res.end(JSON.stringify(mode==='ok'?{data:{status:'ok'}}:{unexpected:true}));});try{for(const next of ['ok','error','malformed']){mode=next;const p=page(o=>{fetch('http://127.0.0.1:'+server.address().port+'/api/health').then(async res=>o.success({statusCode:res.status,data:await res.json()}));});await p.checkConnection();assert.equal(p.data.state,next==='ok'?'success':'failed');}}finally{await close(server);}});
