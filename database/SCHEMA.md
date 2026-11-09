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
claiming to reproduce the system — still created a `accountant_wedding_vendors`
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
| `engine_logs.job` | **`email_sweep`** `bank_feed` |
| `engine_logs.status` | `running` `ok` `failed` `skipped` |
| `secretary_mail_log.action` | `labeled` **`drafted`** `trashed` `blocked` `skipped` |
| `secretary_blocklist.status` | `Watching` `Blocked` |
| `engine_mail_rules.label`, `engine_mail_decisions.label` | `Requires Action` `Review` `Jobs` `Housing` `Wedding` `Money` `People` `Reading` `Trash` |
| `engine_mail_rules.push`, `engine_mail_decisions.push` | `push` `highlight` `quiet` |
| `engine_mail_rules.kind` | `sender` `domain` `subject` |
| `engine_mail_rules.source` | `seed` `learned` `taught` |
| `engine_mail_decisions.decided_by` | `rule` `haiku` `none` |
| `engine_mail_decisions.mode`, `engine_mail_watch.mode` | `shadow` `live` |
| `secretary_job_events.kind` | `application` `rejection` `interview` |
| `secretary_todos.list` | `todo` `requires_action` `backlog` |
| `secretary_todos.kind` | `mail` **`draft`** `no_time` `bill` `interview` `subscription` `event_added` `invite` `double_booking` — and NULL exactly when `list` is `todo` or `backlog` |
| `secretary_todos.item_key` | required on every `requires_action` row, unique across the table. Since 2026-10-29 the sweep keys mail items on the message (`mail:<message id>`), the mail watch on `watch:<message id>` |
| `secretary_todos.source` | `sweep` `watch`, or NULL (rows before 2026-10-29, and To Do rows) |
| `accountant_transactions.category` | `dining` `grocery` `shopping` `utility` `gas` `travel` `transfer` `income` — or NULL, which the page shows as "uncategorized". `fee` went on 2026-09-19: account and membership costs are `utility` |
| `accountant_transactions.external_id` | unique, prefixed by where the row came from: `simplefin:` `csv:` `manual:`. The `source` column was dropped 2026-10-05; `accountant_prune_pending` reads the prefix |
| `accountant_merchant_categories.category` | the same eight. No NULL — the map cannot hold "no category" |
| `accountant_accounts.kind` | `checking` `savings` `credit` `investment` `other` |
| `accountant_accounts.owner` | `me` `joint` `sam` |
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
| `engine_tracker_groups.direction` | `out` `in` — `in` is Money In: Gifts, Lodging Payment (guests' lodging deposits; was Reservations), Grandma June. With `wedding_transactions.pending` it gives the page's four words: pending out is `due`, pending in is `promised`, settled out is `paid`, settled in is `received` |
| `accountant_orders.status` | `waiting` `matched` `expired` — the sweep writes rows as `waiting`; only `accountant_match_orders()` moves them |
| `accountant_orders.name` | 1–80 characters, the same limit `page_rename` keeps |
| `accountant_rules.scope` | `category` `name` `wedding` `transfer` `other` |
| `wedding_guests.rsvp` | `yes` `no` `pending` |

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
function feeds), `wedding_*` to the wedding skill, `secretary_*` to the secretary skill — the email sweep is that
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
pattern of `springfield` swallows every Springfield merchant.

**`accountant_transactions` is written only through `accountant_ingest(jsonb)`.**
Never insert directly. Dedupe is on `external_id`, which is what makes
overlapping SimpleFIN windows free.

**Money in is income unless the merchant map calls it a transfer.** `accountant_ingest` files a positive amount whose merchant maps to a spending category (a refund) as `income` (2026-10-06).

