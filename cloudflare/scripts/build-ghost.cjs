const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const platformRoot = path.resolve(__dirname, '..');
const requirePlatform = createRequire(path.join(platformRoot, 'package.json'));
const esbuild = requirePlatform('esbuild');
const [releaseDirectory, outputDirectory] = process.argv.slice(2);
if (!releaseDirectory || !outputDirectory)
  throw new Error(
    'Usage: node scripts/build-ghost.cjs <installed-release-directory> <output-directory>',
  );
const root = path.resolve(releaseDirectory);
const outputRoot = path.resolve(outputDirectory);
fs.mkdirSync(outputRoot, { recursive: true });
const adminSchemaRegistry = require('./compile-admin-schema.cjs').compileAdminSchemas(
  root,
  outputRoot,
);
const skipped = new Set();
const migrationRoot = path.join(root, 'core/server/data/migrations');
const migrationFiles = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) migrationFiles.push(full);
  }
}
walk(migrationRoot);
const registryPath = path.resolve(outputRoot, 'ghost-migration-registry.cjs');
fs.writeFileSync(
  registryPath,
  'module.exports={' +
    migrationFiles
      .map(
        (file) =>
          JSON.stringify('/tmp/ghost/' + path.relative(root, file)) +
          ':()=>require(' +
          JSON.stringify(file) +
          ')',
      )
      .join(',') +
    '};',
);

const adapterRegistryPath = path.join(outputRoot, 'ghost-adapter-registry.cjs');
const dependencies = {
  RouteFileStore: ['core/server/adapters/route-settings/FileStore.js', 'default'],
  RedirectsStoreBase: [
    'node_modules/@tryghost/adapter-base-redirects/build/index.js',
    'RedirectsStoreBase',
  ],
  SchedulingBase: [
    'node_modules/@tryghost/adapter-base-scheduling/build/index.js',
    'SchedulingBase',
  ],
  JobsBackendBase: ['node_modules/@tryghost/adapter-base-jobs/build/index.js', 'JobsBackendBase'],
  defaultRoutes: ['core/server/services/route-settings/default-routes.yaml'],
  later: ['node_modules/@breejs/later'],
};
fs.writeFileSync(
  adapterRegistryPath,
  'module.exports=require(' +
    JSON.stringify(path.join(platformRoot, 'src/ghost-adapters.cjs')) +
    ').createGhostAdapters({' +
    Object.entries(dependencies)
      .map(
        ([name, [file, property]]) =>
          name +
          ':require(' +
          JSON.stringify(path.join(root, file)) +
          ')' +
          (property ? '.' + property : ''),
      )
      .join(',') +
    '});',
);
const appRegistryPath = path.join(outputRoot, 'ghost-app-registry.cjs');
const appDirectory = path.join(root, 'core/frontend/apps');
fs.writeFileSync(
  appRegistryPath,
  'const apps={' +
    fs
      .readdirSync(appDirectory)
      .filter((name) => fs.existsSync(path.join(appDirectory, name, 'index.js')))
      .map(
        (name) =>
          JSON.stringify(name) +
          ':()=>require(' +
          JSON.stringify(path.join(appDirectory, name)) +
          ')',
      )
      .join(',') +
    '};module.exports=(name)=>{if(!apps[name])throw new Error("Ghost app not linked: "+name);return apps[name]();};',
);

const templateRegistryPath = path.resolve(outputRoot, 'ghost-template-registry.cjs');
const templateEntries = [];
const hbs = createRequire(path.join(root, 'package.json'))('handlebars');
function templateWalk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'built' && entry.name !== 'node_modules') templateWalk(file);
    } else if (/\.hbs$/.test(file)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const input of new Set([source, source + ' '])) {
        for (const preventIndent of [false, true]) {
          const key =
            require('node:crypto').createHash('sha256').update(input).digest('hex') +
            ':' +
            preventIndent;
          templateEntries.push(
            JSON.stringify(key) + ':' + hbs.precompile(input, { preventIndent }),
          );
        }
      }
    }
  }
}
templateWalk(path.join(root, 'core'));
templateWalk(path.join(root, 'content/themes'));
fs.writeFileSync(
  templateRegistryPath,
  'const specs={' +
    templateEntries.join(',') +
    '};module.exports.compile=(input,options,env)=>{const key=require("node:crypto").createHash("sha256").update(input).digest("hex")+":"+Boolean(options.preventIndent);const spec=specs[key];if(!spec)throw new Error("Ghost template needs compilation: "+key);return env.template(spec);};',
);

