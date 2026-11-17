const session = require('./session.js');
let epoch = -1, revision = 0;
const listeners = new Set();
function current() {
  if (epoch !== session.snapshot().epoch) { epoch = session.snapshot().epoch; revision = 0; }
  return revision;
}
function changed() { current(); revision++;for(const listener of listeners) listener(); }
function watch(listener) { listeners.add(listener);return ()=>listeners.delete(listener); }
module.exports = { current, changed, watch };
