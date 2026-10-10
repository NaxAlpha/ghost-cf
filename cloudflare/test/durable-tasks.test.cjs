const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DurableTasks } = require('../src/durable-tasks.cjs');

function storage() {
  const data = new Map();
  let alarm = null;
  let active = false;
  const root = {
    data,
    async get(key) {
      return structuredClone(data.get(key));
    },
    async put(key, value) {
      data.set(key, structuredClone(value));
    },
    async delete(key) {
      data.delete(key);
    },
    async list({ prefix, limit }) {
      return new Map(
        [...data]
          .filter(([key]) => key.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, limit),
      );
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(time) {
      alarm = time;
    },
    async deleteAlarm() {
      alarm = null;
    },
    async transaction(callback) {
      const snapshot = structuredClone(data);
      const originalAlarm = alarm;
      try {
        if (active) throw new Error('Nested root KV transaction');
        active = true;
        return await callback(scope);
      } catch (error) {
        data.clear();
        for (const [key, value] of snapshot) data.set(key, value);
        alarm = originalAlarm;
        throw error;
      } finally {
        active = false;
      }
    },
  };
  const scope = {};
  for (const name of ['get', 'put', 'delete', 'list', 'getAlarm', 'setAlarm', 'deleteAlarm']) {
    const method = root[name].bind(root);
    scope[name] = method;
    root[name] = (...args) => {
      if (active) throw new Error('Root KV operation inside transaction: ' + name);
      return method(...args);
    };
  }
  return root;
}

test('delivers persisted tasks after object recreation and clears their alarm', async () => {
  const durable = storage();
  const now = Date.now();
  await new DurableTasks(durable).schedule('one', now, { kind: 'job', value: 42 });
  const resumed = new DurableTasks(durable);
  const delivered = [];
  resumed.handle('job', async (payload) => delivered.push(payload.value));
  await resumed.run(now + 1);
  assert.deepEqual(delivered, [42]);
  assert.equal(durable.data.size, 0);
  assert.equal(await durable.getAlarm(), null);
});

test('retains failures for retry and honors cancellation across recreation', async () => {
  const durable = storage();
  const now = Date.now();
  const first = new DurableTasks(durable);
  first.handle('job', async () => {
    throw new Error('Temporary failure');
  });
  await first.schedule('retry', now, { kind: 'job' });
  await first.schedule('cancelled', now + 100, { kind: 'job' });
  await first.cancel('cancelled');
  await first.run(now);
  assert.equal(await first.has('retry'), true);
  assert.equal(await first.has('cancelled'), false);
  const resumed = new DurableTasks(durable);
  let calls = 0;
  resumed.handle('job', async () => calls++);
  await resumed.run(now + 6000);
  assert.equal(calls, 1);
  assert.equal(durable.data.size, 0);
});

test('preserves a replacement scheduled while the old task is being delivered', async () => {
  const durable = storage();
  const now = Date.now();
  const tasks = new DurableTasks(durable);
  const values = [];
  tasks.handle('job', async ({ value }) => {
    values.push(value);
    if (value === 1) await tasks.schedule('same', now + 1000, { kind: 'job', value: 2 });
  });
  await tasks.schedule('same', now, { kind: 'job', value: 1 });
  await tasks.run(now);
  assert.equal(await tasks.has('same'), true);
  await tasks.run(now + 1001);
  assert.deepEqual(values, [1, 2]);
  assert.equal(durable.data.size, 0);
});

test('reschedules recurring work durably and limits each alarm batch', async () => {
  const durable = storage();
  const now = Date.now();
  const tasks = new DurableTasks(durable);
  let calls = 0;
  tasks.handle('job', async () => calls++);
  tasks.nextCron = () => now + 60000;
  await tasks.schedule('recurring', now, { kind: 'job' }, { kind: 'cron', cron: '* * * * *' });
  for (let index = 0; index < 40; index++)
    await tasks.schedule('item-' + index, now, { kind: 'job' });
  await tasks.run(now);
  assert.equal(calls, 32);
  await tasks.run(now + 1);
  assert.equal(calls, 41);
  assert.equal(await tasks.has('recurring'), true);
  assert.equal(await durable.getAlarm(), now + 60000);
});
