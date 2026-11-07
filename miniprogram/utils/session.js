const key = 'personal-wardrobe.auth.v1';
let token = null, expiresAt = null, user = null, epoch = 0, navigating = false;
function snapshot() { return { token, expiresAt, user, epoch }; }
function restore() {
  const saved = wx.getStorageSync(key);
  if (saved && typeof saved.token === 'string' && typeof saved.expiresAt === 'string') { token = saved.token; expiresAt = saved.expiresAt; }
  return snapshot();
}
function adopt(login) { epoch++; token = login.token; expiresAt = login.expiresAt; user = login.user; wx.setStorageSync(key, { token, expiresAt }); }
function setUser(value) { user = value; }
function clear() { epoch++; token = null; expiresAt = null; user = null; wx.removeStorageSync(key); }
function showLogin() {
  if (navigating) return;
  navigating = true;
  wx.reLaunch({ url: '/pages/auth/login/index', complete: () => { navigating = false; } });
}
async function guard() { await getApp().authReady; if (!token || !user) { showLogin(); return false; } return true; }
module.exports = { snapshot, restore, adopt, setUser, clear, showLogin, guard };
