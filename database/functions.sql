-- Every function in the public schema, exactly as the live database holds them.
--
-- Regenerated 2026-10-06 (mail sorting added 2026-10-31) with pg_get_functiondef, not written by hand, so this is
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
  -- a pending charge is skipped; it arrives again once it posts
  with incoming as (
    select
      (r->>'account_id')::bigint                as account_id,
      (r->>'date')::date                        as date,
      (r->>'amount')::numeric(12,2)             as amount,
      accountant_clean_name(r->>'description')  as description,
      r->>'description'                         as raw_description,
      r->>'external_id'                         as external_id
    from jsonb_array_elements(rows) as r
    where not coalesce((r->>'pending')::boolean, false)
  ),
  done as (
    insert into accountant_transactions
      (account_id, date, amount, description, raw_description, category, external_id)
    -- money in is income, a refund included, unless the merchant map calls it a transfer
    select i.account_id, i.date, i.amount, i.description, i.raw_description,
           case when i.amount > 0 and c.category not in ('income', 'transfer') then 'income' else c.category end,
           i.external_id
    from incoming i
    left join accountant_merchant_categories c on c.clean_name = i.description
    on conflict (external_id) do nothing
    returning 1
  )
  select count(*)::int into ins from done;
  select (jsonb_array_length(rows) - ins)::int into skp;
  return query select ins, skp;
end $function$
;

CREATE OR REPLACE FUNCTION public.accountant_match_orders()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- Names bare bank charges from the order and receipt emails the sweep recorded.
-- A waiting order matches charges that still carry only the merchant's bare
-- name (description = merchant), dated 3 days before the order to 30 after:
-- one charge of the whole total, else two or three that add up to it. More
-- than one way to add up leaves it waiting. Matched charges take the order's
-- name. An order of two or more items also gets them as
-- accountant_transaction_items, priced only when one charge holds the whole
-- order and every price is known: tax and shipping spread in proportion, the
-- rounding cent on the largest. Never tags a tracker, never sets a category.
-- An order still waiting after 45 days expires.
declare
  today      date := (now() at time zone 'America/Los_Angeles')::date;
  o          accountant_orders;
  ids        bigint[];
  n_combos   int;
  priced     boolean;
  sum_prices numeric;
  matched    jsonb := '[]'::jsonb;
  n_expired  int;
begin
  for o in select * from accountant_orders where status = 'waiting' order by ordered_on, id loop
    ids := null;

    select array[t.id] into ids
      from accountant_transactions t
     where lower(t.description) = lower(o.merchant)
       and t.amount = o.total
       and t.date between o.ordered_on - 3 and o.ordered_on + 30
     order by abs(t.date - o.ordered_on), t.id
     limit 1;

    if ids is null then
      with c as (
        select t.id, t.amount
          from accountant_transactions t
         where lower(t.description) = lower(o.merchant)
           and sign(t.amount) = sign(o.total)
           and abs(t.amount) < abs(o.total)
           and t.date between o.ordered_on - 3 and o.ordered_on + 30
      ), combos as (
        select array[a.id, b.id] as ids
          from c a join c b on a.id < b.id
         where a.amount + b.amount = o.total
        union all
        select array[a.id, b.id, d.id]
          from c a join c b on a.id < b.id join c d on b.id < d.id
         where a.amount + b.amount + d.amount = o.total
      )
      select count(*), min(combos.ids) into n_combos, ids from combos;
      if n_combos <> 1 then ids := null; end if;
    end if;

    continue when ids is null;

    update accountant_transactions set description = o.name where id = any(ids);

    if jsonb_array_length(o.items) >= 2 then
      priced := cardinality(ids) = 1 and not exists (
        select 1 from jsonb_array_elements(o.items) x
         where coalesce((x ->> 'price')::numeric, 0) <= 0);
      sum_prices := case when priced then
        (select sum((x ->> 'price')::numeric) from jsonb_array_elements(o.items) x) end;

      insert into accountant_transaction_items (txn_id, name, amount)
      select tid, e.name,
             case when priced then e.share + case when e.rn = 1 then o.total - sum(e.share) over (partition by tid) else 0 end end
        from unnest(ids) tid,
             (select left(btrim(x ->> 'name'), 200) as name,
                     round(o.total * (x ->> 'price')::numeric / sum_prices, 2) as share,
                     row_number() over (order by (x ->> 'price')::numeric desc nulls last) as rn
                from jsonb_array_elements(o.items) x
               where coalesce(btrim(x ->> 'name'), '') <> '') e
       where not exists (select 1 from accountant_transaction_items i where i.txn_id = tid);
    end if;

    update accountant_orders set status = 'matched', txn_ids = ids, matched_at = now() where id = o.id;
    matched := matched || jsonb_build_object('order', o.id, 'name', o.name, 'txns', to_jsonb(ids));
  end loop;

  update accountant_orders set status = 'expired'
   where status = 'waiting' and ordered_on < today - 45;
  get diagnostics n_expired = row_count;

  return jsonb_build_object('matched', matched, 'expired', n_expired);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.doctor_food_log_add(p_person text, p_foods jsonb, p_date date DEFAULT NULL::date, p_use_pantry boolean DEFAULT false, p_is_estimated boolean DEFAULT true)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  e jsonb; it doctor_nutrition_items; g numeric; f numeric; n integer := 0;
  v_date date := coalesce(p_date, (now() at time zone 'America/Los_Angeles')::date);
  v_group uuid := gen_random_uuid();
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
  if p_person not in ('Alex','Sam') then raise exception 'person is Alex or Sam' using errcode='22023'; end if;
  if jsonb_typeof(p_foods) is distinct from 'array' or jsonb_array_length(p_foods) not between 1 and 40 then raise exception '1 to 40 foods per sitting' using errcode='22023'; end if;
  if v_date > (now() at time zone 'America/Los_Angeles')::date + 1 or v_date < current_date - 400 then raise exception 'date is out of range' using errcode='22023'; end if;
  for e in select * from jsonb_array_elements(p_foods) loop
    select * into it from doctor_nutrition_items where id = (e->>'item_id')::uuid;
    if not found then raise exception 'unknown food' using errcode='22023'; end if;
    if it.serving_g is null then raise exception '% has no serving_g in the library', it.item using errcode='22023'; end if;
    g := (e->>'grams')::numeric;
    if g is null or g <= 0 or g > 5000 then raise exception 'grams is 0 to 5000' using errcode='22023'; end if;
    f := g / it.serving_g;
    insert into doctor_food_log (meal, person, date, calories, protein_g, carbs_g, fat_g, sugar_g, is_estimated, portion_fraction, meal_group_id)
    values (it.item, p_person, v_date, round(it.calories*f,1), round(it.protein_g*f,1), round(it.carbs_g*f,1), round(it.fat_g*f,1), round(it.sugar_g*f,1), coalesce(p_is_estimated,true), round(f,3),
            case when jsonb_array_length(p_foods) > 1 then v_group end);
    if p_use_pantry then update doctor_pantry set quantity_g = greatest(quantity_g - g, 0), updated_at=now() where item_id = it.id; end if;
    n := n + 1;
  end loop;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.doctor_food_log_delete(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
  delete from doctor_food_log where id = p_id;
  if not found then raise exception 'log row not found' using errcode='22023'; end if;
end $function$
;

CREATE OR REPLACE FUNCTION public.doctor_food_log_list(p_person text DEFAULT NULL::text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_from date := coalesce(p_from, (now() at time zone 'America/Los_Angeles')::date - 13); v_to date := coalesce(p_to, (now() at time zone 'America/Los_Angeles')::date);
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
  if p_person is not null and p_person not in ('Alex','Sam') then raise exception 'person is Alex or Sam' using errcode='22023'; end if;
  if v_to - v_from > 92 then raise exception 'ask for 93 days or fewer at a time' using errcode='22023'; end if;
  return coalesce((select jsonb_agg(to_jsonb(l) order by l.date, l.logged_at) from doctor_food_log l
    where l.date between v_from and v_to and (p_person is null or l.person = p_person)),'[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.doctor_food_log_update(p_id uuid, p_meal text DEFAULT NULL::text, p_date date DEFAULT NULL::date, p_calories numeric DEFAULT NULL::numeric, p_protein_g numeric DEFAULT NULL::numeric, p_carbs_g numeric DEFAULT NULL::numeric, p_fat_g numeric DEFAULT NULL::numeric, p_sugar_g numeric DEFAULT NULL::numeric, p_is_estimated boolean DEFAULT NULL::boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
  if p_meal is not null and length(btrim(p_meal)) not between 1 and 200 then raise exception 'meal is 1 to 200 characters' using errcode='22023'; end if;
  if p_date is not null and (p_date > (now() at time zone 'America/Los_Angeles')::date + 1 or p_date < current_date - 400) then raise exception 'date is out of range' using errcode='22023'; end if;
  if least(coalesce(p_calories,0),coalesce(p_protein_g,0),coalesce(p_carbs_g,0),coalesce(p_fat_g,0),coalesce(p_sugar_g,0)) < 0 or coalesce(p_calories,0) > 5000 or greatest(coalesce(p_protein_g,0),coalesce(p_carbs_g,0),coalesce(p_fat_g,0),coalesce(p_sugar_g,0)) > 1000 then raise exception 'nutrient values are out of range' using errcode='22023'; end if;
  update doctor_food_log set meal=coalesce(btrim(p_meal),meal), date=coalesce(p_date,date), calories=coalesce(p_calories,calories), protein_g=coalesce(p_protein_g,protein_g),
    carbs_g=coalesce(p_carbs_g,carbs_g), fat_g=coalesce(p_fat_g,fat_g), sugar_g=coalesce(p_sugar_g,sugar_g), is_estimated=coalesce(p_is_estimated,is_estimated) where id=p_id;
  if not found then raise exception 'log row not found' using errcode='22023'; end if;
end $function$
;

CREATE OR REPLACE FUNCTION public.doctor_nutrition_item_delete(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
  if exists (select 1 from doctor_pantry where item_id=p_id) or exists (select 1 from doctor_recipe_ingredients where item_id=p_id) then
    raise exception 'that food is still in the pantry or a recipe: remove it there first' using errcode='23503'; end if;
  delete from doctor_nutrition_items where id = p_id;
  if not found then raise exception 'food not found' using errcode='22023'; end if;
end $function$
;

CREATE OR REPLACE FUNCTION public.doctor_nutrition_item_list()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(i) order by i.item) from doctor_nutrition_items i),'[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.doctor_nutrition_item_set(p_item text, p_serving text, p_serving_g numeric, p_calories numeric, p_protein_g numeric, p_carbs_g numeric, p_fat_g numeric, p_sugar_g numeric, p_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_id uuid := p_id;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
  if length(btrim(coalesce(p_item,''))) not between 1 and 120 or length(btrim(coalesce(p_serving,''))) not between 1 and 80 then raise exception 'item and serving are 1 to 120 and 1 to 80 characters' using errcode='22023'; end if;
  if p_serving_g is null or p_serving_g <= 0 or p_serving_g > 5000 then raise exception 'serving_g is 0 to 5000' using errcode='22023'; end if;
  if least(p_calories,p_protein_g,p_carbs_g,p_fat_g,p_sugar_g) < 0 or p_calories > 5000 or greatest(p_protein_g,p_carbs_g,p_fat_g,p_sugar_g) > 1000 then raise exception 'nutrient values are out of range' using errcode='22023'; end if;
  if v_id is null then
    if exists (select 1 from doctor_nutrition_items where lower(item)=lower(btrim(p_item)) and lower(serving)=lower(btrim(p_serving))) then raise exception 'that food and serving already exist' using errcode='23505'; end if;
    insert into doctor_nutrition_items (item, serving, serving_g, calories, protein_g, carbs_g, fat_g, sugar_g) values (btrim(p_item), btrim(p_serving), p_serving_g, p_calories, p_protein_g, p_carbs_g, p_fat_g, p_sugar_g) returning id into v_id;
  else
    update doctor_nutrition_items set item=btrim(p_item), serving=btrim(p_serving), serving_g=p_serving_g, calories=p_calories, protein_g=p_protein_g, carbs_g=p_carbs_g, fat_g=p_fat_g, sugar_g=p_sugar_g where id=v_id;
    if not found then raise exception 'food not found' using errcode='22023'; end if;
  end if;
  return v_id;
end $function$
;

CREATE OR REPLACE FUNCTION public.doctor_pantry_list()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('item_id',p.item_id,'item',i.item,'serving',i.serving,'serving_g',i.serving_g,'quantity_g',p.quantity_g,'location',p.location,'expires_on',p.expires_on,'updated_at',p.updated_at) order by i.item)
    from doctor_pantry p join doctor_nutrition_items i on i.id=p.item_id),'[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.doctor_pantry_remove(p_item_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
  delete from doctor_pantry where item_id = p_item_id;
