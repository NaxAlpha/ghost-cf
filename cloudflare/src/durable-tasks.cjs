const { randomUUID } = require('node:crypto');

const PREFIX = 'ghost-cf:task:';
const INDEX = 'ghost-cf:task-index:';

class DurableTasks {
  constructor(storage) {
    this.storage = storage;
    this.handlers = new Map();
  }
  handle(kind, handler) {
    this.handlers.set(kind, handler);
  }
  async schedule(id, runAt, payload, repeat) {
    if (!Number.isFinite(runAt)) throw new TypeError('Invalid task time');
    return this.storage.transaction((transaction) =>
      this.writeTask(transaction, id, runAt, payload, repeat),
    );
  }
  async writeTask(transaction, id, runAt, payload, repeat) {
    const previous = await transaction.get(INDEX + id);
    if (previous) await transaction.delete(previous);
    const key = `${PREFIX}${String(Math.max(0, Math.floor(runAt))).padStart(16, '0')}:${id}`;
    await transaction.put(key, { id, runAt, payload, repeat, revision: randomUUID(), attempts: 0 });
    await transaction.put(INDEX + id, key);
    const alarm = await transaction.getAlarm();
    if (alarm === null || runAt < alarm)
      await transaction.setAlarm(Math.max(Date.now() + 1, runAt));
  }
  async has(id) {
    return Boolean(await this.storage.get(INDEX + id));
  }
  async cancel(id) {
    await this.storage.transaction(async (transaction) => {
      const key = await transaction.get(INDEX + id);
      if (key) await transaction.delete(key);
      await transaction.delete(INDEX + id);
    });
  }
  async run(now = Date.now()) {
    // Bound each wakeup; remaining due tasks cause a subsequent alarm.
    const tasks = await this.storage.list({ prefix: PREFIX, limit: 32 });
    for (const [key, task] of tasks) {
      if (task.runAt > now) break;
      const handler = this.handlers.get(task.payload.kind);
      try {
        if (!handler) throw new Error(`Task handler missing: ${task.payload.kind}`);
        await handler(task.payload);
        await this.storage.transaction(async (transaction) => {
          const current = await transaction.get(key);
          if (current?.revision !== task.revision) return;
          await transaction.delete(key);
          await transaction.delete(INDEX + task.id);
          if (task.repeat) {
            const next =
              task.repeat.kind === 'interval'
                ? now + task.repeat.ms
                : this.nextCron(task.repeat.cron, now);
            await this.writeTask(transaction, task.id, next, task.payload, task.repeat);
          }
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'ghost-cf.task.failed',
            kind: task.payload.kind,
            attempts: task.attempts + 1,
            message: error.message,
          }),
        );
        await this.storage.transaction(async (transaction) => {
          const current = await transaction.get(key);
          if (current?.revision !== task.revision) return;
          await transaction.delete(key);
          const retryAt = now + Math.min(3600000, 5000 * 2 ** Math.min(task.attempts, 10));
          const retryKey = `${PREFIX}${String(retryAt).padStart(16, '0')}:${task.id}`;
          await transaction.put(retryKey, {
            ...task,
            runAt: retryAt,
            attempts: task.attempts + 1,
          });
          await transaction.put(INDEX + task.id, retryKey);
        });
      }
    }
    await this.storage.transaction(async (transaction) => {
      const [entry] = await transaction.list({ prefix: PREFIX, limit: 1 });
      if (entry) await transaction.setAlarm(Math.max(Date.now() + 1, entry[1].runAt));
      else await transaction.deleteAlarm();
    });
  }
}

module.exports = { DurableTasks };
