const session = require('./session.js');
const outfits = require('./outfit-state.js');
const listeners = new Set();
let epoch = -1, revision = 0;
function current() {
  if (epoch !== session.snapshot().epoch) { epoch = session.snapshot().epoch; revision = 0; }
  return revision;
}
function changed() { current(); revision++; outfits.changed(); for(const listener of listeners) listener(); }
function watch(listener) { listeners.add(listener); return ()=>listeners.delete(listener); }
module.exports = { current, changed, watch };
