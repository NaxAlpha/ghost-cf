const { test } = require('node:test');
const assert = require('node:assert/strict');
const { siteAccess } = require('../src/site-access.cjs');

test('public access keeps owner bootstrap and runtime configuration private', () => {
  const env = { PUBLIC_SITE: true, TEST_TOKEN: 'private-bootstrap' };
  const request = (path, method = 'GET', token) =>
    new Request('https://blog.example' + path, {
      method,
      headers: token ? { 'X-Ghost-CF-Test': token } : {},
    });
  assert.equal(siteAccess(request('/'), env), true);
  assert.equal(siteAccess(request('/ghost/'), env), true);
  assert.equal(siteAccess(request('/ghost/api/admin/authentication/setup/'), env), true);
  assert.equal(siteAccess(request('/ghost/api/admin/authentication/setup/', 'POST'), env), false);
  assert.equal(
    siteAccess(request('/ghost/api/admin/authentication/setup/', 'POST', env.TEST_TOKEN), env),
    true,
  );
  assert.equal(
    siteAccess(request('/__ghost-cf/runtime-assets.json', 'GET', env.TEST_TOKEN), env),
    false,
  );
  assert.equal(siteAccess(request('/__ghost-cf/fonts/Inter.ttf'), env), true);
  assert.equal(siteAccess(request('/'), { TEST_TOKEN: env.TEST_TOKEN }), false);
  assert.equal(
    siteAccess(request('/', 'GET', env.TEST_TOKEN), { TEST_TOKEN: env.TEST_TOKEN }),
    true,
  );
  assert.equal(siteAccess(request('/'), {}), false);
});
