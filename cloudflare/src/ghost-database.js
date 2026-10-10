import { DurableObject } from 'cloudflare:workers';
import context from './context.cjs';
import durable from './durable-client.cjs';
import bookshelf from 'bookshelf';
import transactionEvents from '@tryghost/bookshelf-transaction-events';

const { withBindings } = context;
const { createDurableDatabase } = durable;

// One object per publication, rather than a global database for all sites.
export class GhostDatabase extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS probe_counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL); INSERT OR IGNORE INTO probe_counter VALUES (1, 0);',
      );
    });
  }
  async increment() {
    return withBindings({ DO_STORAGE: this.ctx.storage }, async () => {
      const db = createDurableDatabase();
      return db.transaction(async (trx) => {
        const current = await trx('probe_counter').where({ id: 1 }).first();
        await Promise.resolve();
        await trx('probe_counter')
          .where({ id: 1 })
          .update({ value: current.value + 1 });
        return current.value + 1;
      });
    });
  }
  async checks() {
    return withBindings({ DO_STORAGE: this.ctx.storage }, async () => {
      const db = createDurableDatabase();
      const checks = {};
      await db('probe_counter').where({ id: 1 }).update({ value: 0 });
      const result = await db.transaction(async (trx) => {
        const row = await trx('probe_counter').where({ id: 1 }).first();
        await trx('probe_counter')
          .where({ id: 1 })
          .update({ value: row.value + 1 });
        return 'committed';
      });
      checks.asyncCommit =
        result === 'committed' && (await db('probe_counter').first()).value === 1;
      try {
        await db.transaction(async (trx) => {
          await trx('probe_counter').where({ id: 1 }).update({ value: 99 });
          await Promise.resolve();
          throw new Error('rollback probe');
        });
      } catch (error) {
        checks.asyncRollback =
          error.message === 'rollback probe' && (await db('probe_counter').first()).value === 1;
      }
      await db.transaction(async (trx) => {
        await trx('probe_counter').where({ id: 1 }).update({ value: 88 });
        await trx.rollback();
      });
      checks.explicitRollback = (await db('probe_counter').first()).value === 1;
      await db.transaction(async (outer) => {
        await outer('probe_counter').where({ id: 1 }).update({ value: 2 });
        try {
          await outer.transaction(async (inner) => {
            await inner('probe_counter').where({ id: 1 }).update({ value: 3 });
            throw new Error('nested rollback probe');
          });
        } catch (error) {
          if (error.message !== 'nested rollback probe') throw error;
        }
        checks.nestedRollback = (await outer('probe_counter').first()).value === 2;
      });
      checks.outerCommitAfterNestedRollback = (await db('probe_counter').first()).value === 2;
      await db('probe_counter').where({ id: 1 }).update({ value: 0 });
      return checks;
    });
  }
  value() {
    return this.ctx.storage.sql.exec('SELECT value FROM probe_counter WHERE id = 1').one().value;
  }
  async checkTransactionEvents() {
    const storage = this.ctx.storage;
    let settled = false;
    let failCommit = false;
    const binding = {
      sql: storage.sql,
      transaction: (callback) =>
        storage
          .transaction(async () => {
            const result = await callback();
            if (failCommit) throw new Error('native commit failure probe');
            return result;
          })
          .then(
            (value) => {
              settled = true;
              return value;
            },
            (error) => {
              settled = true;
              throw error;
            },
          ),
    };
    return withBindings({ DO_STORAGE: binding }, async () => {
      const db = createDurableDatabase();
      const models = bookshelf(db);
      models.plugin(transactionEvents);
      const Counter = models.Model.extend({ tableName: 'probe_counter' });
      const checks = {};
      await db('probe_counter').where({ id: 1 }).update({ value: 0 });
      let eventAfterCommit = false;
      await models.transaction(async (trx) => {
        trx.on('committed', (success) => {
          eventAfterCommit = success && settled;
        });
        const counter = await Counter.forge({ id: 1 }).fetch({ transacting: trx });
        await counter.save({ value: 1 }, { transacting: trx, method: 'update' });
      });
      checks.bookshelfCrud = (await Counter.forge({ id: 1 }).fetch()).get('value') === 1;
      checks.eventsAfterNativeCommit = eventAfterCommit;
      settled = false;
      failCommit = true;
      let reportedCommitted = false;
      try {
        await models.transaction(async (trx) => {
          trx.on('committed', (success) => {
            if (success) reportedCommitted = true;
          });
          await trx('probe_counter').where({ id: 1 }).update({ value: 99 });
        });
      } catch (error) {
        checks.nativeCommitFailureRollback =
          error.message === 'native commit failure probe' &&
          (await db('probe_counter').first()).value === 1;
      }
      checks.noFalseCommitEvent = !reportedCommitted;
      await db('probe_counter').where({ id: 1 }).update({ value: 0 });
      return checks;
    });
  }
  async checkSchema(schema) {
    return withBindings({ DO_STORAGE: this.ctx.storage }, async () => {
      const db = createDurableDatabase();
      await db.transaction(async (trx) => {
        for (const query of schema.queries) await trx.raw(query);
      });
      const tables = (await db('sqlite_master').where({ type: 'table' }).select('name')).map(
        (row) => row.name,
      );
      return {
        schemaVersion: schema.version,
        schemaTables: schema.tables.length,
        schemaCreated: schema.tables.every((name) => tables.includes(name)),
        foreignKeysValid: (await db.raw('PRAGMA foreign_key_check')).length === 0,
      };
    });
  }
  async reset() {
    await this.ctx.storage.deleteAll();
  }
}
