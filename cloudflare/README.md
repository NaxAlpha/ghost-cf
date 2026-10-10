# Ghost on Cloudflare

Experimental port of Ghost 6.69.0. **Full Ghost boot and core publishing work on Cloudflare Workers.**
The full site bootstrap is experimental; feature parity and production readiness
are still being verified. The default project remains an adapter probe.

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

Thirty-two local tests cover D1 queries, bindings, Bookshelf database identity, SQLite migration error codes,
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

A local full-release diagnostic bundle now completes Ghost 6.69.0 boot with the
frontend and backend enabled. The homepage, Admin HTML, site API, RSS, and sitemap
return HTTP 200 in the production Workers runtime. Owner onboarding and login return HTTP 201. Authenticated draft creation,
publishing, and rendering the resulting public post pass locally, as do the tags,
members, newsletters, tiers, and settings read APIs. Image uploads through the Admin API and byte-for-byte R2 retrieval also pass.
Admin JavaScript and CSS delivery, native alarm scheduled publishing, and
published-content persistence across complete runtime restart pass locally.
Real browser publishing and production staff/member authentication also pass.
Complete feature parity, integrations, free-tier compatibility and throughput
remain unfinished. The beta
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

## Release bundle diagnostic

Build an installed official Ghost release without editing its source files:

```sh
node scripts/build-ghost.cjs /absolute/path/to/installed/ghost ./artifacts/ghost
```

The builder links migrations, internal apps, theme checks, and adapters statically;
preserves class names used by Ghost events; precompiles bundled Handlebars views;
and imports precompiled Undici WASM. It precompiles the upstream Admin JSON
schemas with their defaults and validation behavior, and schedules Bluebird
callbacks with native Promises to work within Durable Object transaction gates. The result requires a Worker bootstrap that
provides configuration, filesystem assets, bindings, and the HTTP bridge. That
bootstrap is available in `site/`; it is still experimental. This command alone
is not a deployment installer.
Uploaded themes use an AST interpreter for newly uploaded Handlebars templates,
while bundled templates remain precompiled. Upstream theme validation remains
enabled. Theme files persist in R2 with manifests in SQLite Durable Object
storage and restore before Ghost boots. Local upload, activation, rendering,
ZIP download, binary asset delivery, and complete runtime restart pass. Broad
third-party theme compatibility still needs verification.

The unchanged gift image renderer produces a valid 1200×630 PNG in a remote
Worker. Cloudflare Images supplies raster composition and text, with a statically
linked Resvg WASM module rasterizing SVG overlays. Exact font-weight parity and
the complete gift purchase flow still need verification.

SQLite bulk inserts use modern VALUES statements and pack large scalar binding
sets into one JSON parameter, retaining statement atomicity. Durable task records
retain retries, cancellation, recurrence, and identity across object recreation.
The jobs and routes adapters inherit Ghost's own base classes supplied by the
release builder. Cloudflare Images replaces ordinary native image resizing; its
full image and gift workflow remains to be verified.

Remote full-site testing also passed owner setup, login, publishing, public post
rendering, Admin asset delivery, R2 upload and byte-for-byte retrieval, original
image retrieval, WebP transformation, and native scheduled publishing after
redeployment on 2026-10-10. These checks used an
already-paid account; they do not prove complete feature parity or free hosting.

## Experimental full site

Use an installed official release containing its runtime dependencies, bundled
themes, and built Admin assets. From this directory:

```sh
node scripts/install-release.cjs /absolute/path/to/new/ghost-release
node scripts/build-ghost.cjs /absolute/path/to/installed/ghost artifacts/ghost
node scripts/prepare-assets.cjs /absolute/path/to/installed/ghost artifacts/ghost https://your-test-worker.your-subdomain.workers.dev
cd site
GHOST_CF_WORKER_NAME=your-unique-test-worker GHOST_CF_BUCKET_NAME=your-dedicated-bucket cf deploy --dry-run
```

The installer defaults to the tested version in `upstream.json`. It downloads the
official GitHub release, checks GitHub's SHA-256 digest, refuses existing output
directories, and installs production dependencies with the unchanged frozen pnpm
lockfile. Native dependency build scripts are unnecessary for this port and are
disabled. Pass a version or `latest` as the second argument to fetch another
release; downloading a newer release does not establish compatibility. Build and
validate it privately before updating the publication.

