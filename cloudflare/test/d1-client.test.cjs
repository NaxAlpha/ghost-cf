const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const knex = require('knex');
const { D1Client, normalizeBinding } = require('../src/d1-client.cjs');
const { withBindings, getBindings } = require('../src/context.cjs');

function database() {
  const sqlite = new DatabaseSync(':memory:');
  const DB = {
    prepare(sql) {
      let bindings = [];
      return {
        bind(...values) {
          bindings = values;
          return this;
        },
        async all() {
          const statement = sqlite.prepare(sql);
          const results = statement.columns().length ? statement.all(...bindings) : [];
          const meta = statement.columns().length
            ? { changes: 0, last_row_id: 0 }
            : statement.run(...bindings);
          return {
            success: true,
            results,
            meta: {
              changes: Number(meta.changes || 0),
              last_row_id: Number(meta.lastInsertRowid || 0),
            },
          };
        },
      };
    },
  };
  return { DB, sqlite };
}

test('retains Knex SQLite CRUD response shapes without a native driver', async () => {
  const { DB, sqlite } = database();
  const db = knex({ client: D1Client });
  await withBindings({ DB }, async () => {
    await db.schema.createTable('posts', (table) => {
      table.increments('id');
      table.string('title');
      table.boolean('published');
    });
    assert.deepEqual(await db('posts').insert({ title: 'Ghost on Workers', published: true }), [1]);
    assert.equal((await db('posts').first()).title, 'Ghost on Workers');
    assert.equal(await db('posts').where({ id: 1 }).update({ title: 'Updated' }), 1);
    assert.deepEqual(await db('posts').pluck('title'), ['Updated']);
    assert.equal(await db('posts').where({ id: 1 }).del(), 1);
    assert.equal((await db('posts')).length, 0);
  });
  sqlite.close();
});

test('rejects interactive transactions before running any callback or writes', () => {
  const db = knex({ client: D1Client });
  let called = false;
  assert.throws(
    () =>
      db.transaction(() => {
        called = true;
      }),
    { code: 'GHOST_CF_D1_TRANSACTION_UNSUPPORTED' },
  );
  assert.equal(called, false);
});

test('isolates bindings across concurrent request contexts', async () => {
  const db = knex({ client: D1Client });
  const left = database();
  const right = database();
  await Promise.all(
    [left, right].map(({ DB }, i) =>
      withBindings({ DB }, async () => {
        await db.schema.createTable('values_table', (table) => table.integer('value'));
        await db('values_table').insert({ value: i });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal((await db('values_table').first()).value, i);
      }),
    ),
  );
  assert.throws(getBindings, /inside a request/);
  left.sqlite.close();
  right.sqlite.close();
});

test('normalizes scalar and sliced binary bindings without unrelated bytes', () => {
  assert.equal(normalizeBinding(true), 1);
  assert.equal(normalizeBinding(undefined), null);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  assert.deepEqual([...new Uint8Array(normalizeBinding(bytes.subarray(1, 3)))], [2, 3]);
  assert.throws(() => normalizeBinding({}), /Unsupported/);
});
