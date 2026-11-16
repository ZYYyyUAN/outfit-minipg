const session = require('./session.js');
let epoch = -1, revision = 0;
function current() {
  if (epoch !== session.snapshot().epoch) { epoch = session.snapshot().epoch; revision = 0; }
  return revision;
}
function changed() { current(); revision++; }
module.exports = { current, changed };
