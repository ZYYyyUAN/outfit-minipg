import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const rowHash = row => createHash('sha256').update(JSON.stringify(row)).digest('hex');

// Full before/after rows bind field changes and removed relations to the existing hash chain.
export function applyBusinessEvents(baseline, manifests) {
  const copies=structuredClone(manifests), registered=new Map();
  for(const manifest of copies){
    for(const entry of manifest.rows)registered.set(entry.table+':'+entry.row.key,{entry,manifest});
    for(const event of manifest.businessEvents || []){
      const {table,ownerId,before,after}=event;
      assert.ok(['clothes','outfits','outfit_items'].includes(table),'BUSINESS_TABLE');
      assert.ok(manifest.manualScope.ownerIds.includes(ownerId),'BUSINESS_SCOPE_OWNER');
      assert.ok(before || after,'BUSINESS_EMPTY_EVENT');
      const raw=before || after,key=table==='outfit_items'?raw.outfit_id+':'+raw.clothing_id:raw.id;
      assert.ok(!baseline.tables[table].rows.some(row=>String(row.key)===String(key)),'ORIGINAL_ROW_IS_PROTECTED');
      const previous=registered.get(table+':'+key);
      assert.ok(previous,'BUSINESS_UNREGISTERED_ROW');
      assert.equal(previous.entry.ownerId,ownerId,'BUSINESS_OWNER');
      assert.equal(rowHash(before),previous.entry.row.sha256,'BUSINESS_BEFORE_HASH');
      if(table==='outfit_items'){
        assert.ok(manifest.manualScope.outfitIds.includes(raw.outfit_id),'BUSINESS_PARENT_SCOPE');
        const parent=registered.get('outfits:'+raw.outfit_id),clothing=registered.get('clothes:'+raw.clothing_id);
        assert.equal(parent.entry.ownerId,ownerId,'BUSINESS_PARENT_OWNER');
        assert.equal(clothing.entry.ownerId,ownerId,'BUSINESS_CHILD_OWNER');
        if(after){assert.deepEqual(Object.keys(after),Object.keys(before));assert.equal(after.outfit_id,before.outfit_id);assert.equal(after.clothing_id,before.clothing_id);assert.ok(Number.isInteger(after.sort_order)&&after.sort_order>0&&after.sort_order<=20);}
      }else{
        assert.ok(after,'BUSINESS_PARENT_DELETE_FORBIDDEN');
        assert.equal(before.user_id,ownerId);assert.equal(after.user_id,ownerId);
        assert.ok(manifest.manualScope[table==='clothes'?'clothingIds':'outfitIds'].includes(raw.id),'BUSINESS_ROW_SCOPE');
        const allowed=table==='clothes'?['name','image_path','is_archived','updated_at']:['name','occasion','note','is_archived','updated_at'];
        assert.deepEqual(Object.keys(after),Object.keys(before),'BUSINESS_COLUMNS');
        for(const field of Object.keys(before))if(!allowed.includes(field))assert.deepEqual(after[field],before[field],'BUSINESS_FORBIDDEN_FIELD:'+field);
        if(table==='clothes')assert.ok(after.image_path.startsWith('users/'+ownerId+'/'),'BUSINESS_IMAGE_OWNER');
      }
      if(after)previous.entry.row={...previous.entry.row,sha256:rowHash(after)};
      else {previous.manifest.rows.splice(previous.manifest.rows.indexOf(previous.entry),1);registered.delete(table+':'+key);}
    }
    delete manifest.businessEvents;
  }
  return copies;
}
