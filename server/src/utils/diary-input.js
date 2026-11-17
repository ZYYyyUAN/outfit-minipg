import {invalid,BusinessError} from './business-error.js';
import {validateBody,text} from './input-validation.js';

export function dateInput(value,field='date'){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number(value.slice(0,4))<1000)throw invalid(field,'请填写1000～9999年的真实日期');
  const d=new Date(value+'T00:00:00Z');
  if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value)throw invalid(field,'日期不存在');
  return value;
}
export function monthInput(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}$/.test(value))throw invalid('month','请填写YYYY-MM月份');
  dateInput(value+'-01','month');return value;
}
export function monthRange(month){
  const start=month+'-01';
  if(month==='9999-12')return {start,end:'9999-12-31',operator:'<='};
  const d=new Date(start+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+1);
  return {start,end:d.toISOString().slice(0,10),operator:'<'};
}
export const shanghaiDate=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
export function diaryInput(body){
  validateBody(body,['wearDate','sourceOutfitId','clothingIds','occasion','mood','photoPath','note']);
  const wearDate=dateInput(body.wearDate,'wearDate'),occasion=text(body.occasion,'occasion',1,20),mood=body.mood===null?null:text(body.mood,'mood',1,12),note=text(body.note,'note',0,1000,true);
  if(body.sourceOutfitId!==null&&(!Number.isInteger(body.sourceOutfitId)||body.sourceOutfitId<1||body.sourceOutfitId>4294967295))throw invalid('sourceOutfitId','请填写有效搭配ID或null');
  if(body.photoPath!==null&&typeof body.photoPath!=='string')throw invalid('photoPath','请填写稳定图片路径或null');
  const ids=body.clothingIds;
  if(!Array.isArray(ids)||ids.some(id=>!Number.isInteger(id)||id<1||id>4294967295))throw invalid('clothingIds','请填写整数ID数组');
  if(ids.length<1||ids.length>20||new Set(ids).size!==ids.length)throw new BusinessError(400,'INVALID_SELECTION','请选择1～20件不重复衣物');
  return {wearDate,occasion,mood,note,sourceOutfitId:body.sourceOutfitId,photoPath:body.photoPath,clothingIds:[...ids]};
}
