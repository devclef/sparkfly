# Sparkfly — design

A small self-hosted bridge: **Firefly III webhook in → rule match → SparkyFitness diary entry out.**

> "Lunch at Indian Garden, €14.50" in Firefly → "Chicken Tikka Masala, 1 serving, Lunch" in SparkyFitness.

---

## 1. What the two sides give us (researched from source)

### Firefly III (v6.7.x)

- **Webhooks**: created in *Automation → Webhooks* or via `POST /api/v1/webhooks`.
  - `triggers` (array, up to 10): `STORE_TRANSACTION`, `UPDATE_TRANSACTION`, `DESTROY_TRANSACTION` (also `ANY` and budget triggers).
  - `responses`: `TRANSACTIONS` (sends the full transaction group). Other options are `ACCOUNTS`, `RELEVANT` and `NONE`.
  - `deliveries`: `JSON`.
  - An admin has to turn on webhooks: *Administration → Configuration → allow webhooks*.
- **Payload**:
  ```json
  {
    "uuid": "…", "user_id": 1, "user_group_id": 1,
    "trigger": "STORE_TRANSACTION", "response": "TRANSACTIONS",
    "url": "…", "version": "v1",
    "content": {
      "id": 123, "group_title": null,
      "transactions": [{
        "transaction_journal_id": 456, "type": "withdrawal",
        "date": "2026-10-25T12:41:00+02:00",
        "amount": "14.50", "currency_code": "EUR",
        "description": "Indian Garden",
        "source_name": "Checking", "destination_name": "Indian Garden",
        "category_name": "Eating out", "budget_name": "Food",
        "tags": ["lunch"], "notes": null, "…": "…"
      }]
    }
  }
  ```
- **Signature**: header `Signature: t=<unix>,v1=<hex>`, where
  `v1 = HMAC-SHA3-256(secret, "<t>.<raw body>")`. The body sent is the same JSON string that gets signed, so verify against the **raw** request bytes.
- **Delivery behaviour**: up to 3 attempts by default (`WEBHOOK_MAX_ATTEMPTS`). The URL host must not resolve to a reserved IP range. `127.x` and LAN/Docker private IPs are allowed, so `http://sparkfly:8080/...` on the same Docker network works.

### SparkyFitness

- **Auth**: API key created in the UI (Settings → API keys), sent as `Authorization: Bearer <key>` or `x-api-key`. Read-only keys are refused on writes, so the key must have **write** access.
- **Log a saved meal**: `POST /api/food-entry-meals`
  `{ meal_template_id, meal_type_id | meal_type, entry_date, entry_time "HH:MM", quantity, unit, notes }`. If you leave out `foods`, it expands the meal template's foods for you.
- **Log a single food**: `POST /api/food-entries`
  `{ food_id, variant_id, meal_type_id, quantity, unit, entry_date, entry_time, notes, source, source_id }`.
  `(user_id, source, source_id)` is an **idempotent upsert key**. With `source: "firefly"` and `source_id: <journal id>`, a resend updates the entry instead of duplicating it.
- **Lookups for the config UI**: `GET /api/meals/search?searchTerm=tikka`, `GET /api/meals`, `GET /api/foods/search`, `GET /api/meal-types` (breakfast, lunch, dinner, snacks, plus custom types).
- **Undo**: `DELETE /api/food-entry-meals/:id`, `DELETE /api/food-entries/:id`, `PUT` on both for updates.

---

## 2. Architecture

```
Firefly III ──POST /hooks/firefly──▶ Sparkfly ──REST──▶ SparkyFitness
                (signed)              │
                                      ├─ verify signature, reply 202 at once
                                      ├─ dedupe on webhook uuid
                                      ├─ evaluate rules per split (journal)
                                      ├─ call SparkyFitness
                                      └─ SQLite: rules, links, event log
```

- **Stack**: TypeScript + Fastify + SQLite (better-sqlite3), shipped as a single Docker image. It's the same language as SparkyFitness, so you can reuse their types and patterns.
- **Ack fast, process async**: reply `202` after the signature check and the DB insert, then process from an in-process queue. Firefly retries only on failure, so our own retry with backoff handles SparkyFitness being down.

## 3. Rules (the core)

Each rule is a **match** plus an **action**, and rules are checked in order (first match wins, with an optional `continue: true`).

