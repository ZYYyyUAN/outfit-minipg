import test from 'node:test';
import assert from 'node:assert/strict';
import { filters, clothingInput, positive, pagination, queryInput } from '../src/routes/clothes.js';
import { literalLike, seasonMatches, shanghaiDate, utcIso } from '../src/services/clothes.js';
import {createServer} from 'node:http';
import {createApp} from '../src/app.js';
import {unauthenticated} from '../src/utils/business-error.js';

test('clothes filters normalize only known inputs and retain literal keyword',()=> {
  assert.deepEqual(filters({}),{page:1,pageSize:12,offset:0,archived:'active',keyword:'',categoryId:undefined,color:undefined,season:undefined});
  assert.equal(filters({keyword:'  Alpha_%!  ',color:' 浅粉色 ',season:'秋'}).keyword,'Alpha_%!');
  assert.equal(filters({keyword:'',archived:'all'}).archived,'all');
  assert.equal(literalLike('Alpha_%!\\'),'%alpha!_!%!!\\%');
  assert.deepEqual(seasonMatches.秋,['秋','春秋','秋冬','四季']);
  assert.deepEqual(seasonMatches.夏,['夏','春夏','四季']);
});
for(const query of [{page:''},{page:'0'},{page:'1e2'},{page:'1.5'},{page:'9007199254740992'},{page:'9007199254740991',pageSize:'50'},{pageSize:'51'},{pageSize:['1','2']},{archived:''},{archived:'false'},{season:'春秋'},{categoryId:'other'},{color:''},{keyword:'x'.repeat(41)},{sort:'id'},{keyword:{value:'a'}}]) {
  test('clothes rejects query '+JSON.stringify(query),()=>assert.throws(()=>filters(query),{code:'INVALID_INPUT',status:400}));
}
test('clothes decimal IDs, paging defaults and page offsets',()=> {
  assert.equal(positive('00012','id',4294967295),12);
  assert.deepEqual(pagination({page:'2',pageSize:'12'}),{page:2,pageSize:12,offset:12});
  for(const value of ['0','-1','1.1','1e1','4294967296',null,1,[]]) assert.throws(()=>positive(value,'id',4294967295));
  assert.throws(()=>queryInput({extra:'x'},[]));
});
const body={name:' 针织 ',categoryId:'tops',imagePath:'users/1/fixture.jpg',color:' 浅粉色 ',season:'春秋',note:'第一行\n第二行'};
test('clothes full form preserves note and counts Unicode codepoints',()=> {
  assert.equal(clothingInput(body).name,'针织');
  assert.equal(clothingInput({...body,name:'🧥'.repeat(40),color:'🎨'.repeat(20),note:'📝'.repeat(500)}).note.length,1000);
  assert.equal(clothingInput({...body,note:''}).note,'');
  for(const change of [{name:'🧥'.repeat(41)},{name:'a\nb'},{color:'🎨'.repeat(21)},{note:'a'.repeat(501)},{note:null},{season:'全部'},{categoryId:'new'},{imagePath:null},{isArchived:false}]) assert.throws(()=>clothingInput({...body,...change}),{code:'INVALID_INPUT'});
  const missing={...body};delete missing.note;assert.throws(()=>clothingInput(missing));
});
test('clothes dates explicitly preserve UTC and Shanghai natural-day boundary',()=> {
  assert.equal(utcIso('2026-11-04 16:00:00.123'),'2026-11-04T16:00:00.123Z');
  assert.equal(shanghaiDate(new Date('2026-11-04T15:59:59.999Z')),'2026-11-04');
  assert.equal(shanghaiDate(new Date('2026-11-04T16:00:00.000Z')),'2026-11-05');
});

test('clothes authentication precedes malformed and oversized JSON parsing',async()=> {
  const account={authenticate:async()=>{throw unauthenticated();}};
  const server=createServer(createApp(account,null,{}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    for(const body of ['{',JSON.stringify({note:'x'.repeat(9000)})]) {
      const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/clothes',{method:'POST',headers:{'Content-Type':'application/json'},body});
      assert.equal(response.status,401);assert.equal((await response.json()).error.code,'UNAUTHENTICATED');
    }
  } finally {await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
