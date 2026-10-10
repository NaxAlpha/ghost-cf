const path = require('node:path');
const assert = require('node:assert/strict');
const { R2Storage } = require('../src/r2-storage.cjs');

const root = process.env.GHOST_RELEASE_DIR;
if (!root) throw new Error('Set GHOST_RELEASE_DIR to the installed official Ghost release');
const { AdapterManager } = require(
  path.join(path.resolve(root), 'core/server/services/adapter-manager/adapter-manager.js'),
);
const { StorageBase } = require(
  path.join(path.resolve(root), 'node_modules/ghost-storage-base/build/index.js'),
);
const adapters = {
  storage: {
    active: 'R2Storage',
    R2Storage: { siteUrl: 'https://blog.example' },
    images: {
      adapter: 'R2Storage',
      staticFileURLPrefix: '/content/images/',
      siteUrl: 'https://blog.example',
    },
    media: {
      adapter: 'R2Storage',
      staticFileURLPrefix: '/content/media/',
      siteUrl: 'https://blog.example',
    },
    files: {
      adapter: 'R2Storage',
      staticFileURLPrefix: '/content/files/',
      siteUrl: 'https://blog.example',
    },
  },
};
const manager = new AdapterManager({
  config: {
    get(key) {
      return key === 'adapters' ? adapters : undefined;
    },
    getContentPath(name) {
      return `/tmp/ghost/content/${name}`;
    },
  },
  baseClasses: { storage: StorageBase },
  pathsToAdapters: ['/platform/adapters'],
  loadAdapterFromPath(filename) {
    assert.equal(filename, '/platform/adapters/storage/R2Storage');
    return require('../src/r2-storage.cjs');
  },
});
manager.init();
for (const feature of ['images', 'media', 'files']) {
  const adapter = manager.getAdapter(`storage:${feature}`);
  assert.ok(adapter instanceof R2Storage);
  assert.equal(adapter.url('test.bin'), `/content/${feature}/test.bin`);
  assert.strictEqual(manager.getAdapter(`storage:${feature}`), adapter);
}
assert.notStrictEqual(manager.getAdapter('storage:images'), manager.getAdapter('storage:media'));
console.log('Ghost adapter manager accepted and isolated all three R2 storage variants.');
