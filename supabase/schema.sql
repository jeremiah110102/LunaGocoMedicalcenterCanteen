-- ==========================================================
-- Campus Canteen POS — SUPABASE DATABASE
-- ==========================================================
-- Makes a Supabase (Postgres) project the canteen's database. Firebase is still
-- used for sign-in: Supabase checks each Firebase sign-in token (Third-party Auth),
-- and the functions below apply the same rules as firestore.rules.
--
-- SETUP (about 5 minutes)
--  1. Create a project at https://supabase.com (the free plan is fine).
--  2. SQL Editor → New query → paste this whole file → Run.
--  3. Authentication → Sign In / Providers → Third-party Auth → Add provider →
--     Firebase → enter your Firebase Project ID → Create.
--  4. Project Settings → API Keys: copy the Project URL and the publishable key
--     (sb_publishable_…) or the legacy "anon public" key.
--     NEVER use the secret / service_role key in the website.
--  5. In the app: Settings → Database → Supabase → paste URL and key → Test → Switch.
--
-- Running this file again is safe: it keeps your records and updates the functions.
--
-- Storage: every record is one row of pos.docs (col = list name such as "sales",
-- id = record id, data = the record as JSON, v = version). The website cannot reach
-- the table directly; everything goes through public.pos_request, which checks the
-- signed-in Firebase account first. Product photos go to the "product-images" bucket.
-- ==========================================================

set client_min_messages = warning;
create schema if not exists pos;
revoke all on schema pos from public;

create table if not exists pos.docs (
  col        text        not null,
  id         text        not null,
  data       jsonb       not null,
  v          bigint      not null default 1,
  updated_at timestamptz not null default now(),
  primary key (col, id)
);
alter table pos.docs add column if not exists v bigint not null default 1;
alter table pos.docs enable row level security; -- no policies: no direct access
create index if not exists docs_created_idx on pos.docs (col, (data -> 'createdAt' ->> '__ts'));
revoke all on pos.docs from public;

-- ---------------------------------------------------------- who is calling
-- The Firebase uid, only for tokens issued by Firebase. Supabase has already checked
-- the token's signature against your Firebase project (Third-party Auth).
create or replace function pos.uid() returns text
language sql stable as $$
  select case
    when c ->> 'iss' = 'https://securetoken.google.com/' || (c ->> 'aud')
     and coalesce(c ->> 'sub', '') <> ''
    then c ->> 'sub'
  end
  from (select nullif(current_setting('request.jwt.claims', true), '')::jsonb as c) x
$$;

create or replace function pos.fail(code text, message text) returns void
language plpgsql as $$
begin
  raise exception using message = message, hint = 'pos:' || code;
end $$;

drop type if exists pos.ctx cascade;
create type pos.ctx as (
  uid       text,
  signed_in boolean,
  device    boolean, -- an approved sign-in account (owner or device)
  owner     boolean  -- the owner account
);

create or replace function pos.make_ctx(p_uid text) returns pos.ctx
language plpgsql stable as $$
declare
  me jsonb;
  r pos.ctx;
begin
  if p_uid is not null then
    select data into me from pos.docs where col = 'users' and id = p_uid;
  end if;
  r.uid := p_uid;
  r.signed_in := p_uid is not null;
  r.device := me is not null and me -> 'active' = 'true'::jsonb and me ->> 'role' in ('admin', 'device');
  r.owner := r.device and me ->> 'role' = 'admin';
  return r;
end $$;

-- Used by the storage policies for product photos
create or replace function pos.is_device_uid(p_uid text) returns boolean
language sql stable security definer set search_path = pos, pg_temp as $$
  select p_uid is not null and exists (
    select 1 from pos.docs where col = 'users' and id = p_uid
      and data -> 'active' = 'true'::jsonb and data ->> 'role' in ('admin', 'device'))
$$;

create or replace function pos.get(p_col text, p_id text) returns jsonb
language sql stable as $$ select data from pos.docs where col = p_col and id = p_id $$;

