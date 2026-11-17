const session = require('../../utils/session.js');
const { request } = require('../../utils/request.js');
const media = require('../../utils/media.js');
const clean = item => ({...item,src:'',imageState:'loading'});
Component({
  properties:{selected:{type:Array,value:[]},epoch:{type:Number,value:-1}},
  data:{open:false,items:[],chosen:[],selectedIds:[],page:0,total:0,busy:false,error:'',keywordDraft:'',keyword:'',categoryId:'',color:'',season:'',archived:'active',categories:[],colors:[],optionError:'',scopes:[{id:'active',name:'在用'},{id:'archived',name:'已归档'},{id:'all',name:'全部'}],seasons:['春','夏','秋','冬']},
  lifetimes:{detached(){this.closeState();}},
  pageLifetimes:{hide(){this.closeState();}},
  methods:{
    valid(generation=this._generation){return this.data.open && this._epoch===session.snapshot().epoch && generation===this._generation;},
    open(){
      if(this.properties.epoch!==session.snapshot().epoch) return;
      this._epoch=this.properties.epoch;this._generation=(this._generation||0)+1;this._query=0;this._options=0;this._images=new Map();
      const chosen=this.properties.selected.map(clean);
      this.setData({open:true,chosen,selectedIds:chosen.map(item=>item.id),items:[],page:0,total:0,busy:false,error:'',keywordDraft:'',keyword:'',categoryId:'',color:'',season:'',archived:'active',categories:[],colors:[],optionError:''});
      this.options();this.load(false);this.refreshImages();
    },
    closeState(){this._generation=(this._generation||0)+1;this._query++;this._options++;this.setData({open:false,items:[],chosen:[],selectedIds:[],busy:false});},
    cancel(){if(!this.valid())return;this.closeState();this.triggerEvent('cancel');},
    confirm(){if(!this.valid())return;const items=this.data.chosen.map(clean);this.closeState();this.triggerEvent('confirm',{items,epoch:this._epoch});},
    stop(){},
    async options(){
      const generation=this._generation,sequence=++this._options,archived=this.data.archived;
      this.setData({optionError:''});
      try {const [categories,facets]=await Promise.all([request('/categories'),request('/clothes/facets',{data:{archived}})]);if(this.valid(generation)&&sequence===this._options)this.setData({categories:categories.items,colors:facets.colors});}
      catch(error){if(this.valid(generation)&&sequence===this._options)this.setData({optionError:error.message});}
    },
    reload(){this._query++;this._images.clear();this.setData({items:[],page:0,total:0,busy:false,error:''});this.refreshImages();this.load(false);},
    async load(append){
      if(!this.valid()||this.data.busy)return;
      const generation=this._generation,query=++this._query,page=append?this.data.page+1:1;
      const data={page,pageSize:12,archived:this.data.archived};
      for(const key of ['keyword','categoryId','color','season'])if(this.data[key])data[key]=this.data[key];
      this.setData({busy:true,error:''});
      try {const value=await request('/clothes',{data});if(!this.valid(generation)||query!==this._query)return;
        const current=new Map([...this.data.items,...this.data.chosen].map(item=>[item.id,item]));
        const items=value.items.map(item=>({...clean(item),...(current.get(item.id)?.imagePath===item.imagePath?{src:current.get(item.id).src,imageState:current.get(item.id).imageState}:{}),selected:this.data.selectedIds.includes(item.id)})),byId=new Map(items.map(item=>[item.id,item]));
        this.setData({items:append?[...this.data.items,...items]:items,page:value.page,total:value.total,busy:false,chosen:this.data.chosen.map(item=>byId.get(item.id)||item)});this.refreshImages();
      }catch(error){if(this.valid(generation)&&query===this._query)this.setData({busy:false,error:error.message});}
    },
    more(){if(this.data.page&&this.data.items.length<this.data.total)this.load(true);},
    retry(){this.load(Boolean(this.data.page));},
    input(event){this.setData({keywordDraft:event.detail.value});},
    search(){const keyword=this.data.keywordDraft.trim();if(Array.from(keyword).length>40){this.setData({error:'搜索名称不能超过40个字符'});return;}this.setData({keyword});this.reload();},
    filter(event){if(!this.valid())return;const {field,value}=event.currentTarget.dataset;this.setData({[field]:value});if(field==='archived')this.options();this.reload();},
    reset(){this.setData({keyword:'',keywordDraft:'',categoryId:'',color:'',season:'',archived:'active'});this.options();this.reload();},
    toggle(event){
      if(!this.valid())return;const id=Number(event.currentTarget.dataset.id),chosen=[...this.data.chosen],index=chosen.findIndex(item=>item.id===id);
      if(index>=0)chosen.splice(index,1);
      else {if(chosen.length===20){this.setData({error:'最多选择20件，仍可取消已选衣物'});return;}chosen.push({...this.data.items.find(item=>item.id===id)});}
      this.setData({chosen,items:this.data.items.map(item=>({...item,selected:chosen.some(row=>row.id===item.id)})),selectedIds:chosen.map(item=>item.id),error:''});this.refreshImages();
    },
    move(event){
      if(!this.valid())return;const {index,step}=event.currentTarget.dataset,from=Number(index),to=from+Number(step),chosen=[...this.data.chosen];
      if(to<0||to>=chosen.length)return;[chosen[from],chosen[to]]=[chosen[to],chosen[from]];this.setData({chosen});
    },
    remove(event){if(!this.valid())return;const chosen=this.data.chosen.filter(item=>item.id!==Number(event.currentTarget.dataset.id));this.setData({chosen,items:this.data.items.map(item=>({...item,selected:chosen.some(row=>row.id===item.id)})),selectedIds:chosen.map(item=>item.id)});},
    refreshImages(){const items=new Map([...this.data.items,...this.data.chosen].map(item=>[item.id,item]));for(const item of items.values())if(!item.src&&item.imageState!=='failed'&&!this._images.has(item.id))this.readImage(item);},
    async readImage(item){
      const generation=this._generation,attempt={};this._images.set(item.id,attempt);
      const update=patch=>{if(!this.valid(generation)||this._images.get(item.id)!==attempt)return;for(const key of ['items','chosen'])this.setData({[key]:this.data[key].map(row=>row.id===item.id&&row.imagePath===item.imagePath?{...row,...patch}:row)});};
      update({imageState:'loading'});
      try{update({src:await media.download(item.imagePath),imageState:'ready'});}catch(error){update({src:'',imageState:'failed'});}
    },
    retryImage(event){if(!this.valid())return;const item=[...this.data.items,...this.data.chosen].find(row=>row.id===Number(event.currentTarget.dataset.id));this.readImage(item);},
    imageFailed(event){if(!this.valid())return;const {id,src}=event.currentTarget.dataset;for(const key of ['items','chosen'])this.setData({[key]:this.data[key].map(item=>item.id===Number(id)&&item.src===src?{...item,src:'',imageState:'failed'}:item)});},
  }
});
