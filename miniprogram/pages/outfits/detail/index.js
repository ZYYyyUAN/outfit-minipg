const session = require('../../../utils/session.js');
const { request } = require('../../../utils/request.js');
const media = require('../../../utils/media.js');
const outfits = require('../../../utils/outfit-state.js');
const initial = () => ({outfit:null,loading:true,error:'',notFound:false,acting:false});
Page({
  data: initial(),
  edit() { if(this.current(this._sequence) && this.data.outfit && !this.data.acting) wx.navigateTo({url:'/pages/outfits/edit/index?id='+this._id}); },
  onLoad(options) { this._id=options.id;this._sequence=0;this._show=0;this._scroll=0;this._images=new Map(); },
  async onShow() {
    this._visible=true;const show=++this._show;
    if(this._epoch!==session.snapshot().epoch) this.setData(initial());
    if(!await session.guard() || !this._visible || show!==this._show) return;
    if(this._archivePending && this._archiveEpoch===session.snapshot().epoch) {
      this.setData({acting:true});
      try { await this._archivePending; } catch(error) { this._revision=-1; }
    }
    if(!this._visible || show!==this._show) return;
    this.setData({acting:false});
    if(this._unwatch) this._unwatch();
    this._unwatch=outfits.watch(()=> { if(!this.current(this._sequence) || this._revision===outfits.current()) return; this._revision=outfits.current();this._scroll=0;this.load();wx.pageScrollTo({scrollTop:0,duration:0}); });
    const epoch=session.snapshot().epoch,revision=outfits.current();
    if(this._epoch!==epoch || this._revision!==revision || !this.data.outfit) {
      this._epoch=epoch;this._revision=revision;this._scroll=0;this.load();wx.pageScrollTo({scrollTop:0,duration:0});return;
    }
    this.refreshImages();wx.pageScrollTo({scrollTop:this._scroll,duration:0});
  },
  onHide() {
    if(this._unwatch) { this._unwatch();this._unwatch=null; }
    this._visible=false;this._show++;this._sequence++;this._images.clear();
    this.setData({acting:false,outfit:this.data.outfit?{...this.data.outfit,items:this.data.outfit.items.map(item=>({...item,src:''}))}:null});
  },
  onUnload() { this.onHide(); },
  onPageScroll(event) { this._scroll=event.scrollTop; },
  current(sequence) { return this._visible && this._epoch===session.snapshot().epoch && sequence===this._sequence; },
  async load() {
    const sequence=++this._sequence;this._images.clear();this.setData(initial());
    try {
      const value=await request('/outfits/'+this._id);
      if(!this.current(sequence)) return;
      this.setData({outfit:{...value,items:value.items.map(item=>({...item,src:'',imageState:'loading'}))},loading:false});this.refreshImages();
    } catch(error) { if(this.current(sequence)) this.setData({loading:false,error:error.httpStatus===404?'搭配不存在或无法访问':error.message,notFound:error.httpStatus===404}); }
  },
  refreshImages() { for(const item of this.data.outfit.items) if(!item.src) this.readImage(item.id,item.imagePath); },
  async readImage(id,imagePath) {
    const sequence=this._sequence,attempt={};this._images.set(id,attempt);
    const update=patch=> {
      if(!this.current(sequence) || this._images.get(id)!==attempt) return;
      const i=this.data.outfit.items.findIndex(item=>item.id===id && item.imagePath===imagePath);
      if(i>=0) this.setData({[`outfit.items[${i}]`]:{...this.data.outfit.items[i],...patch}});
    };
    update({imageState:'loading'});
    try { update({src:await media.download(imagePath),imageState:'ready'}); }
    catch(error) { update({src:'',imageState:'failed'}); }
  },
  retryImage(event) { const item=this.data.outfit.items.find(item=>item.id===Number(event.currentTarget.dataset.id));this.readImage(item.id,item.imagePath); },
  imageFailed(event) {
    if(!this.current(this._sequence)) return;
    const i=this.data.outfit.items.findIndex(item=>item.id===Number(event.currentTarget.dataset.id));
    if(i>=0 && this.data.outfit.items[i].src===event.currentTarget.dataset.src) this.setData({[`outfit.items[${i}].src`]:'',[`outfit.items[${i}].imageState`]:'failed'});
  },
  clothing(event) { if(this.current(this._sequence)) wx.navigateTo({url:'/pages/clothes/detail/index?id='+event.currentTarget.dataset.id}); },
  archive() {
    if(this.data.acting || !this.data.outfit || !this.current(this._sequence)) return;
    const target=!this.data.outfit.isArchived,sequence=this._sequence,epoch=this._epoch;
    this.setData({acting:true});
    wx.showModal({title:target?'归档这套搭配？':'恢复这套搭配？',content:target?'归档后不在默认列表显示，组合与已有穿着记录会保留。':'恢复后会重新显示在在用搭配中。',confirmText:target?'归档':'恢复',success:async result=> {
      if(!this.current(sequence)) return;
      if(!result.confirm) { this.setData({acting:false});return; }
      this.setData({error:''});
      let pending;
      try {
        pending=request('/outfits/'+this._id+'/archive',{method:'PATCH',data:{isArchived:target}});
        // 返回同一详情时等待本次写入结算，避免读取归档前的数据。
        this._archiveEpoch=epoch;this._archivePending=pending;
        const value=await pending;
        // 同一会话的已提交写入仍使后台列表失效；离页后不更新详情或弹反馈。
        if(epoch!==session.snapshot().epoch) return;
        if(this.current(sequence)) this._revision=outfits.current()+1;
        outfits.changed();
        if(!this.current(sequence)) return;
        this._revision=outfits.current();
        this._sequence++;this._images.clear();
        this.setData({outfit:{...value,items:value.items.map(item=>({...item,src:'',imageState:'loading'}))},acting:false});this.refreshImages();
        wx.showToast({title:target?'已归档':'已恢复',icon:'success'});
      } catch(error) { if(this.current(sequence)) this.setData({acting:false,error:error.message}); }
      finally { if(this._archivePending===pending) this._archivePending=null; }
    },fail:()=> { if(this.current(sequence)) this.setData({acting:false}); }});
  },
  recordWear() {
    if(!this.current(this._sequence) || !this.data.outfit || this.data.acting) return;
    const {id,name}=this.data.outfit,source={sourceOutfitId:id};
    wx.showModal({title:'记录穿着入口',content:`来源搭配：${name}（sourceOutfitId=${source.sourceOutfitId}）。尚未生成穿着记录。日记功能将在阶段6开放。`,showCancel:false,confirmText:'知道了'});
    return source;
  },
  back() { if(getCurrentPages().length>1) wx.navigateBack({delta:1});else wx.switchTab({url:'/pages/outfits/index'}); },
});