end $function$
;

CREATE OR REPLACE FUNCTION public.doctor_pantry_set(p_item_id uuid, p_quantity_g numeric, p_location text DEFAULT 'pantry'::text, p_expires_on date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
  if p_quantity_g is null or p_quantity_g < 0 or p_quantity_g > 100000 then raise exception 'quantity_g is 0 to 100000' using errcode='22023'; end if;
  if p_location not in ('pantry','fridge','freezer') then raise exception 'location is pantry, fridge or freezer' using errcode='22023'; end if;
  if not exists (select 1 from doctor_nutrition_items where id=p_item_id) then raise exception 'unknown food: add it to the nutrition library first' using errcode='22023'; end if;
  insert into doctor_pantry (item_id, quantity_g, location, expires_on) values (p_item_id, p_quantity_g, p_location, p_expires_on)
  on conflict (item_id) do update set quantity_g=excluded.quantity_g, location=excluded.location, expires_on=excluded.expires_on, updated_at=now();
end $function$
;

CREATE OR REPLACE FUNCTION public.doctor_recipe_delete(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
  delete from doctor_recipes where id = p_id;
end $function$
;

CREATE OR REPLACE FUNCTION public.doctor_recipe_list()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'servings',r.servings,'instructions',r.instructions,'notes',r.notes,
    'ingredients',(select coalesce(jsonb_agg(jsonb_build_object('item_id',g.item_id,'item',i.item,'amount_g',g.amount_g) order by i.item),'[]'::jsonb)
      from doctor_recipe_ingredients g join doctor_nutrition_items i on i.id=g.item_id where g.recipe_id=r.id)) order by r.name)
    from doctor_recipes r),'[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.doctor_recipe_save(p_name text, p_servings numeric, p_ingredients jsonb, p_instructions text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_id uuid := p_id; e jsonb;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
  if jsonb_typeof(p_ingredients) is distinct from 'array' or jsonb_array_length(p_ingredients) not between 1 and 60 then
    raise exception 'a recipe has 1 to 60 ingredients' using errcode='22023'; end if;
  if v_id is null then
    insert into doctor_recipes (name, servings, instructions, notes) values (btrim(p_name), p_servings, p_instructions, p_notes) returning id into v_id;
  else
    update doctor_recipes set name=btrim(p_name), servings=p_servings, instructions=p_instructions, notes=p_notes, updated_at=now() where id=v_id;
    if not found then raise exception 'recipe not found' using errcode='22023'; end if;
    delete from doctor_recipe_ingredients where recipe_id=v_id;
  end if;
  for e in select * from jsonb_array_elements(p_ingredients) loop
    insert into doctor_recipe_ingredients (recipe_id, item_id, amount_g) values (v_id, (e->>'item_id')::uuid, (e->>'amount_g')::numeric);
  end loop;
  return v_id;
end $function$
;

CREATE OR REPLACE FUNCTION public.engine_anthropic_key()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select decrypted_secret from vault.decrypted_secrets where name = 'anthropic_api_key';
$function$;

