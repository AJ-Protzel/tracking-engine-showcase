# Settlements

Read by the 1:00am email sweep (`sweeps/email-sweep.md`): the **Notices** part
every night, the **Search** part on Sundays only. It is not a routine of its
own: folding it into the one routine that already runs costs one session boot
instead of two. Edit here, commit, push; the next run reads it.

The data is the `accountant` skill's — `accountant_settlements` and
`accountant_assets` — and the sweep is acting for it here, the way it acts for
the secretary everywhere else. The page's Settlements card on Alerts shows
every row still his to act on.

**Never file a claim, fill a form, or submit anything.** Filing happens in a
live chat: Claude fills the form, Alex does the CAPTCHA and clicks submit.
Send no email.

## The table

`accountant_settlements`, one row per settlement:

| Column | What goes in it |
|---|---|
| `title` | the settlement's short name — `Amazon return policy` |
| `claim_url` | the claim form on the settlement's own site, https. Unique: it is what keeps a settlement from being raised twice |
| `source_url` | where you found it — the listing page or the notice email's link |
| `deadline` | the claim deadline, a date |
| `payout` | what he would get, as the settlement says it — `$25`, `up to $5,000`, `varies` |
| `proof_required` | true, false, or null when the settlement does not say |
| `evidence` | **required**: the one sentence that says why he qualifies — `Amazon refunds on your cards in 2024 and 2025`, `Notice emailed to you on Sep 20` |
| `claim_id` | the Claim ID, PIN or notice ID from a notice email, when there is one |
| `gmail_thread_id` | the notice's thread, when it came by email |
| `asks_about` | on an `ask` row only: the thing to ask about, written to finish "Do you have, or did you ever have, …?" — `an iPhone 6 or 7` |
| `status` | `ask`, `new`, `ongoing`, `done`, `skipped` — write only `ask` or `new` |

```sql
insert into accountant_settlements (title, claim_url, source_url, deadline, payout,
  proof_required, evidence, claim_id, gmail_thread_id, status, asks_about)
values (...)
on conflict (claim_url) do nothing;
```

`ongoing`, `done` and `skipped` are his, set from the page. A `skipped` or
`done` row stays in the table for good so the same settlement is never raised
again — **check by title too**, not just `claim_url`, because the same
settlement is often listed under two URLs.

`accountant_assets` is what he owns and has owned: vehicles, homes he lived
in, employers, insurers, devices, services (phone carriers, internet providers,
online and financial accounts) and schools. `owned = false` means sold, left
or attended — still evidence for a settlement about a past purchase, tenancy,
job, account or data breach. He adds to it by answering an `ask` row with "I
have it" on the page. A row whose `notes` start `Sam's` is his partner's: a
settlement for it is hers to file, so its `evidence` says so.

## Notices — every night

During the inbox pass, a thread that is a class action notice addressed to him
— "you may be eligible", "notice of settlement", a Claim ID or PIN, from a
settlement administrator (Kroll, Epiq, Angeion, JND, Simpluris and the like) or
the settlement's own domain — becomes a `new` row. It is the strongest
evidence there is: the notice means he is already in the class.

- `evidence`: `Notice emailed to you on <Mon D>`. `claim_id` and
  `gmail_thread_id` from the thread.
- `claim_url`: the notice's claim link, **only if** its domain is the
  settlement's official site. Notices are a favourite phishing costume: if the
  link goes anywhere else, look the settlement up on one of the sites below and
  use the claim link listed there; if you cannot confirm one, write no row and
  add the thread to the summary's `failures` for him to look at.
- File the thread to `Save`. It does not go to Requires Action — the card
  holds it, and a deadline under 14 days away raises itself there.
- A notice that is only marketing ("see if you qualify for these lawsuits")
  is junk, not a notice.

## Search — Sundays only

`TZ='America/Los_Angeles' date +%u` prints `7` on a Sunday. Any other day, skip
this part.

**Sources**, the open-settlement lists of these four. Measured 2026-09-25: all
four serve real listings to an automated fetch.

- https://topclassactions.com/category/lawsuit-settlements/open-lawsuit-settlements/
- https://www.classaction.org/settlements
- https://www.claimdepot.com/settlements
- https://www.openclassactions.com/settlements.php

Consumer Action blocks automated fetches and ClassActionRebates lists only
expired ones; do not use either. If a source fails twice, move on and name it
in `failures`.

**For each open settlement not already in the table**, decide in this order:

1. **Skip it** if its deadline is less than 2 days away, it has no claim form
   link, or the class plainly excludes him (a state he never lived in;
   a business-only class).
2. **`new`** if there is written evidence he qualifies. Look, cheapest first:
   - `accountant_assets` — the product, vehicle, landlord, employer or insurer
     it names;
   - `accountant_transactions` — a charge or refund from the company inside
     the class period (`description ilike '%<name>%'`, dates between the
     class period's ends);
   - `accountant_accounts` — the bank or card a breach or fee settlement names;
   - Gmail — `from:<company domain>` for proof he had an account, or a breach
     notice from them.
   `evidence` names what you found, specifically.
3. **`ask`** if it is for a common consumer product or service he may well
   have had but nothing proves either way — a phone model, a console, an
   appliance, a subscription. `asks_about` names it specifically enough to jog
   his memory: `a Nintendo Switch with Joy-Con drift`, not `electronics`. **At
   most 5 new `ask` rows a week**, soonest deadline first: a list of questions
   nobody answers is noise.
4. **Skip it** otherwise. No row. A settlement with no reason to think he
   qualifies is not worth his attention.

**Caps.** 40 page fetches in all. Never follow a link to anywhere that asks
for a login, and never fill a form.

## Counts

Add to the run row's `counts`: `settlement_notices`, and on Sundays
`settlements_new` and `settlements_asked`. A Sunday that found nothing is
normal — write zeros.
