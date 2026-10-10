# Private admin inbox

This optional standalone Email Routing Worker receives mail for one configured
Ghost owner address. It stores raw MIME messages in a dedicated private R2 bucket.
It does not forward mail or send replies. Mail is retained until explicitly deleted.

Set `GHOST_CF_INBOX_WORKER`, `GHOST_CF_INBOX_BUCKET`,
`GHOST_CF_INBOX_ADDRESS`, and `CLOUDFLARE_ACCOUNT_ID`. Create the named R2 bucket
with `cf r2 buckets create`. From this directory, deploy with
`cf deploy --secrets-file /absolute/path/to/private-secrets.json`; the private
JSON file must contain a randomly generated `INBOX_TOKEN`. Keep that file out of Git.

Inspect existing domain DNS and routing before enabling Email Routing with
`cf email-routing enable`. Create a literal `to` rule for the owner address with
a `worker` action targeting the deployed Worker. Preserve existing rules and mail
providers; enabling routing installs receiving MX records.

All HTTP operations require `Authorization: Bearer <INBOX_TOKEN>`:

- `GET /messages` lists up to 100 IDs; `?cursor=...` continues pagination.
- `GET /messages/<id>` returns raw MIME as plain text, without executing HTML.
- `DELETE /messages/<id>` permanently deletes the selected message.

The Worker rejects other recipients and messages larger than 5 MiB. It awaits
storage before returning from delivery. HTTP responses disable caching. Keep
inbox tokens separate from Ghost passwords, and never publish verification links
or log incoming messages. This API is an operational inbox, not a full mail client.
