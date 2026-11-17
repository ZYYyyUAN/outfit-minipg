function today(){const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');}
function days(month){return new Date(Number(month.slice(0,4)),Number(month.slice(5)),0).getDate();}
function shift(date,step){const d=new Date(date.slice(0,7)+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+step);const month=d.toISOString().slice(0,7);return month+'-'+String(Math.min(Number(date.slice(8)),days(month))).padStart(2,'0');}
function grid(month,items){const first=new Date(month+'-01T00:00:00Z'),offset=(first.getUTCDay()+6)%7,marked=new Set(items.map(x=>x.wearDate));return [...Array(offset).fill(null),...Array.from({length:days(month)},(_,i)=>{const date=month+'-'+String(i+1).padStart(2,'0');return {day:i+1,date,marked:marked.has(date)};})];}
module.exports={today,days,shift,grid};