The builder resolves package files canonically for pnpm's isolated layout,
resolves AJV through the upstream schema package, and hydrates the filesystem
assets at their actual virtual paths. A fresh official-release installation passes
local boot, schema, staff/member authentication, publishing, R2 media, uploaded
themes and restart checks. pnpm deduplication reduces the compressed Ghost bundle
from about 8.2 MiB to 7.5 MiB; it still exceeds the free-plan limit.

Set `CLOUDFLARE_ACCOUNT_ID` to select the intended account. Create the dedicated
bucket using `cf`, then deploy with `--secrets-file` pointing to a private JSON
file containing a random `TEST_TOKEN`. Every request requires the
`X-Ghost-CF-Test` header. Browser access requires a test client that supplies it.
Never reuse a production Worker or bucket name for disposable testing.

The site uses one Worker and one SQLite Durable Object per publication. It
hydrates release assets, including binary theme files, into ephemeral storage;
media persists in R2, while routing settings and background tasks persist in
Durable Object storage. Admin assets use Workers Static Assets. Owner welcome
email is disabled until mail transport is configured.

Ghost's app and task handlers survive object recreation within an isolate, while
each instance restores ephemeral files and uses its live storage handle. Local
explicit object-reset checks pass uploaded-theme rendering and native alarm
publication; a subsequent complete runtime restart retains the theme and post.

The current full bundle exceeds the Workers free-plan size limit. A deployment
on an already-paid account is not evidence of free-tier compatibility. Outgoing
HTTP integrations and complete feature parity remain unfinished. Real Chrome
checks pass owner creation, native email device verification, authenticated
Admin, draft saving, publication, and public rendering. Live checks also pass
member signup email, magic-link verification, signed member sessions, data export,
route and redirect downloads, feeds, and sitemaps.

After initializing the owner privately, set `GHOST_CF_PUBLIC=true` to serve the
publication without the test header. Set `GHOST_CF_DOMAIN` to attach a custom
domain only when ready to replace its current site. An existing Worker route can
take precedence over the custom domain; `GHOST_CF_ROUTE` adds a specific fetch
route without changing other hostnames. Owner creation still requires
the private header, and internal runtime assets are blocked in both modes. Keep
the bootstrap token private; Ghost handles normal staff and member authentication.

## Transactional email

An optional [private admin inbox](inbox/README.md) receives owner authentication
mail through Email Routing into R2. Its HTTP API requires a separate secret.

Set `GHOST_CF_MAIL_FROM` to a sender address on a domain onboarded to Cloudflare
Email Service when running both `prepare-assets.cjs` and the site build or
deployment. This selects Ghost's `cloudflare` transport and adds the native
`EMAIL` binding. The transport preserves named recipients, reply addresses,
allowed custom headers, in-memory attachments, and provider delivery errors.
Ghost's HTML mail templates compile at build time, avoiding runtime code
generation; notification text templates are linked statically.

Local end-to-end checks pass password-reset email generation, password changes,
staff device-verification email and code verification, member signup email,
signup-link verification, and signed member identity sessions. Messages are
accepted by the native local email simulator; a test-only capture checks their
HTML and text without real delivery. A real transactional delivery check passed
through Email Routing into the private inbox, including authenticated retrieval.
Real Chrome staff sign-in passes native delivery into the private inbox and code
verification. Member mail must use a sender on the onboarded domain; a default
sender derived from a `workers.dev` test hostname cannot send. Ghost's remaining
live mail workflows still need verification. Cloudflare Email Service is for transactional messages; Ghost
newsletters still require a supported bulk-mail provider. Do not configure a
real sender for disposable tests unless delivery is intended.

Ghost's trusted integration HTTP client also fetches external HTTPS in Workers
after delegating its default DNS resolution to the platform. The separate
`request-external` DNS checks used for user-supplied URLs are preserved and still
need a compatible secure transport before those integrations work.

## Social Web

Set `GHOST_CF_ACTIVITYPUB_ORIGIN` to the HTTPS origin of a compatible ActivityPub
backend. Only `/.ghost/activitypub/`, WebFinger, and NodeInfo requests are proxied.
Ghost identity authorization is forwarded; staff cookies and the bootstrap token
are removed. The proxy replaces untrusted forwarding headers with the request's
publication hostname and Cloudflare client address.

Ghost's [hosted service](https://docs.ghost.org/hosting/#hosted-activitypub-usage-limits)
at `https://ap.ghost.org` is an optional external dependency. Its use requires
accepting Ghost's published limits and sending Social Web requests to that
service. Live checks pass registration, authenticated Admin onboarding, WebFinger,
and NodeInfo. This does not establish federation parity or provide a
Cloudflare-hosted ActivityPub backend.
