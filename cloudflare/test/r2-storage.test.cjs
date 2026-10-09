const { test } = require('node:test');
const assert = require('node:assert/strict');
const { R2Storage, safePath } = require('../src/r2-storage.cjs');
const { withBindings } = require('../src/context.cjs');

test('rejects traversal, foreign URLs, invalid prefixes, and encoded traversal', () => {
  const storage = new R2Storage({ siteUrl: 'https://blog.example' });
  for (const input of ['../secret', '2026/../secret', 'a\\b', 'a//b', 'a\0b']) {
    assert.throws(() => safePath(input));
  }
  assert.throws(() => storage.urlToPath('https://evil.example/content/images/a.jpg'));
  assert.throws(() => storage.urlToPath('/content/files/a.jpg'));
  assert.throws(() => storage.urlToPath('/content/images/a%2F..%2Fb.jpg'));
  assert.equal(storage.urlToPath('/content/images/2026/10/test.jpg'), '2026/10/test.jpg');
});

test('round-trips raw bytes through the R2 binding and deletes only its prefixed key', async () => {
  const objects = new Map();
  const MEDIA = {
    async put(key, value) {
      objects.set(key, Buffer.from(value));
    },
    async head(key) {
      return objects.has(key) ? {} : null;
    },
    async get(key) {
      const value = objects.get(key);
      return value
        ? {
            arrayBuffer: async () =>
              value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
          }
        : null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  const storage = new R2Storage();
  await withBindings({ MEDIA }, async () => {
    assert.equal(
      await storage.saveRaw(Buffer.from('media'), '2026/10/file.txt'),
      '/content/images/2026/10/file.txt',
    );
    assert.equal(await storage.exists('file.txt', '2026/10'), true);
    assert.equal((await storage.read({ path: '2026/10/file.txt' })).toString(), 'media');
    await storage.delete('file.txt', '2026/10');
    assert.equal(await storage.exists('2026/10/file.txt'), false);
    await assert.rejects(storage.read({ path: '2026/10/file.txt' }), { code: 'ENOENT' });
  });
});
