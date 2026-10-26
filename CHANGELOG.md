# Changelog

All notable changes to Sparkfly are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-10-26

First release. Sparkfly turns Firefly III transactions into SparkyFitness
diary entries through signed Firefly webhooks.

### Webhooks and processing
- `POST /hooks/firefly` verifies Firefly's HMAC-SHA3-256 signature, stores the
  delivery and replies `202` at once; processing runs on an in-process queue
  with exponential backoff, so SparkyFitness being down loses nothing.
- Redeliveries are deduped on the webhook `uuid`; pending and failed events are
  picked up again after a restart.
- `STORE_TRANSACTION` logs a saved meal, a single food or several foods per
  matching rule. `UPDATE_TRANSACTION` re-runs the rules and updates, replaces
  or deletes the linked entries; `DESTROY_TRANSACTION` deletes them.
- Events that exhaust their retry budget are marked `dead` and can be retried
  from the UI.
- Dates are converted to `TZ` before picking the entry date/time, weekday and
  time filters and the automatic meal type.
- `DRY_RUN=true` evaluates everything without writing to SparkyFitness.

### Rules
- Match on type, source, destination, description, category, budget,
  currency, amount range, tags, weekdays and a time window; exact or
  `/regex/` patterns. First match wins unless a rule sets `continue`.
- Managed in the web UI (list, reorder, edit, enable/disable, delete) with
  SparkyFitness search typeaheads for meals, foods, variants and meal types,
  and a JSON API at `/api/rules`. `config/rules.yaml` is imported once on
  first start.
- "New rule from this transaction" pre-fills the type and destination and
  offers the transaction's other values as one-click suggestions.
- Every delivery has a page with a live dry-run of what the current rules
  would do, the linked entries and the activity log.

### Dashboard and webhook filters
- Recent transactions with date (in `TZ`), description, amount, destination,
  budget, category, the matching rule — or a **needs rule** flag — and status.
- Summary tiles and tabs for *Shown*, *Needs a rule*, *Failed* and *All
  incl. hidden*.
- Webhook filters (`/filters`): include or exclude transactions by budget,
  category, description, destination, source, tag or type, so the dashboard
  only shows the ones that could be meals. Filters change what is displayed,
  not what the rules process.
- Optional `ADMIN_PASSWORD` basic auth for every page and API route;
  `GET /health` for monitoring.

### Deployment
- Docker image `ghcr.io/devclef/sparkfly` (non-root, `/data` volume,
  health check) and an example `docker-compose.yml`.

[0.1.0]: https://github.com/devclef/sparkfly/releases/tag/v0.1.0
