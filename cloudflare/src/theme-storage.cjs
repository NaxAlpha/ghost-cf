const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getBindings } = require('./context.cjs');
const { safePath } = require('./r2-storage.cjs');

const PREFIX = 'ghost-cf:theme:';
const GARBAGE = 'ghost-cf:theme-garbage:';
function nameKey(name) {
  const safe = safePath(name);
  if (safe.includes('/')) throw new Error('Invalid theme directory name');
  return PREFIX + safe;
}
async function collect(directory, relative = '') {
  const files = [];
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const filename = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(directory, filename)));
    else if (entry.isFile()) files.push(safePath(filename));
    else throw new Error('Theme persistence rejects symbolic links and special files');
  }
  return files;
}
async function copyTheme(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const filename of await collect(source)) {
    const target = path.join(destination, filename);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await fs.readFile(path.join(source, filename)));
  }
}
async function cleanupGarbage() {
  const { DO_STORAGE, MEDIA } = getBindings();
  for (const [key, files] of await DO_STORAGE.list({ prefix: GARBAGE })) {
    for (let offset = 0; offset < files.length; offset += 1000) {
      await MEDIA.delete(files.slice(offset, offset + 1000));
    }
    await DO_STORAGE.delete(key);
  }
}
async function restoreThemes(directory = '/tmp/ghost/content/themes') {
  const { DO_STORAGE, MEDIA } = getBindings();
  await cleanupGarbage();
  for (const [key, manifest] of await DO_STORAGE.list({ prefix: PREFIX })) {
    const name = key.slice(PREFIX.length);
    nameKey(name);
    const target = path.join(directory, name);
    await fs.rm(target, { recursive: true, force: true });
    for (const file of manifest.files) {
      const relative = safePath(file.path);
      const object = await MEDIA.get(file.key);
      if (!object) throw new Error(`Persistent theme file is missing: ${name}/${relative}`);
      const filename = path.join(target, relative);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, Buffer.from(await object.arrayBuffer()));
    }
  }
}
function persistentThemeStorage(UpstreamThemeStorage) {
  return class PersistentThemeStorage extends UpstreamThemeStorage {
    async save(file, targetDir) {
      const key = nameKey(file.name);
      const base = targetDir
        ? this._resolveAndValidateStoragePath(targetDir, undefined, true)
        : this.getTargetDir();
      const directory = this._resolveAndValidateStoragePath(base, file.name);
      await copyTheme(file.path, directory);
      const result = directory;
      const revision = randomUUID();
      const manifest = { revision, files: [] };
      const { DO_STORAGE, MEDIA } = getBindings();
      try {
        for (const filename of await collect(directory)) {
          const objectKey = `ghost-cf/themes/${revision}/${filename}`;
          const bytes = await fs.readFile(path.join(directory, filename));
          manifest.files.push({ path: filename, key: objectKey });
          await MEDIA.put(objectKey, bytes);
        }
        await DO_STORAGE.transaction(async (transaction) => {
          const previous = await transaction.get(key);
          if (previous)
            await transaction.put(
              GARBAGE + previous.revision,
              previous.files.map((file) => file.key),
            );
          await transaction.put(key, manifest);
        });
      } catch (error) {
        if (manifest.files.length)
          await DO_STORAGE.put(
            GARBAGE + revision,
            manifest.files.map((file) => file.key),
          );
        throw error;
      }
      await cleanupGarbage();
      return result;
    }
    async rename(source, destination) {
      const sourceKey = nameKey(source);
      const destinationKey = nameKey(destination);
      const sourcePath = this._resolveAndValidateStoragePath(this.getTargetDir(), source);
      const destinationPath = this._resolveAndValidateStoragePath(this.getTargetDir(), destination);
      try {
        await fs.lstat(destinationPath);
        throw new Error('Theme destination already exists');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await fs.rename(sourcePath, destinationPath);
      const { DO_STORAGE } = getBindings();
      try {
        await DO_STORAGE.transaction(async (transaction) => {
          const manifest = await transaction.get(sourceKey);
          if (!manifest) throw new Error('Theme persistence manifest is missing');
          const previous = await transaction.get(destinationKey);
          if (previous)
            await transaction.put(
              GARBAGE + previous.revision,
              previous.files.map((file) => file.key),
            );
          await transaction.put(destinationKey, manifest);
          await transaction.delete(sourceKey);
        });
      } catch (error) {
        await fs.rename(destinationPath, sourcePath);
        throw error;
      }
      await cleanupGarbage();
    }
    async delete(name) {
      const key = nameKey(name);
      const { DO_STORAGE } = getBindings();
      await DO_STORAGE.transaction(async (transaction) => {
        const manifest = await transaction.get(key);
        if (manifest)
          await transaction.put(
            GARBAGE + manifest.revision,
            manifest.files.map((file) => file.key),
          );
        await transaction.delete(key);
      });
      await fs.rm(this._resolveAndValidateStoragePath(this.getTargetDir(), name), {
        recursive: true,
        force: true,
      });
      await cleanupGarbage();
    }
  };
}
module.exports = { persistentThemeStorage, restoreThemes };
