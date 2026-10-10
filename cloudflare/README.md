# Ghost on Cloudflare

Experimental port of Ghost 6.69.0. **This branch does not yet run Ghost.** The
Worker currently exercises the platform adapters; it does not provide the blog,
Admin, members, newsletters, or Ghost APIs. Do not deploy it as a production blog.

Upstream Ghost is preserved. All port code lives in this directory, with its own
pnpm workspace. `upstream.json` records the release and commit being tested.

## Architecture

Use one SQLite Durable Object per publication for Ghost's transactional database,
Workers for HTTP, and R2 for persistent media. Public pages can be cached outside
the database object. Separate publications have separate objects; a single
publication's database remains a throughput constraint that needs benchmarking.

D1 is an alternative query adapter. It supports CRUD and atomic batches, but
rejects interactive Knex transactions before running their callback. Ghost uses
these transactions extensively, so D1 cannot currently be selected for full Ghost.

The Durable Object adapter delegates transaction commit and rollback to native
storage while preserving Knex's asynchronous transaction callback interface.
Nested transaction rollback has passed a remote test. Ghost migrations and full
model workflows still need verification.

## Verified foundation

Remote tests on Cloudflare passed on 2026-10-09:

- Express over the Workers Node HTTP bridge.
- Knex SQLite query compilation with D1 CRUD and atomic batch rollback.
- R2 writes, reads, and deletion through a Ghost-style storage contract.
- Durable Object async transaction commit, thrown and explicit rollback,
  20 concurrent increments without lost updates, and publication isolation.
- Actual Bookshelf model CRUD and Ghost's transaction-event plugin, including
  rollback on simulated native commit failure with no false commit event.
- All 99 upstream schema tables created using Ghost's unchanged table builder,
  plus foreign-key validation and nested rollback with outer commit.

Eleven local tests cover D1 queries, bindings, Bookshelf database identity, SQLite migration error codes,
R2 streaming and byte ranges, subdirectory URLs, and build-time Handlebars compilation. Type checking and both Worker probe bundles
pass. These checks do not establish full Ghost compatibility or throughput.
Test Workers, the current-account D1 database, and R2 bucket were deleted after
testing. Test names and credentials are deliberately absent from this repository.

## Development

Install pnpm, Node.js 22 or newer, and the beta Cloudflare `cf` CLI, then:

```sh
cd cloudflare
pnpm install
pnpm test
GHOST_CF_PROBE=do pnpm typecheck
GHOST_CF_PROBE=do cf deploy --dry-run
```

For a remote Durable Object probe, authenticate with `cf auth login`, create a
secret JSON file outside the repository with a random `TEST_TOKEN`, and choose a
unique Worker name:

```sh
GHOST_CF_PROBE=do GHOST_CF_WORKER_NAME=your-unique-probe \
  cf deploy --secrets-file /absolute/path/to/secrets.json
```

Send an authenticated POST to `/__test-do` using `Authorization: Bearer` followed
by the token. The response explicitly reports `ghostBooted: false`. Delete the
Worker with `cf workers delete your-unique-probe --force` after testing; this also
removes its Durable Object namespace. Never use an existing production name.

For the D1/R2 probe, create dedicated disposable resources with `cf`, set
`GHOST_CF_WORKER_NAME`, `GHOST_CF_DATABASE_NAME`, `GHOST_CF_DATABASE_ID`, and
`GHOST_CF_BUCKET_NAME`, then deploy without `GHOST_CF_PROBE=do`. POST `/__test`
with the same authentication. Delete the Worker, database, and bucket afterward.

`/__health` is public. All probe routes require the token. No user registration,
production data, or public content endpoints are implemented yet.

## Remaining work

A local full-release diagnostic bundle has reached Ghost's database migration
stage after loading configuration, Express, and Bookshelf. This diagnostic is
still under development and does not establish successful Ghost boot. The beta
`cf dev` runner currently fails with a code-generation error; production bundles
are being tested directly in the local Workers runtime.

1. Bundle and boot the official Ghost release with explicit platform seams for
   configuration, filesystem assets, dynamic dependencies, and failure handling.
2. Verify the real schema, migrations, Bookshelf models, and nested transactions.
3. Connect the verified R2 adapter-manager integration to full Ghost boot, and
   finish media HTTP parity.
4. Integrate precompiled themes and support theme uploads without request-time eval.
5. Replace native image transforms and durable background jobs; validate scheduled
   publishing, email, newsletters, webhooks, memberships, and payment integrations.
6. Run full blog/Admin/API workflows, migration tests, and throughput/CPU benchmarks.
7. Provide a reproducible release-based installer and document upstream upgrades.

Free operation is a target, not a promise. Workers, SQLite Durable Objects, D1,
and R2 have quotas, and Ghost's email, analytics, payments, and image processing
may need additional services. Full feature parity and free-tier CPU viability
have not been established.

To check the unchanged Ghost adapter manager against this R2 class:

```sh
GHOST_RELEASE_DIR=/absolute/path/to/installed/ghost pnpm storage:check
```
