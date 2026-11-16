import { BusinessError } from '../utils/business-error.js';
import { validateImageReference } from '../utils/image-reference.js';
import { utcSql } from './account.js';

export const seasonMatches = { 春:['春','春夏','春秋','四季'], 夏:['夏','春夏','四季'], 秋:['秋','春秋','秋冬','四季'], 冬:['冬','秋冬','四季'] };
export const literalLike = value => '%' + value.toLowerCase().replace(/[!%_]/g, char=>'!'+char) + '%';
export const shanghaiDate = date => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
export const utcIso = value => new Date(value.replace(' ','T')+'Z').toISOString();
const notFound = () => new BusinessError(404,'NOT_FOUND','衣物不存在或无法访问');

export function createClothesService(database, config, now = ()=>new Date()) {
  const imageUrl = value => value === null ? null : config.publicBaseUrl+'/api/media/'+value.split('/').at(-1);
  const summary = row => ({id:row.id,name:row.name,categoryId:row.category_id,color:row.color,season:row.season,imagePath:row.image_path,imageUrl:imageUrl(row.image_path),isArchived:Boolean(row.is_archived)});
  async function connectionWork(work, snapshot = false) {
    const connection = await database.getConnection();
    try {
      if (snapshot) await connection.query('START TRANSACTION READ ONLY');
      return await work(connection);
    } finally {
      if (snapshot) await connection.rollback();
      connection.release();
    }
  }
  async function owned(connection,userId,id) {
    const [rows] = await connection.execute('SELECT * FROM clothes WHERE id=? AND user_id=?',[id,userId]);
    if (!rows.length) throw notFound();
    return rows[0];
  }
  async function detailOn(connection,userId,id,asOf) {
    const row = await owned(connection,userId,id);
    const [[stats]] = await connection.execute('SELECT COUNT(*) wearCount,MAX(d.wear_date) lastWornDate FROM diary_items i JOIN diaries d ON d.id=i.diary_id WHERE i.clothing_id=? AND d.user_id=? AND d.wear_date<=?',[id,userId,asOf]);
    return {...summary(row),note:row.note,createdAt:utcIso(row.created_at),updatedAt:utcIso(row.updated_at),wearCount:Number(stats.wearCount),lastWornDate:stats.lastWornDate};
  }
  function scope(userId,archived) {
    return { sql:'user_id=?'+(archived==='all'?'':' AND is_archived=?'), values:archived==='all'?[userId]:[userId,archived==='archived'?1:0] };
  }
  return {
    async list(userId,input) {
      const where=scope(userId,input.archived);
      if(input.keyword) { where.sql+=" AND LOWER(name) LIKE ? ESCAPE '!'"; where.values.push(literalLike(input.keyword)); }
      for(const [field,column] of [['categoryId','category_id'],['color','color']]) if(input[field]!==undefined) { where.sql+=` AND ${column}=?`;where.values.push(input[field]); }
      if(input.season) { const values=seasonMatches[input.season];where.sql+=` AND season IN (${values.map(()=>'?').join(',')})`;where.values.push(...values); }
      return connectionWork(async connection=> {
        const [[count]]=await connection.execute('SELECT COUNT(*) total FROM clothes WHERE '+where.sql,where.values);
        const [rows]=await connection.execute(`SELECT * FROM clothes WHERE ${where.sql} ORDER BY id DESC LIMIT ${input.pageSize} OFFSET ${input.offset}`,where.values);
        return {items:rows.map(summary),page:input.page,pageSize:input.pageSize,total:Number(count.total)};
      },true);
    },
    async facets(userId,archived) {
      const where=scope(userId,archived);
      return connectionWork(async connection=> {
        const [rows]=await connection.execute('SELECT DISTINCT color FROM clothes WHERE '+where.sql+' ORDER BY color',where.values);
        return {colors:rows.map(row=>row.color)};
      });
    },
    async detail(userId,id) { const asOf=shanghaiDate(now());return connectionWork(connection=>detailOn(connection,userId,id,asOf),true); },
    async create(userId,input) {
      await validateImageReference(input.imagePath,userId,config.uploadRoot);
      const instant=now(), time=utcSql(instant);
      return connectionWork(async connection=> {
        const [result]=await connection.execute('INSERT INTO clothes (user_id,category_id,name,image_path,color,season,note,is_archived,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)',[userId,input.categoryId,input.name,input.imagePath,input.color,input.season,input.note,time,time]);
        return detailOn(connection,userId,result.insertId,shanghaiDate(instant));
      });
    },
    async update(userId,id,input) {
      const instant=now();
      return connectionWork(async connection=> {
        await owned(connection,userId,id);
        await validateImageReference(input.imagePath,userId,config.uploadRoot);
        await connection.execute('UPDATE clothes SET category_id=?,name=?,image_path=?,color=?,season=?,note=?,updated_at=? WHERE id=? AND user_id=?',[input.categoryId,input.name,input.imagePath,input.color,input.season,input.note,utcSql(instant),id,userId]);
        return detailOn(connection,userId,id,shanghaiDate(instant));
      });
    },
    async archive(userId,id,isArchived) {
      const instant=now();
      return connectionWork(async connection=> {
        const row=await owned(connection,userId,id);
        if(Boolean(row.is_archived)!==isArchived) await connection.execute('UPDATE clothes SET is_archived=?,updated_at=? WHERE id=? AND user_id=?',[isArchived?1:0,utcSql(instant),id,userId]);
        return detailOn(connection,userId,id,shanghaiDate(instant));
      });
    },
    async related(userId,id,kind,input) {
      const outfit=kind==='outfits', table=outfit?'outfits':'diaries', items=outfit?'outfit_items':'diary_items', parent=outfit?'outfit_id':'diary_id';
      return connectionWork(async connection=> {
        await owned(connection,userId,id);
        const where=`p.user_id=? AND EXISTS (SELECT 1 FROM ${items} target WHERE target.${parent}=p.id AND target.clothing_id=?)`;
        const [[count]]=await connection.execute(`SELECT COUNT(*) total FROM ${table} p WHERE ${where}`,[userId,id]);
        const [rows]=await connection.execute(`SELECT p.* FROM ${table} p WHERE ${where} ORDER BY ${outfit?'p.id DESC':'p.wear_date DESC,p.id DESC'} LIMIT ${input.pageSize} OFFSET ${input.offset}`,[userId,id]);
        const grouped=new Map(rows.map(row=>[row.id,[]]));
        if(rows.length) {
          const [children]=await connection.execute(`SELECT i.${parent} parentId,c.* FROM ${items} i JOIN clothes c ON c.id=i.clothing_id WHERE i.${parent} IN (${rows.map(()=>'?').join(',')}) AND c.user_id=? ORDER BY i.${parent},i.sort_order`,[...rows.map(row=>row.id),userId]);
          for(const row of children) grouped.get(row.parentId).push(summary(row));
        }
        return {items:rows.map(row=> {
          const all=grouped.get(row.id),common={id:row.id,occasion:row.occasion,clothingCount:all.length,previewItems:all.slice(0,outfit?4:3)};
          return outfit?{...common,name:row.name,isArchived:Boolean(row.is_archived)}:{...common,wearDate:row.wear_date,mood:row.mood,photoUrl:imageUrl(row.photo_path)};
        }),page:input.page,pageSize:input.pageSize,total:Number(count.total)};
      },true);
    },
  };
}