```yaml
rules:
  - name: Indian Garden lunch
    match:
      type: withdrawal
      destination: "Indian Garden"         # exact, case-insensitive; or /regex/
      # optional: description, category, tags_any, tags_none,
      #           amount: { min: 8, max: 25 }, weekdays: [mon-fri],
      #           time: { from: "11:00", to: "15:30" }
    action:
      log: meal                            # meal | food | foods
      meal_template_id: "b1c…"             # picked from UI search
      meal_type: auto                      # auto | breakfast | lunch | dinner | snacks | <custom>
      quantity: 1
      note: "{{description}} – {{amount}} {{currency}}"

  - name: Coffee shop
    match: { destination: /starbucks|costa/i }
    action: { log: food, food_id: "…", variant_id: "…", quantity: 1, unit: serving, meal_type: snacks }

defaults:
  meal_type_auto:                          # used when meal_type: auto
    breakfast: "04:00-10:59"
    lunch:     "11:00-15:59"
    snacks:    "16:00-17:29"
    dinner:    "17:30-03:59"
  global_skip_tag: "no-sparky"             # tag a transaction in Firefly to skip it
```

- `entry_date` and `entry_time` come from the Firefly transaction `date`. If the time is `00:00`, which usually means you entered no time, Sparkfly uses the rule's meal type and leaves out `entry_time`.
- **Scaling (optional)**: `quantity_from_amount: { per_unit: 14.50 }` lets €29 log 2 servings. This is off by default, because €29 at Indian Garden probably means you paid for two people.

## 4. Lifecycle handling

| Firefly trigger       | Sparkfly action |
|-----------------------|-----------------|
| `STORE_TRANSACTION`   | Match the rules, create the entry, store `journal_id → sparky_entry_id, kind, rule_id`. |
| `UPDATE_TRANSACTION`  | Re-check the rules. Same result: `PUT` the date, time or quantity. Different rule: delete the old entry and create a new one. No match anymore: delete the entry. |
| `DESTROY_TRANSACTION` | Delete the linked entry, if any. |

The link table is what makes update and delete work. It's needed for meals in particular, because `food-entry-meals` has no `source_id`.

## 5. Web UI (small, server-rendered or a tiny SPA)

1. **Rules**: list, create and edit. Typeahead fields search SparkyFitness meals and foods, so you never paste UUIDs by hand.
2. **Test a rule**: paste or choose a recent Firefly transaction and see what *would* be logged (dry run).
3. **Activity log**: each webhook received, which rule matched, the SparkyFitness result, and a retry button.
4. **Setup page**: shows the webhook URL and secret to paste into Firefly. If you give it a Firefly Personal Access Token, it can register the webhook through the API.

Protect the UI with a single admin password or put it behind your reverse proxy. Leave the webhook route open, since the signature protects it.

## 6. Config / env

```
FIREFLY_WEBHOOK_SECRET=…        # shown in Firefly when you create the webhook
SPARKY_URL=http://sparkyfitness-server:3010
SPARKY_API_KEY=…                # write-enabled key
FIREFLY_URL=…  FIREFLY_PAT=…    # optional: auto-register webhook, backfill, "test with recent tx"
TZ=Europe/…                     # used for meal_type auto
DRY_RUN=false
```

## 7. Milestones

1. **MVP**: webhook endpoint, signature check, rules in YAML, single-food and saved-meal logging, `STORE` only, SQLite log, Docker image.
2. **Lifecycle**: `UPDATE` and `DESTROY` through the link table, retries, idempotency on the webhook uuid.
3. **UI**: rule editor with SparkyFitness search, dry-run tester, activity log.
4. **Extras** (done in v0.2.0): backfill (run the rules over past Firefly transactions through the API), webhook auto-registration, amount-based quantity, notifications on failure.

## 8. Edge cases noted

- **Split transactions**: one group can hold several journals. Check each journal separately.
- **Refunds and deposits**: the default match is `type: withdrawal` only.
- **Currency**: amount filters compare `amount` in the transaction currency. A rule can also pin `currency`.
- **Timezone**: Firefly sends ISO dates with an offset. Convert them to `TZ` before picking the meal type and `entry_date`.
- **Firefly webhook timeout**: the sender sets no effective request timeout, so a slow response would block Firefly. That's another reason to reply `202` at once.
