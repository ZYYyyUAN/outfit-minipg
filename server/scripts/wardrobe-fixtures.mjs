import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {utcSql} from '../src/services/account.js';
import {validateImageReference} from '../src/utils/image-reference.js';
import {createDatabase} from '../src/db.js';

const definitions=[
 ['tops','浅粉色','春秋',0],['bottoms','浅蓝色','四季',0],['outerwear','灰米色','秋',0],['dresses','米白色','夏',0],['shoes','黑色','秋冬',0],
 ['bags','棕色','四季',0],['accessories','银色','冬',0],['tops','浅粉色','春夏',0],['tops','白色','春',0],['tops','黑色','冬',0],
 ['bottoms','浅蓝色','夏',0],['outerwear','藏蓝与灰色','春秋',0],['accessories','彩色','秋',0],['tops','浅粉色','春秋',1],['bottoms','浅蓝色','四季',1],
];
export async function prepareWardrobeFixtures(database,config,account,output,{rollbackCheck=false,existingClothes=[]}={}) {
  await validateImageReference(account.imagePath,account.id,config.uploadRoot);
  const connection=await database.getConnection(), map={userId:account.id,clothes:{},outfits:{},diaries:{},state:'preparing',purpose:'offline-test-fixture-not-business-api'};
  try {
    const [[owner]]=await connection.execute('SELECT username FROM users WHERE id=?',[account.id]);
    assert.equal(owner.username,account.username);assert.match(owner.username,existingClothes.length?/^p4_[a-f0-9]{8}_u$/:/^p4_[a-f0-9]{8}_b$/);
    const [current]=await connection.execute('SELECT * FROM clothes WHERE user_id=? ORDER BY id',[account.id]);assert.equal(current.length,existingClothes.length,'FIXTURE_OWNER_COUNT');
    if(existingClothes.length) {assert.equal(existingClothes.length,2);assert.deepEqual(current.map(row=>row.id),existingClothes.map(row=>row.id).sort((a,b)=>a-b));}
    await connection.beginTransaction();const time=utcSql(new Date());
    for(const [index,[category,color,season,archived]] of definitions.entries()) {
      const key='C'+(index+1),name=index===0?'P4针织_%!Alpha':index===1?'P4牛仔裤Beta':index===13?'P4归档针织':'P4夹具'+key;
      if(index<existingClothes.length) {
        const row=existingClothes[index];assert.equal(row.user_id,account.id);assert.equal(row.name,name);assert.equal(row.category_id,category);assert.equal(row.color,color);assert.equal(row.season,season);assert.equal(row.is_archived,0);
        await validateImageReference(row.image_path,account.id,config.uploadRoot);map.clothes[key]=row.id;continue;
      }
      const [result]=await connection.execute('INSERT INTO clothes (user_id,category_id,name,image_path,color,season,note,is_archived,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',[account.id,category,name,account.imagePath,color,season,'独立分页测试夹具',archived,time,time]);
      map.clothes[key]=result.insertId;
    }
    if(rollbackCheck) throw Object.assign(new Error('CONTROLLED_FIXTURE_FAILURE'),{code:'P4_EXPECTED_ROLLBACK'});
    for(const [index,keys] of [['C2','C3','C4','C5','C1'],['C1','C2'],['C1']].entries()) {
      const [result]=await connection.execute('INSERT INTO outfits (user_id,name,occasion,note,is_archived,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',[account.id,'P4夹具搭配'+(index+1),'日常','独立关联测试夹具',index===1?1:0,time,time]);
      map.outfits['O'+(index+1)]=result.insertId;
      for(const [order,key] of keys.entries()) await connection.execute('INSERT INTO outfit_items (outfit_id,clothing_id,sort_order) VALUES (?,?,?)',[result.insertId,map.clothes[key],order+1]);
    }
    const diaries=[['2026-10-07','O1',['C1','C4','C3']],['2026-10-08',null,['C1']],['2026-11-05','O2',['C1','C2']]];
    for(const [index,[date,source,keys]] of diaries.entries()) {
      const [result]=await connection.execute('INSERT INTO diaries (user_id,wear_date,source_outfit_id,occasion,mood,photo_path,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',[account.id,date,source?map.outfits[source]:null,'日常',index===1?null:'轻松',index===2?account.imagePath:null,index===1?'':'实际衣物独立保存',time,time]);
      map.diaries['D'+(index+1)]=result.insertId;
      for(const [order,key] of keys.entries()) await connection.execute('INSERT INTO diary_items (diary_id,clothing_id,sort_order) VALUES (?,?,?)',[result.insertId,map.clothes[key],order+1]);
    }
    await fs.writeFile(output,JSON.stringify(map,null,2)+'\n',{flag:'wx'});
    await connection.commit();map.state='committed';await fs.writeFile(output,JSON.stringify(map,null,2)+'\n');return map;
  } catch(error) {
    await connection.rollback();
    if(!rollbackCheck || error.code!=='P4_EXPECTED_ROLLBACK') throw error;
    const [[after]]=await connection.execute('SELECT COUNT(*) n FROM clothes WHERE user_id=?',[account.id]);assert.equal(Number(after.n),0);
    const freshDatabase=createDatabase(config),fresh=await freshDatabase.getConnection();
    try {const [[again]]=await fresh.execute('SELECT COUNT(*) n FROM clothes WHERE user_id=?',[account.id]);assert.equal(Number(again.n),0);}
    finally {fresh.release();await freshDatabase.end();}
    map.state='injected-failure-rollback-confirmed';map.expectedError=error.code;map.sameConnectionRows=0;map.newConnectionRows=0;
    await fs.writeFile(output,JSON.stringify(map,null,2)+'\n',{flag:'wx'});return map;
  }
  finally {connection.release();}
}
