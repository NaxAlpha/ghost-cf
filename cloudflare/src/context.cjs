const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

function withBindings(bindings, callback) {
  return storage.run(bindings, callback);
}

function getBindings() {
  const bindings = storage.getStore();
  if (!bindings) {
    throw new Error('Cloudflare bindings must be accessed inside a request or scheduled handler');
  }
  return bindings;
}

module.exports = { withBindings, getBindings };
