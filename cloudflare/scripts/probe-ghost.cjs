const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

// Point at an unpacked official release installed with its own dependencies.
// No dependencies are silently stubbed: build failures are compatibility evidence.
async function main() {
  const root = process.env.GHOST_RELEASE_DIR;
  if (!root) throw new Error('Set GHOST_RELEASE_DIR to the unpacked official Ghost release');
  const out = path.resolve(__dirname, '../artifacts');
  fs.mkdirSync(out, { recursive: true });
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'core/boot.js')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: path.join(out, 'ghost-boot.mjs'),
    metafile: true,
    external: ['node:*', 'cloudflare:*'],
    logLimit: 20,
  });
  fs.writeFileSync(
    path.join(out, 'ghost-boot-metafile.json'),
    JSON.stringify(result.metafile, null, 2),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
