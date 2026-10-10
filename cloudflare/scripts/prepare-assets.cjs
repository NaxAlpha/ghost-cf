const fs = require('node:fs');
const path = require('node:path');
const [releaseDirectory, outputDirectory, siteUrl] = process.argv.slice(2);
if (!releaseDirectory || !outputDirectory || !siteUrl) {
  throw new Error('Usage: node scripts/prepare-assets.cjs <release> <output> <site-url>');
}
const url = new URL(siteUrl);
if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
  throw new Error('The experimental site requires an HTTPS origin URL');
}
const root = path.resolve(releaseDirectory);
const output = path.resolve(outputDirectory);
const files = {};
const packageAssets = path.join(output, 'ghost-runtime-package-assets.json');
if (fs.existsSync(packageAssets))
  Object.assign(files, JSON.parse(fs.readFileSync(packageAssets, 'utf8')));
function collect(relative, accept = () => true) {
  const directory = path.join(root, relative);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) collect(filename, accept);
    else if (entry.isFile() && accept(filename)) {
      files['/tmp/ghost/' + filename] = fs
        .readFileSync(path.join(root, filename))
        .toString('base64');
    }
  }
}
collect('core/shared/config', (file) => file.endsWith('.json'));
collect('core', (file) => !file.includes('/built/') && /\.(hbs|html|css|json)$/.test(file));
collect('core/frontend/public');
collect('core/server/web/gift-preview', (file) => /\.(png|ttf)$/.test(file));
collect('content/themes');
collect('node_modules/@tryghost/i18n/locales');
files['/tmp/ghost/node_modules/jsdom/lib/jsdom/browser/default-stylesheet.css'] = fs
  .readFileSync(path.join(root, 'node_modules/jsdom/lib/jsdom/browser/default-stylesheet.css'))
  .toString('base64');
files['/tmp/ghost/core/built/admin/index.html'] = fs
  .readFileSync(path.join(root, 'core/built/admin/index.html'))
  .toString('base64');
const storage = { active: 'R2Storage', R2Storage: { siteUrl: url.origin } };
for (const kind of ['images', 'media', 'files', 'imports']) {
  storage[kind] = {
    adapter: 'R2Storage',
    staticFileURLPrefix: 'content/' + kind,
    siteUrl: url.origin,
  };
}
const configuration = {
  url: url.origin,
  // Let the Workers edge compress responses after the Node HTTP bridge.
  compress: false,
  database: { client: 'sqlite3', connection: { filename: ':memory:' } },
  logging: { transports: ['stdout'] },
  sendWelcomeEmail: false,
  ...(process.env.GHOST_CF_MAIL_FROM
    ? { mail: { transport: 'cloudflare', from: process.env.GHOST_CF_MAIL_FROM } }
    : {}),
  adapters: {
    storage,
    'route-settings': {
      active: 'DurableRoutes',
      DurableRoutes: {
        basePath: '/tmp/ghost/content/settings',
        defaultSettingsBasePath: '/tmp/ghost/core/server/services/route-settings',
      },
    },
    redirects: { active: 'DurableRedirects' },
    jobs: { active: 'DurableJobs' },
  },
  scheduling: { active: 'DurableScheduling' },
};
files['/tmp/ghost/config.production.json'] = Buffer.from(JSON.stringify(configuration)).toString(
  'base64',
);
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'runtime-assets.json'), JSON.stringify(files));
fs.mkdirSync(path.join(output, 'public/__ghost-cf'), { recursive: true });
fs.writeFileSync(path.join(output, 'public/__ghost-cf/runtime-assets.json'), JSON.stringify(files));
// Keep the sizeable Admin application outside the Worker JavaScript bundle.
const adminAssets = path.join(root, 'core/built/admin/assets');
if (fs.existsSync(adminAssets)) {
  fs.cpSync(adminAssets, path.join(output, 'public/ghost/assets'), { recursive: true });
}
console.log(JSON.stringify({ runtimeFiles: Object.keys(files).length, siteUrl: url.origin }));

fs.mkdirSync(path.join(output, 'public/__ghost-cf/fonts'), { recursive: true });
fs.copyFileSync(
  path.join(root, 'core/server/web/gift-preview/Inter.ttf'),
  path.join(output, 'public/__ghost-cf/fonts/Inter.ttf'),
);