esbuild
  .build({
    stdin: {
      contents:
        'require(' +
        JSON.stringify(path.join(root, 'node_modules/bluebird')) +
        ').setScheduler((callback)=>Promise.resolve().then(callback)); require(' +
        JSON.stringify(path.join(root, 'node_modules/express')) +
        '); module.exports=require(' +
        JSON.stringify(path.join(root, 'core/boot.js')) +
        '); module.exports.withBindings=require(' +
        JSON.stringify(path.resolve(platformRoot, 'src/context.cjs')) +
        ').withBindings; module.exports.getBindings=require(' +
        JSON.stringify(path.resolve(platformRoot, 'src/context.cjs')) +
        ').getBindings;',
      resolveDir: root,
      sourcefile: 'ghost-platform-entry.cjs',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    conditions: ['module-sync'],
    outfile: path.resolve(outputRoot, 'ghost-platform-boot.mjs'),
    metafile: true,
    define: { 'process.exit': 'ghostCFExit' },
    minify: true,
    keepNames: true,
    banner: {
      js: 'import {createRequire} from "node:module"; const require=createRequire("/bundle/index.js"); function ghostCFExit(code){throw new Error("GHOST_CF_PROCESS_EXIT:"+code)}',
    },
    external: ['node:*', 'cloudflare:*', '*.wasm?module'],
    plugins: [
      {
        name: 'explicit-optional-edges',
        setup(build) {
          build.onResolve({ filter: /^ghost-storage-base$/ }, () => ({
            path: path.join(root, 'node_modules/ghost-storage-base/build/index.js'),
          }));
          build.onLoad({ filter: /\.yaml$/ }, (args) => ({
            contents: fs.readFileSync(args.path, 'utf8'),
            loader: 'text',
          }));
          build.onResolve({ filter: /^@tryghost\/image-transform$/ }, () => ({
            path: path.resolve(platformRoot, 'src/cloudflare-images.cjs'),
          }));
          build.onResolve({ filter: /^knex$/ }, () => ({
            path: 'knex-platform',
            namespace: 'platform-knex',
          }));
          build.onLoad({ filter: /.*/, namespace: 'platform-knex' }, () => ({
            contents:
              'const factory=require(' +
              JSON.stringify(path.resolve(platformRoot, 'src/durable-client.cjs')) +
              ').createDurableDatabase; module.exports=factory; module.exports.default=factory;',
            loader: 'js',
            resolveDir: root,
          }));
          build.onResolve({ filter: /^ajv\/dist\// }, (args) => ({
            path: createRequire(path.join(root, 'package.json')).resolve(args.path),
          }));
          build.onResolve({ filter: /^css-tree$/ }, (args) => ({
            path: createRequire(args.importer).resolve('css-tree'),
          }));
          build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
            path: path.join(root, 'node_modules/jsonc-parser/lib/esm/main.js'),
          }));
          build.onResolve({ filter: /\.node$/ }, (args) => {
            skipped.add(args.path);
            return { path: args.path, namespace: 'unsupported-optional' };
          });
          build.onResolve({ filter: /.*/ }, (args) => {
            if (
              !/node_modules\/(consolidate\/lib\/consolidate\.js|knex\/lib\/dialects\/|express-hbs\/lib\/hbs\.js)/.test(
                args.importer,
              )
            )
              return;
            if (args.path.startsWith('.') || args.path.startsWith('node:')) return;
            try {
              createRequire(args.importer).resolve(args.path);
              return;
            } catch {
              skipped.add(args.path);
              return { path: args.path, namespace: 'unsupported-optional' };
            }
          });
          build.onLoad({ filter: /\.(?:js|cjs|mjs)$/, namespace: 'file' }, async (args) => {
            let source = fs.readFileSync(args.path, 'utf8');
            if (args.path.endsWith('/@tryghost/admin-api-schema/build/utils/json-schema.js')) {
              const start = source.indexOf('const require =');
              const end = source.indexOf('export async function validate');
              if (start < 0 || end < 0) throw new Error('Ghost JSON schema compiler changed');
              source =
                source.slice(0, start) +
                'const registry=require(' +
                JSON.stringify(adminSchemaRegistry) +
                ');const getValidation=(schema,definition)=>registry[schema.$id];\n' +
                source.slice(end);
              source = source
                .replace("import { Ajv } from 'ajv';", '')
                .replace("import { addIsLowercaseKeyword } from './is-lowercase-keyword.js';", '');
            }

            if (args.path === path.join(root, 'core/frontend/web/site.js'))
              source = source.replaceAll(
                "require(path.join(config.get('paths').internalAppPath, appName))",
                'require(' + JSON.stringify(appRegistryPath) + ')(appName)',
              );
            if (args.path === path.join(root, 'core/frontend/services/apps/loader.js'))
              source = source.replace(
                'require(getAppAbsolutePath(name))',
                'require(' + JSON.stringify(appRegistryPath) + ')(name)',
              );
            if (args.path === path.join(root, 'node_modules/gscan/lib/specs/index.js'))
              source = source.replace(
                'require(`./${[version]}`)',
                '(' +
                  fs
                    .readdirSync(path.join(root, 'node_modules/gscan/lib/specs'))
                    .filter((file) => /^v.*\.js$/.test(file))
                    .map(
                      (file) =>
                        'version===' +
                        JSON.stringify(file.slice(0, -3)) +
                        '?require(' +
                        JSON.stringify(path.join(root, 'node_modules/gscan/lib/specs', file)) +
                        '):',
                    )
                    .join('') +
                  '(()=>{throw new Error("Unknown Ghost theme spec: "+version)})())',
              );
            if (args.path === path.join(root, 'node_modules/gscan/lib/checker.js')) {
              const checks = fs
                .readdirSync(path.join(root, 'node_modules/gscan/lib/checks'))
                .filter((file) => file.endsWith('.js'));
              source = source.replace(
                'function loadChecks() {',
                'function loadChecks() { return {' +
                  checks
                    .map(
                      (file) =>
                        JSON.stringify(path.basename(file, '.js')) +
                        ':require(' +
                        JSON.stringify(path.join(root, 'node_modules/gscan/lib/checks', file)) +
                        ')',
                    )
                    .join(',') +
                  '};',
              );
            }
            if (args.path.endsWith('/handlebars/dist/cjs/handlebars/compiler/compiler.js'))
              source = source.replace(
                'function compile(input, options, env) {',
                'function compile(input, options, env) { return require(' +
                  JSON.stringify(templateRegistryPath) +
                  ').compile(input,options||{},env);',
              );
            if (args.path.endsWith('/handlebars/lib/handlebars/compiler/compiler.js'))
              source = source.replace(
                'export function compile(input, options = {}, env) {',
                'export function compile(input, options = {}, env) { return require(' +
                  JSON.stringify(templateRegistryPath) +
                  ').compile(input,options,env);',
              );

            if (args.path.endsWith('/undici/lib/dispatcher/client-h1.js')) {
              const wasmPath = path.join(path.dirname(args.path), '../llhttp/llhttp-wasm.js');
              const bytes = createRequire(args.path)(wasmPath);
              const hash = require('node:crypto')
                .createHash('sha256')
                .update(bytes)
                .digest('hex')
                .slice(0, 12);
              const filename = 'ghost-llhttp-' + hash + '.wasm';
              fs.writeFileSync(path.resolve(outputRoot, filename), bytes);
              source =
                'import ghostCFLlhttp from ' +
                JSON.stringify(path.resolve(outputRoot, filename) + '?module') +
                ';\n' +
                source;
              source = source
                .replaceAll(
                  "WebAssembly.compile(require('../llhttp/llhttp_simd-wasm.js'))",
                  'Promise.resolve(ghostCFLlhttp)',
                )
                .replaceAll(
                  "WebAssembly.compile(llhttpWasmData || require('../llhttp/llhttp-wasm.js'))",
                  'Promise.resolve(ghostCFLlhttp)',
                )
                .replaceAll(
                  "new WebAssembly.Module(require('../llhttp/llhttp_simd-wasm.js'))",
                  'ghostCFLlhttp',
                )
                .replaceAll(
                  "new WebAssembly.Module(llhttpWasmData || require('../llhttp/llhttp-wasm.js'))",
                  'ghostCFLlhttp',
                );
            }

            if (args.path.endsWith('/jsdom/lib/jsdom/living/xhr/XMLHttpRequest-impl.js'))
              source = source.replace(
                'require.resolve("./xhr-sync-worker.js")',
                JSON.stringify(
                  '/tmp/ghost/node_modules/jsdom/lib/jsdom/living/xhr/xhr-sync-worker.js',
                ),
              );
            if (
              args.path ===
              path.join(root, 'core/frontend/services/theme-engine/handlebars/template.js')
            )
              source = source.replace(
                /_\.template\(\s*((?:'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"))\s*,?\s*\)/g,
                (_match, literal) => {
                  const text = Function('return ' + literal)();
                  return (
                    '(' +
                    createRequire(path.join(root, 'package.json'))('lodash').template(
                      text.replace(/<%=\s*(\w+)\s*%>/g, '<%= data.$1 %>'),
                      { variable: 'data' },
                    ).source +
                    ')'
                  );
                },
              );
            if (args.path === path.join(root, 'core/server/data/db/database-state-manager.js'))
              source = source.replace(
                'knexMigratorFilePath,',
                'knexMigratorFilePath, knexMigratorConfig: require(' +
                  JSON.stringify(path.join(root, 'MigratorConfig.js')) +
                  '),',
              );
            if (args.path === path.join(root, 'node_modules/knex-migrator/lib/database.js'))
              source = source.replace(
                'function loadKnex(options) {',
                'function loadKnex(options) { return peerKnex;',
              );
            if (args.path === path.join(root, 'MigratorConfig.js'))
              source = source.replace(
                "require('tsx/cjs');",
                '/* Compiled production release needs no TypeScript loader. */',
              );
            if (args.path === path.join(root, 'node_modules/knex-migrator/lib/utils.js')) {
              source =
                'const ghostCFMigrations=require(' + JSON.stringify(registryPath) + ');\n' + source;
              source = source.replaceAll(
                'fs.readdirSync(absolutePath)',
                '[...new Set(Object.keys(ghostCFMigrations).filter(file=>file.startsWith(absolutePath+"/")).map(file=>file.slice(absolutePath.length+1).split("/")[0]))]',
              );
              source = source.replace(
                'require(path.join(absolutePath, file))',
                'ghostCFMigrations[path.join(absolutePath,file)]()',
              );
            }
            if (args.path === path.join(root, 'node_modules/knex-migrator/lib/index.js')) {
              source = source
                .replaceAll(
                  "require(path.join(self.migrationPath, '/hooks/init'))",
                  'require(' + JSON.stringify(path.join(migrationRoot, 'hooks/init')) + ')',
                )
                .replaceAll(
                  "require(path.join(this.migrationPath, '/hooks/init'))",
                  'require(' + JSON.stringify(path.join(migrationRoot, 'hooks/init')) + ')',
                )
                .replaceAll(
                  "require(path.join(this.migrationPath, '/hooks/migrate'))",
                  'require(' + JSON.stringify(path.join(migrationRoot, 'hooks/migrate')) + ')',
                );
            }

            if (args.path === path.join(root, 'core/boot.js'))
              source = source
                .replace('process.exit(1);', 'throw error;')
                .replace('process.exit(2);', 'throw serverStartError;');
            if (args.path.endsWith('/@tryghost/version/lib/version.js'))
              source = source.replace(
                "require(path.join(rootUtils.getProcessRoot(), 'package.json'))",
                'require(' + JSON.stringify(path.join(root, 'package.json')) + ')',
              );
            if (
              args.path.endsWith('/@tryghost/logging/lib/logging.js') ||
              args.path.endsWith('/@tryghost/metrics/lib/metrics.js')
            )
              source = source.replace(
                "require(path.join(getProcessRoot(), 'loggingrc'))",
                'require(' + JSON.stringify(path.join(root, 'loggingrc.js')) + ')',
              );
            if (args.path === path.join(root, 'core/server/services/adapter-manager/index.js'))
              source = source.replace(
                'loadAdapterFromPath: require,',
                'loadAdapterFromPath: (name)=>{const adapterName=name.split("/").pop();const registry=require(' +
                  JSON.stringify(adapterRegistryPath) +
                  ');if(registry[adapterName])return {default:registry[adapterName]};if(adapterName==="R2Storage")return require(' +
                  JSON.stringify(path.join(platformRoot, 'src/r2-storage.cjs')) +
                  ');if(adapterName==="MemoryCache")return require(' +
                  JSON.stringify(path.join(root, 'core/server/adapters/cache/MemoryCache.js')) +
                  ');if(adapterName==="DefaultSSOAdapter")return require(' +
                  JSON.stringify(path.join(root, 'core/server/adapters/sso/DefaultSSOAdapter.js')) +
                  ');throw new Error("Ghost adapter not linked: "+name);},',
              );
            if (args.path === path.join(root, 'core/server/models/base/bookshelf.js'))
              source = source.replace(
                "ghostBookshelf.plugin('bookshelf-relations',",
                "ghostBookshelf.plugin(require('bookshelf-relations'),",
              );
            if (args.path === path.join(root, 'core/server/data/schema/default-settings/index.js'))
              source = source.replace(
                'require(defaultSettingsPath)',
                'require("./default-settings.json")',
              );
            if (args.path === path.join(root, 'core/server/data/schema/fixtures/index.js'))
              source = source.replace('require(fixturePath)', 'require("./fixtures.json")');
            if (args.path === path.join(root, 'core/shared/config/index.js'))
              source = source.replace(
                'loadNconf)()',
                'loadNconf)({baseConfigPath: "/tmp/ghost/core/shared/config", customConfigPath: "/tmp/ghost"})',
              );

            const virtual = '/tmp/ghost/' + path.relative(root, args.path);
            const transformed = await esbuild.transform(source, {
              loader: 'js',
              define: {
                __dirname: JSON.stringify(path.dirname(virtual)),
                __filename: JSON.stringify(virtual),
                'import.meta.dirname': JSON.stringify(path.dirname(virtual)),
                'import.meta.filename': JSON.stringify(virtual),
                'import.meta.url': JSON.stringify('file://' + virtual),
              },
            });
            return {
              contents: transformed.code,
              loader: 'js',
              resolveDir: path.dirname(args.path),
            };
          });
          build.onLoad({ filter: /.*/, namespace: 'unsupported-optional' }, (args) => ({
            contents: `throw new Error(${JSON.stringify('Unsupported optional Ghost dependency: ' + args.path)});`,
            loader: 'js',
          }));
        },
      },
    ],
    logLimit: 20,
  })
  .then((result) => {
    fs.writeFileSync(
      path.join(outputRoot, 'ghost-platform-metafile.json'),
      JSON.stringify(result.metafile),
    );
    console.log('Unsupported optional dependency edges:', [...skipped]);
  })
  .catch(() => {
    process.exitCode = 1;
  });