**Only posted charges are stored (2026-10-06).** The bank rewrites or drops a
pending charge, which lost every rename, category and tracker link made on one,
so the sweep skips pending charges and `accountant_ingest` ignores any row sent
with `pending: true`. A charge lands a day or two later, once it posts, and is
never rewritten by a re-pull. There is no `pending` column.

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
`counts` holds `accounts_seen`, `txns_seen`, `rows_inserted` and
`rows_skipped` (runs before 2026-10-06 also have `pending_dropped`); its errors are joined into `error`. The sweep's
`summary.failures` is a list of short strings the page shows as "finished with
problems". A dry run of the bank feed logs nothing.

It merged `engine_phase_runs` and `accountant_phase_runs` on 2026-09-19. Sweep
rows kept their ids, so `secretary_mail_log.run_id` still points at them; the
legacy phases and the bank feed's dry runs were not carried over.

### engine_settings — numbers set from the page

| Table | Rows | Columns |
|---|---|---|
| `engine_settings` | 0 (2026-09-28) | key text pk, value jsonb, updated_at |

Written only by `page_setting_set`. `key` is one of `heat_day` (the Spending
card's day budget, where grey turns to yellow) and `heat_top` (the day total
where the colour reaches deep red), each a number from 1 to 99999, or
`savings_target` (since 2026-10-16: the Wallet page's savings fund target in
dollars, 1 to 99999999). A missing row means the page's default: the
`#budget` figures, or no savings target.

### user_layouts: each user's pages and cards

| Table | Rows | Columns |
|---|---|---|
| `user_layouts` | 0 (2026-10-30) | user_id uuid pk references auth.users on delete cascade, layout jsonb, updated_at |

