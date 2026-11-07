import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readConfig, serverRoot } from '../src/config.js';
import { createDatabase, probe } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createAccountService, tokenHash } from '../src/services/account.js';
import { validateImageReference } from '../src/utils/image-reference.js';
import { verifyPassword } from '../../shared/password.mjs';
import { snapshot } from './verify-foundation.mjs';

const root=path.dirname(serverRoot), evidence=path.join(root,'docs/evidence/P3-02');
const hash=x=>createHash('sha256').update(x).digest('hex');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const write=(p,v)=>fs.writeFile(p,JSON.stringify(v,null,2)+'\n');
const tables=['users','categories','clothes','outfits','outfit_items','diaries','diary_items'];
export async function implementationHashes() {
  const hashes={};
  async function walk(folder) {for(const e of await fs.readdir(path.join(root,folder),{withFileTypes:true})) {
    if(['node_modules','uploads','.env','project.config.json','project.private.config.json'].includes(e.name))continue;
    const p=folder+'/'+e.name;if(e.isDirectory())await walk(p);else hashes[p]=hash(await fs.readFile(path.join(root,p)));
  }}
  await walk('server');await walk('miniprogram');return hashes;
}
export async function audit(database) {
  const baseline=await read(path.join(evidence,'baseline.json')),c=await database.getConnection();
  try {
    const identity=await probe(c),current=await snapshot(c);
    for(const k of ['version','hostname','port','account','db'])assert.equal(identity[k],baseline.identity[k],'INSTANCE_MISMATCH');
    for(const table of tables.slice(1))for(const key of ['counts','rowHashes','structure'])assert.equal(current[key][table],baseline[key][table],key+':'+table);
    const [ddl]=await c.query('SHOW CREATE TABLE users');assert.equal(hash(ddl[0]['Create Table'].replace(/ AUTO_INCREMENT=\d+/g,'')),baseline.usersStructure,'USERS_STRUCTURE');
    for(const [p,expected]of Object.entries(baseline.hashes))assert.equal(hash(await fs.readFile(path.join(root,p))),expected,'PROTECTED_FILE:'+p);
    const images=[];
    async function collect(folder){for(const e of await fs.readdir(path.join(root,folder),{withFileTypes:true})){const p=folder+'/'+e.name;if(e.isDirectory())await collect(p);else images.push(p);}}
    await collect('server/uploads');assert.deepEqual(images.sort(),Object.keys(baseline.hashes).filter(p=>p.startsWith('server/uploads/')).sort(),'UPLOAD_FILE_SET');
    const manifests=[];
    for(const e of await fs.readdir(evidence,{withFileTypes:true}))if(e.isDirectory()){
      const p=path.join(evidence,e.name,'accounts.json');
      try{manifests.push(...(await read(p)).accounts);}catch(error){if(error.code!=='ENOENT')throw error;}
    }
    const [users]=await c.query('SELECT * FROM users ORDER BY id');
    const added=[];
    for(const u of users){const original=baseline.userFingerprints.find(x=>x.id===u.id);
      if(original){for(const [k,v]of Object.entries(u))assert.equal(hash(JSON.stringify(v)),original.columns[k],'EXISTING_USER_COLUMN:'+k);}
      else{const entry=manifests.find(x=>x.username===u.username);assert.ok(entry,'UNREGISTERED_NEW_ACCOUNT');if(entry.id!==null)assert.equal(entry.id,u.id,'ACCOUNT_ID');assert.equal(u.auth_token_hash,null,'TEST_ACCOUNT_STILL_LOGGED_IN');assert.equal(u.auth_expires_at,null,'TEST_ACCOUNT_STILL_LOGGED_IN');added.push({id:u.id,username:u.username,runId:entry.runId,purpose:entry.purpose});}
    }
    assert.equal(users.length,baseline.counts.users+added.length);
    return{identity,counts:current.counts,registeredNewAccounts:added,protectedFiles:Object.keys(baseline.hashes).length,uploads:50,usersStructureUnchanged:true,existingUsersAllColumnsUnchanged:true};
  }finally{c.release();}
}

