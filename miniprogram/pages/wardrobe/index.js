const session = require('../../utils/session.js');
const { request } = require('../../utils/request.js');
const media = require('../../utils/media.js');
const wardrobe = require('../../utils/wardrobe-state.js');
const initial = () => ({ items: [], total: 0, page: 0, busy: false, error: '', keywordDraft: '', keyword: '', categoryId: '', color: '', season: '', archived: 'active', categories: [], colors: [], categoryError: '', facetError: '', panel: false, draftColor: '', draftSeason: '', scopes: [{id:'active',name:'在用'},{id:'archived',name:'已归档'},{id:'all',name:'全部'}], seasons: ['春','夏','秋','冬'] });
Page({
  data: initial(),
  onLoad() { this._generation = 0; this._optionsGeneration = 0; this._scroll = 0; },
  async onShow() {
    this._visible = true;
    if (!await session.guard() || !this._visible) return;
    const epoch = session.snapshot().epoch, revision = wardrobe.current();
    if (this._epoch !== epoch) {
      this._epoch = epoch; this._revision = revision; this._scroll = 0; this.setData(initial());
      this.loadCategories(); this.loadFacets(); this.reload(); return;
    }
    if (this._revision !== revision) { this._revision = revision; this.loadFacets(); this.reload(); return; }
    if (!this.data.page) this.load(false);
    else { this.refreshImages(); wx.pageScrollTo({scrollTop:this._scroll,duration:0}); }
    if (!this.data.categories.length) this.loadCategories();
    if (this.data.facetError) this.loadFacets();
  },
  onHide() {
    this._visible = false; this._generation++; this._optionsGeneration++;
    this.setData({ busy: false, items: this.data.items.map(item=>({...item,src:''})) });
  },
  onPageScroll(event) { this._scroll = event.scrollTop; },
  onReachBottom() { this.more(); },
  async loadCategories() {
    const epoch = this._epoch;
    try { const value = await request('/categories'); if (this._visible && epoch === session.snapshot().epoch) this.setData({categories:value.items,categoryError:''}); }
    catch(error) { if(this._visible && epoch===session.snapshot().epoch) this.setData({categoryError:error.message}); }
  },
  async loadFacets() {
    const epoch=this._epoch, sequence=++this._optionsGeneration, archived=this.data.archived;
    try { const value=await request('/clothes/facets',{data:{archived}}); if(this._visible && epoch===session.snapshot().epoch && sequence===this._optionsGeneration) this.setData({colors:value.colors,facetError:''}); }
    catch(error) { if(this._visible && epoch===session.snapshot().epoch && sequence===this._optionsGeneration) this.setData({facetError:error.message}); }
  },
  reload() {
    this._generation++; this._scroll=0; this.setData({items:[],page:0,total:0,busy:false,error:''});
    wx.pageScrollTo({scrollTop:0,duration:0}); this.load(false);
  },
  async load(append) {
    if(this.data.busy || !this._visible) return;
    const generation=++this._generation, epoch=this._epoch, page=append?this.data.page+1:1;
    const data={page,pageSize:12,archived:this.data.archived};
    for(const key of ['keyword','categoryId','color','season']) if(this.data[key]) data[key]=this.data[key];
    this.setData({busy:true,error:''});
    try {
      const result=await request('/clothes',{data});
      if(!this._visible || generation!==this._generation || epoch!==session.snapshot().epoch) return;
      const items=result.items.map(item=>({...item,src:'',imageState:'loading'}));
      this.setData({items:append?[...this.data.items,...items]:items,page:result.page,total:result.total,busy:false});
      this.refreshImages();
    } catch(error) { if(this._visible && generation===this._generation && epoch===session.snapshot().epoch) this.setData({busy:false,error:error.message}); }
  },
  more() { if(this.data.page && this.data.items.length < this.data.total) this.load(true); },
  retry() { this.load(Boolean(this.data.page)); },
  refreshImages() { for(const item of this.data.items) if(!item.src) this.readImage(item.id,item.imagePath); },
  async readImage(id,imagePath) {
    const epoch=this._epoch,generation=this._generation;
    const update=patch=> {
      if(!this._visible || epoch!==session.snapshot().epoch || generation!==this._generation) return;
      const index=this.data.items.findIndex(item=>item.id===id && item.imagePath===imagePath);
      if(index>=0) this.setData({[`items[${index}]`]:{...this.data.items[index],...patch}});
    };
    update({imageState:'loading'});
    try { update({src:await media.download(imagePath),imageState:'ready'}); }
    catch(error) { update({src:'',imageState:'failed'}); }
  },
  retryImage(event) { const item=this.data.items.find(row=>row.id===Number(event.currentTarget.dataset.id)); if(item) this.readImage(item.id,item.imagePath); },
  imageError(event) { const index=this.data.items.findIndex(row=>row.id===Number(event.currentTarget.dataset.id)); if(index>=0) this.setData({[`items[${index}].src`]:'',[`items[${index}].imageState`]:'failed'}); },
  keywordInput(event) { this.setData({keywordDraft:event.detail.value}); },
  search() {
    const keyword=this.data.keywordDraft.trim();
    if(Array.from(keyword).length>40) { this.setData({error:'搜索名称不能超过40个字符'}); return; }
    this.setData({keyword}); this.reload();
  },
  clearSearch() { this.setData({keyword:'',keywordDraft:''}); this.reload(); },
  category(event) { this.setData({categoryId:event.currentTarget.dataset.id}); this.reload(); },
  scope(event) { this.setData({archived:event.currentTarget.dataset.id}); this.loadFacets(); this.reload(); },
  openPanel() { this.setData({panel:true,draftColor:this.data.color,draftSeason:this.data.season}); },
  closePanel() { this.setData({panel:false}); },
  chooseColor(event) { this.setData({draftColor:event.currentTarget.dataset.value}); },
  chooseSeason(event) { this.setData({draftSeason:event.currentTarget.dataset.value}); },
  resetPanel() { this.setData({draftColor:'',draftSeason:''}); },
  applyPanel() { this.setData({color:this.data.draftColor,season:this.data.draftSeason,panel:false}); this.reload(); },
  clearFilters() { this.setData({keyword:'',keywordDraft:'',categoryId:'',color:'',season:''}); this.reload(); },
  create() { wx.navigateTo({url:'/pages/clothes/edit/index'}); },
  detail(event) { wx.navigateTo({url:'/pages/clothes/detail/index?id='+event.currentTarget.dataset.id}); },
});
