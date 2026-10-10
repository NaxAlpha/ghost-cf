const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { withBindings } = require('../src/context.cjs');
const { persistentThemeStorage, restoreThemes } = require('../src/theme-storage.cjs');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ghost-cf-themes-'));
  const target = path.join(root, 'themes');
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'index.hbs'), '<h1>{{title}}</h1>');
  await fs.mkdir(path.join(source, 'assets'));
  await fs.writeFile(path.join(source, 'assets/binary.bin'), Buffer.from([0, 1, 255, 42]));
  const values = new Map();
  const objects = new Map();
  const transaction = {
    get: async (key) => values.get(key),
    put: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    delete: async (key) => {
      values.delete(key);
    },
  };
  const bindings = {
    DO_STORAGE: {
      ...transaction,
      transaction: async (callback) => callback(transaction),
      list: async ({ prefix }) => new Map([...values].filter(([key]) => key.startsWith(prefix))),
    },
    MEDIA: {
      put: async (key, bytes) => {
        objects.set(key, Buffer.from(bytes));
      },
      delete: async (keys) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
      },
      get: async (key) =>
        objects.has(key)
          ? { arrayBuffer: async () => Uint8Array.from(objects.get(key)).buffer }
          : null,
    },
  };
  class UpstreamStorage {
    getTargetDir() {
      return target;
    }
    _resolveAndValidateStoragePath(directory, name) {
      const result = path.resolve(directory, name || '');
      const relative = path.relative(target, result);
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))
        throw new Error('Invalid storage path');
      return result;
    }
  }
  const Storage = persistentThemeStorage(UpstreamStorage);
  return { root, target, source, values, objects, bindings, storage: new Storage() };
}

test('persists staged themes, atomic manifest renames, binary files, restoration, and deletion', async () => {
  const f = await fixture();
  try {
    await withBindings(f.bindings, async () => {
      await f.storage.save({ name: 'staging', path: f.source });
      const transaction = f.bindings.DO_STORAGE.transaction;
      f.bindings.DO_STORAGE.transaction = async () => {
        throw new Error('Simulated commit failure');
      };
      await assert.rejects(f.storage.rename('staging', 'uploaded'), /Simulated commit failure/);
      assert.equal(
        await fs.readFile(path.join(f.target, 'staging/index.hbs'), 'utf8'),
        '<h1>{{title}}</h1>',
      );
      assert.equal(f.values.has('ghost-cf:theme:staging'), true);
      await assert.rejects(fs.stat(path.join(f.target, 'uploaded')), { code: 'ENOENT' });
      f.bindings.DO_STORAGE.transaction = transaction;
      await f.storage.rename('staging', 'uploaded');
      assert.equal(f.values.has('ghost-cf:theme:staging'), false);
      assert.equal(f.values.has('ghost-cf:theme:uploaded'), true);
      await fs.rm(f.target, { recursive: true, force: true });
      await restoreThemes(f.target);
      assert.equal(
        await fs.readFile(path.join(f.target, 'uploaded/index.hbs'), 'utf8'),
        '<h1>{{title}}</h1>',
      );
      assert.deepEqual(
        await fs.readFile(path.join(f.target, 'uploaded/assets/binary.bin')),
        Buffer.from([0, 1, 255, 42]),
      );
      await f.storage.delete('uploaded');
      assert.equal(f.values.size, 0);
      assert.equal(f.objects.size, 0);
      await assert.rejects(f.storage.delete('../outside'), /Invalid storage path/);
    });
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('never exposes a partial theme and retains cleanup work after R2 failure', async () => {
  const f = await fixture();
  let calls = 0;
  const put = f.bindings.MEDIA.put;
  f.bindings.MEDIA.put = async (...args) => {
    if (++calls === 2) throw new Error('Simulated upload failure');
    return put(...args);
  };
  try {
    await withBindings(f.bindings, async () => {
      await assert.rejects(
        f.storage.save({ name: 'staging', path: f.source }),
        /Simulated upload failure/,
      );
      assert.equal(f.values.has('ghost-cf:theme:staging'), false);
      assert.equal(f.objects.size, 1);
      await restoreThemes(f.target);
      assert.equal(f.objects.size, 0);
      assert.equal(f.values.size, 0);
    });
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
