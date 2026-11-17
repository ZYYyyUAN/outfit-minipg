import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=new URL('../scripts/verify-outfit-edit.mjs',import.meta.url);
test('edit verifier default help never requires private configuration or starts a database',()=>{
 const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('DB_')||['PUBLIC_BASE_URL','UPLOAD_ROOT'].includes(key))delete env[key];
 const result=spawnSync(process.execPath,[fileURLToPath(script)],{env,encoding:'utf8',windowsHide:true});assert.equal(result.status,0);assert.match(result.stdout,/显式写1套/);assert.equal(result.stderr,'');
});
// 执行同一编排函数，用桩I/O注入退出/保护失败，不注册、不写数据库、不启动真实服务。
for(const point of ['logout','proof'])test('edit verifier always closes owned runtime and pool after '+point+' failure',async()=>{
 const calls=[];const user={id:37,updated_at:'2026-11-17 00:00:00.000',auth_token_hash:null,auth_expires_at:null};
 const database={async getConnection(){return {async execute(query){return [query.includes('FROM users')?[user]:[]];},release(){}};},async end(){calls.push('database.end');}};
 const source=fs.readFileSync(script,'utf8').replace(/^import .*;\r?\n/gm,'').replace('export async function verifyEdit','async function verifyEdit').split('if(import.meta.main)')[0]+'\nverifyEdit;';
 const verify=vm.runInNewContext(source,{assert,path,createHash,process,serverRoot:'Z:/test/server',readConfig:()=>({uploadRoot:'uploads'}),createDatabase:()=>database,loadManifests:async()=>[{sequence:1}],reserveRun:async()=>'/evidence',captureSnapshot:async()=>({}),compareCumulative:()=>({}),sessionTransitionProof:()=>{throw Error('PROOF_FAILURE');},execFileSync:()=> 'base',
 fs:{async readFile(file){return file.includes('.p5-private')?JSON.stringify({accounts:[{id:37,username:'a',password:'private'}]}):'{}';},async writeFile(){}},
 start:async()=>({server:{address:()=>({port:12345})},async close(){calls.push('runtime.close');}}),
 fetch:async(url)=>{if(url.endsWith('/auth/login'))return {status:200,json:async()=>({data:{token:'session'}})};if(url.endsWith('/auth/logout')){if(point==='logout')throw Error('LOGOUT_FAILURE');return {status:200,json:async()=>({data:{}})};}throw Error('BUSINESS_FAILURE');}});
 await assert.rejects(verify('test-cleanup'),new RegExp(point==='logout'?'LOGOUT_FAILURE':'PROOF_FAILURE'));assert.deepEqual(calls,['runtime.close','database.end']);
});
