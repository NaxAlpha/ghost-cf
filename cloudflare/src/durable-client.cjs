const Transaction = require('knex/lib/dialects/sqlite3/execution/sqlite-transaction');
const makeKnex = require('knex/lib/knex-builder/make-knex');
const { D1Client } = require('./d1-client.cjs');
const { compactBindings } = require('./sql-bindings.cjs');
const { DurableQueryCompiler } = require('./durable-querycompiler.cjs');
const { getBindings } = require('./context.cjs');
const storageQueues = new WeakMap();
function storageQueue(storage) {
  let queue = storageQueues.get(storage);
  if (!queue) {
    queue = { tail: Promise.resolve() };
    storageQueues.set(storage, queue);
  }
  return queue;
}

class ExplicitRollback extends Error {}

// Storage owns commit and rollback; Knex retains its transactor API.
class DurableTransaction extends Transaction {
  async _evaluateContainer(config, container) {
    const storage = getBindings().DO_STORAGE;
    const queue = storageQueue(storage);
    let release;
    if (!this.outerTx) {
      const previous = queue.tail;
      queue.tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
    }
    try {
      this._nativeTransaction = storage.transaction(() =>
        super._evaluateContainer(config, container),
      );
      return await this._nativeTransaction;
    } catch (error) {
      if (error instanceof ExplicitRollback && this.doNotRejectOnRollback) return undefined;
      throw error;
    } finally {
      release?.();
    }
  }
  async begin() {}
  async savepoint() {}
  async commit(_connection, value) {
    this._completed = true;
    this._resolver(value);
    await this._nativeTransaction;
  }
  async release(connection, value) {
    return this.commit(connection, value);
  }
  async rollback(_connection, error) {
    this._completed = true;
    this._rejecter(error === undefined ? new ExplicitRollback('Explicit rollback') : error);
    // Ghost's transaction-events plugin awaits rollback before emitting. Preserve
    // its resolved return value while the transaction itself rejects to callers.
    await this._nativeTransaction.catch(() => undefined);
  }
  async rollbackTo(connection, error) {
    return this.rollback(connection, error);
  }
}

class DurableClient extends D1Client {
  queryCompiler(builder, formatter) {
    return new DurableQueryCompiler(this, builder, formatter);
  }
  async acquireConnection() {
    return { storage: getBindings().DO_STORAGE };
  }
  transaction() {
    return new DurableTransaction(this, ...arguments);
  }
  async _query(connection, query) {
    if (!query.sql) throw new Error('The query is empty');
    const sql = connection.storage.sql;
    const statement = compactBindings(query.sql, query.bindings || []);
    let cursor;
    try {
      cursor = sql.exec(statement.sql, ...statement.bindings);
    } catch (error) {
      // Ghost's migrator distinguishes an uninitialized database using the
      // native SQLite code. Workers puts that code in the error message.
      const code = error.message?.match(/\b(SQLITE_[A-Z_]+)\b/)?.[1];
      if (code && !error.code) error.code = code;
      throw error;
    }
    // Consume synchronously: a cursor retained across await is not a snapshot.
    query.response = cursor.toArray();
    query.context = sql.exec('SELECT last_insert_rowid() AS lastID, changes() AS changes').one();
    return query;
  }
}

function createDurableDatabase(config = {}) {
  const database = makeKnex(new DurableClient({ ...config, client: DurableClient }));
  // Bookshelf validates this public function name, including in minified builds.
  Object.defineProperty(database, 'name', { value: 'knex' });
  return database;
}
module.exports = { DurableClient, createDurableDatabase };
