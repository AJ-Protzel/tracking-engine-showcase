-- Every function in the public schema, exactly as the live database holds them.
--
-- Regenerated 2026-09-25 with pg_get_functiondef, not written by hand, so this is
-- the real source rather than a copy that drifted. Regenerate the same way:
--
--   select string_agg(pg_get_functiondef(p.oid), E';\n\n' order by p.proname)
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public';
--
-- This is the one part of the schema that could not be reconstructed from
-- SCHEMA.md if it were lost. Tables and constraints are described there in
-- prose; logic has to be kept as logic.
--
-- Every definition is CREATE OR REPLACE, so running this file against the live
-- database is safe and idempotent. Grants are not part of a definition: who may
-- execute each function is in SCHEMA.md, and a re-run leaves grants untouched.

CREATE OR REPLACE FUNCTION public.accountant_alias_pattern(raw text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select btrim(x.m[1])
    from regexp_matches(coalesce(raw, ''), '[A-Za-z''& ]+', 'g') with ordinality as x(m, n)
   where length(btrim(x.m[1])) >= 5
     and lower(btrim(x.m[1])) not in ('paypal', 'square', 'payp', 'ppal')
   order by x.n
   limit 1;
$function$
;

CREATE OR REPLACE FUNCTION public.accountant_clean_name(raw text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(
    (select a.clean_name from accountant_merchant_aliases a
      where position(lower(a.raw_pattern) in lower(raw)) > 0
      order by length(a.raw_pattern) desc limit 1),
    initcap(regexp_replace(regexp_replace(raw, '[0-9#*]+', ' ', 'g'), '\s+', ' ', 'g'))
  );
$function$
;

CREATE OR REPLACE FUNCTION public.accountant_feed_key_ok(p_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(p_key, '') <> ''
     and exists (select 1 from vault.decrypted_secrets
                  where name = 'bank_feed_key' and decrypted_secret = p_key);
$function$
;

CREATE OR REPLACE FUNCTION public.accountant_ingest(rows jsonb)
 RETURNS TABLE(inserted integer, skipped integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare ins int := 0; skp int := 0;
begin
  with incoming as (
    select
      (r->>'account_id')::bigint                as account_id,
      (r->>'date')::date                        as date,
      (r->>'amount')::numeric(12,2)             as amount,
      accountant_clean_name(r->>'description')  as description,
      r->>'description'                         as raw_description,
      coalesce(r->>'source','simplefin')        as source,
      r->>'external_id'                         as external_id,
      coalesce((r->>'pending')::boolean, false) as pending
    from jsonb_array_elements(rows) as r
  ),
  ready as (
    select i.*, c.category
    from incoming i
    left join accountant_merchant_categories c on c.clean_name = i.description
  ),
  done as (
    insert into accountant_transactions
      (account_id, date, amount, description, raw_description, category, source, external_id, pending)
    select account_id, date, amount, description, raw_description, category, source, external_id, pending
    from ready
    on conflict (external_id) do update set
      date            = excluded.date,
      amount          = excluded.amount,
      description     = excluded.description,
      raw_description = excluded.raw_description,
      category        = excluded.category,
      pending         = excluded.pending
    where accountant_transactions.pending
    returning 1
  )
  select count(*)::int into ins from done;
  select (jsonb_array_length(rows) - ins)::int into skp;
  return query select ins, skp;
end $function$
;

CREATE OR REPLACE FUNCTION public.accountant_prune_pending(since date, keep text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare n int;
begin
  delete from accountant_transactions
   where pending
     and source = 'simplefin'
     and date >= since
     and not (external_id = any(coalesce(keep, array[]::text[])));
  get diagnostics n = row_count;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.engine_prune()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  logs_deleted  int;
  mail_deleted  int;
  todos_deleted int;
  db_bytes      bigint;
begin
  delete from engine_logs where started_at < now() - interval '90 days';
  get diagnostics logs_deleted = row_count;

  delete from secretary_mail_log where acted_at < now() - interval '90 days';
  get diagnostics mail_deleted = row_count;

  -- a cleared row is kept for 90 days so the sweep does not raise the same
  -- thing again the next night; its item_key is what it checks
  delete from secretary_todos where cleared_at < now() - interval '90 days';
  get diagnostics todos_deleted = row_count;

  select pg_database_size(current_database()) into db_bytes;

  return jsonb_build_object(
    'logs_deleted',  logs_deleted,
    'mail_deleted',  mail_deleted,
    'todos_deleted', todos_deleted,
    'db_bytes',      db_bytes,
    'db_pretty',     pg_size_pretty(db_bytes),
    'over_threshold', db_bytes > 350 * 1024 * 1024
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.page_data()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  today date := (now() at time zone 'America/Los_Angeles')::date;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'transactions', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'date', t.date, 'desc', t.description,
               'cat', t.category, 'amt', t.amount, 'prov', t.pending, 'acct', t.account_id)
             order by t.date desc, t.id desc)
      from accountant_transactions t), '[]'::jsonb),

    -- a failed run writes a row too, with nothing seen; that is not a sync
    'synced', (
      select to_char(max(started_at) at time zone 'America/Los_Angeles', 'Mon FMDD')
             || ' at ' || to_char(max(started_at) at time zone 'America/Los_Angeles', 'FMHH12:MI AM')
      from engine_logs
      where job = 'bank_feed'
        and coalesce((counts ->> 'rows_inserted')::int, 0)
          + coalesce((counts ->> 'rows_skipped')::int, 0) > 0),

    'accounts', coalesce((select jsonb_object_agg(a.id::text, a.name)
                            from accountant_accounts a), '{}'::jsonb),

    'people', coalesce((select jsonb_agg(person order by person)
                          from (select distinct person from doctor_food_log) p), '[]'::jsonb),

    -- 14 days: the Intake chart draws a fortnight, and a tapped day opens onto
    -- the foods behind it
    'nutrition', coalesce((
      select jsonb_agg(jsonb_build_object('person', f.person, 'd', f.date,
               'day', to_char(f.date, 'Mon DD'), 'meal', f.meal,
               'cal', round(f.calories), 'p', round(f.protein_g),
               'c', round(f.carbs_g), 'f', round(f.fat_g), 'sug', round(f.sugar_g))
             order by f.date desc, f.person, f.id)
      from doctor_food_log f
      where f.date >= today - 13), '[]'::jsonb),

    -- the newest per person, however old: each stands until the doctor writes
    -- that person's next one
    'recs', coalesce((
      select jsonb_agg(jsonb_build_object('person', r.person, 'body', r.body,
               'dt', to_char(r.created_at at time zone 'America/Los_Angeles', 'Mon FMDD'))
             order by r.person)
      from (select distinct on (person) * from doctor_recommendations
             order by person, created_at desc) r), '[]'::jsonb),

    'jobs', jsonb_build_object(
      'counts', coalesce((select jsonb_object_agg(kind, n)
                          from (select kind, count(*)::int n from secretary_job_events group by kind) k), '{}'::jsonb)),

    -- To Do and Requires Action share secretary_todos. A crossed-off row stays
    -- on the page until the next email sweep clears it.
    'todos', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'text', t.text, 'done', t.done_at is not null,
               -- the note under the line, without the tracking tags Claude files by
               'detail', nullif(array_to_string(array(
                 select s from unnest(string_to_array(t.detail, ' | ')) s
                  where s !~ '^\s*(Project|side|session|last):'), ' | '), ''))
             order by t.created_at, t.id)
      from secretary_todos t
      where t.list = 'todo' and t.cleared_at is null), '[]'::jsonb),

    -- Backlog: tasks he has parked. The page shows them behind a tab on To Do and
    -- leaves them out of every count and the badge.
    'backlog', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'text', t.text, 'done', t.done_at is not null,
               -- the note under the line, without the tracking tags Claude files by
               'detail', nullif(array_to_string(array(
                 select s from unnest(string_to_array(t.detail, ' | ')) s
                  where s !~ '^\s*(Project|side|session|last):'), ' | '), ''))
             order by t.created_at, t.id)
      from secretary_todos t
      where t.list = 'backlog' and t.cleared_at is null), '[]'::jsonb),

    'actions', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'text', t.text,
               'detail', t.detail, 'done', t.done_at is not null, 'file_to', t.file_to)
             order by t.created_at, t.id)
      from secretary_todos t
      where t.list = 'requires_action' and t.cleared_at is null), '[]'::jsonb),

    -- every statement credit Amex has posted this calendar year; the page
    -- works out which cycle and which credit row each belongs to
    'credit_postings', coalesce((
      select jsonb_agg(jsonb_build_object('card', a.name, 'd', t.date, 'amt', t.amount, 'desc', t.description)
             order by t.date)
      from accountant_transactions t
      join accountant_accounts a on a.id = t.account_id
      where a.bank = 'AmEx' and a.kind = 'credit'
        and t.amount > 0 and t.description ilike '%credit%'
        and t.date >= date_trunc('year', today)::date), '[]'::jsonb),

    'credits', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'card', c.card, 'name', c.name,
               'amt', c.amount, 'amt_dec', c.amount_december, 'period', c.period,
               'match', c.match, 'claimed', c.claimed, 'claimed_cycle', c.claimed_cycle,
               'claimed_as_of', c.claimed_as_of, 'icon', c.icon_domain, 'remind', c.remind)
             order by c.sort_order)
      from accountant_credits c), '[]'::jsonb),

    -- Temporary, with the Rentals tab. The rent shown and capped is Zillow's
    -- where the vet step found the house for rent there: RentCast's can be wrong. A house off the market is taken and
    -- leaves the page, unless it was saved (a status past new): those stay,
    -- whatever their price or verdict, so a lost favourite shows as gone.
    -- The row always stays, so a relisting is not new again.
    -- A dismissed one never shows again, and only a house the vet step
    -- passed, or could not decide on, shows at all.
    'rentals', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'address', l.address, 'city', l.city,
               'price', coalesce(l.zillow_price, l.price), 'price_was', l.price_was, 'beds', l.beds, 'baths', l.baths,
               'sqft', l.sqft, 'days', greatest(0, coalesce(today - l.listed_date, l.days_on_market)),
               'photo', coalesce(l.photo, case when k.street_view_key is not null then
                 'https://maps.googleapis.com/maps/api/streetview?size=192x144&source=outdoor&return_error_code=true&location='
                 || replace(replace(regexp_replace(l.address || ', ' || coalesce(l.city, '') || ' ' || coalesce(l.zip, ''),
                                                   '[^A-Za-z0-9 ,.-]', '', 'g'), ' ', '+'), ',', '%2C')
                 || '&key=' || k.street_view_key end), 'url', coalesce(l.zillow_url, l.url), 'status', l.status, 'gone', l.gone_on is not null or l.zillow_gone_on is not null,
               'agent_name', l.agent_name, 'agent_phone', l.agent_phone,
               'agent_email', l.agent_email, 'notes', l.notes,
               'verdict', l.verdict, 'verdict_reason', l.verdict_reason,
               'building', l.building_key, 'landlord', l.landlord,
               'income_rule', l.income_rule, 'apply_note', l.apply_note))
      from rentals_listings l
      cross join (select street_view_key, max_price from rentals_search where id = 1) k
      where l.dismissed_at is null
        and ((l.verdict in ('pass', 'unsure') and coalesce(l.zillow_price, l.price) <= k.max_price
                  and l.gone_on is null and l.zillow_gone_on is null)
             or l.status <> 'new')), '[]'::jsonb),

    'rental_statuses', to_jsonb(enum_range(null::rentals_status)),

    -- Settlements that are still his to act on: a question about whether he owns
    -- the product, found, or filed and not yet paid. Done and skipped rows are
    -- kept only so the sweep never raises them again. Soonest deadline first.
    'settlements', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'url', s.claim_url,
               'deadline', s.deadline, 'payout', s.payout, 'proof', s.proof_required,
               'evidence', s.evidence, 'claim_id', s.claim_id, 'status', s.status,
               'asks_about', s.asks_about, 'notes', s.notes)
             order by s.deadline nulls last, s.id)
      from accountant_settlements s
      where s.status in ('ask', 'new', 'ongoing')
        and (s.deadline is null or s.deadline >= today or s.status = 'ongoing')), '[]'::jsonb),

    'settlement_statuses', to_jsonb(enum_range(null::accountant_settlement_status)),

    -- Problems are worked out on every load rather than stored. Each clears
    -- itself the moment its cause is gone, so none of them can be crossed off.
    'problems', coalesce((
      select jsonb_agg(jsonb_build_object('tag', x.tag, 'txt', x.txt, 'detail', x.detail))
      from (
        select 'Sweep' as tag,
               case when s.id is null then 'Email sweep has never run'
                    when s.started_at < now() - interval '30 hours'
                      then 'Email sweep has not run since '
                           || to_char(s.started_at at time zone 'America/Los_Angeles', 'Mon FMDD')
                    when s.status = 'failed' then 'Email sweep failed'
                    when s.status = 'running' then 'Email sweep did not finish'
                    else 'Email sweep finished with problems' end as txt,
               case when s.status = 'ok' and s.started_at >= now() - interval '30 hours'
                      then left((select string_agg(case jsonb_typeof(f) when 'string' then f #>> '{}'
                                                   else f::text end, '; ')
                                 from jsonb_array_elements(case when jsonb_typeof(s.summary -> 'failures') = 'array'
                                                                then s.summary -> 'failures'
                                                                else '[]'::jsonb end) f), 240)
                    else left(s.error, 240) end as detail
        from (select 1) one
        left join lateral (select l.* from engine_logs l where l.job = 'email_sweep'
                           order by l.started_at desc limit 1) s on true
        where s.id is null
           or s.started_at < now() - interval '30 hours'
           or s.status = 'failed'
           or (s.status = 'running' and s.started_at < now() - interval '1 hour')
           or (s.status = 'ok' and jsonb_typeof(s.summary -> 'failures') = 'array'
               and jsonb_array_length(s.summary -> 'failures') > 0)
        union all
        select 'Bank',
               case when b.started_at < now() - interval '30 hours'
                      then 'Bank feed has not run since '
                           || to_char(b.started_at at time zone 'America/Los_Angeles', 'Mon FMDD')
                    when coalesce((b.counts ->> 'rows_inserted')::int, 0)
                       + coalesce((b.counts ->> 'rows_skipped')::int, 0) = 0
                      then 'Bank feed loaded nothing'
                    else 'Bank feed reported errors' end,
               left(b.error, 240)
        from (select l.* from engine_logs l where l.job = 'bank_feed'
              order by l.started_at desc limit 1) b
        where b.started_at < now() - interval '30 hours'
           or coalesce((b.counts ->> 'rows_inserted')::int, 0)
            + coalesce((b.counts ->> 'rows_skipped')::int, 0) = 0
           or b.error is not null
        union all
        select 'Rentals',
               case when r.started_at < now() - interval '30 hours'
                      then 'Rental feed has not run since '
                           || to_char(r.started_at at time zone 'America/Los_Angeles', 'Mon FMDD')
                    when r.status = 'skipped' then 'Rental feed paused at its request cap'
                    else 'Rental feed failed' end,
               left(coalesce(r.error, r.summary ->> 'note'), 240)
        from (select l.* from engine_logs l where l.job = 'rental_feed'
              order by l.started_at desc limit 1) r
        where r.started_at < now() - interval '30 hours'
           or r.status in ('failed', 'skipped')
        union all
        select 'Settlement',
               s.title || ' — claim closes ' || case when s.deadline = today then 'today'
                 when s.deadline = today + 1 then 'tomorrow'
                 else 'in ' || (s.deadline - today) || ' days' end,
               coalesce(s.payout || ' · ', '') || 'File it from the Settlements card.'
        from accountant_settlements s
        where s.status = 'new' and s.deadline between today and today + 13
        union all
        -- good news, not a fault: the day's new houses that passed vetting,
        -- gone again tomorrow
        select 'Rentals',
               r.n || case when r.n = 1 then ' new rental' else ' new rentals' end || ' in Filtered today',
               'Open the Rentals tab.'
        from (select count(distinct l.building_key) n
                from rentals_listings l
                cross join (select max_price from rentals_search where id = 1) k
               where l.verdict = 'pass' and l.found_on = today and l.dismissed_at is null
                 and l.gone_on is null and l.zillow_gone_on is null
                 and coalesce(l.zillow_price, l.price) <= k.max_price) r
        where r.n > 0
      ) x), '[]'::jsonb)
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.page_rename(p_txn_id bigint, p_name text, p_category text, p_whole_merchant boolean)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_from text;
  v_raw text;
  v_pattern text;
  v_count int;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_name = '' or length(v_name) > 80 then
    raise exception 'a name is 1 to 80 characters' using errcode = '22023';
  end if;

  select description, raw_description into v_from, v_raw
    from accountant_transactions where id = p_txn_id;
  if not found then
    raise exception 'no transaction %', p_txn_id using errcode = 'P0002';
  end if;

  -- a missing flag means this charge only, never the whole merchant
  if not coalesce(p_whole_merchant, false) then
    update accountant_transactions set description = v_name, category = p_category where id = p_txn_id;
    return 1;
  end if;

  -- The alias is matched against the bank's own text, so build the pattern
  -- from that when the row has it. Falling back to the shown name only works
  -- where the bank's text held no digits, * or #.
  v_pattern := coalesce(accountant_alias_pattern(v_raw),
                        btrim(regexp_replace(v_from, '[0-9#*]', '', 'g')));
  if v_pattern <> '' then
    insert into accountant_merchant_aliases (raw_pattern, clean_name) values (v_pattern, v_name)
    on conflict (raw_pattern) do update set clean_name = excluded.clean_name;
  end if;
  if p_category is not null then
    insert into accountant_merchant_categories (clean_name, category) values (v_name, p_category)
    on conflict (clean_name) do update set category = excluded.category;
  end if;

  update accountant_transactions set description = v_name, category = p_category where description = v_from;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.page_rental_dismiss(p_id bigint, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if length(v_reason) > 200 then
    raise exception 'a reason is at most 200 characters' using errcode = '22023';
  end if;
  -- the page shows a building as one row, so dismissing it dismisses every
  -- unit in it; the rows stay, so a relisting stays dismissed
  update rentals_listings set dismissed_at = now(), dismiss_reason = v_reason
   where building_key = (select building_key from rentals_listings where id = p_id)
     and dismissed_at is null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.page_rental_set(p_id bigint, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- the cast rejects anything outside the enum
  update rentals_listings
     set status = p_status::rentals_status, status_at = now()
   where id = p_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.page_settlement_set(p_id bigint, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_was accountant_settlement_status;
  v_what text;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select status, asks_about into v_was, v_what from accountant_settlements where id = p_id;
  if not found then
    raise exception 'no settlement %', p_id using errcode = 'P0002';
  end if;
  update accountant_settlements
     set status = p_status::accountant_settlement_status, status_at = now()
   where id = p_id;
  -- "I have it" on a question: he owns the thing, so it joins the asset list
  -- and the next sweep matches on it without asking again.
  if v_was = 'ask' and p_status = 'new' and coalesce(btrim(v_what), '') <> '' then
    insert into accountant_assets (name, kind, owned, notes)
    values (btrim(v_what), 'other', true, 'confirmed on the Settlements card')
    on conflict (kind, name) do update set owned = true, updated_at = now();
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.page_todo_add(p_text text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_text text := btrim(coalesce(p_text, ''));
  new_id bigint;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_text = '' or length(v_text) > 200 then
    raise exception 'a to-do is 1 to 200 characters' using errcode = '22023';
  end if;
  insert into secretary_todos (list, text) values ('todo', v_text) returning id into new_id;
  return new_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.page_todo_set(p_id bigint, p_done boolean, p_file_to text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- the page may only pick where a reply-needed email goes: Save or Trash
  update secretary_todos
     set done_at = case when p_done then coalesce(done_at, now()) end,
         file_to = case when kind in ('mail', 'draft') and p_file_to in ('Save', 'Trash')
                        then p_file_to else file_to end
   where id = p_id and cleared_at is null;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.rentals_ingest(p_rows jsonb, p_complete boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  today date := (now() at time zone 'America/Los_Angeles')::date;
  r jsonb;
  hit rentals_listings%rowtype;
  n_ins int := 0; n_upd int := 0; n_back int := 0; n_gone int := 0;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    -- RentCast's id first; a relisted house comes back under a new id at the
    -- same address, and is the same house
    select * into hit from rentals_listings
     where rentcast_id = r->>'rentcast_id' or address_key = r->>'address_key'
     order by (rentcast_id = r->>'rentcast_id') desc
     limit 1;
    if found then
      update rentals_listings set
        rentcast_id    = r->>'rentcast_id',
        price_was      = case when (r->>'price')::int <> price then price else price_was end,
        price          = (r->>'price')::int,
        beds           = (r->>'beds')::numeric,
        baths          = (r->>'baths')::numeric,
        sqft           = (r->>'sqft')::int,
        listed_date    = (r->>'listed_date')::date,
        days_on_market = (r->>'days_on_market')::int,
        agent_name     = r->>'agent_name',
        agent_phone    = r->>'agent_phone',
        agent_email    = r->>'agent_email',
        url            = r->>'url',
        last_seen_on   = today,
        gone_on        = null
       where id = hit.id;
      n_upd := n_upd + 1;
      if hit.gone_on is not null then n_back := n_back + 1; end if;
    else
      insert into rentals_listings (rentcast_id, address_key, address, city, zip, latitude,
        longitude, price, beds, baths, sqft, listed_date, days_on_market, agent_name,
        agent_phone, agent_email, url)
      values (r->>'rentcast_id', r->>'address_key', r->>'address', r->>'city', r->>'zip',
        (r->>'latitude')::numeric, (r->>'longitude')::numeric, (r->>'price')::int,
        (r->>'beds')::numeric, (r->>'baths')::numeric, (r->>'sqft')::int,
        (r->>'listed_date')::date, (r->>'days_on_market')::int, r->>'agent_name',
        r->>'agent_phone', r->>'agent_email', r->>'url');
      n_ins := n_ins + 1;
    end if;
  end loop;

  -- Only a full, non-empty pull may say what is gone: an empty or broken run
  -- would otherwise take every house off the market.
  if p_complete and jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 0 then
    update rentals_listings set gone_on = today
     where gone_on is null and last_seen_on < today;
    get diagnostics n_gone = row_count;
  end if;

  return jsonb_build_object('inserted', n_ins, 'updated', n_upd,
                            'returned', n_back, 'marked_gone', n_gone);
end;
$function$
;
