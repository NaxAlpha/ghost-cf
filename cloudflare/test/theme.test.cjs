const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { precompileTheme } = require('../scripts/precompile-theme.cjs');

test('precompiles templates and partials with escaping preserved', async () => {
  const root = await fs.mkdtemp(path.join(__dirname, '.theme-test-'));
  try {
    await fs.mkdir(path.join(root, 'partials'));
    await fs.writeFile(path.join(root, 'post.hbs'), '<h1>{{title}}</h1>{{> byline}}');
    await fs.writeFile(path.join(root, 'partials/byline.hbs'), '<p>{{author}}</p>');
    const output = path.join(root, 'compiled.mjs');
    assert.deepEqual(await precompileTheme(root, output), { templates: 1, partials: 1 });
    const compiled = await import(pathToFileURL(output).href);
    compiled.registerPartials();
    assert.equal(
      compiled.templates.post({ title: '<script>', author: 'Ghost' }),
      '<h1>&lt;script&gt;</h1><p>Ghost</p>',
    );
    const source = await fs.readFile(output, 'utf8');
    assert.equal(source.includes('new Function'), false);
    assert.equal(source.includes('Handlebars.compile('), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
