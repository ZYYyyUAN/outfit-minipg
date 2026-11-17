import test from 'node:test';
import assert from 'node:assert/strict';
import {applyBusinessEvents,rowHash} from '../scripts/outfit-business-proof.mjs';
import {compareCumulative} from '../scripts/verify-outfits.mjs';
function fixture(){
 const baseline={identity:{},grants:[],columns:[],U0:0,tables:{},protectedFiles:{},images:{}};
 for(const table of ['users','categories','clothes','outfits','outfit_items','diaries','diary_items'])baseline.tables[table]={count:0,structure:table,rows:[]};
 const clothing={id:10,user_id:2,name:'old',image_path:'users/2/a.jpg',is_archived:0,created_at:'old',updated_at:'old'};
 const outfit={id:20,user_id:2,name:'old',occasion:'a',note:'',is_archived:0,created_at:'old',updated_at:'old'};
 const item={outfit_id:20,clothing_id:10,sort_order:1};
 const first={version:1,runId:'first',accounts:[{id:2}],images:[],rows:[{table:'users',ownerId:2,row:{key:2,sha256:'user'},beforeSha256:null},...[['clothes',clothing],['outfits',outfit],['outfit_items',item]].map(([table,raw])=>({table,ownerId:2,row:{key:table==='outfit_items'?'20:10':raw.id,sha256:rowHash(raw),...(raw.user_id?{userId:2}:{})},beforeSha256:null}))]};
 const later={version:1,runId:'manual',accounts:[],rows:[],images:[],manualScope:{ownerIds:[2],clothingIds:[10],outfitIds:[20]},businessEvents:[{table:'clothes',ownerId:2,before:clothing,after:{...clothing,name:'new',updated_at:'new'}},{table:'outfit_items',ownerId:2,before:item,after:null}]};
 return {baseline,first,later};
}
test('business proof folds exact field changes and explicit relation removal, preserving old manifests',()=>{
 const {baseline,first,later}=fixture(),original=structuredClone(first),folded=applyBusinessEvents(baseline,[first,later]);
 assert.deepEqual(first,original);assert.equal(folded[0].rows.length,3);assert.equal(folded[0].rows[1].row.sha256,rowHash(later.businessEvents[0].after));
 const current=structuredClone(baseline);current.U0=1;for(const entry of folded[0].rows){current.tables[entry.table].rows.push(entry.row);current.tables[entry.table].count++;}
 current.ownership={users:{2:{ownerId:2}},clothes:{10:{ownerId:2}},outfits:{20:{ownerId:2}}};
 assert.equal(compareCumulative(baseline,current,[first,later]).unexpectedRows,0);
 const unknown=structuredClone(current);unknown.tables.outfit_items.rows.push({key:'20:10',sha256:'leftover'});unknown.tables.outfit_items.count++;assert.throws(()=>compareCumulative(baseline,unknown,[first,later]));
});
test('business proofs reject false previous rows, protected data, scope and forbidden field changes',()=>{
 const {baseline,first,later}=fixture();
 for(const mutate of [m=>m.businessEvents[0].before.name='false',m=>m.businessEvents[0].after.user_id=3,m=>m.businessEvents[0].after.created_at='new',m=>m.businessEvents[0].after=null,m=>m.manualScope.clothingIds=[],m=>m.manualScope.ownerIds=[],m=>m.manualScope.outfitIds=[],m=>m.businessEvents[0].table='diaries',m=>m.businessEvents[1].before.clothing_id=99]){
  const bad=structuredClone(later);mutate(bad);assert.throws(()=>applyBusinessEvents(baseline,[first,bad]));
 }
 const protectedBaseline=structuredClone(baseline);protectedBaseline.tables.clothes.rows.push(first.rows[1].row);assert.throws(()=>applyBusinessEvents(protectedBaseline,[first,later]),/ORIGINAL_ROW_IS_PROTECTED/);
});