-- A record as it will be after the writes being checked
create or replace function pos.after(after_map jsonb, p_col text, p_id text) returns jsonb
language sql stable as $$
  select case when after_map ? (p_col || '/' || p_id)
    then nullif(after_map -> (p_col || '/' || p_id), 'null'::jsonb)
    else pos.get(p_col, p_id) end
$$;

create or replace function pos.num(v jsonb) returns boolean
language sql immutable as $$ select v is not null and jsonb_typeof(v) = 'number' $$;
create or replace function pos.str(v jsonb) returns boolean
language sql immutable as $$ select v is not null and jsonb_typeof(v) = 'string' and length(v #>> '{}') > 0 $$;
create or replace function pos.nonneg(v jsonb) returns boolean
language sql immutable as $$ select pos.num(v) and (v #>> '{}')::numeric >= 0 $$;

-- Only the listed keys differ between b and a
create or replace function pos.changed_only(b jsonb, a jsonb, allowed text[]) returns boolean
language sql immutable as $$
  select coalesce(bool_and(k = any (allowed)), true)
  from (select jsonb_object_keys(coalesce(b, '{}')) k union select jsonb_object_keys(coalesce(a, '{}'))) keys
  where (b -> k) is distinct from (a -> k)
$$;

-- ---------------------------------------------------------- rules (same as firestore.rules)
create or replace function pos.can_read(r pos.ctx, p_col text, p_id text, d jsonb) returns boolean
language sql stable as $$
  select case p_col
    when 'settings' then p_id = 'setup' and r.signed_in
    when 'users' then r.signed_in and (r.uid = p_id or r.owner)
    else coalesce(r.device, false)
  end
$$;

create or replace function pos.can_write(
  r pos.ctx, kind text, p_col text, p_id text, b jsonb, a jsonb, after_map jsonb
) returns boolean
language plpgsql stable as $$
begin
  case p_col
    when 'settings' then
      -- created once, together with the first (owner) account
      return p_id = 'setup' and kind = 'create' and r.signed_in
        and a ->> 'ownerUid' = r.uid
        and pos.after(after_map, 'users', r.uid) ->> 'role' = 'admin';

    when 'users' then
      if kind = 'create' and r.signed_in and r.uid = p_id
         and a -> 'active' = 'true'::jsonb
         and (select bool_and(k = any (array['email', 'displayName', 'role', 'active', 'createdAt'])) from jsonb_object_keys(a) k)
         and (a ->> 'role' = 'pending'
              or (a ->> 'role' = 'admin'
                  and pos.get('settings', 'setup') is null
                  and pos.after(after_map, 'settings', 'setup') ->> 'ownerUid' = r.uid)) then
        return true;
      end if;
      -- the owner approves/disables other accounts (and restores them); nobody else becomes owner
      return r.owner and r.uid <> p_id and kind in ('create', 'update')
        and a ->> 'role' in ('device', 'pending')
        and coalesce(b ->> 'role', '') <> 'admin';

    when 'staff' then
      return r.device and kind in ('create', 'update')
        and pos.str(a -> 'name')
        and a ->> 'role' in ('admin', 'manager', 'cashier', 'inventory', 'accountant')
        and pos.str(a -> 'pinHash') and pos.str(a -> 'pinSalt');

    when 'categories', 'suppliers' then
      return r.device;

    when 'products' then
      return r.device and (kind = 'delete' or (
        (not (a ? 'stock') or pos.num(a -> 'stock')) and pos.nonneg(a -> 'price')));

    when 'ingredients' then
      -- stock may go below zero when out-of-stock items are sold anyway
      return r.device and (kind = 'delete' or not (a ? 'stock') or pos.num(a -> 'stock'));

    when 'purchaseOrders' then
      return r.device and kind in ('create', 'update');

    when 'deliveries' then
      return (r.device and kind = 'create'
          and jsonb_typeof(a -> 'items') = 'array' and jsonb_array_length(a -> 'items') > 0
          and pos.nonneg(a -> 'total'))
        or (r.device and kind = 'update' and pos.changed_only(b, a, array['paidAmount', 'paymentStatus', 'updatedAt'])
          and pos.nonneg(a -> 'paidAmount'))
        or (r.owner and kind <> 'delete');

    when 'supplierPayments' then
      return (r.device and kind = 'create' and pos.num(a -> 'amount') and (a ->> 'amount')::numeric > 0)
        or (r.owner and kind <> 'delete');

    when 'refunds' then
      return (r.device and kind = 'create'
          and jsonb_typeof(a -> 'lines') = 'array' and jsonb_array_length(a -> 'lines') > 0
          and pos.nonneg(a -> 'amount') and pos.str(a -> 'approvedById') and a ->> 'accountUid' = r.uid)
        or (r.owner and kind <> 'delete');

    when 'shifts', 'stockCounts', 'batches' then
      return r.device and kind in ('create', 'update');

    when 'expenses' then
      return r.device and kind in ('create', 'update') and pos.num(a -> 'amount') and (a ->> 'amount')::numeric > 0;

    when 'appSettings' then
      return r.device;

    when 'stockMovements' then
      return (r.device and kind = 'create' and pos.num(a -> 'change'))
        or (r.owner and kind <> 'delete');

    when 'counters' then
      return p_id in ('sales', 'purchaseOrders', 'deliveries', 'refunds', 'shifts', 'stockCounts', 'supplierPayments') and (
        (r.device and kind = 'create' and a -> 'next' = '1'::jsonb)
        or (r.device and kind = 'update' and pos.num(a -> 'next') and pos.num(b -> 'next')
            and (a ->> 'next')::numeric = (b ->> 'next')::numeric + 1)
        or (r.owner and kind <> 'delete'));

    when 'sales' then
      return (r.device and kind = 'create'
          and jsonb_typeof(a -> 'items') = 'array' and jsonb_array_length(a -> 'items') > 0
          and pos.nonneg(a -> 'total')
          and a ->> 'paymentMethod' in ('cash', 'gcash', 'credit')
          and pos.str(a -> 'cashierId')
          and a ->> 'accountUid' = r.uid)
        -- a sale is never changed, except to note how much of it was refunded
        or (r.device and kind = 'update' and pos.changed_only(b, a, array['refundedQty', 'refundedTotal', 'refundStatus', 'updatedAt'])
          and pos.nonneg(a -> 'refundedTotal') and (a ->> 'refundedTotal')::numeric <= (b ->> 'total')::numeric)
        or (r.owner and kind <> 'delete');

    when 'creditAccounts' then
      return (r.device and kind in ('create', 'update') and pos.nonneg(a -> 'balance') and pos.nonneg(a -> 'limit'))
        or (r.owner and kind <> 'delete');

    when 'creditPayments' then
      return (r.device and kind = 'create' and pos.num(a -> 'amount') and (a ->> 'amount')::numeric > 0)
        or (r.owner and kind <> 'delete');

    when 'auditLogs' then
      return (r.device and kind = 'create' and a ->> 'accountUid' = r.uid)
        or (r.owner and kind <> 'delete');

    else
      return false;
  end case;
end $$;

-- ---------------------------------------------------------- queries
-- Sort keys: numbers compare as numbers; text and dates ({"__ts": ISO}) as text.
create or replace function pos.num_key(v jsonb) returns numeric
language sql immutable as $$ select case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric end $$;

create or replace function pos.text_key(v jsonb) returns text
language sql immutable as $$
  select case
    when v is null or jsonb_typeof(v) = 'null' or jsonb_typeof(v) = 'number' then null
    when jsonb_typeof(v) = 'string' then v #>> '{}'
    when jsonb_typeof(v) = 'object' and v ? '__ts' then v ->> '__ts'
    else v::text end
$$;

create or replace function pos.cmp(a jsonb, b jsonb) returns integer
language sql immutable as $$
  select case
    when pos.num_key(a) is not null and pos.num_key(b) is not null then sign(pos.num_key(a) - pos.num_key(b))::int
    when pos.text_key(a) is not null and pos.text_key(b) is not null then
      case when pos.text_key(a) collate "C" < pos.text_key(b) collate "C" then -1
           when pos.text_key(a) collate "C" > pos.text_key(b) collate "C" then 1 else 0 end
  end
$$;

create or replace function pos.matches(d jsonb, w jsonb) returns boolean
language plpgsql immutable as $$
declare
  v jsonb := d -> (w ->> 0);
  op text := w ->> 1;
  val jsonb := w -> 2;
  c int;
begin
  if op = '==' then return v is not null and v = val; end if;
  if op = '!=' then return v is not null and v <> val; end if;
  if op = 'in' then return v is not null and exists (select 1 from jsonb_array_elements(coalesce(val, '[]')) x where x = v); end if;
  c := pos.cmp(v, val);
  if c is null then return false; end if;
  return case op when '<' then c < 0 when '<=' then c <= 0 when '>' then c > 0 when '>=' then c >= 0 else false end;
end $$;

create or replace function pos.matches_all(d jsonb, wheres jsonb) returns boolean
language sql immutable as $$
  select coalesce(bool_and(pos.matches(d, w)), true) from jsonb_array_elements(coalesce(wheres, '[]')) w
$$;

create or replace function pos.run_query(r pos.ctx, p_col text, wheres jsonb, orders jsonb, lim integer) returns jsonb
language plpgsql stable as $$
declare
  ord text := '';
  o jsonb;
  dir text;
  res jsonb;
begin
  if coalesce(p_col, '') = '' then perform pos.fail('invalid-argument', 'Missing collection name.'); end if;
  for o in select * from jsonb_array_elements(coalesce(orders, '[]')) loop
    dir := case when lower(o ->> 1) = 'desc' then 'desc' else 'asc' end;
    ord := ord || format('pos.num_key(data -> %L) %s nulls last, pos.text_key(data -> %L) collate "C" %s nulls last, ', o ->> 0, dir, o ->> 0, dir);
  end loop;
  ord := ord || 'id';
  execute format(
    'select coalesce(jsonb_agg(jsonb_build_object(''id'', id, ''data'', data, ''v'', v) order by rn), ''[]'') from (
       select id, data, v, row_number() over (order by %s) rn
       from pos.docs where col = $1 and pos.matches_all(data, $2) and pos.can_read($3, $1, id, data)
       order by %s %s) t',
    ord, ord, case when lim > 0 then 'limit ' || lim else '' end)
  into res using p_col, coalesce(wheres, '[]'), r;
  return res;
end $$;

-- ---------------------------------------------------------- writes
create or replace function pos.resolve_server_times(v jsonb, now_iso text) returns jsonb
language plpgsql immutable as $$
declare
  o jsonb := '{}';
  k text;
  x jsonb;
begin
  if v is null then return null; end if;
  case jsonb_typeof(v)
    when 'object' then
      if v = '{"__serverTimestamp": true}'::jsonb then return jsonb_build_object('__ts', now_iso); end if;
      for k, x in select * from jsonb_each(v) loop o := o || jsonb_build_object(k, pos.resolve_server_times(x, now_iso)); end loop;
      return o;
    when 'array' then
      return (select coalesce(jsonb_agg(pos.resolve_server_times(e, now_iso)), '[]') from jsonb_array_elements(v) e);
    else return v;
  end case;
end $$;

-- ops: [{ type: set|update|delete, path: "col/id", data }]
-- pre: [{ path, v }] — the version each record must still have (0 = must not exist)
create or replace function pos.commit(r pos.ctx, ops jsonb, pre jsonb) returns void
language plpgsql as $$
declare
  now_iso text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  after_map jsonb := '{}';
  planned jsonb := '[]';
  op jsonb;
  p jsonb;
  parts text[];
  k text;
  cur jsonb;
  dat jsonb;
  nxt jsonb;
  kind text;
  cur_v bigint;
begin
  if jsonb_typeof(ops) <> 'array' or jsonb_array_length(ops) = 0 then return; end if;
  -- One commit at a time keeps stock and receipt numbers consistent (a canteen's load)
  perform pg_advisory_xact_lock(hashtext('pos.commit'));

  for p in select * from jsonb_array_elements(coalesce(pre, '[]')) loop
    parts := string_to_array(coalesce(p ->> 'path', ''), '/');
    select v into cur_v from pos.docs where col = parts[1] and id = parts[2];
    if coalesce(cur_v, 0) <> coalesce((p ->> 'v')::bigint, 0) then
      perform pos.fail('aborted', 'A record changed while saving: ' || (p ->> 'path'));
    end if;
  end loop;

  for op in select * from jsonb_array_elements(ops) loop
    parts := string_to_array(coalesce(op ->> 'path', ''), '/');
    if array_length(parts, 1) is distinct from 2 or parts[1] = '' or parts[2] = '' then
      perform pos.fail('invalid-argument', 'Bad record path: ' || coalesce(op ->> 'path', ''));
    end if;
    k := parts[1] || '/' || parts[2];
    cur := pos.after(after_map, parts[1], parts[2]);
    dat := pos.resolve_server_times(op -> 'data', now_iso);
    case op ->> 'type'
      when 'delete' then nxt := null;
      when 'update' then
        if cur is null then perform pos.fail('not-found', 'No record to update: ' || k); end if;
        nxt := cur || coalesce(dat, '{}');
      when 'set' then nxt := coalesce(dat, '{}');
      else perform pos.fail('invalid-argument', 'Unknown write: ' || coalesce(op ->> 'type', '?'));
    end case;
    after_map := after_map || jsonb_build_object(k, coalesce(nxt, 'null'::jsonb));
    planned := planned || jsonb_build_array(jsonb_build_object(
      'type', op ->> 'type', 'col', parts[1], 'id', parts[2],
      'before', coalesce(pos.get(parts[1], parts[2]), 'null'::jsonb), 'after', coalesce(nxt, 'null'::jsonb)));
  end loop;

  for p in select * from jsonb_array_elements(planned) loop
    cur := nullif(p -> 'before', 'null'::jsonb);
    nxt := nullif(p -> 'after', 'null'::jsonb);
    if p ->> 'type' = 'delete' and cur is null then continue; end if;
    kind := case when p ->> 'type' = 'delete' then 'delete' when cur is not null then 'update' else 'create' end;
    if not coalesce(pos.can_write(r, kind, p ->> 'col', p ->> 'id', cur, nxt, after_map), false) then
      perform pos.fail('permission-denied', 'Not allowed: ' || kind || ' in ' || (p ->> 'col') || '.');
    end if;
  end loop;

  for k, nxt in select * from jsonb_each(after_map) loop
    parts := string_to_array(k, '/');
    if jsonb_typeof(nxt) = 'null' then
      delete from pos.docs where col = parts[1] and id = parts[2];
    else
      insert into pos.docs as t (col, id, data, v, updated_at) values (parts[1], parts[2], nxt, 1, now())
      on conflict (col, id) do update set data = excluded.data, v = t.v + 1, updated_at = now();
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------- the website's only entry point
-- body: { action: ping | get | getMany | query | commit, … }  (same as Database.gs)
create or replace function public.pos_request(body jsonb) returns jsonb
language plpgsql
security definer
set search_path = pos, pg_temp
as $$
declare
  v_uid text := pos.uid();
  r pos.ctx;
  parts text[];
  d record;
  out jsonb := '{}';
  path text;
  hint text;
  msg text;
begin
  if body ->> 'action' = 'ping' then
    return jsonb_build_object('ok', true, 'app', 'campus-canteen-pos', 'version', 1, 'signedIn', v_uid is not null, 'uid', v_uid);
  end if;

  r := pos.make_ctx(v_uid);
  case body ->> 'action'
    when 'get' then
      parts := string_to_array(coalesce(body ->> 'path', ''), '/');
      select id, data, v into d from pos.docs where col = parts[1] and id = parts[2];
      if d.id is null then return jsonb_build_object('ok', true, 'doc', null); end if;
      if not pos.can_read(r, parts[1], parts[2], d.data) then
        perform pos.fail('permission-denied', 'You do not have access to this record.');
      end if;
      return jsonb_build_object('ok', true, 'doc', jsonb_build_object('id', d.id, 'data', d.data, 'v', d.v));

    when 'getMany' then
      for path in select jsonb_array_elements_text(coalesce(body -> 'paths', '[]')) loop
        parts := string_to_array(path, '/');
        select id, data, v into d from pos.docs where col = parts[1] and id = parts[2];
        if d.id is not null then
          if not pos.can_read(r, parts[1], parts[2], d.data) then
            perform pos.fail('permission-denied', 'You do not have access to ' || path || '.');
          end if;
          out := out || jsonb_build_object(path, jsonb_build_object('id', d.id, 'data', d.data, 'v', d.v));
        elsif not pos.can_read(r, parts[1], parts[2], null) then
          perform pos.fail('permission-denied', 'You do not have access to ' || path || '.');
        end if;
        d := null;
      end loop;
      return jsonb_build_object('ok', true, 'docs', out);

    when 'query' then
      return jsonb_build_object('ok', true, 'docs', pos.run_query(
        r, body ->> 'collection', body -> 'where', body -> 'orderBy', nullif(body ->> 'limit', '')::integer));

    when 'commit' then
      perform pos.commit(r, coalesce(body -> 'ops', '[]'), coalesce(body -> 'pre', '[]'));
      return jsonb_build_object('ok', true);

    else
      return jsonb_build_object('ok', false, 'code', 'invalid-argument', 'message', 'Unknown action.');
  end case;
exception when others then
  -- everything this request changed is undone
  get stacked diagnostics hint = pg_exception_hint, msg = message_text;
  if hint like 'pos:%' then
    return jsonb_build_object('ok', false, 'code', substr(hint, 5), 'message', msg);
  end if;
  return jsonb_build_object('ok', false, 'code', 'internal', 'message', msg);
end $$;

-- ---------------------------------------------------------- permissions
revoke all on all functions in schema pos from public;
revoke all on function public.pos_request(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on pos.docs from anon, authenticated';
    execute 'revoke all on all functions in schema pos from anon, authenticated';
    -- Firebase tokens without a "role" claim arrive as anon; pos.uid() still verifies them
    execute 'grant execute on function public.pos_request(jsonb) to anon, authenticated';
    -- for the storage policies below
    execute 'grant usage on schema pos to anon, authenticated';
    execute 'grant execute on function pos.uid() to anon, authenticated';
    execute 'grant execute on function pos.is_device_uid(text) to anon, authenticated';
  end if;
end $$;

-- ---------------------------------------------------------- product photos (Supabase Storage)
-- Public bucket: anyone with the link can view a photo; only approved devices can upload.
do $$ begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public) values ('product-images', 'product-images', true)
      on conflict (id) do update set public = true;
    execute 'drop policy if exists "pos images read" on storage.objects';
    execute 'drop policy if exists "pos images insert" on storage.objects';
    execute 'drop policy if exists "pos images update" on storage.objects';
    execute 'drop policy if exists "pos images delete" on storage.objects';
    execute $p$create policy "pos images read" on storage.objects for select to anon, authenticated
      using (bucket_id = 'product-images')$p$;
    execute $p$create policy "pos images insert" on storage.objects for insert to anon, authenticated
      with check (bucket_id = 'product-images' and pos.is_device_uid(pos.uid()))$p$;
    execute $p$create policy "pos images update" on storage.objects for update to anon, authenticated
      using (bucket_id = 'product-images' and pos.is_device_uid(pos.uid()))$p$;
    execute $p$create policy "pos images delete" on storage.objects for delete to anon, authenticated
      using (bucket_id = 'product-images' and pos.is_device_uid(pos.uid()))$p$;
  end if;
end $$;
