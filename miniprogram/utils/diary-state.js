const session=require('./session.js');
const wardrobe=require('./wardrobe-state.js');
let epoch=-1,revision=0,selectedDate=null;
function current(){if(epoch!==session.snapshot().epoch){epoch=session.snapshot().epoch;revision=0;selectedDate=null;}return revision;}
function changed(date){current();revision++;selectedDate=date;wardrobe.changed();}
function selection(){current();return selectedDate;}
module.exports={current,changed,selection};
