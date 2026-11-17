import {BusinessError,invalid} from '../utils/business-error.js';
import {validateImageReference} from '../utils/image-reference.js';
import {monthRange,shanghaiDate} from '../utils/diary-input.js';
import {utcSql} from './account.js';
import {utcIso} from './clothes.js';

export const dateConflict=e=>e.code==='ER_DUP_ENTRY'&&e.errno===1062&&/for key '(?:diaries\.)?uq_diaries_user_date'/.test(e.sqlMessage??'');
export function createDiaryService(database,config,now=()=>new Date(),fault=async()=>{}){
  const image=p=>p===null?null:config.publicBaseUrl+'/api/media/'+p.split('/').at(-1);
  async function transaction(work,userId,input){
    const c=await database.getConnection();
    try{await c.beginTransaction();const value=await work(c);await c.commit();return value;}
    catch(e){
      await c.rollback();
      if(input&&dateConflict(e)){
        const [rows]=await c.execute('SELECT id FROM diaries WHERE user_id=? AND wear_date=?',[userId,input.wearDate]);
        const error=new BusinessError(409,'DATE_OCCUPIED','该日期已有穿搭日记');error.details={wearDate:input.wearDate,existingDiaryId:rows[0].id};throw error;
      }
      throw e;
    }finally{c.release();}
  }
  async function owned(c,userId,id,lock=false){
    const [rows]=await c.execute('SELECT * FROM diaries WHERE id=? AND user_id=?'+(lock?' FOR UPDATE':''),[id,userId]);
    if(!rows.length)throw new BusinessError(404,'NOT_FOUND','日记不存在或无法访问');return rows[0];
  }
  async function detail(c,userId,id){
    const row=await owned(c,userId,id);
    const [items]=await c.execute('SELECT c.* FROM diary_items i JOIN clothes c ON c.id=i.clothing_id WHERE i.diary_id=? AND c.user_id=? ORDER BY i.sort_order',[id,userId]);
    const [sources]=row.source_outfit_id===null?[[]]:await c.execute('SELECT name,is_archived FROM outfits WHERE id=? AND user_id=?',[row.source_outfit_id,userId]);
    return {id:row.id,wearDate:row.wear_date,occasion:row.occasion,mood:row.mood,note:row.note,photoPath:row.photo_path,photoUrl:image(row.photo_path),sourceOutfitId:row.source_outfit_id,sourceOutfitName:sources[0]?.name??null,sourceOutfitArchived:Boolean(sources[0]?.is_archived),items:items.map(c=>({id:c.id,name:c.name,categoryId:c.category_id,color:c.color,season:c.season,imagePath:c.image_path,imageUrl:image(c.image_path),isArchived:Boolean(c.is_archived)})),createdAt:utcIso(row.created_at),updatedAt:utcIso(row.updated_at)};
  }
  async function selection(c,userId,input){
    if(input.wearDate>shanghaiDate(now()))throw invalid('wearDate','不能记录未来日期');
    const [items]=await c.execute(`SELECT id FROM clothes WHERE user_id=? AND id IN (${input.clothingIds.map(()=>'?').join(',')})`,[userId,...input.clothingIds]);
    if(items.length!==input.clothingIds.length)throw new BusinessError(400,'INVALID_SELECTION','请选择本人已有衣物');
    if(input.sourceOutfitId!==null){const [rows]=await c.execute('SELECT id FROM outfits WHERE id=? AND user_id=?',[input.sourceOutfitId,userId]);if(!rows.length)throw new BusinessError(404,'NOT_FOUND','来源搭配不存在或无法访问');}
    await validateImageReference(input.photoPath,userId,config.uploadRoot);
  }
  async function children(c,id,ids){for(const [i,clothingId]of ids.entries()){await c.execute('INSERT INTO diary_items (diary_id,clothing_id,sort_order) VALUES (?,?,?)',[id,clothingId,i+1]);await fault('item-inserted',c,id);}}
  return {
    list(userId,month){return transaction(async c=>{const range=monthRange(month);const [rows]=await c.execute(`SELECT id FROM diaries WHERE user_id=? AND wear_date>=? AND wear_date${range.operator}? ORDER BY wear_date`,[userId,range.start,range.end]);const items=[];for(const row of rows){const d=await detail(c,userId,row.id);items.push({id:d.id,wearDate:d.wearDate,occasion:d.occasion,mood:d.mood,clothingCount:d.items.length,photoUrl:d.photoUrl,previewItems:d.items.slice(0,3)});}return {month,items};});},
    byDate(userId,date){return transaction(async c=>{const [rows]=await c.execute('SELECT id FROM diaries WHERE user_id=? AND wear_date=?',[userId,date]);return rows.length?detail(c,userId,rows[0].id):null;});},
    detail(userId,id){return transaction(c=>detail(c,userId,id));},
    create(userId,input){return transaction(async c=>{await selection(c,userId,input);const time=utcSql(now());const [r]=await c.execute('INSERT INTO diaries (user_id,wear_date,source_outfit_id,occasion,mood,photo_path,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',[userId,input.wearDate,input.sourceOutfitId,input.occasion,input.mood,input.photoPath,input.note,time,time]);await fault('created',c,r.insertId);await children(c,r.insertId,input.clothingIds);return detail(c,userId,r.insertId);},userId,input);},
    update(userId,id,input){return transaction(async c=>{await owned(c,userId,id,true);await selection(c,userId,input);await c.execute('UPDATE diaries SET wear_date=?,source_outfit_id=?,occasion=?,mood=?,photo_path=?,note=?,updated_at=? WHERE id=? AND user_id=?',[input.wearDate,input.sourceOutfitId,input.occasion,input.mood,input.photoPath,input.note,utcSql(now()),id,userId]);await c.execute('DELETE FROM diary_items WHERE diary_id=?',[id]);await fault('updated',c,id);await children(c,id,input.clothingIds);return detail(c,userId,id);},userId,input);},
    remove(userId,id){return transaction(async c=>{await owned(c,userId,id,true);await c.execute('DELETE FROM diaries WHERE id=? AND user_id=?',[id,userId]);await fault('deleted',c,id);return {deletedId:id};});},
  };
}
