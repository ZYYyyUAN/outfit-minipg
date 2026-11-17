const session=require('../../utils/session.js');
const {request}=require('../../utils/request.js');
const calendar=require('../../utils/diary-calendar.js');
Page({
 data:{month:'',page:1,value:null,from:'',busy:false,error:''},
 onLoad(){this._sequence=0;},
 async onShow(){this._visible=true;const epoch=session.snapshot().epoch;if(this._epoch!==epoch)this.setData({month:calendar.today().slice(0,7),page:1,value:null,error:''});if(!await session.guard()||!this._visible)return;this._epoch=epoch;this.load();},
 onHide(){this._visible=false;this._sequence++;},onUnload(){this.onHide();},
 async load(){const n=++this._sequence,epoch=this._epoch;this.setData({busy:true,error:''});try{const value=await request('/statistics',{data:{month:this.data.month,notWornPage:this.data.page}});if(!this._visible||n!==this._sequence||epoch!==session.snapshot().epoch)return;const first=new Date(value.asOf+'T00:00:00Z');first.setUTCDate(first.getUTCDate()-29);this.setData({value,from:first.toISOString().slice(0,10),busy:false});}catch(e){if(this._visible&&n===this._sequence&&epoch===session.snapshot().epoch)this.setData({busy:false,error:e.message,value:null});}},
 month(event){this.setData({month:event.detail.value});this.load();},
 page(event){if(this.data.busy)return;this.setData({page:this.data.page+Number(event.currentTarget.dataset.step)});this.load();},
 clothing(event){wx.navigateTo({url:'/pages/clothes/detail/index?id='+event.currentTarget.dataset.id});}
});
