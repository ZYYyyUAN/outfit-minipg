const session = require('../../../utils/session.js');
const { request } = require('../../../utils/request.js');
Page({
  data: { username: '', password: '', busy: false, restoring: true, restoreError: '', error: '', fields: {}, focusField: '' },
  async onShow() {
    this._active = true;
    await getApp().authReady;
    if (!this._active) return;
    if (session.snapshot().user) { wx.switchTab({ url: '/pages/wardrobe/index' }); return; }
    this.setData({ restoring: false, busy: false, restoreError: getApp().restoreError || '' });
  },
  onHide() { this._active = false; this._generation = (this._generation || 0) + 1; this.setData({ password: '' }); },
  onUnload() { this._active = false; this.setData({ password: '' }); },
  input(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value, error: '', fields: {} }); },
  async retry() { this.setData({ restoring: true }); await getApp().retryRestore(); this.onShow(); },
  register() { if (!this.data.busy) wx.navigateTo({ url: '/pages/auth/register/index' }); },
  async submit() {
    if (this.data.busy) return;
    const fields = {}, name = this.data.username.trim().toLowerCase();
    if (!/^[a-z0-9_]{4,20}$/.test(name)) fields.username = '请输入4～20位字母、数字或下划线';
    if (Array.from(this.data.password).length < 8 || Array.from(this.data.password).length > 64) fields.password = '密码为8～64个字符';
    if (Object.keys(fields).length) { this.setData({ fields, focusField: Object.keys(fields)[0], error: '请检查填写内容' }); return; }
    const epoch = session.snapshot().epoch, generation = this._generation || 0;
    const isCurrent = () => this._active && session.snapshot().epoch === epoch && generation === (this._generation || 0);
    this.setData({ busy: true, error: '', fields: {} });
    try {
      const login = await request('/auth/login', { method: 'POST', auth: false, data: { username: name, password: this.data.password } });
      if (!isCurrent()) return;
      session.adopt(login); this.setData({ password: '', busy: false }); wx.switchTab({ url: '/pages/wardrobe/index' });
    } catch (error) { if (isCurrent()) this.setData({ error: error.message, fields: error.fields || {}, focusField: Object.keys(error.fields || {})[0] || '' }); }
    finally { if (isCurrent()) this.setData({ busy: false }); }
  },
});
