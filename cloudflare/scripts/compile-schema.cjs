const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { createDatabase } = require('../src/knex.cjs');

// Build-time only: use Ghost's own table builder, replacing its database import
// with the SQLite query compiler. No Ghost application modules are patched.
function compileSchema(root) {
  const filename = path.join(root, 'core/server/data/schema/commands.js');
  const source = fs.readFileSync(filename, 'utf8');
  const commands = new Module(filename, module);
  commands.filename = filename;
  commands.paths = Module._nodeModulePaths(path.dirname(filename));
  const requireOriginal = commands.require.bind(commands);
  const db = createDatabase();
  commands.require = (id) => (id === '../db' ? { knex: db } : requireOriginal(id));
  commands._compile(source, filename);
  const schema = require(path.join(root, 'core/server/data/schema/schema.js'));
  const queries = Object.entries(schema).flatMap(([name, spec]) =>
    commands.exports
      .createTable(name, db, spec)
      .toSQL()
      .map((query) => {
        if (query.bindings?.length) throw new Error('Unexpected bound schema statement');
        return query.sql;
      }),
  );
  return {
    version: require(path.join(root, 'package.json')).version,
    commandsSha256: createHash('sha256').update(source).digest('hex'),
    tables: Object.keys(schema),
    queries,
  };
}

if (require.main === module) {
  const root = process.env.GHOST_RELEASE_DIR;
  if (!root) throw new Error('Set GHOST_RELEASE_DIR to an installed official Ghost release');
  const output = path.resolve(__dirname, '../artifacts/schema.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const schema = compileSchema(path.resolve(root));
  fs.writeFileSync(output, JSON.stringify(schema, null, 2) + '\n');
  console.log(`Compiled ${schema.tables.length} Ghost ${schema.version} tables to ${output}`);
}
module.exports = { compileSchema };
