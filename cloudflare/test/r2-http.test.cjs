const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { Readable } = require('node:stream');
const express = require('express');
const { R2Storage } = require('../src/r2-storage.cjs');
const { StorageBase } = require('ghost-storage-base');
const { withBindings } = require('../src/context.cjs');

test('implements Ghost adapter inheritance and subdirectory URLs', () => {
  const storage = new R2Storage({
    siteUrl: 'https://blog.example/journal/',
    staticFileURLPrefix: '/content/media/',
  });
  assert.ok(storage instanceof StorageBase);
  assert.equal(storage.url('2026/10/movie.mp4'), '/journal/content/media/2026/10/movie.mp4');
  assert.equal(
    storage.urlToPath('https://blog.example/journal/content/media/2026/10/movie.mp4'),
    '2026/10/movie.mp4',
  );
  assert.throws(() => storage.urlToPath('/content/media/2026/10/movie.mp4'));
});

test('streams media with conditional, HEAD, and byte-range HTTP behavior', async (t) => {
  const bytes = Buffer.from('0123456789');
  const metadata = {
    size: bytes.length,
    etag: 'version-one',
    httpEtag: '"version-one"',
    httpMetadata: { contentType: 'video/mp4' },
  };
  let reads = 0;
  let changed = false;
  const MEDIA = {
    async head(key) {
      return key === 'content/media/movie.mp4' ? metadata : null;
    },
    async get(key, options) {
      reads++;
      assert.equal(key, 'content/media/movie.mp4');
      assert.equal(options.onlyIf.etagMatches, metadata.etag);
      if (changed) return metadata;
      const range = options.range;
      const data = range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;
      return { ...metadata, body: Readable.toWeb(Readable.from(data)) };
    },
  };
  const app = express();
  app.use((req, res, next) => withBindings({ MEDIA }, next));
  app.use('/media', new R2Storage({ staticFileURLPrefix: 'content/media' }).serve());
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/media/movie.mp4`;
  let response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(await response.text(), '0123456789');
  const before = reads;
  response = await fetch(url, { method: 'HEAD' });
  assert.equal(response.headers.get('content-length'), '10');
  assert.equal(await response.text(), '');
  response = await fetch(url, { headers: { 'If-None-Match': '"other", W/"version-one"' } });
  assert.equal(response.status, 304);
  assert.equal(reads, before);
  for (const [range, expected, contentRange] of [
    ['bytes=2-5', '2345', 'bytes 2-5/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=8-100', '89', 'bytes 8-9/10'],
  ]) {
    response = await fetch(url, { headers: { Range: range } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), contentRange);
    assert.equal(await response.text(), expected);
  }
  response = await fetch(url, { headers: { Range: 'bytes=10-' } });
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('content-range'), 'bytes */10');
  response = await fetch(url, { headers: { Range: 'bytes=2-5', 'If-Range': '"old-version"' } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '0123456789');
  response = await fetch(url, { headers: { Range: 'bytes=0-1,4-5' } });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  response = await fetch(url.replace('movie.mp4', 'missing.mp4'));
  assert.equal(response.status, 404);
  changed = true;
  response = await fetch(url, { headers: { Range: 'bytes=2-5' } });
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '');
});
