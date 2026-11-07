const session = require('../../utils/session.js');
Page({ onShow() { session.guard(); } });
