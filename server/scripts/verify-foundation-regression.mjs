import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {readConfig,serverRoot} from '../src/config.js';
import {createDatabase,probe} from '../src/db.js';
import {tokenHash} from '../src/services/account.js';
import {validateImageReference} from '../src/utils/image-reference.js';
import {verifyPassword} from '../../shared/password.mjs';
import {implementationHashes} from './verify-auth.mjs';
import {makeFixtures} from '../test/media-fixtures.mjs';
import {verifyOriginals} from './verify-wardrobe.mjs';
import {captureSnapshot,compareCumulative,loadManifests,historicalReleaseHashes} from './verify-outfits.mjs';
import {snapshot as p6Snapshot} from './verify-diaries.mjs';
import {fixtureManifestRows} from './outfit-http.mjs';
const root=path.dirname(serverRoot);
let evidence=path.join(root,'docs/evidence/P4');
const hash=x=>createHash('sha256').update(x).digest('hex');
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const write=(p,value)=>fs.writeFile(p,JSON.stringify(value,null,2)+'\n');
async function uploadFiles(){const files={};async function walk(folder){for(const e of await fs.readdir(path.join(root,folder),{withFileTypes:true})){const f=folder+'/'+e.name;if(e.isDirectory())await walk(f);else{const bytes=await fs.readFile(path.join(root,f));files[f]={sha256:hash(bytes),bytes:bytes.length};}}}await walk('server/uploads');return files;}
async function audit(database){return verifyOriginals(database);}
async function main(){
  const args=process.argv.slice(2);const p6=args[0]==='--p6';if(p6){args.shift();evidence=path.join(root,'docs/evidence/P6');}const p5=args[0]==='--p5';if(p5){args.shift();evidence=path.join(root,'docs/evidence/P5');}if(!args.length){console.log('Usage: verify-foundation-regression.mjs --run-id <unique-id> | --audit <existing-run-id>');return;}
  assert.ok(args.length===2&&['--run-id','--audit'].includes(args[0])&&/^[A-Za-z0-9_-]+$/.test(args[1]),'INVALID_ARGUMENTS');
  assert.ok(!p5||args[0]==='--run-id','P5_REQUIRES_NEW_RUN');
  const runId=args[1],dir=path.join(evidence,runId),config=readConfig(),database=createDatabase(config);
  if(args[0]==='--audit'){
    const report={runId,at:new Date().toISOString(),state:'running'};
    try{await read(path.join(dir,'accounts.json'));report.protection=await audit(database,{recordManual:true});report.implementation=await implementationHashes();report.state='passed';await write(path.join(evidence,'protection-latest.json'),report);}
    catch(error){report.state='failed';report.failure={code:error.code??'CHECK_FAILED',check:error.code==='ERR_ASSERTION'?error.message.split('\n')[0]:'Sensitive exception omitted'};process.exitCode=1;}
    finally{await database.end();await fs.writeFile(path.join(dir,'audit-'+Date.now()+'.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
    console.log(JSON.stringify({state:report.state,counts:report.protection?.counts,newImages:report.protection?.newImages,failure:report.failure}));return;
  }
  const p6Before=p6?await p6Snapshot(database,config.uploadRoot):null;
  const prior=p5?await loadManifests():[];
  const baseline=p5?await read(path.join(root,'docs/evidence/P5/run-20261116-b1-baseline/baseline.json')):null;
  const releases=p5?await historicalReleaseHashes():null;
  const checkProtection=async()=>p6?{mode:'P6 original rows checked at final snapshot'}:p5?compareCumulative(baseline,await captureSnapshot(database,config.uploadRoot),await loadManifests()):audit(database);
  await fs.mkdir(dir);await fs.mkdir(path.join(dir,'fixtures'));await fs.mkdir(path.join(dir,'manual'));
  const suffix=randomBytes(4).toString('hex'),accounts=['a','b'].map(part=>({runId,username:'p4_'+suffix+'_'+part,id:null,purpose:part==='u'?'manual':'HTTP',state:'reserved'})),files=[];
  const passwords=[' '+randomBytes(12).toString('base64url')+' ',randomBytes(16).toString('base64url')],active=new Map();
  const saveAccounts=()=>write(path.join(dir,'accounts.json'),{runId,accounts}),saveFiles=()=>write(path.join(dir,'files-manifest.json'),{runId,files});await saveAccounts();await saveFiles();
  const fixtures=await makeFixtures();await fs.writeFile(path.join(dir,'fixtures/ui-avatar.png'),fixtures.png);
  const ui={runId,files:[{path:'assets/clothes/clothing-001.jpg',sha256:hash(fixtures.jpeg)},{path:(p5?'docs/evidence/P5/':'docs/evidence/P4/')+runId+'/fixtures/ui-avatar.png',sha256:hash(fixtures.png)}]};await write(path.join(dir,'ui-fixtures.json'),ui);
  const report={runId,startedAt:new Date().toISOString(),state:'running',cases:[],implementation:await implementationHashes(),processes:[]};
  let server,connection;const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const origin='http://127.0.0.1:'+port;
  async function listen(){
    server=spawn(process.execPath,[path.join(serverRoot,'src/index.js')],{cwd:serverRoot,env:{...process.env,PORT:String(port),PUBLIC_BASE_URL:origin},windowsHide:true,stdio:['ignore','pipe','pipe']});
    const child=server;let text='';
    await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Object.assign(new Error('STARTUP_TIMEOUT'),{code:'STARTUP_TIMEOUT'})),15000);child.once('error',e=>{clearTimeout(timeout);reject(e);});child.once('exit',()=>{clearTimeout(timeout);reject(Object.assign(new Error('CHILD_START_FAILED'),{code:'CHILD_START_FAILED'}));});child.stderr.on('data',()=>{});child.stdout.on('data',b=>{text+=b.toString();if(text.includes('"event":"http-listening"')){clearTimeout(timeout);resolve();}});});
    report.processes.push({pid:child.pid,startedAt:new Date().toISOString(),origin});
  }
  async function close(){if(!server||server.exitCode!==null)return;const child=server;await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);child.kill('SIGTERM');});report.processes.find(p=>p.pid===child.pid).stoppedAt=new Date().toISOString();report.processes.find(p=>p.pid===child.pid).stopMode=process.platform==='win32'?'owned Windows child terminated; no graceful-shutdown claim':'SIGTERM';}
  async function call(label,{url='/api/me',method='GET',body,form,raw,token,headers={},status=200,code}={}){
    const r=await fetch(origin+url,{method,headers:{...(body!==undefined||raw!==undefined?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...headers},...(form!==undefined?{body:form}:body!==undefined||raw!==undefined?{body:raw??JSON.stringify(body)}:{})});const data=await r.json();assert.equal(r.status,status,label+':STATUS');if(code)assert.equal(data.error?.code,code,label+':CODE');report.cases.push({id:'HTTP-'+String(report.cases.length+1).padStart(3,'0'),label,status:r.status,code:data.error?.code??null,passed:true});return data.data;
  }
  async function loginAs(i){const value=await call('login '+i,{url:'/api/auth/login',method:'POST',body:{username:accounts[i].username,password:passwords[i]}});active.set(i,value.token);accounts[i].state='logged-in';await saveAccounts();return value;}
  function form(bytes,name='file',type='image/png'){const f=new FormData();f.append(name,new Blob([bytes],{type}),'fixture.jpg');return f;}
  async function upload(label,bytes,i,source){const value=await call(label,{url:'/api/uploads',method:'POST',form:form(bytes),token:active.get(i),status:201});assert.match(value.imagePath,/^users\/[1-9]\d*\/[0-9a-f-]{36}\.(jpg|png)$/);assert.equal(value.imagePath.split('/')[1],String(accounts[i].id));assert.equal(value.imageUrl,origin+'/api/media/'+path.basename(value.imagePath));assert.equal(value.size,bytes.length);assert.equal(hash(await fs.readFile(path.join(config.uploadRoot,value.imagePath))),hash(bytes));files.push({runId,userId:accounts[i].id,imagePath:value.imagePath,filename:path.basename(value.imagePath),mimeType:value.mimeType,size:bytes.length,sha256:hash(bytes),source:{kind:source,sha256:hash(bytes)},retention:'successful HTTP upload retained',avatarReferenced:false});await saveFiles();return value;}
  async function image(label,value,i){const r=await fetch(origin+'/api/media/'+path.basename(value.imagePath),{headers:{Authorization:'Bearer '+active.get(i)}});assert.equal(r.status,200,label+':STATUS');const bytes=Buffer.from(await r.arrayBuffer());const recorded=files.find(f=>f.imagePath===value.imagePath);assert.equal(hash(bytes),recorded.sha256);assert.equal(r.headers.get('content-type'),recorded.mimeType);assert.equal(r.headers.get('content-length'),String(recorded.size));assert.equal(r.headers.get('cache-control'),'private, no-store');assert.equal(r.headers.get('etag'),null);report.cases.push({id:'HTTP-'+String(report.cases.length+1).padStart(3,'0'),label,status:200,sha256:hash(bytes),bytes:bytes.length,passed:true});}
  try{
    connection=await database.getConnection();report.identity=await probe(connection);await checkProtection();for(const a of accounts){const [rows]=await connection.execute('SELECT id FROM users WHERE username=?',[a.username]);assert.equal(rows.length,0,'ACCOUNT_COLLISION');}
    await listen();
    await call('anonymous health',{url:'/api/health'});
    for(const url of [...(p6?[]:['/api/diaries','/api/statistics']),'/uploads/users/11/file.jpg','/api/api/health'])await call('unimplemented '+url,{url,status:404,code:'NOT_FOUND'});
    if(p6)for(const url of ['/api/diaries','/api/statistics'])await call('P6 migrated anonymous '+url,{url,status:401,code:'UNAUTHENTICATED'});
    await call('outfits anonymous authentication migrated from old 404',{url:'/api/outfits',status:401,code:'UNAUTHENTICATED'});
    for(let i=0;i<2;i++){
      const user=await call('register '+i,{url:'/api/auth/register',method:'POST',body:{username:i?' '+accounts[i].username.toUpperCase()+' ':accounts[i].username,password:passwords[i],nickname:i?'隔离账号':'衣😀'.repeat(10)},status:201});
      accounts[i].id=user.id;accounts[i].state='registered';await write(path.join(dir,'accounts.json'),{runId,accounts});
      assert.deepEqual(Object.keys(user).sort(),['avatarPath','avatarUrl','id','nickname','username']);assert.equal(user.avatarPath,null);
      const [rows]=await connection.execute('SELECT * FROM users WHERE id=?',[user.id]);assert.equal(rows[0].auth_token_hash,null);assert.equal(rows[0].auth_expires_at,null);assert.equal(rows[0].password_hash.length,178);assert.ok(await verifyPassword(passwords[i],rows[0].password_hash));assert.equal(await verifyPassword('incorrect-password',rows[0].password_hash),false);assert.equal(rows[0].created_at,rows[0].updated_at);accounts[i].immutable=Object.fromEntries(['id','username','password_hash','created_at'].map(k=>[k,hash(JSON.stringify(rows[0][k]))]));await saveAccounts();
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

    report.migratedAuthCases=report.cases.length;
    await saveAccounts();
    a=await loginAs(0);b=await loginAs(1);
    const category=await call('categories real ordered seven',{url:'/api/categories',token:a.token});const source=JSON.parse(await fs.readFile(path.join(root,'data/demo-data.json'),'utf8'));assert.deepEqual(category.items,source.categories.map(c=>({id:c.id,name:c.name,sortOrder:c.sortOrder})));
    await call('categories anonymous',{url:'/api/categories',status:401,code:'UNAUTHENTICATED'});await call('categories extra query',{url:'/api/categories?userId=1',token:a.token,status:400,code:'INVALID_INPUT'});
    const beforeUnauth=await uploadFiles();
    for(const [label,raw,headers]of [['unauth invalid JSON','{',{'Content-Type':'application/json'}],['unauth invalid multipart','bad',{'Content-Type':'multipart/form-data'}]])await call(label,{url:'/api/uploads',method:'POST',raw,headers,status:401,code:'UNAUTHENTICATED'});
    await call('unauth oversized file',{url:'/api/uploads',method:'POST',form:form(Buffer.alloc(5242881)),status:401,code:'UNAUTHENTICATED'});assert.deepEqual(await uploadFiles(),beforeUnauth);
    const beforeUpload=(await connection.execute('SELECT * FROM users WHERE id=?',[accounts[0].id]))[0];
    const jpeg=await upload('real JPEG upload',fixtures.jpeg,0,'assets/clothes/clothing-001.jpg');const png=await upload('real PNG upload',fixtures.png,0,'generated PNG');const other=await upload('other user own image',fixtures.png,1,'generated PNG');
    assert.deepEqual((await connection.execute('SELECT * FROM users WHERE id=?',[accounts[0].id]))[0],beforeUpload);
    await image('JPEG private read',jpeg,0);await image('PNG private read',png,0);await image('B private own read',other,1);
    await call('anonymous image read',{url:'/api/media/'+path.basename(jpeg.imagePath),status:401,code:'UNAUTHENTICATED'});await call('B cannot read A JPEG',{url:'/api/media/'+path.basename(jpeg.imagePath),token:b.token,status:404,code:'NOT_FOUND'});await call('A cannot read B PNG',{url:'/api/media/'+path.basename(other.imagePath),token:a.token,status:404,code:'NOT_FOUND'});
    for(const [name,bytes,status,code]of [['empty image',Buffer.alloc(0),415,'UNSUPPORTED_IMAGE'],['fake JPEG',Buffer.from([255,216,255,0]),415,'UNSUPPORTED_IMAGE'],['truncated JPEG',fixtures.jpeg.subarray(0,32),415,'UNSUPPORTED_IMAGE'],['truncated PNG',fixtures.png.subarray(0,40),415,'UNSUPPORTED_IMAGE'],['GIF',Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'),415,'UNSUPPORTED_IMAGE'],['SVG',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),415,'UNSUPPORTED_IMAGE'],['HTML',Buffer.from('<html>not image</html>'),415,'UNSUPPORTED_IMAGE'],['over 5MiB',fixtures.sizedPng(5242881),413,'FILE_TOO_LARGE']]){const prior=await uploadFiles();await call(name,{url:'/api/uploads',method:'POST',form:form(bytes),token:a.token,status,code});assert.deepEqual(await uploadFiles(),prior);}
    for(const size of [5242879,5242880]){const bytes=fixtures.sizedPng(size);await sharp(bytes).raw().toBuffer();await upload('valid boundary '+size,bytes,0,'valid PNG tEXt boundary');}
    for(const [name,body]of [['no file',new FormData()],['wrong field',form(fixtures.png,'avatar')],['two files',(()=>{const f=form(fixtures.png);f.append('file',new Blob([fixtures.png]),'another.png');return f;})()],['extra text',(()=>{const f=form(fixtures.png);f.append('userId','1');return f;})()]]){const prior=await uploadFiles();await call(name,{url:'/api/uploads',method:'POST',form:body,token:a.token,status:400,code:name==='no file'?'IMAGE_REQUIRED':'INVALID_INPUT'});assert.deepEqual(await uploadFiles(),prior);}
    await call('no multipart',{url:'/api/uploads',method:'POST',body:{},token:a.token,status:400,code:'IMAGE_REQUIRED'});await call('missing boundary',{url:'/api/uploads',method:'POST',raw:'bad',headers:{'Content-Type':'multipart/form-data'},token:a.token,status:400,code:'INVALID_INPUT'});await call('upload query rejected',{url:'/api/uploads?userId=1',method:'POST',form:form(fixtures.png),token:a.token,status:400,code:'INVALID_INPUT'});
    for(const name of ['invalid.png','users%2F'+accounts[0].id+'%2F'+path.basename(jpeg.imagePath),'00000000-0000-0000-0000-000000000000.png'])await call('invalid/missing image '+name,{url:'/api/media/'+name,token:a.token,status:404,code:'NOT_FOUND'});
    await call('image query rejected',{url:'/api/media/'+path.basename(jpeg.imagePath)+'?userId=1',token:a.token,status:400,code:'INVALID_INPUT'});
    const saved=await call('save nonnull avatar',{method:'PUT',body:{nickname:'图片测试A',avatarPath:jpeg.imagePath},token:a.token});assert.equal(saved.avatarPath,jpeg.imagePath);assert.equal(saved.avatarUrl,jpeg.imageUrl);assert.equal((await call('read persisted nonnull avatar',{token:a.token})).avatarPath,jpeg.imagePath);
    const expiry=(await connection.execute('SELECT auth_expires_at FROM users WHERE id=?',[accounts[0].id]))[0][0].auth_expires_at;const firstPid=server.pid;await close();await listen();assert.notEqual(server.pid,firstPid);assert.equal((await call('actual new process preserves avatar',{token:a.token})).avatarPath,jpeg.imagePath);await image('actual new process reads identical bytes',jpeg,0);assert.equal((await connection.execute('SELECT auth_expires_at FROM users WHERE id=?',[accounts[0].id]))[0][0].auth_expires_at,expiry);report.mediaRestart={oldPid:firstPid,newPid:server.pid,avatarPreserved:true,byteHashPreserved:true,expiryUnchanged:true};
    await call('replace avatar',{method:'PUT',body:{nickname:'图片测试A',avatarPath:png.imagePath},token:a.token});await image('old successful JPEG retained after replacement',jpeg,0);assert.equal((await call('cancel makes no write/read same saved avatar',{token:a.token})).avatarPath,png.imagePath);
    await call('remove avatar',{method:'PUT',body:{nickname:'图片测试A',avatarPath:null},token:a.token});assert.equal((await call('removed avatar is null',{token:a.token})).avatarPath,null);await image('successful PNG retained after remove',png,0);
    await call('reject B path in A profile',{method:'PUT',body:{nickname:'must-not-save',avatarPath:other.imagePath},token:a.token,status:400,code:'INVALID_IMAGE_REF'});assert.equal((await call('cross path refusal preserves profile',{token:a.token})).nickname,'图片测试A');
    const [expired]=await connection.execute("UPDATE users SET auth_expires_at='2000-01-01 00:00:00.000' WHERE id=? AND auth_token_hash=?",[accounts[0].id,tokenHash(a.token)]);assert.equal(expired.affectedRows,1);report.mediaExpiryFixture={id:accounts[0].id,column:'auth_expires_at',affectedRows:1};
    for(const [route,method,body]of [['/api/categories','GET'],['/api/media/'+path.basename(jpeg.imagePath),'GET'],['/api/uploads','POST',form(fixtures.png)]]){const prior=await uploadFiles();await call('expired media '+route,{url:route,method,form:body,token:a.token,status:401,code:'UNAUTHENTICATED'});assert.deepEqual(await uploadFiles(),prior);}a=await loginAs(0);
    for(const i of [0,1]){await call('final media logout '+i,{url:'/api/auth/logout',method:'POST',token:active.get(i)});active.delete(i);accounts[i].state='logged-out';await saveAccounts();}
    report.state='automated-passed';
  }catch(error){report.state='failed';report.failure={code:error.code??'CHECK_FAILED',check:error.code==='ERR_ASSERTION'?error.message.split('\n')[0]:'Sensitive exception omitted'};process.exitCode=1;}
  finally{
    if(server&&server.exitCode===null){for(const [i,token]of active){try{await call('failure cleanup logout '+i,{url:'/api/auth/logout',method:'POST',token});accounts[i].state='logged-out';}catch(error){report.cleanupFailure=true;process.exitCode=1;}}await close();}
    connection?.release();
    if(p6){
      try{
        const final=await p6Snapshot(database,config.uploadRoot);
        for(const [table,value]of Object.entries(p6Before.tables)){assert.equal(final.tables[table].structure,value.structure);for(const [key,sha]of Object.entries(value.rows))assert.equal(final.tables[table].rows[key],sha,'ORIGINAL_ROW:'+table+':'+key);const added=Object.keys(final.tables[table].rows).filter(k=>!Object.hasOwn(value.rows,k));assert.deepEqual(added.sort(),table==='users'?accounts.filter(a=>a.id).map(a=>String(a.id)).sort():[]);}
        for(const [file,sha]of Object.entries(p6Before.files))assert.equal(final.files[file],sha,'ORIGINAL_FILE:'+file);
        const added=Object.keys(final.files).filter(f=>!Object.hasOwn(p6Before.files,f));assert.deepEqual(added.sort(),files.map(f=>'server/uploads/'+f.imagePath).sort());
        assert.ok(accounts.every(a=>a.state==='logged-out'));
        await write(path.join(dir,'baseline.json'),p6Before);await write(path.join(dir,'final-snapshot.json'),final);await write(path.join(dir,'registry.json'),{users:accounts.map(a=>a.id),images:files.map(f=>({userId:f.userId,path:f.imagePath,sha256:f.sha256})),clothes:[],outfits:[],diaries:[],deleted:[]});
        await write(path.join(dir,'events.json'),[{label:'A/session/media full regression, temporary expiry changes in automated-results.json',changes:accounts.map(a=>({table:'users',key:String(a.id),before:null,after:final.tables.users.rows[a.id]}))}]);
        report.protection={originalRowsAndFilesUnchanged:true,allNewRowsAndImagesRegistered:true};
      }finally{await database.end();}
    }else if(p5){
      try{
        const snapshot=await captureSnapshot(database,config.uploadRoot);
        const c=await database.getConnection();let all={};try{for(const table of ['users','clothes','outfits','outfit_items','diaries','diary_items'])all[table]=(await c.query('SELECT * FROM '+table))[0];}finally{c.release();}
        const fixture={accounts:Object.fromEntries(accounts.filter(a=>a.id).map((a,i)=>[i,a])),clothes:{},outfits:{},diaries:{}};
        const inventory=fixtureManifestRows(all,fixture);assert.deepEqual(inventory.unknownRows,[]);assert.deepEqual(inventory.missingRows,[]);
        const manifest={version:1,sequence:Math.max(...prior.map(m=>m.sequence))+1,runId,batch:6,accounts:accounts.filter(a=>a.id).map(a=>({id:a.id,createdByRunId:runId})),rows:inventory.rows,images:files.map(f=>({userId:f.userId,path:f.imagePath,size:f.size,sha256:f.sha256,mimeType:f.mimeType,references:[],retention:f.retention})),allAccountsLoggedOut:accounts.every(a=>a.state==='logged-out'),processClosed:report.processes.every(p=>p.stoppedAt)};
        assert.ok(manifest.allAccountsLoggedOut);assert.ok(manifest.processClosed);await write(path.join(dir,'manifest.json'),manifest);
        report.protection=compareCumulative(baseline,snapshot,[...prior,manifest]);assert.deepEqual(await historicalReleaseHashes(),releases);await write(path.join(dir,'snapshot.json'),snapshot);
        await fs.mkdir(path.join(serverRoot,'.p5-private'),{recursive:true});await write(path.join(serverRoot,'.p5-private',runId+'.json'),{accounts:accounts.map((a,i)=>({id:a.id,username:a.username,password:passwords[i]}))});
      }finally{await database.end();}
    }else{await database.end();}
    await saveAccounts();await saveFiles();report.completedAt=new Date().toISOString();await write(path.join(dir,'automated-results.json'),report);
  }
  console.log(JSON.stringify({runId,state:report.state,httpCases:report.cases.length,regressionCases:report.migratedAuthCases,newImages:files.length,failure:report.failure}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({state:'failed',code:error.code??'INTERNAL_ERROR'}));process.exitCode=1;});
