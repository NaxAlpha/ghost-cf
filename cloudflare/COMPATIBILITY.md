# Compatibility status

Validated against the official Ghost 6.69.0 release on 2026-10-10. This is an
experimental port with a working public publication, not complete Ghost parity.

| Feature                    | Evidence and remaining work                                                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database                   | SQLite Durable Object; actual Ghost schema, migrations, transactions and model CRUD pass. D1 does not support Ghost's interactive transactions.                                          |
| Public publication         | Live homepage, published posts, RSS, sitemap and robots endpoint pass.                                                                                                                   |
| Admin                      | Real Chrome owner setup, staff sign-in, device verification, draft saving and publishing pass.                                                                                           |
| Member authentication      | Live signup mail, magic links and signed member identity pass.                                                                                                                           |
| Transactional mail         | Native Cloudflare Email Service and private Email Routing/R2 inbox work. Staff password reset also passes locally.                                                                       |
| Media                      | R2 upload/read/original and WebP resize pass. Broader format coverage, HEIC and image editing need verification.                                                                         |
| Themes                     | Actual uploaded-theme validation, activation, binary assets, ZIP download and restart persistence pass locally. Third-party Handlebars parity remains incomplete.                        |
| Scheduling                 | Native Durable Object alarm publishing and object-reset recovery pass.                                                                                                                   |
| Routes and redirects       | Persistent adapters work; production downloads pass.                                                                                                                                     |
| Export                     | Production data export passes; full import and version-upgrade migration coverage remain unfinished.                                                                                     |
| Social Web                 | Optional hosted Ghost backend passes registration, Admin onboarding, WebFinger and NodeInfo. Federation workflows and a Cloudflare-hosted backend remain unfinished.                     |
| Newsletters                | Mailgun provider configuration and live bulk delivery remain unfinished. Cloudflare transactional email is not a bulk-mail replacement.                                                  |
| Paid memberships and gifts | Stripe account configuration and end-to-end payment/webhook checks remain unfinished. Gift preview rendering passes.                                                                     |
| Analytics                  | Ghost's Tinybird/traffic analytics integration remains unconfigured. Native Cloudflare analytics adapters remain future work.                                                            |
| External integrations      | Trusted default HTTP works. User-supplied URLs still encounter unsupported custom DNS lookup; their SSRF protection has been preserved.                                                  |
| Free hosting               | The deployed Worker is about 7.8 MiB compressed, exceeding the 3 MiB free-plan limit. It uses an already-paid account. Free CPU viability and workload quotas have not been established. |
| Scale                      | One publication uses one database object and Ghost singleton. Read caching and measured database throughput still need work.                                                             |

The official release installer checks the published archive digest and uses its
frozen pnpm lockfile. Upstream source remains unchanged; platform adaptations are
applied by the build. Downloading `latest` does not prove compatibility with a
new release. Back up data and test upgrades privately before deploying them.

Keep bootstrap and inbox credentials outside Git. Owner creation stays private
after publication becomes public. Internal runtime files are not exposed. Inbox
messages are retained until explicitly deleted.
