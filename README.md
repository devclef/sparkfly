# Sparkfly

Turn [Firefly III](https://github.com/firefly-iii/firefly-iii) transactions into [SparkyFitness](https://github.com/CodeWithCJ/SparkyFitness) diary entries.

Point a Firefly III webhook at Sparkfly, define rules ("expense account = Indian Garden → log *Chicken Tikka Masala* as lunch"), and every matching purchase is logged as a meal or food in SparkyFitness automatically.

> "Lunch at Indian Garden, €14.50" in Firefly → "Chicken Tikka Masala, 1 serving, Lunch" in SparkyFitness.

Design: [docs/DESIGN.md](docs/DESIGN.md) · Latest release: **[v0.2.0](https://github.com/devclef/sparkfly/releases/tag/v0.2.0)** ([changelog](CHANGELOG.md)) · All four milestones complete — see [milestones](#milestones).

## How it works

```
Firefly III ──POST /hooks/firefly──▶ Sparkfly ──REST──▶ SparkyFitness
                (signed)              │
                                      ├─ verify HMAC-SHA3-256 signature, reply 202 at once
                                      ├─ dedupe on webhook uuid
                                      ├─ evaluate rules per split (journal)
                                      ├─ call SparkyFitness (async queue, retry w/ backoff)
                                      └─ SQLite: events, journal→entry links, rules, activity log
```

- **Ack fast, process async** — Firefly only retries on failure, so Sparkfly replies `202` right after the signature check and processes on an in-process queue with exponential backoff. SparkyFitness being down does not lose entries.
- **Idempotent** — webhook redeliveries (same `uuid`) are deduped; single-food entries use SparkyFitness' `source: "firefly"` / `source_id: <journal id>` upsert key, and meal entries are guarded by the local `journal → entry` link table.
- **Full lifecycle** — editing a Firefly transaction re-runs the rules: same rule updates the entry in place (new date/time/quantity/notes), a different rule replaces it, and deleting the transaction removes the linked entry. The `journal → entry` link table (also shown on the status page) is what makes this work for saved meals, which have no source id of their own. Events that exhaust their retry budget land in `dead` — use the **retry** button on the status page to re-queue them.
- **Timezone-aware** — Firefly's ISO dates are converted to your `TZ` before picking `entry_date`, `entry_time`, weekday/time filters and the automatic meal type.

## Quickstart (Docker)

```sh
cp config/rules.example.yaml config/rules.yaml   # then edit: paste real SparkyFitness UUIDs
nano .env          # SPARKY_URL, SPARKY_API_KEY + FIREFLY_URL, FIREFLY_PAT (or FIREFLY_WEBHOOK_SECRET)
docker compose up -d --build
```

Then:

1. In Firefly III: *Administration → Configuration* → allow webhooks (admin).
2. With `FIREFLY_URL` + `FIREFLY_PAT` set, open Sparkfly's **Setup** page (`/setup`) and press *register webhook in Firefly* — Sparkfly creates the webhook and stores the signing secret itself. Otherwise, by hand: *Automation → Webhooks* → new: URL `http://<sparkfly-host>:8080/hooks/firefly`, triggers `STORE_TRANSACTION` + `UPDATE_TRANSACTION` + `DESTROY_TRANSACTION`, response `TRANSACTIONS`, delivery `JSON`, paste the secret shown in Firefly into your `.env` (or read it back from Sparkfly's setup page).
3. Watch it work: open `http://<sparkfly-host>:8080/` — setup details, your rules, and every webhook delivery with its transaction date, description, amount, destination, budget, category, matched rule (or a **needs rule** flag) and outcome. `GET /health` for monitoring.

Prefer to try it without Firefly/Sparky? `DRY_RUN=true` starts the app and evaluates all rules without writing to SparkyFitness.

### Prebuilt image

Every release publishes `ghcr.io/devclef/sparkfly:<version>` (and `:<major>.<minor>`); every push to `main` publishes `:latest`. To use it instead of building locally, replace `build: .` in `docker-compose.yml` with `image: ghcr.io/devclef/sparkfly:0.2.0`.

## Releasing

1. Bump the version in `package.json`, `package-lock.json` and `src/constants.ts`, and add a section to `CHANGELOG.md`.
2. Merge to `main`, then either push a tag (`git tag v0.2.0 && git push origin v0.2.0`) or run the *Release* workflow by hand on `main` (*Actions → Release → Run workflow*), which releases the version in `package.json` and creates the tag itself.
3. The workflow checks that the tag matches the app version, runs the tests, publishes the image and creates the GitHub release from the changelog section.

## Local development

Requires Node ≥ 22.

```sh
npm install
cp config/rules.example.yaml config/rules.yaml
npm run mock:sparky            # fake SparkyFitness on :3010 (prints everything it receives)
SPARKY_URL=http://127.0.0.1:3010 SPARKY_API_KEY=anything \
FIREFLY_WEBHOOK_SECRET=dev-secret \
TZ=Europe/Berlin \
npm run dev
```

Send a signed delivery:

```sh
BODY='{"uuid":"demo-1","trigger":"STORE_TRANSACTION","content":{"transactions":[
 {"transaction_journal_id":1,"type":"withdrawal","date":"2026-10-25T12:41:00+02:00",
  "amount":"14.50","currency_code":"EUR","description":"Indian Garden",
  "source_name":"Checking","destination_name":"Indian Garden",
  "category_name":"Eating out","budget_name":"Food","tags":["lunch"],"notes":null}]}}'
T=$(date +%s)
V1=$(node -e "const{createHmac}=require('crypto');console.log(createHmac('sha3-256','dev-secret').update(process.argv[1]+'.'+process.argv[2]).digest('hex'))" "$T" "$BODY")
curl -s -X POST localhost:8080/hooks/firefly \
  -H 'Content-Type: application/json' -H "Signature: t=$T,v1=$V1" -d "$BODY"
```

Tests: `npm test` (153 cases: signature scheme, rule matching, meal-type windows, templating, lifecycle updates/deletes, retry/backoff, idempotency, webhook + status routes, rule editor UI, SparkyFitness lookups, dry-run event pages, webhook filters, Firefly API client, webhook registration, backfill, notifications).

## Rules

Rules live in the SQLite database and are managed in the web UI at `/rules` (list, reorder, edit, delete; SparkyFitness search typeaheads fill in the UUIDs). On first start, `config/rules.yaml` is imported once into the database if present — from then on the UI is the source of truth (see the example for every option). Rules are checked in order; the **first match wins** unless the rule sets `continue: true`.

```yaml
rules:
  - name: Indian Garden lunch
    match:
      type: withdrawal            # default when omitted
      destination: "Indian Garden"   # exact, case-insensitive — or /regex/flags
      # description / category / budget / source: same style
      # currency: EUR
      # amount: { min: 8, max: 25 }
      # tags_any: [lunch]
      # tags_none: [paid-by-else]
      # weekdays: [mon-fri]
      # time: { from: "11:00", to: "15:30" }   # local TZ, inclusive, may wrap
    action:
      log: meal                   # meal | food | foods
      meal_template_id: "b1c…"
      meal_type: auto             # auto | breakfast | lunch | dinner | snacks | <custom>
      quantity: 1
      note: "{{description}} – {{amount}} {{currency}}"
      # quantity_from_amount: { per_unit: 14.50 }
```

- **Quantity from the amount**: tick *scale the quantity with the amount paid* in the editor and give the price of one unit; quantity = amount ÷ price, rounded, at least 1 (so €29 at €14.50 logs 2 servings). The editor previews the result for any amount — pre-filled with the transaction's when you start from one. Off by default; not used by `foods` rules, whose items keep their own quantities.

- `meal_type: auto` maps the local time to breakfast/lunch/snacks/dinner via `defaults.meal_type_auto` (the dinner window wraps midnight, so 00:00 → dinner).
- A transaction tagged `no-sparky` (configurable in `defaults.global_skip_tag`) is skipped entirely.
- `entry_date` / `entry_time` come from the Firefly date converted to `TZ`; a `00:00` time (no time entered in Firefly) omits `entry_time`.
- `foods` actions log each item as its own entry (upsert key = `<journal id>:<index>`).

## Setup page: webhook registration, backfill, notifications

`/setup` needs `FIREFLY_URL` and a Firefly **Personal Access Token** in `FIREFLY_PAT` (*Options → Profile → OAuth → Personal access tokens*) for the first two sections.

- **Webhook registration** lists the webhooks Firefly has and registers one for Sparkfly (triggers `STORE`/`UPDATE`/`DESTROY_TRANSACTION`, response `TRANSACTIONS`, delivery `JSON`). The URL defaults to `SPARKFLY_PUBLIC_URL` + the webhook path, falling back to the host you opened the page with — make sure Firefly can reach it (e.g. `http://sparkfly:8080` on a shared Docker network). The secret Firefly generates is stored in the database and accepted next to `FIREFLY_WEBHOOK_SECRET`, so the env var becomes optional. Older Firefly versions take one trigger per webhook; the page flags missing triggers.
- **Backfill** runs the current rules over past transactions from the Firefly API. *Preview* shows what would be logged without writing anything; *log N transactions* then queues each matching transaction group as a `STORE_TRANSACTION` event with uuid `backfill-<group id>`, so it goes through the normal queue, retries, links and activity log. Groups that match no rule are not stored, groups with a split that is already linked are skipped, and re-running a range is a no-op. One run scans up to 5,000 transactions; split longer histories into several ranges.
- **Failure notifications** go to `NOTIFY_URL` when an event is marked `dead` (and, with `NOTIFY_ON=dead,needs-rule`, when a new transaction the dashboard shows matches no rule). `NOTIFY_FORMAT=json` (default) posts `{ app, kind, title, message, event_id, url, text, content }` — `text`/`content` make Slack, Mattermost and Discord webhooks work as-is; `NOTIFY_FORMAT=ntfy` posts plain text with ntfy's `Title`/`Priority`/`Click` headers. Set `SPARKFLY_PUBLIC_URL` to get links to the event page. The page has a *send a test notification* button.

## Webhook filters

Firefly sends *every* transaction to Sparkfly, and most of them (rent, groceries, salary) will never become a meal. At `/filters` you can define which transactions the dashboard shows:

- **include**: when any include filter is enabled, only transactions matching at least one are shown (e.g. budget `Food`, or category `/eating out|coffee/i`).
- **exclude**: matching transactions are hidden (e.g. destination `Landlord`). Each dashboard row has a **hide** shortcut that pre-fills one.

All fields filled in on one filter must match. Patterns use the rule syntax: exact (case-insensitive) or a `/regex/flags` literal. Filters only change what is displayed; rules still run on everything. The dashboard tabs **Shown**, **Needs a rule**, **Failed** and **All incl. hidden** make it obvious which food transactions still lack a rule; failed deliveries show up whether or not a filter hides them.

## Configuration (env)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `FIREFLY_WEBHOOK_SECRET` | yes† | — | Shown by Firefly when creating the webhook |
| `SPARKY_URL` | yes* | — | e.g. `http://sparkyfitness-server:3010` |
| `SPARKY_API_KEY` | yes* | — | **Write-enabled** key (read-only keys are refused) |
| `TZ` | no | system | IANA zone for meal-type auto + entry date/time |
| `DRY_RUN` | no | `false` | * | 
| `ADMIN_PASSWORD` | no | — | Basic-auth for the status page (or use your reverse proxy) |
| `FIREFLY_URL`, `FIREFLY_PAT` | no | — | Firefly API access for webhook registration and backfill (`/setup`) |
| `FIREFLY_TIMEOUT_MS` | no | `30000` | Firefly API request timeout |
| `SPARKFLY_PUBLIC_URL` | no | request host | How Firefly reaches Sparkfly (registration default) and the base of links in notifications |
| `NOTIFY_URL` | no | — | Failure notifications target (Slack/Discord/Mattermost webhook, ntfy topic, any JSON endpoint) |
| `NOTIFY_FORMAT` | no | `json` | `json` or `ntfy` |
| `NOTIFY_ON` | no | `dead` | Comma list of `dead`, `needs-rule` |
| `HOST` / `PORT` | no | `0.0.0.0` / `8080` | Listen address |
| `SPARKFLY_DATA_DIR` | no | `./data` (container: `/data`) | SQLite database location |
| `RULES_FILE` | no | `./config/rules.yaml` (container: `/config/rules.yaml`) | One-time first-start import into the DB (missing = no rules) |
| `SPARKFLY_WEBHOOK_PATH` | no | `/hooks/firefly` | Webhook route |
| `LOG_LEVEL` | no | `info` | pino level |
| `SPARKFLY_MAX_ATTEMPTS` | no | `10` | Give up (status `dead`) after this many tries |
| `SPARKFLY_RETRY_BASE_MS` / `SPARKFLY_RETRY_MAX_MS` | no | `5000` / `600000` | Exponential backoff bounds |
| `FIREFLY_SIGNATURE_TTL` | no | `300` | Allowed skew of the webhook timestamp (s) |

\* not required when `DRY_RUN=true`. † not required once the webhook was registered from `/setup`.

## Milestones

- [x] **1 — MVP**: webhook endpoint, HMAC-SHA3-256 signature check, YAML rules, saved-meal + single-food (+`foods`) logging, `STORE_TRANSACTION`, SQLite event/link/activity log, Docker image, status page, dry run.
- [x] **2 — Lifecycle**: `UPDATE_TRANSACTION` (re-match → update / replace / delete) and `DESTROY_TRANSACTION` (delete linked entry) through the link table, plus a retry button for `dead` events on the status page. Meals are updated via `PUT` (re-created if the entry vanished on the SparkyFitness side); food entries ride the `(source, source_id)` upsert key.
- [x] **3 — UI**: rules moved to SQLite and managed in the web UI — list/reorder/edit/delete, SparkyFitness search typeaheads (meals, foods + variants, meal types), "new rule from this transaction" prefill, per-event page with a live dry-run plan (nothing is written) and the activity log, plus a JSON rule API. The YAML file is a one-time first-start import only.
- [x] **4 — Extras**: backfill from the Firefly API with a preview, webhook auto-registration (the generated secret is stored and accepted), amount-based quantity in the rule editor with a live preview, and failure notifications (`dead` events, optionally new transactions that need a rule) as JSON or ntfy.
