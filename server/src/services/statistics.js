import {monthRange,shanghaiDate} from '../utils/diary-input.js';
export function createStatisticsService(database,now=()=>new Date()){
  return {async get(userId,{month,page,pageSize}){
    const c=await database.getConnection();
    try{
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const asOf=shanghaiDate(now()),first=new Date(asOf+'T00:00:00Z');first.setUTCDate(first.getUTCDate()-29);const from=first.toISOString().slice(0,10),range=monthRange(month);
      const [categories]=await c.execute('SELECT k.id,k.name,COUNT(c.id) count FROM categories k LEFT JOIN clothes c ON c.category_id=k.id AND c.user_id=? AND c.is_archived=0 GROUP BY k.id,k.name,k.sort_order ORDER BY k.sort_order',[userId]);
      const [[days]]=await c.execute(`SELECT COUNT(*) count FROM diaries WHERE user_id=? AND wear_date>=? AND wear_date${range.operator}?`,[userId,range.start,range.end]);
      const [rows]=await c.execute('SELECT c.id,c.name,COUNT(d.id) wearCount,MAX(d.wear_date) lastWornDate,MAX(CASE WHEN d.wear_date>=? THEN 1 ELSE 0 END) recent FROM clothes c LEFT JOIN diary_items i ON i.clothing_id=c.id LEFT JOIN diaries d ON d.id=i.diary_id AND d.user_id=? AND d.wear_date<=? WHERE c.user_id=? AND c.is_archived=0 GROUP BY c.id,c.name ORDER BY c.id',[from,userId,asOf,userId]);
      const all=rows.map(r=>({id:r.id,name:r.name,wearCount:Number(r.wearCount),lastWornDate:r.lastWornDate})),unworn=rows.filter(r=>!r.recent).map(r=>({id:r.id,name:r.name,lastWornDate:r.lastWornDate}));
      const result={asOf,month,activeClothesCount:rows.length,categoryDistribution:categories.map(r=>({...r,count:Number(r.count)})),monthDiaryDays:Number(days.count),mostWorn:all.filter(r=>r.wearCount>0).sort((a,b)=>b.wearCount-a.wearCount||a.id-b.id).slice(0,5),notWornRecently:{page,pageSize,total:unworn.length,items:unworn.slice((page-1)*pageSize,page*pageSize)}};
      await c.commit();return result;
    }catch(e){await c.rollback();throw e;}finally{c.release();}
  }};
}
