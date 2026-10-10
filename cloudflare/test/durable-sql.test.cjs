const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createDurableDatabase } = require('../src/durable-client.cjs');
const { compactBindings } = require('../src/sql-bindings.cjs');
const { withBindings } = require('../src/context.cjs');

function storage(sqlite) {
  return {
    sql: {
      exec(sql, ...bindings) {
        const statement = sqlite.prepare(sql);
        const args = /\?\d/.test(sql)
          ? [Object.fromEntries(bindings.map((value, index) => [`?${index + 1}`, value]))]
          : bindings;
        const rows = statement.columns().length ? statement.all(...args) : [];
        if (!statement.columns().length) statement.run(...args);
        return { toArray: () => rows, one: () => rows[0] };
      },
    },
  };
}

test('inserts Ghost-sized migration sets as one modern SQLite statement', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const db = createDurableDatabase();
  await withBindings({ DO_STORAGE: storage(sqlite) }, async () => {
    await db.schema.createTable('migrations', (table) => {
      table.increments('id');
      table.string('name').unique();
      table.string('version');
    });
    const records = Array.from({ length: 220 }, (_, index) => ({
      name: `migration-${index}`,
      version: '6.69',
    }));
    const query = db('migrations').insert(records).returning(['name', 'version']);
    assert.doesNotMatch(query.toSQL().sql, /union all select/i);
    const result = await query;
    assert.deepEqual(
      result.map((row) => ({ name: row.name, version: row.version })),
      records,
    );
    await assert.rejects(db('migrations').insert([{ name: 'new', version: '6.69' }, records[0]]));
    assert.equal((await db('migrations').where('name', 'new')).length, 0);
    await db('migrations').insert(records).onConflict('name').merge({ version: '6.70' });
    assert.equal((await db('migrations').first()).version, '6.70');
  });
  sqlite.close();
});

test('compacts parameters while retaining SQL literals, comments, types, and blobs', () => {
  const sqlite = new DatabaseSync(':memory:');
  const values = Array.from({ length: 110 }, (_, index) =>
    index % 3 === 0 ? `quote' ? ${index}` : index % 3 === 1 ? null : index / 2,
  );
  const binary = new Uint8Array([1, 2, 255]);
  const source =
    "SELECT '?' AS literal, " +
    [...values, binary].map((_, index) => `? AS c${index}`).join(', ') +
    ' /* ? */ -- ?\n';
  const result = compactBindings(source, [...values, binary]);
  assert.equal(result.bindings.length, 2);
  const row = sqlite
    .prepare(result.sql)
    .get({ '?1': result.bindings[0], '?2': Buffer.from(result.bindings[1]) });
  assert.equal(row.literal, '?');
  values.forEach((value, index) => assert.equal(row[`c${index}`], value));
  assert.deepEqual(new Uint8Array(row.c110), binary);
  assert.throws(() => compactBindings('SELECT ?1', values), /Numbered input/);
  sqlite.close();
});

test('retains nonfinite numeric bindings outside the JSON pack', () => {
  const values = [...Array(101).fill(1), Infinity, -Infinity];
  const result = compactBindings('SELECT ' + values.map((_, i) => `? AS c${i}`).join(', '), values);
  assert.deepEqual(result.bindings.slice(1), [Infinity, -Infinity]);
  const sqlite = new DatabaseSync(':memory:');
  const row = sqlite
    .prepare(result.sql)
    .get({ '?1': result.bindings[0], '?2': Infinity, '?3': -Infinity });
  assert.equal(row.c101, Infinity);
  assert.equal(row.c102, -Infinity);
  sqlite.close();
});

test('serializes independent transactions across clients and preserves nested rollback', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const durable = storage(sqlite);
  let depth = 0;
  let sequence = 0;
  let topLevelEntries = 0;
  durable.transaction = async (callback) => {
    const name = 'native_' + sequence++;
    if (depth === 0) topLevelEntries++;
    depth++;
    sqlite.exec('SAVEPOINT ' + name);
    try {
      const value = await callback();
      sqlite.exec('RELEASE ' + name);
      return value;
    } catch (error) {
      sqlite.exec('ROLLBACK TO ' + name);
      sqlite.exec('RELEASE ' + name);
      throw error;
    } finally {
      depth--;
    }
  };
  const db = createDurableDatabase();
  const other = createDurableDatabase();
  await withBindings({ DO_STORAGE: durable }, async () => {
    await db.schema.createTable('items', (table) => table.integer('id').unique());
    let release;
    let started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const first = db.transaction(async (trx) => {
      await trx('items').insert({ id: 1 });
      started();
      await held;
      await assert.rejects(
        trx.transaction(async (nested) => {
          await nested('items').insert({ id: 99 });
          throw new Error('Nested rollback');
        }),
        /Nested rollback/,
      );
    });
    await ready;
    const second = other.transaction((trx) => trx('items').insert({ id: 2 }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(topLevelEntries, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(topLevelEntries, 2);
    assert.deepEqual(
      (await db('items').orderBy('id')).map((row) => row.id),
      [1, 2],
    );
  });
  sqlite.close();
});
