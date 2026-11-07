const { request } = require('../../../utils/request.js');
Page({
  data: { username: '', nickname: '', password: '', confirmation: '', nicknameCount: 0, busy: false, error: '', fields: {}, focusField: '' },
  onShow() { this._active = true; },
  onHide() { this._active = false; this.setData({ password: '', confirmation: '' }); },
  onUnload() { this._active = false; this.setData({ password: '', confirmation: '' }); },
  input(e) {
    const field = e.currentTarget.dataset.field, value = e.detail.value;
    this.setData({ [field]: value, ...(field === 'nickname' ? { nicknameCount: Array.from(value.trim()).length } : {}), error: '', fields: {} });
  },
  async submit() {
    if (this.data.busy) return;
    const fields = {}, name = this.data.username.trim().toLowerCase(), nick = this.data.nickname.trim();
    if (!/^[a-z0-9_]{4,20}$/.test(name)) fields.username = '用户名为4～20位字母、数字或下划线';
    if (!nick || Array.from(nick).length > 20 || /[\r\n\u2028\u2029]/.test(this.data.nickname)) fields.nickname = '昵称为1～20个字符，不能换行';
    if (Array.from(this.data.password).length < 8 || Array.from(this.data.password).length > 64) fields.password = '密码为8～64个字符';
    if (this.data.confirmation !== this.data.password) fields.confirmation = '两次密码不一致';
    if (Object.keys(fields).length) { this.setData({ fields, error: '请检查填写内容', focusField: Object.keys(fields)[0] }); return; }
    this.setData({ busy: true, fields: {}, error: '' });
    try {
      const user = await request('/auth/register', { method: 'POST', auth: false, data: { username: name, password: this.data.password, nickname: nick } });
      if (!this._active) return;
      this.setData({ password: '', confirmation: '' });
      const pages = getCurrentPages(); pages[pages.length - 2].setData({ username: user.username, error: '注册成功，请登录' });
      wx.navigateBack();
    } catch (error) { if (this._active) this.setData({ error: error.message, fields: error.fields || {}, focusField: Object.keys(error.fields || {})[0] || '' }); }
    finally { if (this._active) this.setData({ busy: false }); }
  },
});