CREATE OR REPLACE FUNCTION public.engine_mail_learn_from_sweep()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare n int;
begin
  with mapped as (
    select d.sender,
           case when l.action in ('trashed','blocked') then 'Trash'
                when l.label in ('Save/Jobs','Jobs') then 'Jobs'
                when l.label in ('Money','Money/Out','Money/In','Money Out','Money In','Bills') then 'Money'
                when l.label in ('Reading','Save/Newsletters','Newsletters') then 'Reading'
                when l.label in ('People','Save/Family') then 'People'
                when l.label in ('Housing','Wedding') then l.label end as label
      from secretary_mail_log l
      join engine_mail_decisions d on d.thread_id = l.gmail_thread_id
     where d.sender like '%@%' and d.rule_id is null
  ), agreed as (
    select sender, min(label) label from mapped
     where label is not null group by sender
    having count(*) >= 2 and count(distinct label) = 1
  )
  insert into engine_mail_rules (kind, pattern, label, push, source, note)
  select 'sender', a.sender, a.label, 'quiet', 'learned', 'from the 10am sweep'
    from agreed a
  on conflict (kind, pattern) do nothing;
  get diagnostics n = row_count;
  delete from engine_mail_decisions where created_at < now() - interval '90 days';
  delete from engine_api_usage where at < now() - interval '400 days';
  update engine_mail_watch set learned_at = now() where id = 1;
  return n;
end $function$;

CREATE OR REPLACE FUNCTION public.engine_mail_match(p_sender text, p_subject text)
 RETURNS engine_mail_rules
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select r.* from engine_mail_rules r
   where (r.kind = 'sender' and r.pattern = lower(p_sender))
      or (r.kind = 'domain' and (split_part(lower(p_sender), '@', 2) = r.pattern
                                 or split_part(lower(p_sender), '@', 2) like '%.' || r.pattern))
      or (r.kind = 'subject' and coalesce(p_subject, '') ~* r.pattern)
   order by case r.kind when 'sender' then 0 when 'domain' then 1 else 2 end, length(r.pattern) desc
   limit 1;
$function$;

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

  -- Gmail work the watch script finished a month ago is history no one reads
  delete from engine_mail_queue where applied_at < now() - interval '30 days';

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

