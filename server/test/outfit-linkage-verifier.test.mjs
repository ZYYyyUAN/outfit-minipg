import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=new URL('../scripts/verify-outfit-linkage.mjs',import.meta.url);
test('linkage verifier default help never requires private configuration or starts a database',()=>{
 const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('DB_')||['PUBLIC_BASE_URL','UPLOAD_ROOT'].includes(key))delete env[key];
 const result=spawnSync(process.execPath,[fileURLToPath(script)],{env,encoding:'utf8',windowsHide:true});assert.equal(result.status,0);assert.match(result.stdout,/不写业务数据/);assert.equal(result.stderr,'');
});
// 执行同一编排函数，用桩I/O注入退出/保护失败，不注册、不写数据库、不启动真实服务。
for(const point of ['logout','proof'])test('linkage verifier always closes owned runtime and pool after '+point+' failure',async()=>{
 const calls=[];const user={id:37,updated_at:'2026-11-17 00:00:00.000',auth_token_hash:null,auth_expires_at:null};
 const database={async getConnection(){return {async execute(query){return [query.includes('FROM users')?[user]:[]];},release(){}};},async end(){calls.push('database.end');}};
 const source=fs.readFileSync(script,'utf8').replace(/^import .*;\r?\n/gm,'').replace('export async function verifyLinkage','async function verifyLinkage').split('if(import.meta.main)')[0]+'\nverifyLinkage;';
 const verify=vm.runInNewContext(source,{assert,path,createHash,process,serverRoot:'Z:/test/server',readConfig:()=>({uploadRoot:'uploads'}),createDatabase:()=>database,loadManifests:async()=>[{sequence:1}],reserveRun:async()=>'/evidence',captureSnapshot:async()=>({}),compareCumulative:()=>({}),sessionTransitionProof:()=>{throw Error('PROOF_FAILURE');},execFileSync:()=> 'base',
 fs:{async readFile(file){return file.includes('.p5-private')?JSON.stringify({accounts:[{id:37,username:'a',password:'private'}]}):'{}';},async writeFile(){}},
 start:async()=>({server:{address:()=>({port:12345})},async close(){calls.push('runtime.close');}}),
 fetch:async(url)=>{if(url.endsWith('/auth/login'))return {status:200,json:async()=>({data:{token:'session'}})};if(url.endsWith('/auth/logout')){if(point==='logout')throw Error('LOGOUT_FAILURE');return {status:200,json:async()=>({data:{}})};}throw Error('BUSINESS_FAILURE');}});
 await assert.rejects(verify('test-cleanup'),new RegExp(point==='logout'?'LOGOUT_FAILURE':'PROOF_FAILURE'));assert.deepEqual(calls,['runtime.close','database.end']);
});


test('linkage verifier closes fresh pool when independent connection acquisition fails',async()=>{
 const calls=[],user={id:37,updated_at:'2026-11-17 00:00:00.000',auth_token_hash:null,auth_expires_at:null};let pools=0;
 const database={async getConnection(){return {async execute(query){return [query.includes('FROM users')?[user]:[]];},release(){}};},async end(){calls.push('database.end');}};
 const source=fs.readFileSync(script,'utf8').replace(/^import .*;\r?\n/gm,'').replace('export async function verifyLinkage','async function verifyLinkage').split('if(import.meta.main)')[0]+'\nverifyLinkage;';
 const verify=vm.runInNewContext(source,{assert:{...assert,deepEqual:(a,b)=>assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)))},path,createHash,process,serverRoot:'Z:/test/server',readConfig:()=>({uploadRoot:'uploads'}),createDatabase:()=>++pools===1?database:{async getConnection(){throw Error('FRESH_CONNECTION_FAILURE');},async end(){calls.push('fresh.end');}},loadManifests:async()=>[{sequence:1}],reserveRun:async()=>'/evidence',captureSnapshot:async()=>({}),compareCumulative:()=>({}),sessionTransitionProof:()=>({beforeSha256:createHash('sha256').update(JSON.stringify(user)).digest('hex')}),execFileSync:()=> 'base',
 fs:{async readFile(file){return file.includes('.p5-private')?JSON.stringify({accounts:[{id:37,username:'a',password:'private'}]}):'{}';},async writeFile(){}},
 start:async()=>({server:{address:()=>({port:12345})},async close(){calls.push('runtime.close');}}),
 fetch:async(url)=>({status:200,json:async()=>({data:url.endsWith('/auth/login')?{token:'session'}:url.endsWith('/outfits/49')?{id:49,items:[142,125,123].map(id=>({id}))}:url.includes('/clothes/123/outfits')?{items:[{id:49}]}:{}})})});
 await assert.rejects(verify('test-fresh-failure'),/FRESH_CONNECTION_FAILURE/);assert.deepEqual(calls,['fresh.end','runtime.close','database.end']);
});
