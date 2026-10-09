const { createReadStream } = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { getBindings } = require('./context.cjs');

function safePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) {
    throw new Error('Invalid storage path');
  }
  const parts = value.replace(/^\/+/, '').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw new Error('Invalid storage path');
  return parts.join('/');
}

// Implements the current Ghost StorageBase contract without an S3 access key.
class R2Storage {
  constructor({ staticFileURLPrefix = 'content/images', siteUrl = 'https://localhost' } = {}) {
    this.staticFileURLPrefix = safePath(staticFileURLPrefix);
    this.storagePath = this.staticFileURLPrefix;
    this.siteUrl = new URL(siteUrl).origin;
    this.requiredFns = Object.freeze(['exists', 'save', 'serve', 'delete', 'read']);
  }

  key(relativePath) {
    return `${this.storagePath}/${safePath(relativePath)}`;
  }
  url(relativePath) {
    return `/${this.key(relativePath).split('/').map(encodeURIComponent).join('/')}`;
  }
  getTargetDir() {
    const now = new Date();
    return `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  async save(file, targetDir = this.getTargetDir()) {
    const name = path.basename(file.name).replace(/[^\w@.-]/g, '-');
    const relativePath = safePath(`${targetDir}/${randomUUID()}-${name}`);
    const body = Readable.toWeb(createReadStream(file.path));
    await getBindings().MEDIA.put(this.key(relativePath), body, {
      httpMetadata: { contentType: file.type || 'application/octet-stream' },
    });
    return this.url(relativePath);
  }
  async saveRaw(buffer, targetPath) {
    const relativePath = safePath(targetPath);
    await getBindings().MEDIA.put(this.key(relativePath), buffer);
    return this.url(relativePath);
  }
  async exists(fileName, targetDir) {
    return Boolean(
      await getBindings().MEDIA.head(this.key(targetDir ? `${targetDir}/${fileName}` : fileName)),
    );
  }
  async delete(fileName, targetDir) {
    await getBindings().MEDIA.delete(this.key(targetDir ? `${targetDir}/${fileName}` : fileName));
  }
  async readStream({ path: relativePath }) {
    const object = await getBindings().MEDIA.get(this.key(relativePath));
    if (!object)
      throw Object.assign(new Error('File not found'), { code: 'ENOENT', statusCode: 404 });
    return Readable.fromWeb(object.body);
  }
  async read({ path: relativePath }) {
    const object = await getBindings().MEDIA.get(this.key(relativePath));
    if (!object)
      throw Object.assign(new Error('File not found'), { code: 'ENOENT', statusCode: 404 });
    return Buffer.from(await object.arrayBuffer());
  }
  urlToPath(value) {
    const url = new URL(value, this.siteUrl);
    if (url.origin !== this.siteUrl) throw new Error('Storage URL belongs to a different site');
    const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const prefix = `${this.storagePath}/`;
    if (!pathname.startsWith(prefix)) throw new Error('Storage URL has an invalid prefix');
    return safePath(pathname.slice(prefix.length));
  }
  serve() {
    return async (req, res, next) => {
      try {
        if (!['GET', 'HEAD'].includes(req.method)) return next();
        const relativePath = safePath(decodeURIComponent(new URL(req.url, this.siteUrl).pathname));
        const bucket = getBindings().MEDIA;
        const object =
          req.method === 'HEAD'
            ? await bucket.head(this.key(relativePath))
            : await bucket.get(this.key(relativePath));
        if (!object) return res.status(404).end();
        res.setHeader(
          'Content-Type',
          object.httpMetadata?.contentType || 'application/octet-stream',
        );
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('ETag', object.httpEtag);
        res.setHeader('Content-Length', object.size);
        if (req.headers['if-none-match'] === object.httpEtag) return res.status(304).end();
        if (req.method === 'HEAD') return res.end();
        await pipeline(Readable.fromWeb(object.body), res);
      } catch (error) {
        next(error);
      }
    };
  }
}

module.exports = { R2Storage, safePath };