CREATE OR REPLACE FUNCTION public.engine_vapid()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select jsonb_build_object('public', (select vapid_public from engine_mail_watch where id = 1),
    'private', (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_private'));
$function$
;

CREATE OR REPLACE FUNCTION public.engine_vapid_set(p_public text, p_private text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if exists (select 1 from vault.secrets where name = 'vapid_private') then
    raise exception 'push keys already exist';
  end if;
  perform vault.create_secret(p_private, 'vapid_private', 'Web Push private key for mail watch');
  update engine_mail_watch set vapid_public = p_public where id = 1;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.engine_watch_decide(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  m jsonb; r engine_mail_rules; w engine_mail_watch;
  decided jsonb := '[]'::jsonb; ask jsonb := '[]'::jsonb; d jsonb;
  spent numeric;
begin
  select * into w from engine_mail_watch where id = 1;
  select coalesce(sum(cost_usd), 0) into spent from engine_api_usage
   where at >= date_trunc('month', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles';
  for m in select jsonb_array_elements(coalesce(p -> 'messages', '[]'::jsonb)) loop
    continue when exists (select 1 from engine_mail_decisions where msg_id = m ->> 'msg_id');
    r := engine_mail_match(m ->> 'from', m ->> 'subject');
    if r.id is not null then
      update engine_mail_rules set hits = hits + 1, last_hit = now() where id = r.id;
    end if;
    if r.id is not null and not r.judge then
      -- Trash is always quiet: nothing trashed pushes or becomes a highlight.
      if r.label = 'Trash' then r.push := 'quiet'; end if;
      insert into engine_mail_decisions (msg_id, thread_id, sender, sender_name, subject, rule_id, label, push, highlight, decided_by, mode)
      values (m ->> 'msg_id', m ->> 'thread_id', lower(m ->> 'from'), m ->> 'name', left(m ->> 'subject', 300), r.id, r.label, r.push,
              case when r.push = 'highlight' then left(coalesce(nullif(m ->> 'name', ''), m ->> 'from') || ': ' || coalesce(m ->> 'subject', ''), 140) end,
              'rule', w.mode)
      on conflict (msg_id) do nothing;
      decided := decided || jsonb_build_object('msg_id', m ->> 'msg_id', 'thread_id', m ->> 'thread_id', 'label', r.label, 'push', r.push);
    else
      ask := ask || (m || jsonb_build_object('rule_id', r.id, 'rule_label', r.label, 'rule_push', r.push));
    end if;
  end loop;
  return jsonb_build_object('mode', w.mode, 'spent', spent, 'cap', w.api_cap_usd, 'decided', decided, 'ask', ask);
end $function$;

CREATE OR REPLACE FUNCTION public.engine_watch_key_ok(p_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(p_key, '') <> ''
     and exists (select 1 from vault.decrypted_secrets
                  where name = 'mail_watch_key' and decrypted_secret = p_key);
$function$
;

CREATE OR REPLACE FUNCTION public.engine_watch_pull()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare w engine_mail_watch;
begin
  update secretary_todos set cleared_at = now()
   where list = 'requires_action' and done_at is not null and cleared_at is null
     and gmail_thread_id is null;

  insert into engine_mail_queue (gmail_thread_id, add_labels, remove_labels, trash, todo_id)
  -- "Save" files to where the sorter put the thread (Jobs, Housing, ...), else Save.
  select t.gmail_thread_id,
         case when t.file_to = 'Trash' then '{}'::text[]
              when t.file_to = 'Save' and t.item_key like 'job:%' then array['Jobs']
              when coalesce(t.file_to, 'Save') = 'Save' and t.kind in ('mail', 'draft') then array[coalesce(
                (select d.label from engine_mail_decisions d
                  where d.thread_id = t.gmail_thread_id
                    and d.label in ('Jobs', 'Housing', 'Wedding', 'Money', 'People', 'Reading')
                  order by d.created_at desc limit 1), 'Save')]
              when t.file_to is not null then array[t.file_to]
              else '{}'::text[] end,
         array['Requires Action', 'INBOX'],
         t.file_to = 'Trash' and t.kind in ('mail', 'draft'),
         t.id
    from secretary_todos t
   where t.list = 'requires_action' and t.done_at is not null and t.cleared_at is null
     and t.gmail_thread_id is not null
     and not exists (select 1 from engine_mail_queue q where q.todo_id = t.id);

  select * into w from engine_mail_watch where id = 1;
  if w.learned_at is null or w.learned_at < now() - interval '1 day' then
    perform engine_mail_learn_from_sweep();
  end if;
  return jsonb_build_object(
    'after', w.after_ts,
    'mode', w.mode,
    'alert_domains', to_jsonb(w.alert_domains),
    'self', to_jsonb(w.self_addresses),
    'blocked', coalesce((select jsonb_agg(lower(b.sender_email)) from secretary_blocklist b
                          where b.status = 'Blocked'), '[]'::jsonb),
    'actions', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'thread', q.gmail_thread_id,
                           'add', q.add_labels, 'remove', q.remove_labels, 'trash', q.trash) order by q.id)
                          from engine_mail_queue q where q.applied_at is null and q.tries < 5), '[]'::jsonb));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.engine_watch_push(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r jsonb; tid bigint; n_applied int := 0; n_failed int := 0;
  pushes jsonb := '[]'::jsonb; err text := nullif(p ->> 'error', '');
begin
  for r in select jsonb_array_elements(coalesce(p -> 'applied', '[]'::jsonb)) loop
    if coalesce((r ->> 'ok')::boolean, false) then
      update engine_mail_queue set applied_at = now(), error = null
       where id = (r ->> 'id')::bigint and applied_at is null returning todo_id into tid;
      if tid is not null then
        update secretary_todos set cleared_at = now() where id = tid and cleared_at is null;
      end if;
      n_applied := n_applied + 1;
    else
      update engine_mail_queue set tries = tries + 1, error = left(r ->> 'error', 300)
       where id = (r ->> 'id')::bigint;
      n_failed := n_failed + 1;
    end if;
  end loop;

  for r in select jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb)) loop
    tid := null;
    insert into secretary_todos (list, kind, text, detail, item_key, gmail_thread_id, source)
    values ('requires_action', 'mail',
            left(coalesce(nullif(r ->> 'name', ''), r ->> 'from') || ': '
                 || coalesce(nullif(r ->> 'subject', ''), '(no subject)'), 300),
            left(coalesce(r ->> 'reason', '') || coalesce(' · ' || nullif(r ->> 'snippet', ''), ''), 300),
            'watch:' || (r ->> 'msg_id'), r ->> 'thread_id', 'watch')
    on conflict (item_key) where item_key is not null do nothing
    returning id into tid;
    -- every new row; the edge function decides which of them push
    if tid is not null then
      pushes := pushes || jsonb_build_object(
        'title', left(coalesce(nullif(r ->> 'name', ''), r ->> 'from'), 80),
        'body', left(coalesce(nullif(r ->> 'subject', ''), r ->> 'reason'), 160),
        'tag', 'thread-' || (r ->> 'thread_id'),
        'msg_id', r ->> 'msg_id', 'from', r ->> 'from', 'reason', r ->> 'reason',
        'snippet', r ->> 'snippet');
    end if;
  end loop;

  update engine_mail_watch
     set after_ts = coalesce((p ->> 'after')::bigint, after_ts),
         last_error = err,
         last_ok = case when err is null then now() else last_ok end,
         last_counts = jsonb_build_object('at', now(), 'scanned', p -> 'scanned', 'blocked', p -> 'blocked',
                         'raised', jsonb_array_length(pushes), 'applied', n_applied, 'failed', n_failed)
   where id = 1;

  return jsonb_build_object('pushes', pushes,
    'badge', (select count(*) from secretary_todos
               where list = 'requires_action' and cleared_at is null and done_at is null),
    -- threads in this batch with an open Requires Action row: live filing keeps them there
    'open_threads', coalesce((select jsonb_agg(distinct t.gmail_thread_id) from secretary_todos t
                    where t.list = 'requires_action' and t.cleared_at is null and t.done_at is null
                      and t.gmail_thread_id in (select jsonb_array_elements(coalesce(p -> 'messages', '[]'::jsonb)) ->> 'thread_id')),
                    '[]'::jsonb));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.engine_watch_record(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare x jsonb; w engine_mail_watch; n int := 0; learned int := 0; snd text;
begin
  select * into w from engine_mail_watch where id = 1;
  for x in select jsonb_array_elements(coalesce(p -> 'usage', '[]'::jsonb)) loop
    insert into engine_api_usage (model, input_tokens, output_tokens, cost_usd, msg_id)
    values (x ->> 'model', (x ->> 'input_tokens')::int, (x ->> 'output_tokens')::int, (x ->> 'cost_usd')::numeric, x ->> 'msg_id');
  end loop;
  for x in select jsonb_array_elements(coalesce(p -> 'results', '[]'::jsonb)) loop
    -- Trash is always quiet: nothing trashed pushes or becomes a highlight.
    if x ->> 'label' = 'Trash' then x := x || '{"push": "quiet", "highlight": ""}'::jsonb; end if;
    insert into engine_mail_decisions (msg_id, thread_id, sender, sender_name, subject, rule_id, label, push, highlight, decided_by, mode)
    values (x ->> 'msg_id', x ->> 'thread_id', lower(x ->> 'from'), x ->> 'name', left(x ->> 'subject', 300),
            nullif(x ->> 'rule_id', '')::bigint, x ->> 'label', x ->> 'push', left(nullif(x ->> 'highlight', ''), 140),
            x ->> 'by', w.mode)
    on conflict (msg_id) do nothing;
    n := n + 1;
    -- Live: mail the sorter calls Requires Action gets a row even when the script's rules missed it.
    if w.mode = 'live' and x ->> 'label' = 'Requires Action' then
      insert into secretary_todos (list, kind, text, detail, item_key, gmail_thread_id, source)
      values ('requires_action', 'mail',
              left(coalesce(nullif(x ->> 'name', ''), x ->> 'from') || ': ' || coalesce(nullif(x ->> 'subject', ''), '(no subject)'), 300),
              left('Sorted as Requires Action' || coalesce(' · ' || nullif(x ->> 'highlight', ''), ''), 300),
              'watch:' || (x ->> 'msg_id'), x ->> 'thread_id', 'watch')
      on conflict (item_key) where item_key is not null do nothing;
    end if;
    snd := lower(x ->> 'from');
    if x ->> 'by' = 'haiku' and x ->> 'learn' in ('sender', 'domain')
       and x ->> 'label' not in ('Requires Action', 'Review') and nullif(x ->> 'rule_id', '') is null
       and position('@' in snd) > 0 then
      insert into engine_mail_rules (kind, pattern, label, push, judge, source, note)
      values (x ->> 'learn', case x ->> 'learn' when 'sender' then snd else split_part(snd, '@', 2) end,
              x ->> 'label', case when x ->> 'push' = 'push' then 'highlight' else x ->> 'push' end,
              coalesce((x ->> 'content_varies')::boolean, false)
                or x ->> 'learn' = 'domain'
                or x ->> 'label' not in ('Trash', 'Money', 'Reading'),
              'learned', 'from ' || left(x ->> 'subject', 80))
      on conflict (kind, pattern) do nothing;
      if found then learned := learned + 1; end if;
    end if;
  end loop;
  -- A failed model call shows on the Alerts page as a Watch error until a run succeeds.
  if jsonb_array_length(coalesce(p -> 'errors', '[]'::jsonb)) > 0 then
    update engine_mail_watch set last_error = 'Mail sorting: ' || left(p -> 'errors' ->> 0, 250) where id = 1;
  end if;
  return jsonb_build_object('recorded', n, 'learned', learned);
end $function$;

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
               'cat', t.category, 'amt', t.amount, 'acct', t.account_id, 'wed', exists (select 1 from engine_tracker_links k join engine_trackers r on r.id = k.tracker_id where k.txn_id = t.id and r.name = 'Wedding'))
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

    -- Backlog: tasks he has parked. The page folds them away under To Do and
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
               'detail', t.detail, 'done', t.done_at is not null, 'file_to', t.file_to, 'verdict', t.verdict, 'note', t.note,
               'due', t.due_at, 'watch', t.source = 'watch')
             -- anything with a deadline first, soonest on top
             order by t.due_at nulls last, t.created_at, t.id)
      from secretary_todos t
      where t.list = 'requires_action' and t.cleared_at is null), '[]'::jsonb),

    -- the key a phone subscribes to push with; null until the watch first runs
    'push_key', (select w.vapid_public from engine_mail_watch w where w.id = 1),

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
               'claimed_as_of', c.claimed_as_of, 'icon', c.icon_domain, 'remind', c.remind, 'expected_day', c.expected_day)
             order by c.sort_order)
      from accountant_credits c), '[]'::jsonb),

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

    -- the numbers set from the page itself, e.g. the heatmap's day budget
    'settings', coalesce((select jsonb_object_agg(e.key, e.value) from engine_settings e), '{}'::jsonb),

    -- the quiet line on Alerts: database size now, and Cloudflare builds as
    -- of the newest bank sweep that counted them (free plan: 500 MB, 500 builds)
    'usage', jsonb_build_object(
      'db_bytes', pg_database_size(current_database()),
      'db_limit', 500 * 1024 * 1024,
      'cloudflare', (select l.summary -> 'cloudflare' from engine_logs l
                     where l.job = 'bank_feed' and l.summary ? 'cloudflare'
                     order by l.started_at desc limit 1)),

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
        select 'Watch',
               case when w.last_ok is null and w.last_error is null then 'Mail watch is not installed yet'
                    when w.last_ok is null or w.last_ok < now() - interval '30 minutes'
                      then 'Mail watch has not checked mail since '
                           || coalesce(to_char(w.last_ok at time zone 'America/Los_Angeles', 'Mon FMDD FMHH12:MIam'), 'it started')
                    else 'Mail watch reported a problem' end,
               left(w.last_error, 240)
        from engine_mail_watch w
        where w.id = 1
          and (w.last_ok is null or w.last_ok < now() - interval '30 minutes' or w.last_error is not null)
        union all
        select 'Settlement',
               s.title || ' — claim closes ' || case when s.deadline = today then 'today'
                 when s.deadline = today + 1 then 'tomorrow'
                 else 'in ' || (s.deadline - today) || ' days' end,
               coalesce(s.payout || ' · ', '') || 'File it from the Settlements card.'
        from accountant_settlements s
        where s.status = 'new' and s.deadline between today and today + 13
      ) x), '[]'::jsonb)
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.page_push_subscribe(p_endpoint text, p_p256dh text, p_auth text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_endpoint !~ '^https://' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'bad subscription';
  end if;
  insert into engine_push_subs (endpoint, p256dh, auth, user_id)
  values (p_endpoint, p_p256dh, p_auth, auth.uid())
  on conflict (endpoint) do update
    set p256dh = excluded.p256dh, auth = excluded.auth, user_id = excluded.user_id;
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

CREATE OR REPLACE FUNCTION public.page_setting_set(p_key text, p_value jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- a null value clears the setting, so the page falls back to its default
  if p_value is null or p_value = 'null'::jsonb then
    delete from engine_settings where key = p_key;
    return;
  end if;
  -- heat_day and heat_top: one dollar figure each
  if jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}')::numeric not between 1 and 99999 then
    raise exception '% must be a number from 1 to 99999', p_key using errcode = '22023';
  end if;
  -- the key itself is checked by the table's constraint
  insert into engine_settings (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value, updated_at = now();
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

-- Highlights: mail worth knowing but not a push, last 7 days, one row per
-- sender (newest note, how many), newest first, until he dismisses it.
CREATE OR REPLACE FUNCTION public.page_highlights()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('sender', h.sender, 'name', h.name, 'note', h.note,
             'thread', h.thread_id, 'n', h.n, 'at', h.at) order by h.at desc)
    from (
      select distinct on (d.sender) d.sender, d.sender_name name, d.highlight note, d.thread_id, d.created_at at,
             count(*) over (partition by d.sender) n
        from engine_mail_decisions d
       where d.highlight is not null and d.dismissed_at is null and d.label <> 'Trash'
         and d.created_at >= now() - interval '7 days'
       order by d.sender, d.created_at desc) h), '[]'::jsonb);
