import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { handleAsNodeRequest } from 'cloudflare:node';
import express from 'express';
import context from './context.cjs';
import database from './knex.cjs';
import storage from './r2-storage.cjs';
export { GhostDatabase } from './ghost-database.js';

const { withBindings } = context;
const { createDatabase } = database;
const { R2Storage } = storage;
const app = express();
app.disable('x-powered-by');
app.get('/__http', (req, res) => res.json({ nodeHttp: true, express: true, method: req.method }));
const server = createServer(app);
server.listen(2368);

function authorized(request, token) {
  if (!token) return false;
  const supplied = Buffer.from(request.headers.get('Authorization') || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function runChecks(env) {
  const db = createDatabase();
  const table = `ghost_cf_probe_${randomUUID().replaceAll('-', '')}`;
  const media = new R2Storage();
  const key = `probe/${randomUUID()}.txt`;
  const checks = {};
  try {
    await db.schema.createTable(table, (t) => {
      t.increments('id');
      t.string('title').unique();
    });
    const ids = await db(table).insert({ title: 'Ghost query compiler on D1' });
    checks.insert = ids.length === 1;
    checks.read = (await db(table).first()).title === 'Ghost query compiler on D1';
    checks.update = (await db(table).update({ title: 'Updated' })) === 1;
    checks.delete = (await db(table).del()) === 1;
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO ${table} (title) VALUES (?)`).bind('duplicate'),
        env.DB.prepare(`INSERT INTO ${table} (title) VALUES (?)`).bind('duplicate'),
      ]);
      checks.batchRollback = false;
    } catch {
      checks.batchRollback = (await db(table)).length === 0;
    }
    try {
      db.transaction(() => {
        throw new Error('Must not run');
      });
      checks.interactiveTransactionsRejected = false;
    } catch (error) {
      checks.interactiveTransactionsRejected = error.code === 'GHOST_CF_D1_TRANSACTION_UNSUPPORTED';
    }
    await media.saveRaw(Buffer.from('Ghost media on R2'), key);
    checks.r2ReadWrite = (await media.read({ path: key })).toString() === 'Ghost media on R2';
    await media.delete(key);
    checks.r2Delete = !(await media.exists(key));
  } finally {
    await media.delete(key);
    await db.schema.dropTableIfExists(table);
  }
  return checks;
}

export default {
  async fetch(request, env, ctx) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/__health') {
      return Response.json({
        project: 'ghost-cf',
        status: 'experimental-platform-probe',
        ghostBooted: false,
      });
    }
    if (!authorized(request, env.TEST_TOKEN)) return new Response('Not found', { status: 404 });
    if (pathname === '/__test-do' && request.method === 'POST') {
      const name = `probe-${randomUUID()}`;
      const site = ctx.exports.GhostDatabase.getByName(name);
      const other = ctx.exports.GhostDatabase.getByName(`${name}-other`);
      try {
        const checks = await site.checks();
        Object.assign(checks, await site.checkTransactionEvents());
        if (request.headers.get('content-type')?.includes('application/json')) {
          const schema = await request.json();
          if (!Array.isArray(schema.queries) || !Array.isArray(schema.tables)) {
            return Response.json(
              { passed: false, message: 'Invalid schema probe' },
              { status: 400 },
            );
          }
          const result = await site.checkSchema(schema);
          checks.schemaCreated = result.schemaCreated;
          checks.foreignKeysValid = result.foreignKeysValid;
        }
        await Promise.all(Array.from({ length: 20 }, () => site.increment()));
        checks.concurrentIncrements = (await site.value()) === 20;
        checks.publicationIsolation = (await other.value()) === 0;
        return Response.json({
          passed: Object.values(checks).every(Boolean),
          checks,
          ghostBooted: false,
        });
      } catch (error) {
        console.error(error);
        return Response.json({ passed: false, message: error.message }, { status: 500 });
      } finally {
        await site.reset();
        await other.reset();
      }
    }
    return withBindings(env, async () => {
      if (pathname === '/__http') return handleAsNodeRequest(2368, request);
      if (pathname !== '/__test' || request.method !== 'POST')
        return new Response('Not found', { status: 404 });
      try {
        const checks = await runChecks(env);
        const passed = Object.values(checks).every(Boolean);
        console.log(JSON.stringify({ event: 'platform-probe', passed, checks }));
        return Response.json(
          { passed, checks, ghostBooted: false },
          { status: passed ? 200 : 500 },
        );
      } catch (error) {
        console.error(JSON.stringify({ event: 'platform-probe-failed', message: error.message }));
        return Response.json({ passed: false, message: error.message }, { status: 500 });
      }
    });
  },
};
