const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const { getBindings } = require('./context.cjs');
const { safePath } = require('./r2-storage.cjs');

// The release builder supplies Ghost's own base classes and parsers. This
// avoids copying domain validation or depending on unpublished workspace packages.
function createGhostAdapters({
  RouteFileStore,
  RedirectsStoreBase,
  SchedulingBase,
  JobsBackendBase,
  defaultRoutes,
  later,
}) {
  class DurableRoutes extends RouteFileStore {
    key(filename) {
      const relative = path.relative(this.basePath, filename);
      return 'ghost-cf:routes:' + safePath(relative);
    }
    async readIfExists(filename) {
      return (await getBindings().DO_STORAGE.get(this.key(filename))) ?? null;
    }
    async readDefaultSettings() {
      return defaultRoutes;
    }
    async writeAtomic(filename, content) {
      await getBindings().DO_STORAGE.put(this.key(filename), content);
    }
  }
  class DurableRedirects extends RedirectsStoreBase {
    async getAll() {
      return (await getBindings().DO_STORAGE.get('ghost-cf:redirects')) ?? [];
    }
    async replaceAll(redirects) {
      const storage = getBindings().DO_STORAGE;
      await storage.transaction(async (transaction) => {
        const previous = await transaction.get('ghost-cf:redirects');
        if (previous) await transaction.put('ghost-cf:redirects-backup:' + randomUUID(), previous);
        await transaction.put('ghost-cf:redirects', redirects);
      });
    }
  }
  function scheduledId(job) {
    const url = new URL(job.url);
    url.searchParams.delete('token');
    return (
      'scheduled:' +
      createHash('sha256')
        .update(url.toString() + '\0' + new Date(job.time).toISOString())
        .digest('hex')
    );
  }
  class DurableScheduling extends SchedulingBase {
    rescheduleOnBoot = true;
    run() {
      getBindings().TASKS.handle('scheduled', async ({ job }) => {
        const method = job.extra?.httpMethod || 'PUT';
        const url = new URL(job.url);
        const headers = {};
        if (job.extra?.idempotencyKey) headers['Idempotency-Key'] = job.extra.idempotencyKey;
        let body;
        if (method === 'GET') url.searchParams.set('force', 'true');
        else {
          body = JSON.stringify({ force: true });
          headers['Content-Type'] = 'application/json';
        }
        const request = new Request(url, { method, headers, body });
        const response = await getBindings().INTERNAL_FETCH(request);
        await response.body?.cancel();
        if (!response.ok && response.status !== 404)
          throw new Error(`Scheduled Ghost request failed: ${response.status}`);
      });
    }
    async schedule(job) {
      await getBindings().TASKS.schedule(scheduledId(job), new Date(job.time).valueOf(), {
        kind: 'scheduled',
        job,
      });
    }
    async unschedule(job, options) {
      if (!options?.bootstrap) await getBindings().TASKS.cancel(scheduledId(job));
    }
  }
  class DurableJobs extends JobsBackendBase {
    start({ processor, queues = {} }) {
      for (const [name, settings] of Object.entries(queues)) {
        if (
          settings.concurrency !== undefined &&
          (!Number.isInteger(settings.concurrency) || settings.concurrency < 1)
        )
          throw new Error(`Invalid concurrency for queue ${name}`);
      }
      this.processor = processor;
      this.stopped = false;
      const tasks = getBindings().TASKS;
      tasks.handle('job', ({ envelope }) => processor(envelope));
      tasks.nextCron = (cron, now) => {
        const schedule = later.parse.cron(cron, cron.trim().split(/\s+/).length >= 6);
        const next = later.schedule(schedule).next(1, new Date(now + 1000));
        if (!(next instanceof Date)) throw new Error('Cron schedule has no next occurrence');
        return next.valueOf();
      };
    }
    assertStarted() {
      if (!this.processor) throw new Error('Ghost jobs backend has not started');
    }
    async enqueue(envelope, routing) {
      if (this.stopped) return;
      this.assertStarted();
      await getBindings().TASKS.schedule('job:' + randomUUID(), Date.now(), {
        kind: 'job',
        envelope,
        routing,
      });
    }
    async scheduleRecurring(envelope, { cron }, routing) {
      if (this.stopped) return;
      this.assertStarted();
      const tasks = getBindings().TASKS;
      const id = 'recurring:' + envelope.type;
      if (await tasks.has(id)) return;
      await tasks.schedule(
        id,
        tasks.nextCron(cron, Date.now()),
        { kind: 'job', envelope, routing },
        { kind: 'cron', cron },
      );
    }
    async shutdown() {
      this.stopped = true;
    }
  }
  return { DurableRoutes, DurableRedirects, DurableScheduling, DurableJobs };
}

module.exports = { createGhostAdapters };
