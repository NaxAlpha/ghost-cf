const { createReadStream } = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { getBindings } = require('./context.cjs');
const { StorageBase } = require('ghost-storage-base');

function safePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) {
    throw new Error('Invalid storage path');
  }
  const parts = value.replace(/^\/+/, '').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw new Error('Invalid storage path');
  return parts.join('/');
}

// Ignore malformed/multipart ranges; honor valid single byte ranges for media seeking.
function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!match || (!match[1] && !match[2])) return null;
  if (size === 0) return { unsatisfiable: true };
  if (!match[1]) {
    const length = Math.min(Number(match[2]), size);
    return length > 0 ? { offset: size - length, length } : { unsatisfiable: true };
  }
  const offset = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (offset >= size || end < offset) return { unsatisfiable: true };
  return { offset, length: end - offset + 1 };
}

// Implements the current Ghost StorageBase contract without an S3 access key.
class R2Storage extends StorageBase {
  constructor({ staticFileURLPrefix = 'content/images', siteUrl = 'https://localhost' } = {}) {
    super();
    this.staticFileURLPrefix = safePath(staticFileURLPrefix.replace(/\/+$/, ''));
    this.storagePath = this.staticFileURLPrefix;
    const site = new URL(siteUrl);
    this.siteUrl = site.origin;
    this.urlPrefix = [site.pathname.replace(/^\/+|\/+$/g, ''), this.staticFileURLPrefix]
      .filter(Boolean)
      .join('/');
  }

  key(relativePath) {
    return `${this.storagePath}/${safePath(relativePath)}`;
  }
  url(relativePath) {
    return `/${this.urlPrefix}/${safePath(relativePath).split('/').map(encodeURIComponent).join('/')}`;
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
    const prefix = `${this.urlPrefix}/`;
    if (!pathname.startsWith(prefix)) throw new Error('Storage URL has an invalid prefix');
    return safePath(pathname.slice(prefix.length));
  }
  serve() {
    return async (req, res, next) => {
      try {
        if (!['GET', 'HEAD'].includes(req.method)) return next();
        const relativePath = safePath(decodeURIComponent(new URL(req.url, this.siteUrl).pathname));
        const bucket = getBindings().MEDIA;
        const key = this.key(relativePath);
        const object = await bucket.head(key);
        if (!object) return res.status(404).end();
        res.setHeader(
          'Content-Type',
          object.httpMetadata?.contentType || 'application/octet-stream',
        );
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('ETag', object.httpEtag);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', object.size);
        if (
          (req.headers['if-none-match'] || '')
            .split(',')
            .some(
              (value) =>
                value.trim().replace(/^W\//, '') === object.httpEtag || value.trim() === '*',
            )
        )
          return res.status(304).end();
        if (req.method === 'HEAD') return res.end();
        const range =
          !req.headers['if-range'] || req.headers['if-range'] === object.httpEtag
            ? byteRange(req.headers.range, object.size)
            : null;
        if (range?.unsatisfiable) {
          res.setHeader('Content-Range', `bytes */${object.size}`);
          res.setHeader('Content-Length', 0);
          return res.status(416).end();
        }
        const result = await bucket.get(key, {
          ...(range ? { range } : {}),
          onlyIf: { etagMatches: object.etag },
        });
        if (!result) {
          res.setHeader('Content-Length', 0);
          return res.status(404).end();
        }
        if (!result.body) {
          res.setHeader('Content-Length', 0);
          res.setHeader('Retry-After', '1');
          return res.status(503).end();
        }
        if (range) {
          res.status(206);
          res.setHeader('Content-Length', range.length);
          res.setHeader(
            'Content-Range',
            `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
          );
        }
        await pipeline(Readable.fromWeb(result.body), res);
      } catch (error) {
        next(error);
      }
    };
  }
}

module.exports = { default: R2Storage, R2Storage, safePath, byteRange };