end;
$function$
;
revoke all on function public.page_highlights() from public, anon;
grant execute on function public.page_highlights() to authenticated;

-- Dismisses every highlight from one sender (the page merges them into one row).
CREATE OR REPLACE FUNCTION public.page_highlight_dismiss(p_sender text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  update engine_mail_decisions set dismissed_at = now()
   where sender = lower(p_sender) and dismissed_at is null and highlight is not null;
end;
$function$
;
revoke all on function public.page_highlight_dismiss(text) from public, anon;
grant execute on function public.page_highlight_dismiss(text) to authenticated;

CREATE OR REPLACE FUNCTION public.page_todo_feedback(p_id bigint, p_verdict text, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare t secretary_todos; s text; v text := nullif(p_verdict, ''); n text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if v is not null and v not in ('spam', 'quiet', 'important') then
    raise exception 'unknown verdict' using errcode = '22023';
  end if;
  select * into t from secretary_todos where id = p_id and list = 'requires_action' and cleared_at is null;
  if t.id is null then return; end if;
  update secretary_todos
     set verdict = v, note = left(n, 500),
         file_to = case when t.kind in ('mail', 'draft') and v = 'spam' then 'Trash'
                        when t.kind in ('mail', 'draft') and v in ('quiet', 'important') and t.file_to = 'Trash' then 'Save'
                        else t.file_to end
   where id = p_id;
  -- teach the sender rule the mail watch reads, so the next one is handled without him
  select d.sender into s from engine_mail_decisions d
   where d.msg_id = split_part(coalesce(t.item_key, ''), ':', 2) limit 1;
  if s is not null and v is not null then
    insert into engine_mail_rules (kind, pattern, label, push, judge, source, note)
    values ('sender', lower(s),
            case v when 'spam' then 'Trash' when 'quiet' then 'Review' else 'Requires Action' end,
            case v when 'important' then 'push' else 'quiet' end,
            v = 'important', 'taught', left(coalesce(n, 'marked ' || v || ' on the Alerts page'), 300))
    on conflict (kind, pattern) do update
      set label = excluded.label, push = excluded.push, judge = excluded.judge,
          source = 'taught', note = excluded.note;
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.page_wedding(p_txn_id bigint, p_wedding boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare wtag smallint := (select id from engine_trackers where name = 'Wedding');
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not exists (select 1 from accountant_transactions where id = p_txn_id) then
    raise exception 'no transaction %', p_txn_id using errcode = 'P0002';
  end if;
  -- one charge only: a merchant is never wholly wedding. A charge with no group shows under Other wedding costs
  if coalesce(p_wedding, false) then
    insert into engine_tracker_links (txn_id, tracker_id) values (p_txn_id, wtag) on conflict do nothing;
  else
    delete from engine_tracker_links where txn_id = p_txn_id and tracker_id = wtag;
  end if;
end;
$function$
;

-- ticks one decor item; a ticked item stays on its list, crossed out
CREATE OR REPLACE FUNCTION public.page_wedding_decor_check(p_id bigint, p_done boolean)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r wedding_decor;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  update wedding_decor
     set bought = coalesce(p_done, false),
         bought_at = case when p_done then now() end,
         bought_by = case when p_done then auth.jwt() ->> 'email' end
   where id = p_id
  returning * into r;
  if r.id is null then raise exception 'no decor item %', p_id using errcode = 'P0002'; end if;
  return json_build_object('id', r.id, 'bought', r.bought);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.page_wedding_decor_add(p_event_id bigint, p_item text, p_qty integer, p_source text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r wedding_decor;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  -- a name already used elsewhere keeps its spelling, so the shopping list merges it
  insert into wedding_decor (event_id, item, qty, source, sort_order)
  values (p_event_id,
          coalesce((select item from wedding_decor where lower(item) = lower(btrim(p_item)) limit 1), btrim(p_item)),
          coalesce(p_qty, 1), coalesce(p_source, 'buy'),
          coalesce((select max(sort_order) + 1 from wedding_decor where event_id = p_event_id), 1))
  returning * into r;
  return json_build_object('id', r.id, 'event_id', r.event_id, 'item', r.item, 'qty', r.qty,
                           'source', r.source, 'note', r.note, 'bought', r.bought);
end;
$function$
;

-- changes an item's count or where it comes from; a null leaves that one alone
CREATE OR REPLACE FUNCTION public.page_wedding_decor_set(p_id bigint, p_qty integer, p_source text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r wedding_decor;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  update wedding_decor set qty = coalesce(p_qty, qty), source = coalesce(p_source, source)
   where id = p_id returning * into r;
  if r.id is null then raise exception 'no decor item %', p_id using errcode = 'P0002'; end if;
  return json_build_object('id', r.id, 'qty', r.qty, 'source', r.source);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.page_wedding_decor_remove(p_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  delete from wedding_decor where id = p_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.page_wedding_decor_event_add(p_name text, p_when text, p_where text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r wedding_decor_events;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  insert into wedding_decor_events (name, event_when, event_where, sort_order)
  values (btrim(p_name), nullif(btrim(p_when), ''), nullif(btrim(p_where), ''),
          coalesce((select max(sort_order) + 1 from wedding_decor_events), 1))
  returning * into r;
  return json_build_object('id', r.id, 'name', r.name, 'event_when', r.event_when, 'event_where', r.event_where);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.page_wedding_decor_event_set(p_id bigint, p_name text, p_when text, p_where text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r wedding_decor_events;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if nullif(btrim(p_name), '') is null then raise exception 'an event needs a name' using errcode = '22023'; end if;
  update wedding_decor_events set name = btrim(p_name), event_when = nullif(btrim(p_when), ''), event_where = nullif(btrim(p_where), '')
   where id = p_id and not is_break returning * into r;
  if r.id is null then raise exception 'no decor event %', p_id using errcode = 'P0002'; end if;
  return json_build_object('id', r.id, 'name', r.name, 'event_when', r.event_when, 'event_where', r.event_where);
end;
$function$
;

-- a blank break between events in the Decor list, added at the end
CREATE OR REPLACE FUNCTION public.page_wedding_decor_break_add()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r wedding_decor_events;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  insert into wedding_decor_events (name, is_break, sort_order)
  values ('', true, coalesce((select max(sort_order) + 1 from wedding_decor_events), 1))
  returning * into r;
  return json_build_object('id', r.id, 'name', r.name, 'is_break', true);
end;
$function$
;

-- the events in the order given, first is 1
CREATE OR REPLACE FUNCTION public.page_wedding_decor_event_order(p_ids bigint[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  update wedding_decor_events e set sort_order = o.n
    from unnest(p_ids) with ordinality as o(id, n)
   where e.id = o.id;
end;
$function$
;

-- removing an event removes its items with it
CREATE OR REPLACE FUNCTION public.page_wedding_decor_event_remove(p_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  delete from wedding_decor_events where id = p_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.page_wedding_check(p_id bigint, p_done boolean)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r wedding_checklist;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  update wedding_checklist
     set done = coalesce(p_done, false),
         done_at = case when p_done then now() end,
         done_by = case when p_done then auth.jwt() ->> 'email' end
   where id = p_id
  returning * into r;
  if r.id is null then
    raise exception 'no checklist item %', p_id using errcode = 'P0002';
  end if;
  return json_build_object('id', r.id, 'done', r.done);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.page_wedding_data()
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  yr   int := extract(year from (now() at time zone 'America/Los_Angeles'))::int;
  wtag smallint := (select id from engine_trackers where name = 'Wedding');
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  return (
    with bank as (
      select t.id, t.date, k.amount, k.description, k.group_id, coalesce(k.group_id, 20) as gid, coalesce(g.direction, 'out') as dir, g.name as gname,
             case when extract(year from t.date) = yr then to_char(t.date, 'Mon FMDD')
                  else to_char(t.date, 'Mon FMDD YYYY') end as dlabel
        from accountant_tracked_parts k  -- items of a split charge, plus its unitemized rest
        join accountant_transactions t on t.id = k.txn_id
        left join engine_tracker_groups g on g.id = coalesce(k.group_id, 20)
       where k.tracker_id = wtag
    ),
    -- off-bank rows. The group says in or out, pending says whether it has happened yet;
    -- the page still reads the four words promised, due, received, paid
    led as (
      select l.*, g.direction as dir, g.name as gname,
             case when l.pending then (case g.direction when 'in' then 'promised' else 'due' end)
                  else (case g.direction when 'in' then 'received' else 'paid' end) end as st,
             case when l.date is null then null
                  when extract(year from l.date) = yr then to_char(l.date, 'Mon FMDD')
                  else to_char(l.date, 'Mon FMDD YYYY') end as dlabel
        from wedding_transactions l
        join engine_tracker_groups g on g.id = l.group_id
       where l.tracker_id = wtag
    ),
    tx as (
      -- a bank charge is paid money out; a refund in the same group comes off it.
      -- in_bank is false only for off-bank rows, which the page flags unless they are due
      select b.id, 'paid'::text as status, b.date as due_date, b.dlabel as date_label, null::text as category,
             null::text as company, -b.amount as amount, null::text as amount_note,
             null::text as details, false as refundable,
             null::int as part_num, null::int as part_total, b.description as label, b.gid as group_id,
             null::bigint as payer_id, 'USD'::text as currency, null::numeric as amount_original,
             null::text as gift_via, null::text as gift_side, true as in_bank
        from bank b where b.dir = 'out'
      union all
      -- a deposit that paid for guests is split into one received line per guest
      select b.id, 'received', b.date, b.dlabel, 'Reservation', null, round(b.amount / count(*) over (partition by b.id), 2), null,
             b.description, false, null, null, gu.name, b.gid, gu.id, 'USD', null, null, null, true
        from bank b join wedding_guests gu on gu.paid_txn_id = b.id
       where b.dir = 'in'
      union all
      select b.id, 'received', b.date, b.dlabel,
             case b.gname when 'Gifts' then 'Gift' when 'Lodging Payment' then 'Reservation' else 'Contribution' end,
             null, b.amount, null, null, false, null, null, b.description, b.gid, null, 'USD', null, null, null, true
        from bank b
       where b.dir = 'in' and not exists (select 1 from wedding_guests gu where gu.paid_txn_id = b.id)
      union all
      -- a row linked to its bank charge (txn_id) is already counted above, so it drops out here
      select l.id, l.st, l.date, l.dlabel,
             case l.gname when 'Gifts' then 'Gift' when 'Lodging Payment' then 'Reservation'
                          when 'Contributions' then 'Contribution' else null end,
             null, l.amount, null, null, false, null, null, l.description, l.group_id, l.payer_id, 'USD',
             null, null, null, false
        from led l where l.txn_id is null and l.st <> 'promised'
    ),
    att as (select * from wedding_guests where attending)
    select json_build_object(
      'money', (select json_build_object(
          'paid', coalesce(sum(amount) filter (where status = 'paid'), 0),
          'due', coalesce(sum(amount) filter (where status = 'due' and not refundable), 0),
          'refundable_due', coalesce(sum(amount) filter (where status = 'due' and refundable), 0),
          'committed', coalesce(sum(amount) filter (where status in ('paid','due') and not refundable), 0),
          'unpriced_due', count(*) filter (where status = 'due' and amount is null),
          'due_items', count(*) filter (where status = 'due'),
          'received', coalesce(sum(amount) filter (where status = 'received'), 0)) from tx),
      'lodging', (select json_agg(row_to_json(l) order by l.sort_order) from (
          select b.id, b.cabin, b.bed_type, b.sort_order,
                 (count(g.id) filter (where not g.is_pet))::int as people,
                 count(g.id)::int as bodies,
                 coalesce(string_agg(g.name, ', ' order by g.is_pet, g.name), '') as names
            from wedding_beds b left join att g on g.bed_id = b.id
           group by b.id, b.cabin, b.bed_type, b.sort_order) l),
      'lodging_summary', json_build_object(
          'bed_count', (select count(*) from wedding_beds),
          'beds_used', (select count(distinct bed_id) from att where bed_id is not null),
          'guests_attending', (select count(*) from att where not is_pet),
          'parties_attending', (select count(distinct party) from att where not is_pet),
          'guests_placed', (select count(*) from att where not is_pet and bed_id is not null),
          'rsvped', (select count(*) from att where not is_pet and rsvp = 'yes'),
          'dinner_count', (select count(*) from att where not is_pet and eats_dinner)
                          + coalesce((select sum(headcount) from wedding_vendors where eats_dinner), 0),
          'payers', (select count(*) from att where not is_pet and pays)),
      'guests', (select json_agg(json_build_object('id', id, 'name', name, 'party', party,
                   'is_international', is_international, 'attending', attending, 'pays', pays,
                   'bed_id', bed_id, 'rsvp', rsvp, 'is_pet', is_pet) order by id) from wedding_guests),
      'vendors', (select json_agg(row_to_json(v) order by v.id) from wedding_vendors v),
      'transactions', (select json_agg(row_to_json(t) order by t.due_date nulls first, t.id) from tx t),
      'tx_groups', (select json_agg(json_build_object('id', id, 'name', name, 'details', details,
                     'sort_order', sort_order) order by sort_order, id) from engine_tracker_groups where tracker_id = wtag),
      'settings', (select json_object_agg(key, value) from wedding_settings),
      'page_text', (select json_object_agg(key, html) from wedding_page_text),
      'unsorted_notes', (select json_agg(json_build_object('id', n.id, 'body', n.body, 'created_at', n.created_at)
                           order by n.created_at) from wedding_unsorted_notes n),
      -- what Grandma June has promised: pending money in. A promise with no amount is an estimate and not counted
      'money_promised', (select json_agg(row_to_json(p) order by p.item_date nulls last, p.id) from (
          select l.id, l.description as label, null::text as vendor, l.amount, l.date as item_date,
                 l.dlabel as date_label, (l.amount is null) as is_estimate, null::text as details,
                 l.group_id, null::int as covers_group_id
            from led l where l.st = 'promised') p),
      'checklist', (select json_agg(json_build_object('id', c.id, 'list', c.list, 'sublist', c.sublist,
                      'body', c.body, 'note', c.note, 'done', c.done) order by c.sort_order, c.id)
                    from wedding_checklist c),
      -- decor: the events, then their items
      'decor_events', (select json_agg(json_build_object('id', e.id, 'name', e.name, 'event_when', e.event_when,
                      'event_where', e.event_where, 'is_break', e.is_break) order by e.sort_order, e.id) from wedding_decor_events e),
      'decor', (select json_agg(json_build_object('id', x.id, 'event_id', x.event_id, 'item', x.item, 'qty', x.qty,
                      'source', x.source, 'note', x.note, 'bought', x.bought) order by x.sort_order, x.id)
                    from wedding_decor x)
    )
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.page_wedding_note(p_body text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r wedding_unsorted_notes;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  insert into wedding_unsorted_notes (body, added_by)
  values (btrim(p_body), auth.jwt() ->> 'email')
  returning * into r;
  return json_build_object('id', r.id, 'body', r.body, 'created_at', r.created_at);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.preview_monarch_balances_page()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name,
        'kind', a.kind, 'owner', a.owner, 'bank', a.bank, 'active', a.active) order by a.id)
      from accountant_accounts a), '[]'::jsonb),
    'balances', coalesce((select jsonb_agg(jsonb_build_object('acct', b.account_id, 'd', b.as_of,
        'bal', b.balance, 'avail', b.available) order by b.as_of, b.account_id)
      from preview_monarch_balances b where b.as_of >= current_date - 400), '[]'::jsonb));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sweep_finish(p_run_id bigint, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- Everything the email sweep writes, in one call. Every row is written on its
-- own, so one bad row is named in failures instead of losing the rest.
--   p.mail_log   [{gmail_thread_id, action, label, subject_snippet, note}]
--   p.todos      [{kind, text, detail, item_key, gmail_thread_id, gmail_draft_id, calendar_event_id, file_to}]
--   p.cleared    [secretary_todos.id]  rows Step 2 filed
--   p.job_events [{gmail_thread_id, kind, company, role, occurred_at, note}]
--   p.strikes    [sender email]  one per sender trashed as Junk this run
--   p.orders     [{merchant, name, total, ordered_on, items, order_ref, gmail_thread_id}]
--                then accountant_match_orders() names the charges they match
--   p.actions    [{thread, add: [label], remove: [label], trash}]  Gmail work the
--                watch script does within 10 minutes: labels, archive, trash
--   p.counts     {scanned, labeled, trashed, drafts, events, settlement_notices, ...}
--   p.failures   [text]
--   p.error      text, set only when the run failed
declare
  today     date := (now() at time zone 'America/Los_Angeles')::date;
  failures  jsonb := coalesce(p -> 'failures', '[]'::jsonb);
  n_log     int := 0;
  n_raised  int := 0;
  n_cleared int := 0;
  n_jobs    int := 0;
  n_orders  int := 0;
  n_queued  int := 0;
  n         int;
  orders    jsonb;
  blocked   jsonb := '[]'::jsonb;
  retention jsonb;
  r         jsonb;
  sender    text;
  dates     date[];
begin
  for r in select jsonb_array_elements(coalesce(p -> 'mail_log', '[]'::jsonb)) loop
    begin
      insert into secretary_mail_log (run_id, gmail_thread_id, action, label, subject_snippet, note)
      values (p_run_id, r ->> 'gmail_thread_id', r ->> 'action', r ->> 'label',
              r ->> 'subject_snippet', r ->> 'note');
      n_log := n_log + 1;
    exception when others then
      failures := failures || to_jsonb('Mail log row for thread ' || coalesce(r ->> 'gmail_thread_id', '?')
                                       || ' not written: ' || sqlerrm);
    end;
  end loop;

  for r in select jsonb_array_elements(coalesce(p -> 'todos', '[]'::jsonb)) loop
    begin
      -- a row the watch script raised for the same thread becomes this one
      update secretary_todos
         set kind = r ->> 'kind', text = r ->> 'text', detail = r ->> 'detail',
             item_key = r ->> 'item_key', gmail_draft_id = r ->> 'gmail_draft_id',
             calendar_event_id = r ->> 'calendar_event_id', file_to = r ->> 'file_to',
             due_at = (r ->> 'due_at')::timestamptz, source = 'sweep'
       where id = (select w.id from secretary_todos w
                    where w.source = 'watch' and w.list = 'requires_action'
                      and w.cleared_at is null and w.done_at is null
                      and w.gmail_thread_id = r ->> 'gmail_thread_id'
                    order by w.id limit 1);
      get diagnostics n = row_count;
      if n = 0 then
        insert into secretary_todos (list, kind, text, detail, item_key, gmail_thread_id,
                                     gmail_draft_id, calendar_event_id, file_to, due_at, source)
        values ('requires_action', r ->> 'kind', r ->> 'text', r ->> 'detail', r ->> 'item_key',
                r ->> 'gmail_thread_id', r ->> 'gmail_draft_id', r ->> 'calendar_event_id',
                r ->> 'file_to', (r ->> 'due_at')::timestamptz, 'sweep')
        on conflict (item_key) where item_key is not null do nothing;
        get diagnostics n = row_count;
      end if;
      n_raised := n_raised + n;
    exception when others then
      failures := failures || to_jsonb('Requires Action item "' || coalesce(r ->> 'text', '?')
                                       || '" not written: ' || sqlerrm);
    end;
  end loop;

  begin
    update secretary_todos set cleared_at = now()
     where cleared_at is null
       and id in (select jsonb_array_elements_text(coalesce(p -> 'cleared', '[]'::jsonb))::bigint);
    get diagnostics n_cleared = row_count;
  exception when others then
    failures := failures || to_jsonb('Cleared rows not marked: ' || sqlerrm);
  end;

  for r in select jsonb_array_elements(coalesce(p -> 'job_events', '[]'::jsonb)) loop
    begin
      insert into secretary_job_events (gmail_thread_id, kind, company, role, occurred_at, note)
      values (r ->> 'gmail_thread_id', r ->> 'kind', r ->> 'company', r ->> 'role',
              (r ->> 'occurred_at')::timestamptz, r ->> 'note')
      on conflict (gmail_thread_id, kind, (coalesce(role, ''))) do nothing;
      get diagnostics n = row_count;
      n_jobs := n_jobs + n;
    exception when others then
      failures := failures || to_jsonb('Job event for ' || coalesce(r ->> 'company', '?')
                                       || ' not written: ' || sqlerrm);
    end;
  end loop;

  for sender in select distinct (jsonb_array_elements_text(coalesce(p -> 'strikes', '[]'::jsonb))) loop
    begin
      insert into secretary_blocklist (sender_email, trash_dates)
      values (sender, array[today])
      on conflict (sender_email) do update
        set trash_dates = case when today = any(secretary_blocklist.trash_dates)
                               then secretary_blocklist.trash_dates
                               else secretary_blocklist.trash_dates || today end,
            updated_at = now()
      returning trash_dates into dates;
      if cardinality(dates) >= 3 then
        update secretary_blocklist set status = 'Blocked', blocked_date = today, updated_at = now()
         where sender_email = sender and status <> 'Blocked';
        if found then blocked := blocked || to_jsonb(sender); end if;
      end if;
    exception when others then
      failures := failures || to_jsonb('Strike for ' || sender || ' not recorded: ' || sqlerrm);
    end;
  end loop;

  for r in select jsonb_array_elements(coalesce(p -> 'orders', '[]'::jsonb)) loop
    begin
      insert into accountant_orders (merchant, name, total, ordered_on, items, order_ref, gmail_thread_id)
      values (r ->> 'merchant', r ->> 'name', (r ->> 'total')::numeric, (r ->> 'ordered_on')::date,
              coalesce(r -> 'items', '[]'::jsonb), r ->> 'order_ref', r ->> 'gmail_thread_id')
      on conflict (lower(merchant), coalesce(order_ref, gmail_thread_id, ''), total) do nothing;
      get diagnostics n = row_count;
      n_orders := n_orders + n;
    exception when others then
      failures := failures || to_jsonb('Order "' || coalesce(r ->> 'name', '?')
                                       || '" not recorded: ' || sqlerrm);
    end;
  end loop;

  for r in select jsonb_array_elements(coalesce(p -> 'actions', '[]'::jsonb)) loop
    begin
      insert into engine_mail_queue (gmail_thread_id, add_labels, remove_labels, trash)
      values (r ->> 'thread',
              array(select jsonb_array_elements_text(coalesce(r -> 'add', '[]'::jsonb))),
              array(select jsonb_array_elements_text(coalesce(r -> 'remove', '[]'::jsonb))),
              coalesce((r ->> 'trash')::boolean, false));
      n_queued := n_queued + 1;
    exception when others then
      failures := failures || to_jsonb('Gmail work for thread ' || coalesce(r ->> 'thread', '?')
                                       || ' not queued: ' || sqlerrm);
    end;
  end loop;

  -- every run, so an order recorded on an earlier night matches once its charge posts
  begin
    orders := accountant_match_orders();
  exception when others then
    orders := jsonb_build_object('error', sqlerrm);
    failures := failures || to_jsonb('Charges were not named from order emails: ' || sqlerrm);
  end;

  begin
    retention := engine_prune();
  exception when others then
    retention := jsonb_build_object('error', sqlerrm);
  end;

  update engine_logs
     set finished_at = now(),
         status = case when nullif(p ->> 'error', '') is null then 'ok' else 'failed' end,
         error = nullif(p ->> 'error', ''),
         counts = coalesce(p -> 'counts', '{}'::jsonb)
                  || jsonb_build_object('raised', n_raised, 'cleared', n_cleared,
                                        'job_events', n_jobs, 'logged', n_log, 'queued', n_queued,
                                        'orders', n_orders,
                                        'charges_named', coalesce(jsonb_array_length(orders -> 'matched'), 0)),
         summary = jsonb_build_object('newly_blocked', blocked, 'retention', retention,
                                      'orders', orders, 'failures', failures)
   where id = p_run_id and job = 'email_sweep';

  return jsonb_build_object('run_id', p_run_id, 'logged', n_log, 'raised', n_raised,
                            'cleared', n_cleared, 'job_events', n_jobs, 'orders', n_orders,
                            'named', orders, 'newly_blocked', blocked, 'failures', failures);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sweep_start()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- Everything the email sweep needs before it touches Gmail, in one call:
-- opens the run row, clears his crossed-off to-dos, and returns the open
-- Requires Action rows, the blocklist, recent job events and settlement threads.
declare
  run_id   bigint;
  today    date := (now() at time zone 'America/Los_Angeles')::date;
  cleared  int;
begin
  insert into engine_logs (job) values ('email_sweep') returning id into run_id;

  update secretary_todos set cleared_at = now()
   where list in ('todo', 'backlog') and done_at is not null and cleared_at is null;
  get diagnostics cleared = row_count;

  return jsonb_build_object(
    'run_id', run_id,
    'today', today,
    'weekday', extract(isodow from today)::int,
    'sunday', extract(isodow from today) = 7,
    'todos_cleared', cleared,
    'open_items', coalesce((
      select jsonb_agg(to_jsonb(t) - 'list' - 'cleared_at' order by t.id)
        from secretary_todos t
       where t.list = 'requires_action' and t.cleared_at is null), '[]'::jsonb),
    'blocked', coalesce((
      select jsonb_agg(b.sender_email order by b.sender_email)
        from secretary_blocklist b where b.status = 'Blocked'), '[]'::jsonb),
    'watching', coalesce((
      select jsonb_object_agg(b.sender_email, b.trash_dates)
        from secretary_blocklist b where b.status = 'Watching'), '{}'::jsonb),
    'job_events', coalesce((
      select jsonb_agg(jsonb_build_object('thread', j.gmail_thread_id, 'kind', j.kind,
               'company', j.company, 'role', j.role, 'on', j.occurred_at::date)
             order by j.occurred_at desc)
        from secretary_job_events j
       where j.occurred_at > now() - interval '120 days'), '[]'::jsonb),
    'settlements', coalesce((
      select jsonb_agg(jsonb_build_object('title', s.title, 'claim_url', s.claim_url,
               'thread', s.gmail_thread_id, 'status', s.status) order by s.id)
        from accountant_settlements s), '[]'::jsonb)
  );
end;
$function$
;

-- The Wallet page's net worth and account totals, read when Wallet is opened
-- (2026-10-16). The balances are written by the SimpleFIN sweep.
alter table accountant_accounts
  add column if not exists balance numeric(14,2),
  add column if not exists balance_as_of timestamptz;

create or replace function public.page_wallet_data()
 returns json
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  return (
    select coalesce(json_agg(json_build_object(
             'id', a.id, 'name', a.name, 'bank', a.bank, 'kind', a.kind,
             'owner', a.owner, 'last4', a.last4,
             'balance', a.balance, 'as_of', a.balance_as_of)
           order by a.kind, a.bank, a.name), '[]'::json)
    from accountant_accounts a
    where a.active and a.balance is not null);
end;
$function$;

revoke all on function public.page_wallet_data() from public, anon;
grant execute on function public.page_wallet_data() to authenticated;

-- 2026-10-16: the Monarch trial's table becomes the daily balance history,
-- filled by the bank sweep, and the Monarch page reads it.
alter table preview_monarch_balances rename to accountant_balance_history;
alter index preview_monarch_balances_pkey rename to accountant_balance_history_pkey;

create or replace function public.page_monarch_data()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name,
        'kind', a.kind, 'owner', a.owner, 'bank', a.bank, 'last4', a.last4,
        'balance', a.balance, 'as_of', a.balance_as_of) order by a.kind, a.bank, a.name)
      from accountant_accounts a where a.active), '[]'::jsonb),
    'balances', coalesce((select jsonb_agg(jsonb_build_object('acct', b.account_id, 'd', b.as_of,
        'bal', b.balance) order by b.as_of, b.account_id)
      from accountant_balance_history b where b.as_of >= current_date - 400), '[]'::jsonb));
end;
$function$;
revoke execute on function public.page_monarch_data() from public, anon;
grant execute on function public.page_monarch_data() to authenticated;

-- 2026-10-16: the savings fund's target, typed on the Wallet page.
alter table engine_settings drop constraint engine_settings_key_check,
  add constraint engine_settings_key_check
  check (key = any (array['heat_day', 'heat_top', 'savings_target']));

create or replace function public.page_setting_set(p_key text, p_value jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  hi numeric := case when p_key = 'savings_target' then 99999999 else 99999 end;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- a null value clears the setting, so the page falls back to its default
  if p_value is null or p_value = 'null'::jsonb then
    delete from engine_settings where key = p_key;
    return;
  end if;
  -- heat_day, heat_top and savings_target: one dollar figure each
  if jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}')::numeric not between 1 and hi then
    raise exception '% must be a number from 1 to %', p_key, hi using errcode = '22023';
  end if;
  -- the key itself is checked by the table's constraint
  insert into engine_settings (key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value, updated_at = now();
end;
$function$;

-- 2026-10-16: Wallet also needs the savings target, so it returns an object.
create or replace function public.page_wallet_data()
 returns json
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  return json_build_object(
    'accounts', (select coalesce(json_agg(json_build_object(
             'id', a.id, 'name', a.name, 'bank', a.bank, 'kind', a.kind,
             'owner', a.owner, 'last4', a.last4,
             'balance', a.balance, 'as_of', a.balance_as_of)
           order by a.kind, a.bank, a.name), '[]'::json)
      from accountant_accounts a
      where a.active and a.balance is not null),
    'savings_target', (select (value #>> '{}')::numeric from engine_settings
                      where key = 'savings_target'));
end;
$function$;

-- Each signed-in user's own page layout (layout.js), in user_layouts.
create or replace function public.page_layout_get()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- the caller's own layout, or null when they have never edited it
  return (select layout from user_layouts where user_id = auth.uid());
end;
$function$;

create or replace function public.page_layout_set(p_layout jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- null puts the caller back on the default layout
  if p_layout is null or p_layout = 'null'::jsonb then
    delete from user_layouts where user_id = auth.uid();
    return;
  end if;
  if jsonb_typeof(p_layout) <> 'object' or jsonb_typeof(p_layout -> 'pages') <> 'array' then
    raise exception 'a layout is an object with a pages array' using errcode = '22023';
  end if;
  if octet_length(p_layout::text) > 65536 then
    raise exception 'layout over 64 KB' using errcode = '22023';
  end if;
  insert into user_layouts (user_id, layout) values (auth.uid(), p_layout)
  on conflict (user_id) do update set layout = excluded.layout, updated_at = now();
end;
$function$;
revoke all on function public.page_layout_get() from public, anon;
revoke all on function public.page_layout_set(jsonb) from public, anon;
grant execute on function public.page_layout_get() to authenticated;
grant execute on function public.page_layout_set(jsonb) to authenticated;
