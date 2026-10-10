const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const [destination, requested = require('../upstream.json').tag] = process.argv.slice(2);
if (!destination)
  throw new Error('Usage: node scripts/install-release.cjs <new-directory> [version|latest]');
if (requested !== 'latest' && !/^v?\d+\.\d+\.\d+$/.test(requested))
  throw new Error('Expected a stable release version');
const directory = path.resolve(destination);
function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || command + ' failed');
  return result.stdout;
}

(async () => {
  if (fs.existsSync(directory))
    throw new Error('Choose a new directory; existing files are never replaced');
  const tag = requested.startsWith('v') ? requested : 'v' + requested;
  const endpoint = requested === 'latest' ? 'latest' : 'tags/' + tag;
  const response = await fetch('https://api.github.com/repos/TryGhost/Ghost/releases/' + endpoint, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ghost-cf-release-installer' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error('Official release metadata returned HTTP ' + response.status);
  const release = await response.json();
  const version = release.tag_name.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable official release');
  const asset = release.assets.find((item) => item.name === 'ghost-' + version + '.tgz');
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || ''))
    throw new Error('Official release archive or SHA-256 digest is unavailable');
  if (new URL(asset.browser_download_url).hostname !== 'github.com')
    throw new Error('Unexpected release archive host');
  const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120000) });
  if (!download.ok) throw new Error('Archive download returned HTTP ' + download.status);
  const chunks = [];
  let size = 0;
  for await (const chunk of download.body) {
    size += chunk.byteLength;
    if (size > 128 * 1024 * 1024) throw new Error('Release archive exceeds 128 MiB');
    chunks.push(chunk);
  }
  const archive = Buffer.concat(chunks);
  if ('sha256:' + createHash('sha256').update(archive).digest('hex') !== asset.digest)
    throw new Error('Release archive digest mismatch');
  fs.mkdirSync(directory, { recursive: true });
  const archiveFile = path.join(directory, '.ghost-release.tgz');
  fs.writeFileSync(archiveFile, archive);
  const entries = run('tar', ['-tzf', archiveFile]).trim().split('\n');
  if (entries.some((entry) => entry.startsWith('/') || entry.split('/').includes('..')))
    throw new Error('Unsafe release archive path');
  if (
    run('tar', ['-tvzf', archiveFile])
      .split('\n')
      .some((entry) => /^[lh]/.test(entry))
  )
    throw new Error('Release archive links are unsupported');
  run('tar', ['-xzf', archiveFile, '-C', directory]);
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (pkg.name !== 'ghost' || pkg.version !== version)
    throw new Error('Release package identity mismatch');
  console.log('Installing unchanged Ghost ' + version + ' with its frozen pnpm lockfile');
  console.log(
    run('pnpm', ['install', '--dir', directory, '--prod', '--frozen-lockfile', '--ignore-scripts']),
  );
  console.log(JSON.stringify({ version, directory, sha256: asset.digest }));
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
