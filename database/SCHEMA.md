# What the database actually holds

A snapshot of the live schema, first taken 2026-09-09 and kept up by hand since
(each table's row count carries the date it was read), plus the rules the
columns imply but cannot enforce. **Read this before writing anything**, especially
before changing a value some routine or the page writes.

`functions.sql` beside it holds every function body, generated with
`pg_get_functiondef` — logic has to be kept as logic, and it is the one part of
the schema this document cannot describe in prose.

**There is no rebuild script and no migration folder.** The numbered migrations
were deleted on 2026-09-09: every one had been applied, and `001` — the file
claiming to reproduce the system — still created a table
table dropped four days earlier. A rebuild script that rebuilds the wrong schema
is worse than none, and git holds all eight files if the reasoning is ever
wanted (`git log -- database/`).

When this document and the live database disagree, the database is right.
Regenerate from the query below rather than trusting the page.

Twice now a change has been made in two places and not the third. On 2026-09-08
the phases were consolidated and both the routine and the page were updated to
say `sweep` — but the CHECK constraint still allowed only the old values, so the
first run could not open its run row, *and could not write a failed row either*,
because that insert names the same rejected column. It failed silently. The same
day, the page was written to look for `action = 'draft'` where the table only
accepts `'drafted'`; that one had not fired yet.

Both were the same mistake: an allowed-value list living in the database, and a
second copy of it living in someone's head. This file is that list, written down.

## Regenerating it

This snapshot is hand-maintained and will drift. When in doubt, ask the database
rather than trusting the page below:

```sql
-- every CHECK constraint and what it allows
select rel.relname||'.'||con.conname||' = '||pg_get_constraintdef(con.oid)
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace n on n.oid = rel.relnamespace
 where n.nspname = 'public' and con.contype = 'c'
 order by rel.relname;
```

## Constrained values — the ones that bite

Anything written outside these lists is rejected outright. There is no partial
write and no coercion.

| Column | Allowed |
|---|---|
| `engine_logs.job` | **`email_sweep`** `bank_feed` `rental_feed` |
| `engine_logs.status` | `running` `ok` `failed` `skipped` |
| `secretary_mail_log.action` | `labeled` **`drafted`** `trashed` `blocked` `skipped` |
| `secretary_blocklist.status` | `Watching` `Blocked` |
| `secretary_job_events.kind` | `application` `rejection` `interview` |
| `secretary_todos.list` | `todo` `requires_action` `backlog` |
| `secretary_todos.kind` | `mail` **`draft`** `no_time` `bill` `interview` `subscription` `event_added` `invite` `double_booking` — and NULL exactly when `list` is `todo` or `backlog` |
| `secretary_todos.item_key` | required on every `requires_action` row, unique across the table |
| `accountant_transactions.category` | `dining` `grocery` `shopping` `utility` `gas` `travel` `transfer` `income` — or NULL, which the page shows as "uncategorized". `fee` went on 2026-09-19: account and membership costs are `utility` |
| `accountant_transactions.source` | `simplefin` `csv` `manual` |
| `accountant_merchant_categories.category` | the same eight. No NULL — the map cannot hold "no category" |
| `accountant_accounts.kind` | `checking` `savings` `credit` `investment` `other` |
| `accountant_accounts.owner` | `me` `joint` `partner` |
| `accountant_accounts.network` | `visa` `mastercard` `amex` `discover`, or NULL |
| `doctor_food_log.person` | `Alex` `Sam` — capitalised |
| `doctor_food_log.is_estimated` | boolean, default true — false only for numbers read off a label |
| `doctor_health_log.person` | `Alex` `Sam` |
| `doctor_recommendations.person` | `Alex` `Sam` — `Both` went on 2026-09-25: each person gets their own row |
| `doctor_health_log.entry_type` | `symptom` `vital` `medication` `event` `note` |
| `doctor_health_log.status` | `open` `resolved` `recurring` `monitoring` |
| `doctor_health_log.severity` | integer 1–10 |
| `accountant_settlements.status` | the enum `accountant_settlement_status`: `ask` `new` `ongoing` `done` `skipped`, in that order. The sweep writes only `ask` and `new`; the page sends `ongoing`, `done` and `skipped` |
| `accountant_assets.kind` | `vehicle` `home` `employer` `insurance` `device` `service` `school` `other` — `service` is a carrier, provider or online account; `service` and `school` since 2026-09-25 |
| `rentals_listings.status` | the enum `rentals_status`: `new` `interested` `contacted`, in that order. The page reads the values from `enum_range()` and holds no copy |
| `rentals_search.id` | `1` — the table is one row |
| `rentals_listings.details_status` | `found` `missing`, or NULL until the vet step has asked Apify |
| `rentals_listings.landlord` | `private` `manager` `complex` `unknown`, or NULL until judged |
| `rentals_listings.income_rule` | `strict` `flexible` `none_stated`, or NULL until judged |
| `rentals_listings.verdict` | `pass` `unsure` `fail`, or NULL until judged. The page shows only `pass` and `unsure` |

`drafted` and `Alex`/`Sam` are the three most likely to be got wrong:
one reads like a noun where the column wants a past tense, and the other two are
case-sensitive where nothing else is. The mail log's `drafted` and the to-do
list's `draft` name the same draft from two sides.

## Rules that are not written in the columns

Four things the schema implies but does not enforce. Each was learned by getting
it wrong; each lives here rather than in a migration comment because this is the
file people actually open.

**A table's prefix names the skill that owns it.** `doctor_*` belongs to the
doctor skill, `accountant_*` to the accountant skill (which the SimpleFIN
function feeds), `secretary_*` to the secretary skill — the email sweep is that
skill running unattended. `engine_logs` is the one table no skill owns: every
scheduled job writes its run there. Nothing is named for the page, which only
reads and calls its functions. This is why a skill can be told "you own every
table named `doctor_*`" rather than handed a list — adding a table later needs
no skill edit. Enumerating table names in a skill description is the thing that goes
stale; a prefix rule does not.

**`accountant_clean_name()` strips `[0-9#*]` before storing.** So a
`raw_pattern` in `accountant_merchant_aliases` containing a digit, `*` or `#`
can never match anything, and it fails silently — the alias just sits there
doing nothing forever. It matches the bank's own text, not the cleaned name the
page shows, which is why `accountant_transactions.raw_description` exists
(2026-09-21) and why `accountant_alias_pattern()` builds patterns from it: the
first run of letters in the descriptor, past any payment processor. Take the
first run, never the longest — the longest is often the city and state, and a
pattern of `portland or` swallows every Portland merchant.

**`accountant_transactions` is written only through `accountant_ingest(jsonb)`.**
Never insert directly. Dedupe is on `external_id`, which is what makes
overlapping SimpleFIN windows free.

**A pending row is rewritable; a settled row is not.** `accountant_ingest`
overwrites an existing charge only `where accountant_transactions.pending`, so a
provisional amount can be corrected as it settles and a settled charge can never
be rewritten by a re-pull — including a rename made from the page.

There is no staleness check any more. A flat threshold flagged five of eight
accounts on its first run and a per-account one still fired on cards that were
simply not being used; a warning that goes off on ordinary behaviour is one
nobody reads. A genuinely broken bank connection still arrives on its own, in
SimpleFIN's `errlist`.

**`doctor_nutrition_items` holds atomic, recurring foods only.** An egg, a slice
of bread, a protein shake. A one-off restaurant order goes straight into
`doctor_food_log` as an estimate and is never added to the library — not even a
consistently named one like a particular chain's drink, because a composite
order in a table of ingredients is a row nothing can ever reuse or scale.
Additions stay on demand; nothing should ever be scheduled to promote items
into it.

## Tables

Row counts are from 2026-09-09 and only indicate scale.

### engine_logs — the run log every scheduled job writes

| Table | Rows | Columns |
|---|---|---|
| `engine_logs` | 81 (2026-09-19) | id, job, started_at, finished_at, status, counts jsonb, summary jsonb, error |

One row per run of the email sweep (`email_sweep`) and the bank feed
(`bank_feed`). The page's Requires Action problems read the latest of each, and
its "Synced" line reads the latest bank run that saw rows. The bank feed's
`counts` holds `accounts_seen`, `txns_seen`, `rows_inserted`, `rows_skipped` and
`pending_dropped`; its errors are joined into `error`. The sweep's
`summary.failures` is a list of short strings the page shows as "finished with
problems". A dry run of the bank feed logs nothing.

It merged `engine_phase_runs` and `accountant_phase_runs` on 2026-09-19. Sweep
rows kept their ids, so `secretary_mail_log.run_id` still points at them; the
legacy phases and the bank feed's dry runs were not carried over.

### rentals_* — owned by the rental sweep, temporary

| Table | Rows | Columns |
|---|---|---|
| `rentals_search` | 1 | id, latitude, longitude, radius_mi, property_type, max_price, min_sqft, quota_reset_day, request_cap, updated_at, street_view_key, apify_actor, apify_run_id, apify_batch, gemini_model, vet_rules |
| `rentals_listings` | 254 (2026-09-25) | id, rentcast_id (unique), address_key (unique), address, city, zip, latitude, longitude, price, price_was, beds, baths, sqft, listed_date, days_on_market, agent_name, agent_phone, agent_email, photo, url, found_on, last_seen_on, gone_on, status, status_at, dismissed_at, dismiss_reason, notes, zillow_url, home_type, laundry, cooling, facts, description, details_status, details_tries, details_at, verdict, verdict_reason, vetted_at, zillow_price, zillow_gone_on, building_key (generated), landlord, income_rule, apply_note |

`address_key` is the street line and zip, lowercased with everything but
letters and digits stripped, so a house relisted under a new RentCast id is
matched as the same house. `price_was` is the price before the last change.
`gone_on` is set only by a full pull, and a house with it is taken: the page never lists it.
`photo` is Zillow's first listing photo, filled by the vet step; where it is
null `page_data()` builds a Street View Static image link from the address and
`rentals_search.street_view_key` on every load. Google's terms forbid storing the images. The key is
restricted to the page's sites and to that one API, so it is safe in a
link. A house dismissed from the page
keeps its row with `dismissed_at` and an optional `dismiss_reason` (200
characters), so it never shows again, even relisted; the reasons are what a
chat reads to tighten `rentals_search`. `notes` (1,000 characters) is what
Claude found vetting a house in a chat, shown when the row is opened. The rental feed's `engine_logs`
`counts` hold `kind` (`full` or `new`), `requests`, `used`, `total`, `seen`,
`dropped_units`, `inserted`, `updated`, `returned` and `marked_gone`; the cap
sums `requests`, so a row must never under-report them.

The vet step writes `zillow_url`, `facts` (Zillow's fact box as one line),
`description`, `laundry`, `cooling` and `home_type` when Apify finds the house
(`details_status = found`; a house it does not find is tried on three days),
and `zillow_price` (the rent, only when Zillow lists it for rent; `page_data()` shows and caps it ahead of RentCast's `price`), then `verdict`, `verdict_reason` and `notes` (Gemini's summary). A `fail` is
also dismissed, with `dismiss_reason` starting `Vetting:`. `apify_run_id` and
`apify_batch` are the one Apify run in flight and the houses it was started for.
`building_key` is generated from the address without its unit, plus the zip: a building's units share one Apify read and one verdict, and the page shows them as one row. `zillow_gone_on` is set by the vet step's daily recheck of Filtered and saved houses when Zillow no longer lists one for rent; it is kept apart from `gone_on` so a RentCast pull that still lists the house cannot bring it back. `landlord`, `income_rule` and `apply_note` (at most 120 characters) are what the listing says about who rents it and what applying takes; they decide nothing, and the page orders and labels by them. `vet_rules` defines every answer Gemini gives; the verdict itself is
`decide()` in `sweeps/rental-sweep.ts`.

All of it goes once a place is found — README, "The rental feed".

### secretary_* — owned by the secretary skill

| Table | Rows | Columns |
|---|---|---|
| `secretary_todos` | 8 (2026-09-19) | id, list, kind, text, detail, item_key, gmail_thread_id, gmail_draft_id, calendar_event_id, file_to, created_at, done_at, cleared_at |
| `secretary_mail_log` | 208 | id, run_id, gmail_thread_id, action, label, subject_snippet, acted_at, note |
| `secretary_blocklist` | 40 | sender_email, trash_dates date[], status, blocked_date, updated_at |
| `secretary_job_events` | 61 | id, gmail_thread_id, kind, company, role, occurred_at, note, created_at |

**`secretary_todos` is both lists on the Alerts page.** `list = 'todo'` is
Alex's own, added on the page; `list = 'requires_action'` is raised by the
sweep, or by the secretary skill when he asks in a chat. `list = 'backlog'` is
To Do he has parked: behind a Backlog tab on the To Do card, and left out of the
counts and the badge. Claude moves rows there, never the page. A tap on the page sets
`done_at`; the next sweep acts on it and sets `cleared_at`, and only rows with
no `cleared_at` are shown. `file_to` is where the row's email goes when it
clears — a full Gmail label name, `Save`, `Trash`, or null to leave it —
and the page may set it only to `Save` or `Trash`, only on `mail` and `draft`
rows. Cleared rows are kept 90 days so the unique `item_key` stops the sweep
raising the same thing twice. It replaced `page_todos`, `page_dismissals` and
`engine_calendar_intents` on 2026-09-19.

`secretary_mail_log` is the sweep's record of what it did to each thread — a
thing done by hand in Gmail or in a chat is not in it. Its `label` is the label
name at the time: rows before 2026-09-18 carry the old names (`Needs Response`,
`Flagged for Review`, `Jobs`, `Bills`, `Newsletters`, `Money In`, `Money Out`).

`secretary_job_events` is one row per thing the job mail says happened, and the
page counts it all-time. It is unique on `(gmail_thread_id, kind,
coalesce(role, ''))` — role is in the key because one confirmation thread can
cover two applications. `engine_prune()` does not touch it: a 90-day trim
would quietly shrink an all-time count.

### accountant_* — owned by the SimpleFIN function and the accountant skill

| Table | Rows | Columns |
|---|---|---|
| `accountant_transactions` | 3,046 | id, account_id, date, amount numeric(12,2), description, raw_description, category, source, external_id, pending |
| `accountant_accounts` | 16 (2026-09-23) | id, name, kind, active, created_at, annual_fee_usd, notes, owner, network, rewards_currency, choice_category, benefits_reviewed_on, last4, simplefin_account_id, bank |
| `accountant_merchant_aliases` | 714 | raw_pattern, clean_name |
| `accountant_merchant_categories` | 642 | clean_name, category |
| `accountant_credits` | 14 (2026-09-25) | id, card, name, amount, amount_december, period, match, sort_order, claimed, claimed_cycle, claimed_as_of, icon_domain, remind |
| `accountant_perks` | 7 (2026-09-15) | id, account_id, program, status_tier, enrollment_status, enrolled_on, reenroll_deadline, notes, … |

`amount` is signed: negative out, positive in, on credit and debit alike. Never
re-derive the sign or take an absolute value.

`accountant_accounts` also carries the accountant skill's card notes, none of
which the page or any function reads: `rewards_currency` (`cash`, `ur`, `mr`),
`choice_category` (the one card with a pickable bonus category),
`benefits_reviewed_on` (when the skill last read the issuer's benefits), and
free-text `notes`, where a closed account says it is closed.

`accountant_credits` holds the statement credits the page's Credits card draws,
and `accountant_perks` the benefits with a status but no dollar figure
(`enrollment_status` is `not_enrolled` `pending` `enrolled`). Both are filled by
the accountant skill from the issuer's own site; the page only reads them.

`accountant_credits.period` is `monthly` `quarterly` `semiannual` `annual`. A
statement credit counts toward the first row, by `sort_order`, on the same card
whose `match` appears in its description — which is why Gold's Resy sits above
Dining. `amount_december` is set only where December pays more.
Uber Cash is one row, `uber-cash`, for both cards: they load one Uber balance
that expires on one day, so it is recorded as the combined amount used, read
off the Uber app.

**`claimed` is what the issuer's site reported received in `claimed_cycle`**,
written as the page writes a cycle: `YYYY-MM` monthly, `YYYY-Qn` quarterly,
`YYYY-Hn` semiannual, `YYYY` annual. The page shows the larger of `claimed` and
the postings it matched — the larger, not the sum, because the site's figure
already counts the postings. A cycle that has rolled empties the credit on its
own. `claimed_as_of` is the day it was read, and doubles as the fallback when
`claimed_cycle` does not parse. `icon_domain` names the icon in `page/icons`.
`remind` false keeps a credit off the expiring-credit nudge on Alerts while it
stays on the Credits card; Digital Entertainment is off (2026-09-27).

Nothing on the page writes either table: a tap used to mark a credit used, which
was a claim the page had no way to check (2026-09-15).

**`accountant_settlements`** (id, title, claim_url unique, source_url, deadline,
payout, proof_required, evidence, claim_id, gmail_thread_id, asks_about,
status, status_at, found_on, notes) holds class action settlements he likely
qualifies for, and **`accountant_assets`** (id, name, kind, owned, notes,
updated_at; unique on kind and name) what they are matched against — things he
owns or has owned, `owned = false` once sold or left. Both since 2026-09-25.
The email sweep writes settlements as `sweeps/settlement-sweep.md` says — the
one `accountant_` table it touches — and `evidence` is required: a row says why
he qualifies or it is not written. `done` and `skipped` rows are kept for good
so the same settlement is never raised twice. An `ask` row answered "I have
it" on the page adds `asks_about` to the assets as `kind = 'other'`.

### doctor_* — owned by the doctor skill, on demand

| Table | Rows | Columns |
|---|---|---|
| `doctor_food_log` | 28 | id, meal, person, date, calories, protein_g, carbs_g, fat_g, sugar_g, logged_at, is_estimated, portion_fraction, meal_group_id |
| `doctor_nutrition_items` | 12 | id, item, serving, and the same five nutrients |
| `doctor_health_log` | 17 (2026-09-21) | id, person, date, logged_at, entry_type, label, body_location, severity, value, unit, started_at, resolved_at, status, suspected_cause, notes |
| `doctor_recommendations` | 0 (2026-09-21) | id, person, body (1–800 characters), created_at |

A table with no rows is not a broken one — the page renders that as "no entries
yet".

**One row per distinct food, not per meal.** A sitting of several foods is
several rows sharing a `meal_group_id`; a single-food row leaves it null. The
numbers on a row are the real totals eaten, and `portion_fraction` records how
much of one serving that was — half a burger, two eggs — as a note on how the
figure was reached, never a multiplier to apply when reading. `is_estimated` is
true unless the numbers came off a nutrition label.

Rows logged before this split stayed whole. Where an entry recorded a real
per-item breakdown it was split retroactively; where it only ever held one
aggregate estimate it was left as one row rather than invent a division that
was never measured.

**Dates in `doctor_*` are Pacific dates, and this database runs in UTC.** Write
and read them as `(now() at time zone 'America/Los_Angeles')::date`; plain
`current_date` is already tomorrow from 5pm Pacific onwards, which silently
files an evening meal on the wrong day. `doctor_food_log.logged_at` records
when a row was written, so the next time a date looks wrong the gap between it
and `date` says whether a UTC clock was the cause.

## Views, functions, jobs

**Views** — `accountant_ledger`, `accountant_monthly`, `accountant_uncategorized`,
`accountant_account_watermarks`. `accountant_monthly` excludes `transfer` from
spend totals.

**Functions**

- `accountant_ingest(jsonb)` — the only way rows enter `accountant_transactions`.
  Never insert directly. Takes `pending`; updates an existing row only while
  that row is still pending.
- `accountant_prune_pending(since date, keep text[])` — deletes pending rows in
  the window the sweep just covered that the feed no longer lists, so a charge
  the bank abandons does not linger for ever. **An empty `keep` deletes every
  pending row in the window**, so the sweep never calls it in a run that mapped
  no account. Only `service_role` may execute it: Postgres grants execute to
  `PUBLIC` by default, which had left it callable with the public key.
- `accountant_alias_pattern(text)` — the merchant part of a bank descriptor:
  the first run of letters at least 5 long, skipping a payment processor's own
  name. `page_rename` uses it to write an alias that can actually match.
- `accountant_clean_name(text)` — with no alias match, returns `initcap()` of the
  text with `[0-9#*]` stripped. **A `raw_pattern` containing a digit, `*` or `#`
  can therefore never match anything, and it fails silently.** Strip them before
  writing an alias.
- `accountant_feed_key_ok(text)` — true only for the Vault secret
  `bank_feed_key`. The bank-feed edge function calls it first and refuses any
  request that fails it. `service_role` only.
- `rentals_ingest(p_rows jsonb, p_complete boolean)` — the rental feed's only
  way into `rentals_listings`: matches on `rentcast_id` or `address_key`, moves
  a changed price into `price_was`, and — only when `p_complete` and the pull
  was not empty — marks every house not seen today gone. `service_role` only.
- `engine_prune()` — the sweep's retention step: trims `engine_logs`,
  `secretary_mail_log` and cleared `secretary_todos` rows past 90 days and
  reports the database size. Touches no `accountant_` table. `service_role`
  only.

The page's six, all `security definer`, all raising `42501` when there is no
signed-in user, and executable by `authenticated` only — Postgres and Supabase
grant new functions to `PUBLIC` and `anon` by default, so every new one needs
the revoke:

- `page_data()` — everything the page draws, as one JSON object:
  `transactions`, `accounts`, `synced`, `people`, `nutrition` (14 Pacific
  days, with sugar), `recs` (the newest doctor's recommendation for each
  person, however old), `jobs`, `todos` and `actions` (the two lists in `secretary_todos`,
  uncleared rows only), `credit_postings` (Amex statement credits this year,
  matched on `accountant_accounts.bank = 'AmEx'`), `credits`, and `problems`
  (worked out on every load from `engine_logs`). Charges with no category are
  not a problem row: the page lists the settled ones from `transactions`.
- `page_rename(p_txn_id, p_name, p_category, p_whole_merchant)` — renames one
  charge, or every charge with the same description and writes the alias and
  category maps. The name is 1–80 characters; a null `p_whole_merchant` means
  this charge only. The category is checked by the table's constraint.
- `page_todo_add(p_text)` — adds a to-do of 1–200 characters and returns its id.

Each checks its own limits rather than trusting the page's, because anyone
signed in can call it directly. Every `security definer` function here sets
`search_path` to `public, pg_temp`, so a temporary table can never stand in for
a real one.
- `page_todo_set(p_id, p_done, p_file_to)` — crosses an item on either list off,
  or back on, and on a `mail` or `draft` row records `Save` or `Trash`.
- `page_settlement_set(p_id, p_status)` — sets a settlement's status and
  `status_at`; the cast to `accountant_settlement_status` rejects anything
  else. `ask` to `new` also adds `asks_about` to `accountant_assets`.
- `page_rental_set(p_id, p_status)` — sets a house's status and `status_at`;
  the cast to `rentals_status` rejects anything else.
- `page_rental_dismiss(p_id, p_reason)` — hides a house for good, and every
  other unit in its building; the reason is optional and at most 200
  characters.

`page_data()` also returns `settlements` (rows at `ask`, `new` or `ongoing`,
soonest deadline first, past-deadline ones dropped unless filed),
`settlement_statuses`, and a `Settlement` problem for each `new` one closing
within 14 days.

`page_data()` also returns `rentals` (vetted `pass` and `unsure` houses at or under `rentals_search.max_price`, so a lower ceiling applies before the next pull), `rental_statuses` and a `Rentals` problem
when the rental feed failed, stopped at its cap, or has not run in 30 hours.

**Scheduled** — `rentals-sweep` at `30 12 * * *` UTC, 5:30am PDT, and
`rentals-vet` at `*/10 * * * *`, both temporary (README, "The rental
feed"). And the bank feed: `accountant-simplefin-sweep` at
`30 3,7,11,15,19,23 * * *` UTC — every four hours: 12:30am, 4:30am, 8:30am,
12:30pm, 4:30pm and 8:30pm PDT (since 2026-09-17; it was once a night). That is
six SimpleFIN requests a day, under its limit of 24. SimpleFIN refreshes each
bank only once a day at a varying time, so more runs shorten our part of the
wait, not the bank's. With the rental feed, these are the only things the database runs on its own.

## RLS

Every table has row level security enabled and no policies, and no table is
granted to `anon` or `authenticated`: the publishable key in the page reads
nothing directly. The SimpleFIN function writes with the service role key, which
never leaves the server; the skills and the sweep use the Supabase connector;
the page goes through its six functions above.
