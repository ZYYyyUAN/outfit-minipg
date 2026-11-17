const session=require('../../utils/session.js');
const {request}=require('../../utils/request.js');
const media=require('../../utils/media.js');
const state=require('../../utils/diary-state.js');
const calendar=require('../../utils/diary-calendar.js');
Page({
 data:{month:'',date:'',today:'',days:[],items:[],selected:null,previews:[],busy:false,error:'',week:['一','二','三','四','五','六','日']},
 onLoad(){this._sequence=0;this._show=0;},
 async onShow(){
  this._visible=true;const show=++this._show,epoch=session.snapshot().epoch;
  if(this._epoch!==epoch){this._default=true;this.setData({month:'',date:'',today:'',days:[],items:[],selected:null,previews:[],error:''});}
  if(!await session.guard()||!this._visible||show!==this._show)return;
  this._epoch=epoch;const n=++this._sequence,initial=this.data.date||calendar.today();
  this.setData({busy:true,error:'',date:initial,month:initial.slice(0,7),items:[],selected:null,previews:[],days:calendar.grid(initial.slice(0,7),[])});
  try{
   const clock=await request('/statistics',{data:{month:initial.slice(0,7)}});
   if(!this.current(n)||show!==this._show)return;
   const changed=this._revision!==state.current(),date=(changed&&state.selection())||(this._default?clock.asOf:this.data.date);
   this._default=false;this._revision=state.current();this.setData({today:clock.asOf,date,month:date.slice(0,7)});this.load();
  }catch(e){if(this.current(n))this.setData({busy:false,error:e.message});}
 },
 onHide(){this._visible=false;this._show++;this._sequence++;this.setData({previews:[]});},onUnload(){this.onHide();},
 current(n){return this._visible&&this._epoch===session.snapshot().epoch&&n===this._sequence;},
 async load(){const n=++this._sequence,initialMonth=this.data.month;let month=initialMonth;this.setData({busy:true,error:'',items:[],selected:null,previews:[],days:calendar.grid(month,[])});try{const data=await request('/diaries',{data:{month}});if(!this.current(n))return;this.setData({items:data.items,days:calendar.grid(month,data.items),selected:data.items.find(x=>x.wearDate===this.data.date)||null,busy:false});this.previews();}catch(e){if(this.current(n))this.setData({error:e.message,busy:false});}},
 retry(){this.onShow();},
 month(event){if(!this.data.today)return;const date=calendar.shift(this.data.date,Number(event.currentTarget.dataset.step));if(date<'1000-01-01'||date>'9999-12-31')return;this.setData({date,month:date.slice(0,7)});this.load();},
 now(){const date=this.data.today;this.setData({date,month:date.slice(0,7)});this.load();},
 select(event){const date=event.currentTarget.dataset.date;if(!date)return;this.setData({date,selected:this.data.items.find(x=>x.wearDate===date)||null});this.previews();},
 async previews(){const n=this._sequence,date=this.data.date,items=this.data.selected?.previewItems||[];this.setData({previews:items.map(i=>({...i,src:''}))});for(const item of items){try{const src=await media.download(item.imagePath);if(this.current(n)&&date===this.data.date)this.setData({previews:this.data.previews.map(i=>i.id===item.id?{...i,src}:i)});}catch(e){if(this.current(n)&&date===this.data.date)this.setData({previews:this.data.previews.map(i=>i.id===item.id?{...i,src:''}:i)});}}},
 open(){if(this.data.busy||this.data.error)return;if(this.data.selected)wx.navigateTo({url:'/pages/diary/detail/index?id='+this.data.selected.id});else if(this.data.date<=this.data.today)wx.navigateTo({url:'/pages/diary/edit/index?date='+this.data.date});}
});
