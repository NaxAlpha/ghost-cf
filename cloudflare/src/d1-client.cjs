const SQLiteClient = require('knex/lib/dialects/sqlite3');
const { getBindings } = require('./context.cjs');

class D1TransactionUnsupportedError extends Error {
  constructor() {
    super(
      'Ghost interactive transactions cannot run on D1. Use an explicit atomic D1 batch; transaction callbacks must never be treated as independent writes.',
    );
    this.code = 'GHOST_CF_D1_TRANSACTION_UNSUPPORTED';
  }
}

function normalizeBinding(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return Number(value);
  if (value instanceof Date) return value.toISOString().replace('T', ' ').replace('Z', '');
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  if (typeof value === 'string' || typeof value === 'number' || value instanceof ArrayBuffer)
    return value;
  throw new TypeError('Unsupported D1 binding type');
}

// Retain Ghost's pinned SQLite query compiler and Bookshelf response shapes.
// Connections hold a request-owned binding, never an isolate-global binding.
class D1Client extends SQLiteClient {
  constructor(config = {}) {
    super({ ...config, connection: { filename: ':d1:' }, useNullAsDefault: true });
    // Ghost's DatabaseInfo selects dialect behavior from this value, rather
    // than from the compiler prototype. This driver implements SQLite SQL.
    this.config.client = 'sqlite3';
  }

  initializeDriver() {
    this.driver = {};
  }
  initializePool() {}
  async acquireConnection() {
    return { db: getBindings().DB };
  }
  async releaseConnection() {}
  async destroy() {}
  transaction() {
    throw new D1TransactionUnsupportedError();
  }

  async _query(connection, query) {
    if (!query.sql) throw new Error('The query is empty');
    const statement = connection.db
      .prepare(query.sql)
      .bind(...(query.bindings || []).map(normalizeBinding));
    const result = await statement.all();
    if (!result.success) throw new Error(result.error || 'D1 query failed');
    query.response = result.results;
    query.context = { lastID: result.meta.last_row_id, changes: result.meta.changes };
    return query;
  }
}

module.exports = { D1Client, D1TransactionUnsupportedError, normalizeBinding };
