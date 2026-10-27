# Changelog

All notable changes to Sparkfly are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Backfill
- Re-running a backfill range now re-queues groups whose earlier backfill
  went `dead` (fresh retry budget) and reports them separately, instead of
  silently counting them as duplicates.

## [0.2.0] — 2026-10-27

Milestone 4: the extras. Everything Firefly-side lives on the new **Setup**
page (`/setup`), which needs `FIREFLY_URL` and `FIREFLY_PAT`.

### Added
- **Webhook auto-registration**: list Firefly's webhooks and register one
  for Sparkfly with all three triggers. The secret Firefly generates is
  stored and accepted next to `FIREFLY_WEBHOOK_SECRET`, which is now
  optional. The default URL comes from the new `SPARKFLY_PUBLIC_URL`.
- **Backfill**: run the current rules over past Firefly transactions in a
  date range. A preview shows what would be logged; confirming queues each
  matching transaction group as a `backfill-<group id>` event that goes
  through the normal pipeline. Already-linked and non-matching
  transactions are skipped and re-running a range does nothing.
- **Failure notifications** to `NOTIFY_URL` when an event is marked
  `dead`, and optionally (`NOTIFY_ON=dead,needs-rule`) when a new visible
  transaction matches no rule. JSON (Slack/Discord/Mattermost-friendly)
  or ntfy format (`NOTIFY_FORMAT`), with links to the event page and a
  test button.
- **Amount-based quantity in the rule editor**: a toggle with the price of
  one unit and a live preview (pre-filled with the transaction's amount);
  the rules list shows `qty = amount ÷ price`.

### Changed
- `FIREFLY_WEBHOOK_SECRET` is no longer required by `docker-compose.yml`.

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

[0.2.0]: https://github.com/devclef/sparkfly/releases/tag/v0.2.0
[0.1.0]: https://github.com/devclef/sparkfly/releases/tag/v0.1.0