async function main(){
  const args=process.argv.slice(2);
  if(!args.length){console.log('Usage: verify-auth.mjs --run-id <unique-run-id> | --audit');return;}
  const config=readConfig(),database=createDatabase(config);
  if(args.length===1&&args[0]==='--audit'){try{const result=await audit(database);await write(path.join(evidence,'protection-latest.json'),{at:new Date().toISOString(),...result,implementation:await implementationHashes()});console.log(JSON.stringify({state:'audit-passed',counts:result.counts,protectedFiles:result.protectedFiles}));}finally{await database.end();}return;}
  assert.ok(args.length===2&&args[0]==='--run-id'&&/^[A-Za-z0-9_-]+$/.test(args[1]),'INVALID_RUN_ID');
  const runId=args[1],dir=path.join(evidence,runId);await fs.mkdir(dir);
  const suffix=randomBytes(4).toString('hex').replace(/[0-9]/g,n=>'abcdefghij'[Number(n)]);
  const accounts=['a','b','u'].map(part=>({runId,username:`p302_${suffix}_${part}`,id:null,purpose:part==='u'?'manual':'HTTP',state:'reserved'}));
  const passwords=[ ' '+randomBytes(12).toString('base64url')+' ',randomBytes(16).toString('base64url')];
  await write(path.join(dir,'accounts.json'),{runId,accounts});
  const report={runId,startedAt:new Date().toISOString(),state:'running',cases:[],implementation:await implementationHashes()};
  let server,origin,connection;const active=new Map();
  async function listen(){server=createServer(createApp(createAccountService(database,config)));await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});origin='http://127.0.0.1:'+server.address().port;}
  const close=()=>new Promise((r,j)=>server.close(e=>e?j(e):r()));
  async function call(label,{url='/api/me',method='GET',body,raw,token,headers={},status=200,code}={}){
    const r=await fetch(origin+url,{method,headers:{...(body!==undefined||raw!==undefined?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...headers},...(body!==undefined||raw!==undefined?{body:raw??JSON.stringify(body)}:{})});
    const data=await r.json();assert.equal(r.status,status,label+':STATUS');if(code)assert.equal(data.error?.code,code,label+':CODE');
    report.cases.push({id:'HTTP-'+String(report.cases.length+1).padStart(3,'0'),label,status:r.status,code:data.error?.code??null,passed:true});return data.data;
  }
  async function loginAs(i){const value=await call('login '+i,{url:'/api/auth/login',method:'POST',body:{username:accounts[i].username,password:passwords[i]}});active.set(i,value.token);return value;}
  try{
    connection=await database.getConnection();report.identity=await probe(connection);
    const baseline=await read(path.join(evidence,'baseline.json'));
    // A normalized structure fingerprint ignores only the expected auto-increment allocation.
    if(!baseline.usersStructure){const [ddl]=await connection.query('SHOW CREATE TABLE users');baseline.usersStructure=hash(ddl[0]['Create Table'].replace(/ AUTO_INCREMENT=\d+/g,''));await write(path.join(evidence,'baseline.json'),baseline);}
    await audit(database);
    for(const a of accounts){const [existing]=await connection.execute('SELECT id FROM users WHERE username=?',[a.username]);assert.equal(existing.length,0,'RESERVED_ACCOUNT_COLLISION');}
    await listen();
    await call('anonymous health',{url:'/api/health'});
    for(const url of ['/api/clothes','/api/categories','/api/media/file.jpg','/uploads/users/11/file.jpg','/api/api/health'])await call('unimplemented '+url,{url,status:404,code:'NOT_FOUND'});
    for(let i=0;i<2;i++){
      const user=await call('register '+i,{url:'/api/auth/register',method:'POST',body:{username:i?' '+accounts[i].username.toUpperCase()+' ':accounts[i].username,password:passwords[i],nickname:i?'隔离账号':'衣😀'.repeat(10)},status:201});
      accounts[i].id=user.id;accounts[i].state='registered';await write(path.join(dir,'accounts.json'),{runId,accounts});
      assert.deepEqual(Object.keys(user).sort(),['avatarPath','avatarUrl','id','nickname','username']);assert.equal(user.avatarPath,null);
      const [rows]=await connection.execute('SELECT * FROM users WHERE id=?',[user.id]);assert.equal(rows[0].auth_token_hash,null);assert.equal(rows[0].auth_expires_at,null);assert.equal(rows[0].password_hash.length,178);assert.ok(await verifyPassword(passwords[i],rows[0].password_hash));assert.equal(await verifyPassword('incorrect-password',rows[0].password_hash),false);assert.equal(rows[0].created_at,rows[0].updated_at);
    }
    await call('duplicate normalized username',{url:'/api/auth/register',method:'POST',body:{username:' '+accounts[0].username.toUpperCase()+' ',password:passwords[0],nickname:'重复'},status:409,code:'USERNAME_TAKEN'});
    const valid={username:accounts[0].username,password:passwords[0],nickname:'测试'};
    for(const [name,input]of [['missing',{}],['array',[]],['type',{...valid,password:123}],['extra',{...valid,userId:accounts[1].id}],['short name',{...valid,username:'a'}],['long name',{...valid,username:'a'.repeat(21)}],['unicode username',{...valid,username:'中文用户'}],['short password',{...valid,password:'短'}],['long password',{...valid,password:'😀'.repeat(65)}],['empty nickname',{...valid,nickname:' '}],['long nickname',{...valid,nickname:'衣'.repeat(21)}],['newline nickname',{...valid,nickname:'a\nb'}]])await call('registration '+name,{url:'/api/auth/register',method:'POST',body:input,status:400,code:'INVALID_INPUT'});
    for(const [label,raw,status]of [['invalid JSON','{',400],['oversized JSON',JSON.stringify({x:'x'.repeat(9000)}),413]])await call(label,{url:'/api/auth/register',method:'POST',raw,status,code:'INVALID_INPUT'});
    let a=await loginAs(0),b=await loginAs(1);
    assert.match(a.token,/^[A-Za-z0-9_-]{43}$/);assert.match(a.expiresAt,/Z$/);
    const [signed]=await connection.execute('SELECT auth_token_hash,auth_expires_at,updated_at FROM users WHERE id=?',[accounts[0].id]);assert.ok(signed[0].auth_token_hash===tokenHash(a.token));assert.equal(signed[0].auth_token_hash.length,64);assert.equal(Date.parse(signed[0].auth_expires_at.replace(' ','T')+'Z')-Date.parse(signed[0].updated_at.replace(' ','T')+'Z'),7*24*60*60*1000);
    report.tokenProtocol={rawLength:43,digestLength:64,expiryMilliseconds:604800000,onlyDigestStored:true};
    for(const [label,input]of [['bad password',{username:accounts[0].username,password:'incorrect-password'}],['unknown user',{username:'p302_x_'+suffix,password:passwords[0]}],['password trimmed',{username:accounts[0].username,password:passwords[0].trim()}]])await call(label,{url:'/api/auth/login',method:'POST',body:input,status:401,code:'INVALID_CREDENTIALS'});
    const [unchanged]=await connection.execute('SELECT auth_token_hash,auth_expires_at,updated_at FROM users WHERE id=?',[accounts[0].id]);assert.deepEqual(unchanged,signed);
    for(const header of [undefined,'invalid','Bearer short','Bearer '+randomBytes(32).toString('base64url'),'Bearer '+a.token+', '+a.token])await call('invalid bearer',{headers:header?{Authorization:header}:{},status:401,code:'UNAUTHENTICATED'});
    const me=await call('current user',{token:a.token});assert.equal(me.id,accounts[0].id);assert.equal((await call('other identity',{token:b.token})).id,accounts[1].id);
    await call('query identity rejected',{url:'/api/me?userId='+accounts[1].id,token:a.token,status:400,code:'INVALID_INPUT'});
    const profile=await call('nickname save',{method:'PUT',token:a.token,body:{nickname:' 新的昵称😀 ',avatarPath:null}});assert.equal(profile.nickname,'新的昵称😀');assert.equal((await call('read saved',{token:a.token})).nickname,'新的昵称😀');assert.equal((await call('B unchanged',{token:b.token})).nickname,'隔离账号');
    for(const [name,body,code]of [['missing avatar',{nickname:'bad'},'INVALID_INPUT'],['wrong avatar type',{nickname:'bad',avatarPath:1},'INVALID_INPUT'],['extra userId',{nickname:'bad',avatarPath:null,userId:accounts[1].id},'INVALID_INPUT'],['empty nickname',{nickname:' ',avatarPath:null},'INVALID_INPUT'],['long nickname',{nickname:'x'.repeat(21),avatarPath:null},'INVALID_INPUT'],['newline',{nickname:'a\nb',avatarPath:null},'INVALID_INPUT']])await call(name,{method:'PUT',token:a.token,body,status:400,code});
    const [owner]=await connection.query('SELECT user_id,image_path FROM clothes ORDER BY id LIMIT 1');await validateImageReference(owner[0].image_path,owner[0].user_id,config.uploadRoot);report.existingImageReadOnly={ownerId:owner[0].user_id,valid:true,validationLayer:'function, not authenticated HTTP'};
    for(const p of [owner[0].image_path,'https://example.com/a.jpg','blob:temporary','wxfile://temporary','../users/1/x.png','users/'+accounts[0].id+'/%2e%2e/x.png','users/'+accounts[0].id+'/12345678-1234-1234-1234-123456789abc.png'])await call('invalid image reference',{method:'PUT',token:a.token,body:{nickname:'should-not-save',avatarPath:p},status:400,code:'INVALID_IMAGE_REF'});
    assert.equal((await call('refused edits unchanged',{token:a.token})).nickname,'新的昵称😀');
    const old=a.token;a=await loginAs(0);for(const [method,url,body]of [['GET','/api/me'],['POST','/api/auth/logout'],['PUT','/api/me',{nickname:'旧请求',avatarPath:null}]])await call('superseded token '+method,{method,url,body,token:old,status:401,code:'UNAUTHENTICATED'});
    await call('new login survives stale logout',{token:a.token});
    const expiryBefore=(await connection.execute('SELECT auth_expires_at FROM users WHERE id=?',[accounts[0].id]))[0][0].auth_expires_at;
    await close();await listen();assert.equal((await call('persist after server restart',{token:a.token})).nickname,'新的昵称😀');const expiryAfter=(await connection.execute('SELECT auth_expires_at FROM users WHERE id=?',[accounts[0].id]))[0][0].auth_expires_at;assert.equal(expiryAfter,expiryBefore);report.restart={tokenStillValid:true,expiryUnchanged:true,nicknamePersisted:true};
    const [fixture]=await connection.execute("UPDATE users SET auth_expires_at='2000-01-01 00:00:00.000' WHERE id=? AND auth_token_hash=?",[accounts[0].id,tokenHash(a.token)]);assert.equal(fixture.affectedRows,1);report.expiryFixture={id:accounts[0].id,column:'auth_expires_at',affectedRows:1,newValue:'2000-01-01 00:00:00.000'};
    await call('real HTTP expired token',{token:a.token,status:401,code:'UNAUTHENTICATED'});a=await loginAs(0);
    for(const i of [0,1]){const token=active.get(i);await call('logout '+i,{url:'/api/auth/logout',method:'POST',token});active.delete(i);accounts[i].state='logged-out';await write(path.join(dir,'accounts.json'),{runId,accounts});await call('logout replay '+i,{url:'/api/auth/logout',method:'POST',token,status:401,code:'UNAUTHENTICATED'});}
    report.protection=await audit(database);report.state='automated-passed';
  }catch(error){report.state='failed';report.failure={code:error.code??'CHECK_FAILED',check:error.code==='ERR_ASSERTION'?error.message.split('\n')[0]:'See failing step; sensitive exception omitted'};process.exitCode=1;}
  finally{
    if(server?.listening){for(const [i,token]of active){try{await call('failure cleanup logout '+i,{url:'/api/auth/logout',method:'POST',token});accounts[i].state='logged-out';}catch(error){report.cleanupFailure=true;process.exitCode=1;}}await close();}
    connection?.release();await database.end();report.completedAt=new Date().toISOString();await write(path.join(dir,'accounts.json'),{runId,accounts});await write(path.join(dir,'automated-results.json'),report);
  }
  console.log(JSON.stringify({runId,state:report.state,httpCases:report.cases.length,failure:report.failure,manualUsername:accounts[2].username}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({state:'failed',code:error.code??'INTERNAL_ERROR'}));process.exitCode=1;});