The first table keyed by user rather than shared by the household (added
2026-10-30). One row per signed-in user who has changed their layout; no row
means the page's default layout. `layout` is `{v, pages:[{id, name, kind?,
slots:[{id, w:[{id, t, s?}]}]}]}`, where `t` is a card version id such as
`alerts.todo` (README, The page). Written only by `page_layout_set`, which
checks it is an object with a `pages` array and under 64 KB; the page cleans
anything else it holds when it reads it.

### engine_mail_watch, engine_mail_queue, engine_push_subs: the mail watch

| Table | Rows | Columns |
|---|---|---|
| `engine_mail_watch` | 1 (2026-10-29) | id smallint pk = 1, after_ts bigint, last_ok, last_error, last_counts jsonb, alert_domains text[], self_addresses text[], vapid_public |
| `engine_mail_queue` | 0 (2026-10-29) | id, gmail_thread_id, add_labels text[], remove_labels text[], trash, todo_id → secretary_todos (set null), created_at, applied_at, tries, error |
| `engine_push_subs` | 0 (2026-10-29) | endpoint pk, p256dh, auth, user_id, created_at, last_ok |

Added 2026-10-29 for the Apps Script in the hub Gmail (README, The mail
watch). RLS is on and anon and authenticated hold no grants: everything goes
through functions. `engine_mail_watch` is one row: where the script's last
read ended, its health, and the two lists its rules use, editable here:
`alert_domains` (senders whose request is urgent: rentals, job portals) and
`self_addresses` (his own, never raised). `engine_mail_queue` is Gmail work for
the script: label names by their full Gmail name, with `INBOX` meaning move to
or out of the inbox. A row with `todo_id` clears that Requires Action item once
done; a row that fails 5 times stops being sent. Applied rows go after 30 days
(`engine_prune()`). `engine_push_subs` is one row per phone, written by
`page_push_subscribe`; a push service answering 404 or 410 deletes it.

Vault holds `mail_watch_key` (the script's key) and `vapid_private` (the push
signing key, made by the edge function itself).

### engine_mail_rules, engine_mail_decisions, engine_api_usage: mail sorting

| Table | Rows | Columns |
|---|---|---|
| `engine_mail_rules` | 123 (2026-10-31) | id, kind, pattern, label, push, judge, trash_after_days, unsubscribe, source, hits, last_hit, note, created_at; unique (kind, pattern) |
| `engine_mail_decisions` | 0 (2026-10-31) | msg_id pk, thread_id, sender, sender_name, subject, rule_id → engine_mail_rules (set null), label, push, highlight, decided_by, mode, applied_at, dismissed_at, created_at |
| `engine_api_usage` | 0 (2026-10-31) | id, at, model, input_tokens, output_tokens, cost_usd, msg_id |

Added 2026-10-31 (README, Mail sorting). RLS on, no grants: only the
`mail-watch` edge function writes, through `engine_watch_decide()` (the rule
pass) and `engine_watch_record()` (model results, spend, learned rules). A rule
matches by exact sender, then domain or any subdomain of it, then subject
regex. `judge` sends matching mail to the model anyway, for its push level and
highlight. A rule the model learns skips the model only when it is one sender
filed to Trash, Money or Reading; every other learned rule keeps `judge` on,
so a known sender can still push. `engine_mail_watch` gained `mode` (`shadow` records decisions only;
`live` lets the script file by them), `api_cap_usd` (2.00: past it, no model
calls until the next month, Pacific) and `learned_at`. Once a day
`engine_watch_pull()` runs `engine_mail_learn_from_sweep()`, which turns senders
the 10am sweep filed the same way at least twice into rules and drops
decisions after 90 days. `engine_mail_rules` was seeded from
`secretary_blocklist` and `alert_domains`, which it is meant to replace.
Vault's `anthropic_api_key` is read only by `engine_anthropic_key()`.

### engine_tracker* — what a bank row is for, outside the accountant

| Table | Rows | Columns |
|---|---|---|
| `engine_trackers` | 1 (2026-10-06) | id smallint, name unique, details, sort_order |
| `engine_tracker_groups` | 21 (2026-10-06) | id, tracker_id, name, details, sort_order, direction |
| `engine_tracker_links` | 76 (2026-10-06) | txn_id → accountant_transactions (cascade), tracker_id, group_id, pk (txn_id, tracker_id) |

A tracker is anything that follows some of the bank rows for its own page:
today only Wedding. `accountant_transactions` holds only what the bank knows;
a link says one posted row belongs to a tracker and which of its groups (the
drop-downs on the tracker's page) it sits in. A row can be in several trackers,
one link each. Name, amount, date and category are always read from the bank
row, so a rename or recategorization shows in every tracker with nothing to
sync, and deleting the link takes the row out of that tracker. A link with no
group shows under the tracker's catch-all (Wedding: `Other wedding costs`,
group 20). Links are per charge, never per merchant, so no map carries them.
Renamed from `tags` and `tag_groups` on 2026-10-06; the links replaced
`accountant_transactions.tag_id` and `group_id`.

### secretary_* — owned by the secretary skill

| Table | Rows | Columns |
|---|---|---|
| `secretary_todos` | 8 (2026-09-19) | id, list, kind, text, detail, item_key, gmail_thread_id, gmail_draft_id, calendar_event_id, file_to, created_at, done_at, cleared_at, source, due_at |
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
rows. `verdict` (`spam`, `quiet`, `important`) and `note` (free text, 500 max) are
his feedback on a crossed-off row, set by `page_todo_feedback()`: a verdict
also writes a `taught` sender rule in `engine_mail_rules` (spam: Trash, quiet;
quiet: Review, no push; important: Requires Action, push) and spam sets
`file_to = 'Trash'`. The `note` is for Claude: the 10am sweep reads notes on
done rows and does what they ask (calendar event, session, a rule) before
clearing them. Cleared rows are kept 90 days so the unique `item_key` stops the sweep
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
| `accountant_transactions` | 3,795 (2026-10-06) | id, account_id, date, amount numeric(12,2), description, category, external_id, raw_description |
| `accountant_transaction_items` | 35 (2026-10-12) | id, txn_id → accountant_transactions (cascade), name, amount numeric (null until priced), category, tracker_id, group_id, created_at |
| `accountant_orders` | 0 (2026-10-15) | id, merchant, name (1–80), total numeric(12,2) signed like the charge, ordered_on, items jsonb `[{name, price}]`, order_ref, gmail_thread_id, status, txn_ids bigint[], matched_at, created_at |
| `accountant_rules` | 8 (2026-10-06) | id, rule, scope, example_txn_id, added_on |
| `accountant_review_log` | 17 (2026-10-06) | id, txn_id, note, change, applied_on |
| `accountant_accounts` | 18 (2026-10-16) | id, name, kind, active, created_at, annual_fee_usd, notes, owner, network, rewards_currency, choice_category, benefits_reviewed_on, last4, simplefin_account_id, bank, balance numeric(14,2), balance_as_of |
| `accountant_merchant_aliases` | 714 | raw_pattern, clean_name |
| `accountant_merchant_categories` | 642 | clean_name, category |
| `accountant_credits` | 14 (2026-09-25) | id, card, name, amount, amount_december, period, match, sort_order, claimed, claimed_cycle, claimed_as_of, icon_domain, remind, expected_day |
| `accountant_perks` | 7 (2026-09-15) | id, account_id, program, status_tier, enrollment_status, enrolled_on, reenroll_deadline, notes, … |

`amount` is signed: negative out, positive in, on credit and debit alike. Never
re-derive the sign or take an absolute value.

A wedding cost is a row with a Wedding link in `engine_tracker_links`. The
Balance page moves those out of their category bars into one Wedding bar.

A charge that holds several things is broken down in
`accountant_transaction_items`; the bank row is never split or deleted, because
a deleted SimpleFIN row comes back on the next sweep. A priced item is carved
out of the charge and carries its own tracker tag; whatever is left follows the
charge's own link. The view `accountant_tracked_parts` returns one line per
priced, tagged item plus the unitemized rest of every linked charge, and
`page_wedding_data` reads it. The Balance page still reads the link alone, so
a linked charge with a non-wedding item counts whole there.

**`accountant_orders`** (since 2026-10-15) holds the orders and receipts the
email sweep read out of his mail, so a bare bank charge (`Amazon`, `Uber Eats`)
can be told apart. `accountant_match_orders()`, called by `sweep_finish()` every
run, renames the charges an order matches to its `name` and adds its items to
`accountant_transaction_items`. `status` is `waiting` `matched` `expired`; one
row per merchant, order (`order_ref`, else the thread) and total, so a re-run
adds nothing.

**`accountant_rules`** holds Alex's standing guidelines for curating
transactions, learned from his review notes (money in is income unless a
matched transfer, how lodging payments are named, and so on); read it before
renaming, categorizing or linking. A fix for one merchant goes in the merchant
maps instead, where the sweep applies it for free. **`accountant_review_log`**
is one row per review note and what it changed, kept as precedent.

`accountant_accounts` also carries the accountant skill's card notes, none of
which the page or any function reads: `rewards_currency` (`cash`, `ur`, `mr`),
`choice_category` (the one card with a pickable bonus category),
`benefits_reviewed_on` (when the skill last read the issuer's benefits), and
free-text `notes`, where a closed account says it is closed. `balance` and
`balance_as_of` (since 2026-10-16) are the bank's last reported balance, written
by the SimpleFIN sweep on every run; credit cards are negative. `page_wallet_data()` (a security-definer function that
refuses anyone without a session) returns the active accounts that have a
balance as `{accounts, savings_target}`; no page calls it since the savings fund
and Accounts card left Wallet on 2026-10-30.

**`accountant_balance_history`** (account_id, as_of date, balance, available,
fetched_at; pk account_id + as_of) holds one balance per account per Pacific
day, upserted by the same sweep, so the day's last run wins. It began as the
Monarch trial's table (three days, Sep 26-28) and runs daily from 2026-10-16.
The Wallet page's Net Worth card reads it through `page_monarch_data()`, which returns
`{accounts, balances}` with up to 400 days of rows; a day with no row for an
account carries its last balance forward.

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
stays on the Credits card. `expected_day` (1-31, nullable) marks a credit that
pays itself on about that day of the month: the nudge fires only once the day
has passed with no matching posting in the cycle. Digital Entertainment (Disney+
posts the 22nd, the credit the 23rd) uses `expected_day = 23` (2026-10-18).

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

| `doctor_pantry` | 0 (2026-10-05) | id, item_id (unique, to `doctor_nutrition_items`), quantity_g, location, expires_on, updated_at |
| `doctor_recipes` | 0 (2026-10-05) | id, name (unique, case-insensitive), servings, instructions, notes, created_at, updated_at |
| `doctor_recipe_ingredients` | 0 (2026-10-05) | id, recipe_id, item_id, amount_g |

`doctor_nutrition_items.serving_g` (added 2026-10-05) is the grams in one
serving; it is what lets the pantry, recipes and the food log share one unit.
Nothing can be logged by weight from a food whose `serving_g` is null.

**Sam's food app reaches these only through functions**, never the tables:
`doctor_pantry_list/set/remove`, `doctor_recipe_list/save/delete`,
`doctor_nutrition_item_list/set/delete` and `doctor_food_log_add/list/update/delete`; signed in as either of the two household emails she can also read every table except `engine_settings` (RLS policy `household_read`), never write (delete is one row at a time). They are `security
definer`, check `auth.uid()`, validate every value, and are granted to
`authenticated` only. Her site login is the credential; she has no dashboard
access.

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

### wedding_* — owned by the wedding skill

Moved here from the separate Wedding project (`old-wedding-project`) on
2026-09-28, with the Road to the Lodge site becoming the Wedding page.

| Table | Rows | Columns |
|---|---|---|
| `wedding_transactions` | 41 (2026-10-06) | id, txn_id → accountant_transactions, date, amount, description, pending, tracker_id, group_id, payer_id → wedding_guests |
| `wedding_ledger_old` | 31 (2026-10-05) | the ledger as it was before the rename, kept until the Wedding page is checked, then dropped |
| `wedding_guests` | 38 (2026-09-28) | id, name, party, is_international, attending, pays, bed_id, notes, rsvp, is_pet, eats_dinner, paid_txn_id |
| `wedding_beds` | 18 (2026-09-28) | id, cabin, bed_type, capacity, sort_order |
| `wedding_vendors` | 11 (2026-09-28) | id, name, role, company, headcount, eats_dinner, on_site, contract_status, notes |
| `wedding_documents` | 17 (2026-09-28) | id, title, kind, vendor, drive_id unique, drive_url, notes |
| `wedding_settings` | 6 (2026-09-28) | key, value, note |
| `wedding_page_text` | 2 (2026-09-28) | key (`timeline`, `notes`), html, updated_at |
| `wedding_checklist` | 54 (2026-09-28) | id, list, sublist, body, note, done, done_at, done_by, sort_order, created_at |
| `wedding_decor_events` | 15 (2026-10-07) | id, name (unique among events), event_when, event_where, sort_order, is_break, created_at. The Decor tab's drop-downs; an `is_break` row is a blank gap between them (name `''`, no items), added by `page_wedding_decor_break_add()`, moved and removed like an event; Edit mode renames one through `page_wedding_decor_event_set()` and reorders them through `page_wedding_decor_event_order()`; deleting one deletes its items |
| `wedding_decor` | 70 (2026-10-07) | id, event_id → wedding_decor_events, item, qty (1–999), source (`buy` `rent` `owned` `lodge` `vendor`), note, bought, bought_at, bought_by, sort_order, created_at. One row per item per event, ticked on its own through `page_wedding_decor_check()` (`bought` crosses it out; it is never removed by a tick). `page_wedding_decor_add()` reuses an existing spelling of the name. The page's Edit mode adds, removes and recounts through the other `page_wedding_decor_*` functions |
| `wedding_unsorted_notes` | 0 (2026-09-28) | id, body (1–1000 characters), added_by, created_at |

**Where wedding money lives.** Money that moved through a bank is a row in
`accountant_transactions` with a Wedding link in `engine_tracker_links`, which
also holds its group. `wedding_transactions` holds what the bank has not shown
yet: `pending` bills due (money out) and promises (money in, shown, never
counted). Everything goes through a bank: a settled row needs a bank `txn_id`
(the check `wedding_transactions_settled_needs_bank` refuses `pending = false`
with no `txn_id`), so nothing is ever "off-bank". Money the bank has not shown
is a promise or a bill due. When the bank row turns up, link it to Wedding with
the group and either set the row's `txn_id` to it (the row then drops out of
every total) or delete the row, or it counts twice. A bank deposit that is
partly not wedding gets an `accountant_transaction_items` row with no tracker
for the non-wedding part.

- `amount` is unsigned USD; the group's `direction` and `pending` give the rest.
  A pending row with no amount is an estimate, counted nowhere.
- `date` drives the "in 12d" and "overdue" labels.
- `description` is the name shown, vendor first ("Pinecrest Lodge Venue balance").
  There is no note, instalment, refundable, company or gift column: the group
  and the description carry it. Refundable deposits count as committed.
- A promise to cover a vendor's whole cost is entered at that figure. The
  "still promised" figure is a group's promised rows minus its received lines,
  so each promiser gets their own group.

**Money in.** A bank deposit is money in when it is linked to Wedding in a
group with `direction = 'in'`.

**Who has paid.** A guest counts as paid once a received line carries their id:
`wedding_guests.paid_txn_id` pointing at the deposit, or a settled row's
`payer_id`. Each guest owes `ask_per_person`; a deposit of twice that is the
payer and their +1. Point every guest a deposit covers at it, and the page
splits it evenly between them.

**Guests.** `attending = false` is invited but not coming, hidden from the page.
Guests sharing `party` are drawn tied together. `pays = false` means we cover
them. `is_pet` (the dog) takes a bed but is no guest and no plate. Name boxes run
grey (no bed), pale green (`bed_id` set), solid green (`rsvp = 'yes'`), gold
(paid); a bed reads `paid` once everyone in it who owes the ask has paid. Bed
ids are fixed: `1.x` main cabin, `2.x` family cabin, `3.x`–`6.x` River cabins 1–4.

**Timeline and Notes** are HTML in `wedding_page_text`. Keep to its patterns —
`section`, `sectitle`, `day`/`dayhead`/`run` for dated entries, `kv` for lists —
and write whole values back. A number that follows the guest list is never
typed: `<span data-calc="NAME"></span>` is filled by the page (`guests`,
`musicians`, `standing`, `ceremony_chairs`); a new one goes in `fillCalcs` in
`page/wedding.js`.

**Checklists** are one row per item: `list` is the section, in `sort_order`;
`sublist` an optional heading inside it, where `"During the week · Nov 9–13"`
splits into a heading and small grey text; `note` small text under the item.
`done`, `done_at` and `done_by` are set by the page. Unsorted notes come in from
the page; file them into the checklist or the Notes HTML and delete the row.

`wedding_documents` links the contracts and receipts in the Drive "Wedding"
folder and is not shown on the page.

## Views, functions, jobs

**Views** — `accountant_ledger`, `accountant_monthly`, `accountant_uncategorized`,
`accountant_account_watermarks`. `accountant_monthly` excludes `transfer` from
spend totals.

**Functions**

- `accountant_ingest(jsonb)` — the only way rows enter `accountant_transactions`.
  Never insert directly. Skips a row sent with `pending: true`, and never
  rewrites a row it already has.
- `accountant_alias_pattern(text)` — the merchant part of a bank descriptor:
  the first run of letters at least 5 long, skipping a payment processor's own
  name. `page_rename` uses it to write an alias that can actually match.
- `accountant_clean_name(text)` — with no alias match, returns `initcap()` of the
  text with `[0-9#*]` stripped. **A `raw_pattern` containing a digit, `*` or `#`
  can therefore never match anything, and it fails silently.** Strip them before
  writing an alias.
- `accountant_match_orders()` — names bare charges from `accountant_orders`.
  A waiting order matches charges whose description is still exactly the
  merchant's bare name, dated 3 days before the order to 30 after: one charge
  of the whole total, else the one set of two or three that adds up to it (two
  sets leave it waiting). It writes the order's name onto them and, for two or
  more items, adds the items, priced only when one charge holds the whole order
  and every price is known (shipping and tax spread in proportion, the rounding
  cent on the largest, as `accountant_rules` 16 says). It never sets a category
  or a tracker link. Orders unmatched after 45 days expire. `service_role`
  only.
- `accountant_feed_key_ok(text)` — true only for the Vault secret
  `bank_feed_key`. The bank-feed edge function calls it first and refuses any
  request that fails it. `service_role` only.
- `engine_prune()` — the sweep's retention step: trims `engine_logs`,
  `secretary_mail_log` and cleared `secretary_todos` rows past 90 days and
  reports the database size. Touches no `accountant_` table. `service_role`
  only.
- `sweep_start()` — the email sweep's first call: opens its `engine_logs` row,
  clears crossed-off To Do and Backlog rows, and returns the open Requires
  Action rows, the blocklist, recent job events and every settlement's title,
  link and thread. `service_role` only.
- `sweep_finish(run_id bigint, p jsonb)` — the email sweep's last call: writes
  the run's mail log, Requires Action rows, cleared ids, job events,
  blocklist strikes and orders one row at a time (a bad row is named in
  `failures`, the rest still land), runs `accountant_match_orders()` and
  `engine_prune()`, and closes the run row. Since 2026-10-29 it also queues
  the run's `actions` in `engine_mail_queue`, writes `due_at` and
  `source = 'sweep'`, and turns an open mail watch row for the same thread
  into the sweep's row instead of adding a second.
  `service_role` only.
- `engine_watch_key_ok(text)` - true only for the Vault secret
  `mail_watch_key`; the `mail-watch` edge function refuses any request that
  fails it. `service_role` only.
- `engine_watch_pull()` - queues the filing of every crossed-off Requires
  Action item (clearing at once those with no email), and returns the queued
  Gmail work, the blocked senders and the rules' lists. `service_role` only.
- `engine_watch_push(p jsonb)` - records what the script did (a done queue row
  clears its item) and raises each urgent message as a `watch:<message id>`
  row; returns the rows new this call (with message id and reason, for the
  edge function to pick which push) and the open count for the badge.
  `service_role` only.
- `engine_vapid()`, `engine_vapid_set(text, text)` - the push key pair, read
  from and saved once to Vault by the edge function. `service_role` only.
- `page_push_subscribe(p_endpoint, p_p256dh, p_auth)` - saves the phone's push
  subscription. Signed-in users only.

The page's functions, all `security definer`, all raising `42501` when there is no
signed-in user, and executable by `authenticated` only — Postgres and Supabase
grant new functions to `PUBLIC` and `anon` by default, so every new one needs
the revoke:

- `page_data()` (it no longer reads `doctor_*`: see "Bringing Food back" in
  the README) — everything the page draws, as one JSON object:
  `transactions`, `accounts`, `synced`, `jobs`, `todos`, `backlog` and `actions` (the three lists in `secretary_todos`,
  uncleared rows only), `credit_postings` (Amex statement credits this year,
  matched on `accountant_accounts.bank = 'AmEx'`), `credits`, `push_key` (the
  public half of the push key pair), and `problems` (worked out on every load
  from `engine_logs` and, for the mail watch, `engine_mail_watch`). `actions`
  carry `due` and `watch` and come deadline first. Charges with no category are
  not a problem row: the page lists the settled ones from `transactions`.
- `page_rename(p_txn_id, p_name, p_category, p_whole_merchant)` — renames one
  charge, or every charge with the same description and writes the alias and
  category maps. The name is 1–80 characters; a null `p_whole_merchant` means
  this charge only. The category is checked by the table's constraint.
- `page_todo_add(p_text)` — adds a to-do of 1–200 characters and returns its id.
- `page_todo_set(p_id, p_done, p_file_to)` — crosses an item on either list off,
  or back on, and on a `mail` or `draft` row records `Save` or `Trash`.
- `page_settlement_set(p_id, p_status)` — sets a settlement's status and
  `status_at`; the cast to `accountant_settlement_status` rejects anything
  else. `ask` to `new` also adds `asks_about` to `accountant_assets`.
- `page_wedding(p_txn_id, p_wedding)` — adds or removes one charge's Wedding
  link. Never a whole merchant.
- `page_setting_set(p_key, p_value jsonb)` — saves one of the page's own
  settings in `engine_settings`; a null value deletes it, so the page falls
  back to its default. It checks the value is a number from 1 to 99999; the
  table's constraint checks the key.
- `page_layout_get()`: the caller's own row of `user_layouts`, or null.
- `page_layout_set(p_layout jsonb)`: saves the caller's layout, keyed by
  `auth.uid()`; null deletes it, which puts them back on the default.
- `page_wedding_data()` — everything the Wedding page draws, as one JSON object
  in the shape the old site's `road_data()` returned. Its `transactions` merge
  Wedding-tagged charges and deposits from `accountant_transactions` with the
  due and off-bank rows of `wedding_transactions`; `money` and `lodging_summary` are worked out
  from them on every call. Called only when the Wedding page is opened.
- `page_wedding_check(p_id, p_done)` — ticks or unticks one checklist item and
  records who did it.
- `page_wedding_note(p_body)` — adds an unsorted note of 1–1000 characters.
`page_data()` also returns `settings` (`engine_settings` as one key-to-value
object), `settlements` (rows at `ask`, `new` or `ongoing`,
soonest deadline first, past-deadline ones dropped unless filed),
`settlement_statuses`, and a `Settlement` problem for each `new` one closing
within 14 days.

Each checks its own limits rather than trusting the page's, because anyone
signed in can call it directly. Every `security definer` function here sets
`search_path` to `public, pg_temp`, so a temporary table can never stand in for
a real one.

**Scheduled** — the bank feed: `accountant-simplefin-sweep` at
`30 3,7,11,15,19,23 * * *` UTC — every four hours: 12:30am, 4:30am, 8:30am,
12:30pm, 4:30pm and 8:30pm PDT (since 2026-09-17; it was once a night). That is
six SimpleFIN requests a day, under its limit of 24. SimpleFIN refreshes each
bank only once a day at a varying time, so more runs shorten our part of the
wait, not the bank's. It is the only engine job the database runs on its own.

## Not the engine's

Objects in this database that belong to nothing above. Seen 2026-09-28; none is
read by the page, the sweeps or any skill.

- `tmp_raw_transactions` (103 synthetic rows) — test data for the `mentor`
  skill's lesson 2 eval. It is the one table with policies: `SELECT` for
  `anon`, `authenticated` and `sweep_reader`. Drop it once that lesson ships.
  `tmp_clean_transactions` and `tmp_category_map` appeared beside it on
  2026-09-29 with no comment, presumably the same lesson's output; they go
  with it.
- `preview_monarch_balances_page()` and the edge function
  `preview-monarch-balances` — leftovers of the Monarch trial of 2026-09-27.
  Its table became `accountant_balance_history` on 2026-10-16 and the bank
  sweep fills it now, so neither is used: the function still names the old
  table and would fail if called, and nothing schedules the edge function.
  Both can be dropped.

## RLS

Every engine table has row level security enabled and no policies, and no table is
granted to `anon` or `authenticated`: the publishable key in the page reads
nothing directly. The SimpleFIN function writes with the service role key, which
never leaves the server; the skills and the sweep use the Supabase connector;
the page goes through its functions above. `user_layouts` follows the same
rule: closed, and reached only through `page_layout_get` and `page_layout_set`,
which are granted to `authenticated` alone.
