-- ============================================================================================
-- INVENTORY APP: database setup.  Run this ONCE in Supabase -> SQL Editor -> New query -> Run.
-- It only ADDS new tables. It does not touch, change or delete any of your old tables.
-- It is safe to run twice: everything is "create if not exists" / "create or replace".
-- ============================================================================================

-- ---------- 1. Products you stock (one row per SKU you physically hold, e.g. "Malai More · White · XL") ----------
create table if not exists public.stock_items (
  id              bigserial primary key,
  name            text not null,
  design          text,
  colour          text,
  size            text,
  unit_cost       numeric(10,2),
  lead_time_days  integer not null default 10,
  opening_stock   integer,
  active          boolean not null default true,
  needs_review    boolean not null default true,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------- 2. Marketplace listings (Flipkart now, Amazon later). Many listings can point to one stock item ----------
create table if not exists public.listings (
  id             bigserial primary key,
  platform       text not null,
  listing_id     text not null,
  sku_text       text,
  fsn            text,
  title          text,
  mrp            numeric(10,2),
  selling_price  numeric(10,2),
  listing_status text,
  platform_stock integer,
  stock_item_id  bigint references public.stock_items(id) on delete set null,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  unique (platform, listing_id)
);
create index if not exists listings_stock_item_idx on public.listings (stock_item_id);

-- ---------- 3. Orders (one row per ordered item) ----------
create table if not exists public.order_lines (
  id                   bigserial primary key,
  platform             text not null,
  order_item_id        text not null,
  order_id             text,
  shipment_id          text,
  listing_id           text,
  sku_text             text,
  fsn                  text,
  quantity             integer not null default 1,
  order_date           timestamptz,
  platform_status      text,
  stage                text,          -- to_dispatch | in_transit | delivered | returned | cancelled | rto | other
  payment_type         text,
  selling_price        numeric(10,2),
  total_price          numeric(10,2),
  dispatch_by          timestamptz,
  platform_updated_at  timestamptz,
  delivered_at         timestamptz,
  cancelled_at         timestamptz,
  cancel_type          text,
  cancel_reason        text,
  cancel_sub_reason    text,
  courier_return       boolean not null default false,
  raw                  jsonb,
  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  unique (platform, order_item_id)
);
create index if not exists order_lines_date_idx    on public.order_lines (order_date);
create index if not exists order_lines_stage_idx   on public.order_lines (stage);
create index if not exists order_lines_listing_idx on public.order_lines (platform, listing_id);

-- ---------- 4. Returns ----------
create table if not exists public.return_lines (
  id                   bigserial primary key,
  platform             text not null,
  return_id            text not null,
  order_item_id        text not null,
  order_id             text,
  listing_id           text,
  sku_text             text,
  quantity             integer not null default 1,
  return_type          text,          -- customer_return | courier_return
  status               text,          -- created | completed | cancelled ...
  reason               text,
  sub_reason           text,
  created_on           timestamptz,   -- when the return was raised
  updated_on           timestamptz,
  approved_on          timestamptz,
  expected_on          timestamptz,
  tracking_id          text,
  courier_name         text,
  condition            text check (condition in ('sellable','damaged','dry_clean','press')),
  condition_set_at     timestamptz,
  lookup_tried_at      timestamptz,
  raw                  jsonb,
  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  unique (platform, return_id, order_item_id)
);
create index if not exists return_lines_created_idx on public.return_lines (created_on);
create index if not exists return_lines_item_idx    on public.return_lines (order_item_id);

-- ---------- 5. Download bookkeeping ----------
create table if not exists public.sync_batches (
  id          bigserial primary key,
  mode        text not null,            -- history | update | light
  created_at  timestamptz not null default now(),
  finished_at timestamptz,
  note        text
);

create table if not exists public.sync_tasks (
  id           bigserial primary key,
  batch_id     bigint references public.sync_batches(id) on delete cascade,
  kind         text not null,           -- orders | cancelled | returns | resolve
  source       text not null,           -- preDispatch / SHIPPED / DELIVERED / PICKUP_COMPLETE / buyerCancellation ... / customer_return / courier_return
  window_from  timestamptz,
  window_to    timestamptz,
  field        text,                    -- which date the window applies to: orderDate | cancellationDate | created | modified
  status       text not null default 'pending',   -- pending | running | done | failed
  next_url     text,
  pages_done   integer not null default 0,
  rows_done    integer not null default 0,
  attempts     integer not null default 0,
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index if not exists sync_tasks_status_idx on public.sync_tasks (status, id);
create index if not exists sync_tasks_batch_idx  on public.sync_tasks (batch_id);

create table if not exists public.sync_lease (
  id          integer primary key default 1,
  holder      text,
  expires_at  timestamptz
);

create table if not exists public.app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- ---------- 6. Lock everything: only the app's server code (service role) can read or write ----------
alter table public.stock_items  enable row level security;
alter table public.listings     enable row level security;
alter table public.order_lines  enable row level security;
alter table public.return_lines enable row level security;
alter table public.sync_batches enable row level security;
alter table public.sync_tasks   enable row level security;
alter table public.sync_lease   enable row level security;
alter table public.app_settings enable row level security;

-- ---------- 7. Functions used by the downloader ----------
create or replace function public.upsert_order_lines(p_rows jsonb) returns integer
language plpgsql set search_path = public as $$
declare n integer;
begin
  with src as (
    select * from jsonb_to_recordset(p_rows) as x(
      platform text, order_item_id text, order_id text, shipment_id text, listing_id text, sku_text text, fsn text,
      quantity integer, order_date timestamptz, platform_status text, stage text, payment_type text,
      selling_price numeric, total_price numeric, dispatch_by timestamptz, platform_updated_at timestamptz,
      delivered_at timestamptz, cancelled_at timestamptz, cancel_type text, cancel_reason text,
      cancel_sub_reason text, courier_return boolean, raw jsonb)
  ), up as (
    insert into public.order_lines as o (
      platform, order_item_id, order_id, shipment_id, listing_id, sku_text, fsn, quantity, order_date, platform_status,
      stage, payment_type, selling_price, total_price, dispatch_by, platform_updated_at, delivered_at, cancelled_at,
      cancel_type, cancel_reason, cancel_sub_reason, courier_return, raw)
    select platform, order_item_id, order_id, shipment_id, listing_id, sku_text, fsn, coalesce(quantity, 1), order_date,
           platform_status, stage, payment_type, selling_price, total_price, dispatch_by, platform_updated_at, delivered_at,
           cancelled_at, cancel_type, cancel_reason, cancel_sub_reason, coalesce(courier_return, false), raw
    from src
    on conflict (platform, order_item_id) do update set
      order_id            = excluded.order_id,
      shipment_id         = excluded.shipment_id,
      listing_id          = coalesce(excluded.listing_id, o.listing_id),
      sku_text            = coalesce(excluded.sku_text, o.sku_text),
      fsn                 = coalesce(excluded.fsn, o.fsn),
      quantity            = excluded.quantity,
      order_date          = coalesce(excluded.order_date, o.order_date),
      platform_status     = excluded.platform_status,
      stage               = excluded.stage,
      payment_type        = coalesce(excluded.payment_type, o.payment_type),
      selling_price       = coalesce(excluded.selling_price, o.selling_price),
      total_price         = coalesce(excluded.total_price, o.total_price),
      dispatch_by         = coalesce(excluded.dispatch_by, o.dispatch_by),
      platform_updated_at = excluded.platform_updated_at,
      delivered_at        = coalesce(o.delivered_at, excluded.delivered_at),
      cancelled_at        = coalesce(excluded.cancelled_at, o.cancelled_at),
      cancel_type         = coalesce(excluded.cancel_type, o.cancel_type),
      cancel_reason       = coalesce(excluded.cancel_reason, o.cancel_reason),
      cancel_sub_reason   = coalesce(excluded.cancel_sub_reason, o.cancel_sub_reason),
      courier_return      = excluded.courier_return or o.courier_return,
      raw                 = excluded.raw,
      last_seen_at        = now()
    where o.platform_updated_at is null
       or excluded.platform_updated_at is null
       or excluded.platform_updated_at >= o.platform_updated_at
    returning 1
  )
  select count(*) into n from up;
  return coalesce(n, 0);
end $$;

create or replace function public.upsert_return_lines(p_rows jsonb) returns integer
language plpgsql set search_path = public as $$
declare n integer;
begin
  with src as (
    select * from jsonb_to_recordset(p_rows) as x(
      platform text, return_id text, order_item_id text, order_id text, quantity integer, return_type text, status text,
      reason text, sub_reason text, created_on timestamptz, updated_on timestamptz, approved_on timestamptz,
      expected_on timestamptz, tracking_id text, courier_name text, raw jsonb)
  ), up as (
    insert into public.return_lines as r (
      platform, return_id, order_item_id, order_id, quantity, return_type, status, reason, sub_reason, created_on,
      updated_on, approved_on, expected_on, tracking_id, courier_name, raw)
    select platform, return_id, order_item_id, order_id, coalesce(quantity, 1), return_type, status, reason, sub_reason,
           created_on, updated_on, approved_on, expected_on, tracking_id, courier_name, raw
    from src
    on conflict (platform, return_id, order_item_id) do update set
      order_id     = coalesce(excluded.order_id, r.order_id),
      quantity     = excluded.quantity,
      return_type  = coalesce(excluded.return_type, r.return_type),
      status       = excluded.status,
      reason       = coalesce(excluded.reason, r.reason),
      sub_reason   = coalesce(excluded.sub_reason, r.sub_reason),
      created_on   = coalesce(r.created_on, excluded.created_on),
      updated_on   = excluded.updated_on,
      approved_on  = coalesce(excluded.approved_on, r.approved_on),
      expected_on  = coalesce(excluded.expected_on, r.expected_on),
      tracking_id  = coalesce(excluded.tracking_id, r.tracking_id),
      courier_name = coalesce(excluded.courier_name, r.courier_name),
      raw          = excluded.raw,
      last_seen_at = now()
    where r.updated_on is null or excluded.updated_on is null or excluded.updated_on >= r.updated_on
    returning 1
  )
  select count(*) into n from up;
  return coalesce(n, 0);
end $$;

-- Registers listings the app has not seen before, and creates a matching stock item for each (guessed design/colour/size).
create or replace function public.register_listings(p_rows jsonb) returns integer
language plpgsql set search_path = public as $$
declare r record; new_id bigint; n integer := 0;
begin
  for r in
    select * from jsonb_to_recordset(p_rows) as x(
      platform text, listing_id text, sku_text text, fsn text, title text, mrp numeric, selling_price numeric,
      listing_status text, platform_stock integer, name text, design text, colour text, size text, unit_cost numeric)
  loop
    if exists (select 1 from public.listings l where l.platform = r.platform and l.listing_id = r.listing_id) then
      update public.listings l set
        last_seen_at   = now(),
        sku_text       = coalesce(nullif(l.sku_text, ''), r.sku_text),
        title          = coalesce(l.title, r.title),
        fsn            = coalesce(l.fsn, r.fsn),
        mrp            = coalesce(r.mrp, l.mrp),
        selling_price  = coalesce(r.selling_price, l.selling_price),
        listing_status = coalesce(r.listing_status, l.listing_status),
        platform_stock = coalesce(r.platform_stock, l.platform_stock)
      where l.platform = r.platform and l.listing_id = r.listing_id;
    else
      insert into public.stock_items (name, design, colour, size, unit_cost)
      values (
        coalesce(r.name, r.sku_text, r.listing_id), r.design, r.colour, r.size,
        coalesce(r.unit_cost, (select s.unit_cost from public.stock_items s where s.design = r.design and s.unit_cost is not null limit 1))
      ) returning id into new_id;
      insert into public.listings (platform, listing_id, sku_text, fsn, title, mrp, selling_price, listing_status, platform_stock, stock_item_id)
      values (r.platform, r.listing_id, r.sku_text, r.fsn, r.title, r.mrp, r.selling_price, r.listing_status, r.platform_stock, new_id);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Fills in the listing for returns once the matching order is known.
create or replace function public.link_return_listings() returns integer
language plpgsql set search_path = public as $$
declare n integer;
begin
  with up as (
    update public.return_lines r set listing_id = o.listing_id, sku_text = o.sku_text
    from public.order_lines o
    where o.platform = r.platform and o.order_item_id = r.order_item_id and r.listing_id is null and o.listing_id is not null
    returning 1
  ) select count(*) into n from up;
  return coalesce(n, 0);
end $$;

create or replace function public.mark_lookup_tried(p_ids jsonb) returns integer
language plpgsql set search_path = public as $$
declare n integer;
begin
  with up as (
    update public.return_lines set lookup_tried_at = now()
    where order_item_id in (select jsonb_array_elements_text(p_ids)) and listing_id is null
    returning 1
  ) select count(*) into n from up;
  return coalesce(n, 0);
end $$;

-- Only one downloader may run at a time.
create or replace function public.acquire_lease(p_holder text, p_seconds integer) returns boolean
language plpgsql set search_path = public as $$
declare got integer;
begin
  with up as (
    insert into public.sync_lease as l (id, holder, expires_at)
    values (1, p_holder, now() + make_interval(secs => p_seconds))
    on conflict (id) do update set holder = excluded.holder, expires_at = excluded.expires_at
    where l.expires_at is null or l.expires_at < now() or l.holder = p_holder
    returning 1
  ) select count(*) into got from up;
  return got > 0;
end $$;

create or replace function public.release_lease(p_holder text) returns void
language sql set search_path = public as $$
  update public.sync_lease set expires_at = now() - interval '1 second' where id = 1 and holder = p_holder;
$$;

create or replace function public.close_finished_batches() returns integer
language plpgsql set search_path = public as $$
declare n integer;
begin
  with up as (
    update public.sync_batches b set finished_at = now()
    where b.finished_at is null
      and not exists (select 1 from public.sync_tasks t where t.batch_id = b.id and t.status in ('pending', 'running'))
    returning 1
  ) select count(*) into n from up;
  return coalesce(n, 0);
end $$;

-- Progress of the downloads, for the Sync screen.
create or replace function public.sync_overview() returns jsonb
language plpgsql stable set search_path = public as $$
declare result jsonb;
begin
  select jsonb_build_object(
    'batches', coalesce((select jsonb_agg(row_to_json(x) order by x.id desc) from (
        select b.id, b.mode, b.created_at, b.finished_at,
               count(t.id) as tasks,
               count(t.id) filter (where t.status = 'done') as done,
               count(t.id) filter (where t.status = 'failed') as failed,
               count(t.id) filter (where t.status in ('pending','running')) as open,
               coalesce(sum(t.rows_done), 0) as rows
        from public.sync_batches b left join public.sync_tasks t on t.batch_id = b.id
        group by b.id order by b.id desc limit 8) x), '[]'::jsonb),
    'errors', coalesce((select jsonb_agg(row_to_json(e)) from (
        select t.id, t.kind, t.source, t.last_error, t.updated_at from public.sync_tasks t
        where t.last_error is not null and t.status in ('failed','pending') order by t.updated_at desc limit 10) e), '[]'::jsonb),
    'running_now', coalesce((select expires_at > now() from public.sync_lease where id = 1), false),
    'last_finished', (select max(finished_at) from public.sync_batches),
    'orders_total', (select count(*) from public.order_lines),
    'returns_total', (select count(*) from public.return_lines),
    'listings_total', (select count(*) from public.listings)
  ) into result;
  return result;
end $$;

-- ---------- 8. Read-only views for the screens ----------
create or replace view public.v_orders as
select o.id, o.platform, o.order_item_id, o.order_id, o.listing_id, o.sku_text, o.quantity, o.order_date, o.platform_status,
       o.stage, o.payment_type, o.selling_price, o.total_price, o.delivered_at, o.cancelled_at, o.cancel_type,
       o.cancel_reason, o.cancel_sub_reason, o.courier_return, o.platform_updated_at,
       s.id as stock_item_id, s.name as item_name, s.design, s.colour, s.size
from public.order_lines o
left join public.listings l on l.platform = o.platform and l.listing_id = o.listing_id
left join public.stock_items s on s.id = l.stock_item_id;

create or replace view public.v_returns as
select r.id, r.platform, r.return_id, r.order_item_id, r.order_id, r.listing_id, r.sku_text, r.quantity, r.return_type, r.status,
       r.reason, r.sub_reason, r.created_on, r.updated_on, r.condition, r.condition_set_at,
       o.order_date, o.stage as order_stage, o.payment_type,
       s.id as stock_item_id, s.name as item_name, s.design, s.colour, s.size
from public.return_lines r
left join public.order_lines o on o.platform = r.platform and o.order_item_id = r.order_item_id
left join public.listings l on l.platform = r.platform and l.listing_id = coalesce(r.listing_id, o.listing_id)
left join public.stock_items s on s.id = l.stock_item_id;

create or replace view public.v_catalogue as
select s.id, s.name, s.design, s.colour, s.size, s.unit_cost, s.lead_time_days, s.opening_stock, s.active, s.needs_review, s.notes,
       (select string_agg(distinct l.sku_text, ', ') from public.listings l where l.stock_item_id = s.id) as sku_texts,
       (select count(*) from public.listings l where l.stock_item_id = s.id) as listing_count,
       (select max(l.platform_stock) from public.listings l where l.stock_item_id = s.id) as platform_stock,
       coalesce(st.units_30d, 0) as units_30d,
       coalesce(st.units_90d, 0) as units_90d,
       coalesce(st.returned_90d, 0) as returned_90d
from public.stock_items s
left join (
  select l.stock_item_id,
         sum(o.quantity) filter (where o.order_date >= now() - interval '30 days' and o.stage not in ('cancelled','rto')) as units_30d,
         sum(o.quantity) filter (where o.order_date >= now() - interval '90 days' and o.stage not in ('cancelled','rto')) as units_90d,
         sum(o.quantity) filter (where o.order_date >= now() - interval '90 days' and o.stage = 'returned') as returned_90d
  from public.order_lines o
  join public.listings l on l.platform = o.platform and l.listing_id = o.listing_id
  group by l.stock_item_id
) st on st.stock_item_id = s.id;

-- ---------- 9. Numbers for the Overview screen ----------
create or replace function public.overview(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable set search_path = public as $$
declare result jsonb;
begin
  select jsonb_build_object(
    'stages', coalesce((select jsonb_agg(jsonb_build_object('stage', stage, 'lines', n, 'units', units, 'value', value))
                        from (select stage, count(*) n, coalesce(sum(quantity),0) units, coalesce(sum(total_price),0) value
                              from public.order_lines where order_date >= p_from and order_date < p_to group by stage) a), '[]'::jsonb),
    'returns', coalesce((select jsonb_agg(jsonb_build_object('type', return_type, 'status', status, 'n', n))
                         from (select return_type, status, count(*) n from public.return_lines
                               where created_on >= p_from and created_on < p_to group by 1, 2) b), '[]'::jsonb),
    'reasons', coalesce((select jsonb_agg(jsonb_build_object('reason', reason, 'sub_reason', sub_reason, 'n', n) order by n desc)
                         from (select reason, sub_reason, count(*) n from public.return_lines
                               where created_on >= p_from and created_on < p_to and return_type = 'customer_return' and status <> 'cancelled'
                               group by 1, 2 order by n desc limit 12) c), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('d', d, 'units', units, 'delivered', delivered, 'cancelled', cancelled) order by d)
                       from (select to_char((order_date at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') d,
                                    sum(quantity) units,
                                    sum(quantity) filter (where stage = 'delivered') delivered,
                                    sum(quantity) filter (where stage in ('cancelled','rto')) cancelled
                             from public.order_lines where order_date >= p_from and order_date < p_to group by 1) d1), '[]'::jsonb),
    'dailyReturns', coalesce((select jsonb_agg(jsonb_build_object('d', d, 'n', n) order by d)
                              from (select to_char((created_on at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') d, count(*) n
                                    from public.return_lines where created_on >= p_from and created_on < p_to
                                      and status <> 'cancelled' group by 1) d2), '[]'::jsonb),
    'top', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'units', units, 'delivered', delivered, 'returned', returned) order by units desc)
                     from (select coalesce(s.name, o.sku_text, o.listing_id) as name,
                                  sum(o.quantity) filter (where o.stage not in ('cancelled','rto')) units,
                                  sum(o.quantity) filter (where o.stage = 'delivered') delivered,
                                  sum(o.quantity) filter (where o.stage = 'returned') returned
                           from public.order_lines o
                           left join public.listings l on l.platform = o.platform and l.listing_id = o.listing_id
                           left join public.stock_items s on s.id = l.stock_item_id
                           where o.order_date >= p_from and o.order_date < p_to
                           group by 1 order by 2 desc nulls last limit 15) e), '[]'::jsonb),
    'coverage', jsonb_build_object(
      'first_order', (select min(order_date) from public.order_lines),
      'last_order',  (select max(order_date) from public.order_lines),
      'orders_total',  (select count(*) from public.order_lines),
      'returns_total', (select count(*) from public.return_lines),
      'last_finished', (select max(finished_at) from public.sync_batches))
  ) into result;
  return result;
end $$;

-- ---------- 10. Lists for the screens (called only by the app's server code) ----------
create or replace function public.api_orders(p_from timestamptz, p_to timestamptz, p_stage text, p_q text, p_limit integer, p_offset integer)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  pat text := case when coalesce(p_q, '') = '' then null else '%' || replace(replace(replace(p_q, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  total integer; rows jsonb;
begin
  select count(*) into total from public.v_orders o
  where (p_from is null or o.order_date >= p_from) and (p_to is null or o.order_date < p_to)
    and (coalesce(p_stage, '') = '' or o.stage = p_stage)
    and (pat is null or o.order_id ilike pat or o.sku_text ilike pat or o.item_name ilike pat);
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into rows from (
    select o.id, o.order_id, o.order_date, o.stage, o.platform_status, o.quantity, o.payment_type, o.total_price,
           o.delivered_at, o.cancelled_at, o.cancel_reason, o.cancel_sub_reason, o.item_name, o.sku_text
    from public.v_orders o
    where (p_from is null or o.order_date >= p_from) and (p_to is null or o.order_date < p_to)
      and (coalesce(p_stage, '') = '' or o.stage = p_stage)
      and (pat is null or o.order_id ilike pat or o.sku_text ilike pat or o.item_name ilike pat)
    order by o.order_date desc nulls last, o.id desc
    limit least(coalesce(p_limit, 50), 200) offset greatest(coalesce(p_offset, 0), 0)) x;
  return jsonb_build_object('total', total, 'rows', rows);
end $$;

create or replace function public.api_returns(p_from timestamptz, p_to timestamptz, p_type text, p_status text, p_condition text, p_q text, p_limit integer, p_offset integer)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  pat text := case when coalesce(p_q, '') = '' then null else '%' || replace(replace(replace(p_q, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  total integer; rows jsonb;
begin
  select count(*) into total from public.v_returns r
  where (p_from is null or r.created_on >= p_from) and (p_to is null or r.created_on < p_to)
    and (coalesce(p_type, '') = '' or r.return_type = p_type)
    and (coalesce(p_status, '') = '' or r.status = p_status)
    and (coalesce(p_condition, '') = '' or (p_condition = 'none' and r.condition is null) or r.condition = p_condition)
    and (pat is null or r.order_id ilike pat or r.sku_text ilike pat or r.item_name ilike pat or r.reason ilike pat);
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into rows from (
    select r.id, r.return_id, r.order_id, r.created_on, r.updated_on, r.return_type, r.status, r.reason, r.sub_reason,
           r.condition, r.item_name, r.sku_text, r.order_date, r.payment_type, r.quantity
    from public.v_returns r
    where (p_from is null or r.created_on >= p_from) and (p_to is null or r.created_on < p_to)
      and (coalesce(p_type, '') = '' or r.return_type = p_type)
      and (coalesce(p_status, '') = '' or r.status = p_status)
      and (coalesce(p_condition, '') = '' or (p_condition = 'none' and r.condition is null) or r.condition = p_condition)
      and (pat is null or r.order_id ilike pat or r.sku_text ilike pat or r.item_name ilike pat or r.reason ilike pat)
    order by r.created_on desc nulls last, r.id desc
    limit least(coalesce(p_limit, 50), 200) offset greatest(coalesce(p_offset, 0), 0)) x;
  return jsonb_build_object('total', total, 'rows', rows);
end $$;

create or replace function public.api_catalogue() returns jsonb
language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(c) order by c.design nulls last, c.colour nulls last, c.size nulls last, c.id), '[]'::jsonb) from public.v_catalogue c;
$$;

create or replace function public.api_save_item(p_id bigint, p_patch jsonb) returns jsonb
language plpgsql set search_path = public as $$
begin
  update public.stock_items set
    name           = case when p_patch ? 'name' then coalesce(nullif(btrim(p_patch->>'name'), ''), name) else name end,
    design         = case when p_patch ? 'design' then nullif(btrim(p_patch->>'design'), '') else design end,
    colour         = case when p_patch ? 'colour' then nullif(btrim(p_patch->>'colour'), '') else colour end,
    size           = case when p_patch ? 'size' then nullif(btrim(p_patch->>'size'), '') else size end,
    unit_cost      = case when p_patch ? 'unit_cost' then nullif(p_patch->>'unit_cost', '')::numeric else unit_cost end,
    lead_time_days = case when p_patch ? 'lead_time_days' then coalesce(nullif(p_patch->>'lead_time_days', '')::integer, lead_time_days) else lead_time_days end,
    opening_stock  = case when p_patch ? 'opening_stock' then nullif(p_patch->>'opening_stock', '')::integer else opening_stock end,
    active         = case when p_patch ? 'active' then (p_patch->>'active')::boolean else active end,
    needs_review   = case when p_patch ? 'needs_review' then (p_patch->>'needs_review')::boolean else needs_review end,
    notes          = case when p_patch ? 'notes' then nullif(btrim(p_patch->>'notes'), '') else notes end,
    updated_at     = now()
  where id = p_id;
  return (select to_jsonb(c) from public.v_catalogue c where c.id = p_id);
end $$;

create or replace function public.api_design_cost(p_design text, p_cost numeric) returns integer
language plpgsql set search_path = public as $$
declare n integer;
begin
  with up as (update public.stock_items set unit_cost = p_cost, updated_at = now() where design = p_design returning 1)
  select count(*) into n from up;
  return coalesce(n, 0);
end $$;

create or replace function public.api_design_checked(p_design text, p_checked boolean) returns integer
language plpgsql set search_path = public as $$
declare n integer;
begin
  with up as (update public.stock_items set needs_review = not p_checked, updated_at = now() where design = p_design returning 1)
  select count(*) into n from up;
  return coalesce(n, 0);
end $$;

create or replace function public.api_set_condition(p_id bigint, p_condition text) returns jsonb
language plpgsql set search_path = public as $$
begin
  if coalesce(p_condition, '') not in ('', 'sellable', 'damaged', 'dry_clean', 'press') then
    raise exception 'unknown condition %', p_condition;
  end if;
  update public.return_lines set condition = nullif(p_condition, ''),
         condition_set_at = case when coalesce(p_condition, '') = '' then null else now() end
  where id = p_id;
  return (select jsonb_build_object('id', id, 'condition', condition) from public.return_lines where id = p_id);
end $$;

create or replace function public.api_export(p_what text, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable set search_path = public as $$
begin
  if p_what = 'orders' then
    return coalesce((select jsonb_agg(to_jsonb(x)) from (
      select o.order_date, o.order_id, o.item_name, o.sku_text, o.quantity, o.stage, o.platform_status, o.payment_type, o.total_price,
             o.delivered_at, o.cancelled_at, o.cancel_reason
      from public.v_orders o
      where (p_from is null or o.order_date >= p_from) and (p_to is null or o.order_date < p_to)
      order by o.order_date desc limit 12000) x), '[]'::jsonb);
  else
    return coalesce((select jsonb_agg(to_jsonb(x)) from (
      select r.created_on, r.return_id, r.order_id, r.item_name, r.sku_text, r.quantity, r.return_type, r.status, r.reason, r.sub_reason, r.condition, r.order_date
      from public.v_returns r
      where (p_from is null or r.created_on >= p_from) and (p_to is null or r.created_on < p_to)
      order by r.created_on desc limit 12000) x), '[]'::jsonb);
  end if;
end $$;

-- ============================================================================================
-- FIRST CATALOGUE: the 134 listings from your Flipkart export.
-- Design / colour / size are guessed from the SKU names and costs are filled only where you told me.
-- Everything can be corrected on the Catalogue screen. Safe to run twice (existing listings are not duplicated).
-- ============================================================================================
select public.register_listings($seed$[{"platform":"flipkart","listing_id":"LSTTROHS2RGUGG53MNSZMLZOZ","sku_text":"Black Cream Bottom Pant-40","fsn":"TROHS2RGUGG53MNS","title":"Daswani Exports Flared Men Cream Trousers ()","mrp":2500,"selling_price":734,"listing_status":"ACTIVE","platform_stock":93,"name":"Flared Bottom Pant · Black & Cream · 40","design":"Flared Bottom Pant","colour":"Black & Cream","size":"40","unit_cost":250},{"platform":"flipkart","listing_id":"LSTPYJHRREAGJPFCRHJOSDXXD","sku_text":"Offwhite Bell Bottom Pant (2XL)","fsn":"PYJHRREAGJPFCRHJ","title":"Daswani Exports Indi Men Pyjama ()","mrp":999,"selling_price":595,"listing_status":"ACTIVE","platform_stock":20,"name":"Bell Bottom Pant · Off-white · 2XL","design":"Bell Bottom Pant","colour":"Off-white","size":"2XL","unit_cost":250},{"platform":"flipkart","listing_id":"LSTPYJHRDBAVY7USKAQPLAGRP","sku_text":"Black Bell Bottom Pant-S","fsn":"PYJHRDBAVY7USKAQ","title":"Daswani Exports Indi Men Pyjama ()","mrp":1299,"selling_price":589,"listing_status":"ACTIVE","platform_stock":40,"name":"Bell Bottom Pant · Black · S","design":"Bell Bottom Pant","colour":"Black","size":"S","unit_cost":250},{"platform":"flipkart","listing_id":"LSTDHTHR5EABGHVHNPY1UKVR2","sku_text":"Dhoti-Mirror work-Maroon","fsn":"DHTHR5EABGHVHNPY","title":"Daswani Exports Men's Mirror Work Readymade Dhoti for Festive Wear Solid Men Dhoti ()","mrp":1999,"selling_price":699,"listing_status":"ACTIVE","platform_stock":5,"name":"Dhoti Mirror Work · Maroon · FREE","design":"Dhoti Mirror Work","colour":"Maroon","size":"FREE","unit_cost":290},{"platform":"flipkart","listing_id":"LSTPYJHH7VN7FHM98EDRJSSPX","sku_text":"Offwhite Bell Bottom Pant (XL)","fsn":"PYJHH7VN7FHM98ED","title":"Daswani Exports Indi Men Pyjama ()","mrp":1000,"selling_price":601,"listing_status":"ACTIVE","platform_stock":39,"name":"Bell Bottom Pant · Off-white · XL","design":"Bell Bottom Pant","colour":"Off-white","size":"XL","unit_cost":250},{"platform":"flipkart","listing_id":"LSTPYJHRDBAXBHKCX72AGXUWY","sku_text":"Black Bell Bottom Pant-L","fsn":"PYJHRDBAXBHKCX72","title":"Daswani Exports Indi Men Pyjama ()","mrp":1299,"selling_price":589,"listing_status":"ACTIVE","platform_stock":38,"name":"Bell Bottom Pant · Black · L","design":"Bell Bottom Pant","colour":"Black","size":"L","unit_cost":250},{"platform":"flipkart","listing_id":"LSTDHTHS64RJFSGNH6DQJ9350","sku_text":"DHOTI-WINE","fsn":"DHTHS64RJFSGNH6D","title":"Daswani Exports Men's Cotton Blend Readymade Dhoti Pant Ethnic Wear Solid Men Dhoti ()","mrp":999,"selling_price":674,"listing_status":"ACTIVE","platform_stock":98,"name":"Dhoti Rani · Wine · FREE","design":"Dhoti Rani","colour":"Wine","size":"FREE","unit_cost":290},{"platform":"flipkart","listing_id":"LSTPYJHH7VNURZG8YJSFKQP1X","sku_text":"Offwhite Bell Bottom Pant (L)","fsn":"PYJHH7VNURZG8YJS","title":"Daswani Exports Indi Men Pyjama ()","mrp":1000,"selling_price":601,"listing_status":"ACTIVE","platform_stock":44,"name":"Bell Bottom Pant · Off-white · L","design":"Bell Bottom Pant","colour":"Off-white","size":"L","unit_cost":250},{"platform":"flipkart","listing_id":"LSTPYJHRDBAGEBFNMZHCHEWDK","sku_text":"Black Bell Bottom Pant-M","fsn":"PYJHRDBAGEBFNMZH","title":"Daswani Exports Indi Men Pyjama ()","mrp":1299,"selling_price":589,"listing_status":"ACTIVE","platform_stock":38,"name":"Bell Bottom Pant · Black · M","design":"Bell Bottom Pant","colour":"Black","size":"M","unit_cost":250},{"platform":"flipkart","listing_id":"LSTPYJHRDBACA5KKVC9ZAKBV2","sku_text":"Black Bell Bottom Pant-XL","fsn":"PYJHRDBACA5KKVC9","title":"Daswani Exports Indi Men Pyjama ()","mrp":1299,"selling_price":589,"listing_status":"ACTIVE","platform_stock":39,"name":"Bell Bottom Pant · Black · XL","design":"Bell Bottom Pant","colour":"Black","size":"XL","unit_cost":250},{"platform":"flipkart","listing_id":"LSTKTAHNG7AEHWUAFVKBKINOJ","sku_text":"Pista Ari Work JJ (2XL)","fsn":"KTAHNG7AEHWUAFVK","title":"Daswani Exports Men Embroidered Straight Kurta (Light Green)","mrp":2499,"selling_price":779,"listing_status":"ACTIVE","platform_stock":20,"name":"Ari Work JJ · Pista Green · 2XL","design":"Ari Work JJ","colour":"Pista Green","size":"2XL","unit_cost":350},{"platform":"flipkart","listing_id":"LSTPYJHH7VNWAQDYGD9VTVCLY","sku_text":"Offwhite Bell Bottom Pant (M)","fsn":"PYJHH7VNWAQDYGD9","title":"Daswani Exports Indi Men Pyjama ()","mrp":1000,"selling_price":601,"listing_status":"ACTIVE","platform_stock":7,"name":"Bell Bottom Pant · Off-white · M","design":"Bell Bottom Pant","colour":"Off-white","size":"M","unit_cost":250},{"platform":"flipkart","listing_id":"LSTKTAHJNG6JRJHTZDFRMJBES","sku_text":"White Malaii More (M)","fsn":"KTAHJNG6JRJHTZDF","title":"Daswani Exports Men Embroidered Straight Kurta (White)","mrp":2999,"selling_price":1193,"listing_status":"ACTIVE","platform_stock":33,"name":"Malai More · White · M","design":"Malai More","colour":"White","size":"M","unit_cost":500},{"platform":"flipkart","listing_id":"LSTPYJHH7VNKVNN7JYQLCWINC","sku_text":"Offwhite Bell Bottom Pant (S)","fsn":"PYJHH7VNKVNN7JYQ","title":"Daswani Exports Indi Men Pyjama ()","mrp":1000,"selling_price":619,"listing_status":"ACTIVE","platform_stock":31,"name":"Bell Bottom Pant · Off-white · S","design":"Bell Bottom Pant","colour":"Off-white","size":"S","unit_cost":250},{"platform":"flipkart","listing_id":"LSTDHTHPHJFENCPNTFGJDGOI6","sku_text":"DHOTI-RANI-PINK","fsn":"DHTHPHJFENCPNTFG","title":"Daswani Exports Men's Cotton Blend Readymade Dhoti Pant Ethnic Wear Solid Men Dhoti ()","mrp":999,"selling_price":591,"listing_status":"ACTIVE","platform_stock":55,"name":"Dhoti Rani · Pink · FREE","design":"Dhoti Rani","colour":"Pink","size":"FREE","unit_cost":290},{"platform":"flipkart","listing_id":"LSTETHHQS3QHFMVGYZG2VABL3","sku_text":"Malai-MM-KP-Grey-M","fsn":"ETHHQS3QHFMVGYZG","title":"Daswani Exports Men Kurta Pant Set ()","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":10,"name":"Malai Kurta-Pant Set · Grey · M","design":"Malai Kurta-Pant Set","colour":"Grey","size":"M","unit_cost":null},{"platform":"flipkart","listing_id":"LSTETHHQS3KTDTWY7XBIET9PF","sku_text":"Malai-MM-KP-Grey-XL","fsn":"ETHHQS3KTDTWY7XB","title":"Daswani Exports Men Kurta Pant Set ()","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":10,"name":"Malai Kurta-Pant Set · Grey · XL","design":"Malai Kurta-Pant Set","colour":"Grey","size":"XL","unit_cost":null},{"platform":"flipkart","listing_id":"LSTPYJHRDBAFXKHRFPZBX2UYB","sku_text":"Black Bell Bottom Pant-2XL","fsn":"PYJHRDBAFXKHRFPZ","title":"Daswani Exports Indi Men Pyjama ()","mrp":1299,"selling_price":540,"listing_status":"ACTIVE","platform_stock":39,"name":"Bell Bottom Pant · Black · 2XL","design":"Bell Bottom Pant","colour":"Black","size":"2XL","unit_cost":250},{"platform":"flipkart","listing_id":"LSTDHTHPHJFRT4GSPY8QMELWT","sku_text":"DHOTI-RANI-ORANGE","fsn":"DHTHPHJFRT4GSPY8","title":"Daswani Exports Men's Cotton Blend Readymade Dhoti Pant Ethnic Wear Solid Men Dhoti ()","mrp":999,"selling_price":591,"listing_status":"ACTIVE","platform_stock":53,"name":"Dhoti Rani · Orange · FREE","design":"Dhoti Rani","colour":"Orange","size":"FREE","unit_cost":290},{"platform":"flipkart","listing_id":"LSTKTAHPN2YAX8YGSMBMZF8WD","sku_text":"KURTA-White-42","fsn":"KTAHPN2YAX8YGSMB","title":"Daswani Exports Men Printed Straight Kurta (Multicolor)","mrp":3999,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":20,"name":"Printed Kurta (DE) · White · 42","design":"Printed Kurta (DE)","colour":"White","size":"42","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHQ2EK7CJPXYJFGKUEFP","sku_text":"MM-KP-Pista Green-L","fsn":"KTAHQ2EK7CJPXYJF","title":"Daswani Exports Men Embroidered Straight Kurta (Green)","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":20,"name":"MM Kurta (KP) · Pista Green · L","design":"MM Kurta (KP)","colour":"Pista Green","size":"L","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHPN2YJZXVQ9A29QJVKD","sku_text":"DE-KURTA-White-40","fsn":"KTAHPN2YJZXVQ9A2","title":"Daswani Exports Men Printed Straight Kurta (White)","mrp":3999,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":20,"name":"Printed Kurta (DE) · White · 40","design":"Printed Kurta (DE)","colour":"White","size":"40","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHQ2EH9JM2ZKGXS3BRLN","sku_text":"MM-KP-Grey-M","fsn":"KTAHQ2EH9JM2ZKGX","title":"Daswani Exports Men Embroidered Straight Kurta (Grey)","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":20,"name":"MM Kurta (KP) · Grey · M","design":"MM Kurta (KP)","colour":"Grey","size":"M","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHQ2EKQBBMRXFKUFFEVZ","sku_text":"MM-KP-Grey-XXL","fsn":"KTAHQ2EKQBBMRXFK","title":"Daswani Exports Men Embroidered Straight Kurta (Grey)","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":20,"name":"MM Kurta (KP) · Grey · 2XL","design":"MM Kurta (KP)","colour":"Grey","size":"2XL","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHQ2EKRBRZGFUDXOW70H","sku_text":"MM-KP-Pista Green-XXL","fsn":"KTAHQ2EKRBRZGFUD","title":"Daswani Exports Men Embroidered Straight Kurta (Green)","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":20,"name":"MM Kurta (KP) · Pista Green · 2XL","design":"MM Kurta (KP)","colour":"Pista Green","size":"2XL","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHQ2EKSQHN4PAH9MHFXS","sku_text":"MM-KP-Pista Green-XL","fsn":"KTAHQ2EKSQHN4PAH","title":"Daswani Exports Men Embroidered Straight Kurta (Green)","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":20,"name":"MM Kurta (KP) · Pista Green · XL","design":"MM Kurta (KP)","colour":"Pista Green","size":"XL","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHPN2YCMWFACGXTKL3MW","sku_text":"KURTA-RED-40","fsn":"KTAHPN2YCMWFACGX","title":"Daswani Exports Men Printed Straight Kurta (Red)","mrp":3999,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":19,"name":"Printed Kurta (DE) · Red · 40","design":"Printed Kurta (DE)","colour":"Red","size":"40","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHQ2EKDRPDAWNC7JHTCY","sku_text":"MM-KP-Pista Green-M","fsn":"KTAHQ2EKDRPDAWNC","title":"Daswani Exports Men Embroidered Straight Kurta (Green)","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":20,"name":"MM Kurta (KP) · Pista Green · M","design":"MM Kurta (KP)","colour":"Pista Green","size":"M","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHPN2YZG9RD4RFTXKPUV","sku_text":"KURTA-Rani-40","fsn":"KTAHPN2YZG9RD4RF","title":"Daswani Exports Men Printed Straight Kurta (Pink)","mrp":3999,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":20,"name":"Printed Kurta (DE) · Rani Pink · 40","design":"Printed Kurta (DE)","colour":"Rani Pink","size":"40","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHQ2EKTHQXVHV6WMOVW8","sku_text":"MM-KP-Grey-XL","fsn":"KTAHQ2EKTHQXVHV6","title":"Daswani Exports Men Embroidered Straight Kurta (Grey)","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":20,"name":"MM Kurta (KP) · Grey · XL","design":"MM Kurta (KP)","colour":"Grey","size":"XL","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHQ2EKYZTXD93W9JYFZU","sku_text":"MM-KP-WHT-XXL","fsn":"KTAHQ2EKYZTXD93W","title":"Daswani Exports Men Embroidered Straight Kurta (White)","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":19,"name":"MM Kurta (KP) · White · 2XL","design":"MM Kurta (KP)","colour":"White","size":"2XL","unit_cost":null},{"platform":"flipkart","listing_id":"LSTETHHQS3KZ7N2GHYNLHR1MW","sku_text":"Malai-MM-KP-WHT-XL","fsn":"ETHHQS3KZ7N2GHYN","title":"Daswani Exports Men Kurta Pant Set ()","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":8,"name":"Malai Kurta-Pant Set · White · XL","design":"Malai Kurta-Pant Set","colour":"White","size":"XL","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHQ2EK3FUSQ4QHZKH8NM","sku_text":"MM-KP-Wine-XXL","fsn":"KTAHQ2EK3FUSQ4QH","title":"Daswani Exports Men Embroidered Straight Kurta (Multicolor)","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":17,"name":"MM Kurta (KP) · Wine · 2XL","design":"MM Kurta (KP)","colour":"Wine","size":"2XL","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHGHCZFHM6WAJU49XLSL","sku_text":"Wine Malai More (L)","fsn":"KTAHGHCZFHM6WAJU","title":"Daswani Exports Men Embroidered Straight Kurta (Purple)","mrp":2999,"selling_price":1193,"listing_status":"ACTIVE","platform_stock":12,"name":"Malai More · Wine · L","design":"Malai More","colour":"Wine","size":"L","unit_cost":500},{"platform":"flipkart","listing_id":"LSTTROHRGJBVCV3RG2Y0Q8QPL","sku_text":"Polo Pant-cream-42","fsn":"TROHRGJBVCV3RG2Y","title":"Daswani Exports Slim Fit Men Cream Trousers ()","mrp":1000,"selling_price":498,"listing_status":"ACTIVE","platform_stock":20,"name":"Polo Pant · Cream · 42","design":"Polo Pant","colour":"Cream","size":"42","unit_cost":250},{"platform":"flipkart","listing_id":"LSTKTAHQ2EK2PHJNNY7WLSIGS","sku_text":"MM-KP-Grey-L","fsn":"KTAHQ2EK2PHJNNY7","title":"Daswani Exports Men Embroidered Straight Kurta (Grey)","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":20,"name":"MM Kurta (KP) · Grey · L","design":"MM Kurta (KP)","colour":"Grey","size":"L","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHQ2EKJX6HG5KDTUAHL6","sku_text":"MM-KP-Wine-XL","fsn":"KTAHQ2EKJX6HG5KD","title":"Daswani Exports Men Embroidered Straight Kurta (Multicolor)","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":18,"name":"MM Kurta (KP) · Wine · XL","design":"MM Kurta (KP)","colour":"Wine","size":"XL","unit_cost":null},{"platform":"flipkart","listing_id":"LSTTROHRGJBYYJZYNGU8GLCHK","sku_text":"Polo Pant-cream-38","fsn":"TROHRGJBYYJZYNGU","title":"Daswani Exports Slim Fit Men Cream Trousers ()","mrp":1000,"selling_price":498,"listing_status":"ACTIVE","platform_stock":20,"name":"Polo Pant · Cream · 38","design":"Polo Pant","colour":"Cream","size":"38","unit_cost":250},{"platform":"flipkart","listing_id":"LSTKTAHPN2YVWMXG6SHF09LKM","sku_text":"KURTA-Rani-42","fsn":"KTAHPN2YVWMXG6SH","title":"Daswani Exports Men Printed Straight Kurta (Multicolor)","mrp":3999,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":20,"name":"Printed Kurta (DE) · Rani Pink · 42","design":"Printed Kurta (DE)","colour":"Rani Pink","size":"42","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHNNPAADB2RVPEOVPBKS","sku_text":"Beige Ari Work JJ (XL)","fsn":"KTAHNNPAADB2RVPE","title":"Daswani Exports Men Embroidered Straight Kurta (Beige)","mrp":1999,"selling_price":801,"listing_status":"ACTIVE","platform_stock":20,"name":"Ari Work JJ · Beige · XL","design":"Ari Work JJ","colour":"Beige","size":"XL","unit_cost":350},{"platform":"flipkart","listing_id":"LSTTROHRGJBEXNEKFNWBFIGUM","sku_text":"Polo Pant-cream-44","fsn":"TROHRGJBEXNEKFNW","title":"Daswani Exports Slim Fit Men Cream Trousers ()","mrp":1000,"selling_price":498,"listing_status":"ACTIVE","platform_stock":18,"name":"Polo Pant · Cream · 44","design":"Polo Pant","colour":"Cream","size":"44","unit_cost":250},{"platform":"flipkart","listing_id":"LSTTROHRGJBHKYQFRN6MCOYCJ","sku_text":"Polo Pant-cream-46","fsn":"TROHRGJBHKYQFRN6","title":"Daswani Exports Slim Fit Men White Trousers ()","mrp":1000,"selling_price":498,"listing_status":"ACTIVE","platform_stock":18,"name":"Polo Pant · Cream · 46","design":"Polo Pant","colour":"Cream","size":"46","unit_cost":250},{"platform":"flipkart","listing_id":"LSTKTAHGHCZGFJMZDSZSYK0Q5","sku_text":"Grey Malai More","fsn":"KTAHGHCZGFJMZDSZ","title":"Daswani Exports Men Embroidered Straight Kurta (Grey)","mrp":2999,"selling_price":1193,"listing_status":"ACTIVE","platform_stock":7,"name":"Malai More · Grey","design":"Malai More","colour":"Grey","size":null,"unit_cost":500},{"platform":"flipkart","listing_id":"LSTTROHRGJBZCREZ6ZDTO5GNK","sku_text":"Polo Pant-cream-48","fsn":"TROHRGJBZCREZ6ZD","title":"Daswani Exports Slim Fit Men Cream Trousers ()","mrp":1000,"selling_price":498,"listing_status":"ACTIVE","platform_stock":14,"name":"Polo Pant · Cream · 48","design":"Polo Pant","colour":"Cream","size":"48","unit_cost":250},{"platform":"flipkart","listing_id":"LSTKTAHQ2EKSFBCNHGUKOEHJW","sku_text":"MM-KP-WHT-XL","fsn":"KTAHQ2EKSFBCNHGU","title":"Daswani Exports Men Embroidered Straight Kurta (White)","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":16,"name":"MM Kurta (KP) · White · XL","design":"MM Kurta (KP)","colour":"White","size":"XL","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHNGW2BYS3GEY5AVRALS","sku_text":"Pink Ari Work JJ (2XL)","fsn":"KTAHNGW2BYS3GEY5","title":"Daswani Exports Men Embroidered Straight Kurta (Pink)","mrp":2499,"selling_price":803,"listing_status":"ACTIVE","platform_stock":20,"name":"Ari Work JJ · Pink · 2XL","design":"Ari Work JJ","colour":"Pink","size":"2XL","unit_cost":350},{"platform":"flipkart","listing_id":"LSTKTAHQDMFYRZE4G3QSMPBD2","sku_text":"KURTA-MULTI-L","fsn":"KTAHQDMFYRZE4G3Q","title":"Daswani Exports Men Printed Straight Kurta (Multicolor)","mrp":1999,"selling_price":623,"listing_status":"ACTIVE","platform_stock":20,"name":"Printed Kurta Multi · Multicolour · L","design":"Printed Kurta Multi","colour":"Multicolour","size":"L","unit_cost":null},{"platform":"flipkart","listing_id":"LSTTROHRGJBFVVEGCAG9X5FF5","sku_text":"Polo Pant-cream-36","fsn":"TROHRGJBFVVEGCAG","title":"Daswani Exports Slim Fit Men Cream Trousers ()","mrp":1000,"selling_price":498,"listing_status":"ACTIVE","platform_stock":20,"name":"Polo Pant · Cream · 36","design":"Polo Pant","colour":"Cream","size":"36","unit_cost":250},{"platform":"flipkart","listing_id":"LSTDHTHS64RGG9FFYZWWNHJPQ","sku_text":"DHOTI-RANI-mustard","fsn":"DHTHS64RGG9FFYZW","title":"Daswani Exports Men Dhoti ()","mrp":999,"selling_price":599,"listing_status":"ACTIVE","platform_stock":88,"name":"Dhoti Rani · Mustard · FREE","design":"Dhoti Rani","colour":"Mustard","size":"FREE","unit_cost":290},{"platform":"flipkart","listing_id":"LSTTROHRGJBWAFUCQPYSQSSUX","sku_text":"Polo Pant-cream-40","fsn":"TROHRGJBWAFUCQPY","title":"Daswani Exports Slim Fit Men Cream Trousers ()","mrp":1000,"selling_price":498,"listing_status":"ACTIVE","platform_stock":20,"name":"Polo Pant · Cream · 40","design":"Polo Pant","colour":"Cream","size":"40","unit_cost":250},{"platform":"flipkart","listing_id":"LSTKTAHQ2EKFFR8XQTMI93H4H","sku_text":"MM-KP-WHT-L","fsn":"KTAHQ2EKFFR8XQTM","title":"Daswani Exports Men Embroidered Straight Kurta (White)","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":15,"name":"MM Kurta (KP) · White · L","design":"MM Kurta (KP)","colour":"White","size":"L","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHQDHX2KN2XRFTOI7WJG","sku_text":"Arm_Chair_Sky_Blue_S","fsn":"KTAHQDHX2KN2XRFT","title":"Daswani Exports Men Floral Print, Printed Straight Kurta (Light Blue)","mrp":1999,"selling_price":623,"listing_status":"ACTIVE","platform_stock":20,"name":"Arm Chair Kurta · Sky Blue · S","design":"Arm Chair Kurta","colour":"Sky Blue","size":"S","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHPN2YYUMTSHDEW9JBFB","sku_text":"KURTA-RED-42","fsn":"KTAHPN2YYUMTSHDE","title":"Daswani Exports Men Printed Straight Kurta (Red)","mrp":3999,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":20,"name":"Printed Kurta (DE) · Red · 42","design":"Printed Kurta (DE)","colour":"Red","size":"42","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHQ2EKJZZWCHVP8OYFGE","sku_text":"MM-KP-Wine-M","fsn":"KTAHQ2EKJZZWCHVP","title":"Daswani Exports Men Embroidered Straight Kurta (Multicolor)","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":19,"name":"MM Kurta (KP) · Wine · M","design":"MM Kurta (KP)","colour":"Wine","size":"M","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHQDNN6JVYHPKFV17QT7","sku_text":"Geometric_KURTA_XL","fsn":"KTAHQDNN6JVYHPKF","title":"Daswani Exports Men Printed Straight Kurta (White)","mrp":1999,"selling_price":623,"listing_status":"ACTIVE","platform_stock":20,"name":"Geometric Kurta · White · XL","design":"Geometric Kurta","colour":"White","size":"XL","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHNG4Y3ARY9BXZW6OYDU","sku_text":"Pista Ari Work JJ (S)","fsn":"KTAHNG4Y3ARY9BXZ","title":"Daswani Exports Men Embroidered Straight Kurta (Light Green)","mrp":2499,"selling_price":803,"listing_status":"ACTIVE","platform_stock":20,"name":"Ari Work JJ · Pista Green · S","design":"Ari Work JJ","colour":"Pista Green","size":"S","unit_cost":350},{"platform":"flipkart","listing_id":"LSTKTAHQDHXCBZDQVZMKMMGZC","sku_text":"Arm_Chair_Sky_Blue_XL","fsn":"KTAHQDHXCBZDQVZM","title":"Daswani Exports Men Floral Print, Printed Straight Kurta (Light Blue)","mrp":1999,"selling_price":623,"listing_status":"ACTIVE","platform_stock":20,"name":"Arm Chair Kurta · Sky Blue · XL","design":"Arm Chair Kurta","colour":"Sky Blue","size":"XL","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHNNQ4BE5J5AMVDQ9YKG","sku_text":"Beige Ari Work JJ (S)","fsn":"KTAHNNQ4BE5J5AMV","title":"Daswani Exports Men Embroidered Straight Kurta (Beige)","mrp":2499,"selling_price":803,"listing_status":"ACTIVE","platform_stock":20,"name":"Ari Work JJ · Beige · S","design":"Ari Work JJ","colour":"Beige","size":"S","unit_cost":350},{"platform":"flipkart","listing_id":"LSTKTAHZFHQC3YT24ZD5YKZQK","sku_text":"Beige Ari Work-(M)","fsn":"KTAHZFHQC3YT24ZD","title":"Daswani Exports Men Embroidered Straight Kurta (Beige)","mrp":2499,"selling_price":803,"listing_status":"ACTIVE","platform_stock":6,"name":"Ari Work JJ · Beige · M","design":"Ari Work JJ","colour":"Beige","size":"M","unit_cost":350},{"platform":"flipkart","listing_id":"LSTKTAHZFHQZTYAWHDZQITKOD","sku_text":"Beige Ari Work Kurta-XL","fsn":"KTAHZFHQZTYAWHDZ","title":"Daswani Exports Men Embroidered Straight Kurta (Beige)","mrp":2499,"selling_price":803,"listing_status":"ACTIVE","platform_stock":10,"name":"Ari Work JJ · Beige · XL","design":"Ari Work JJ","colour":"Beige","size":"XL","unit_cost":350},{"platform":"flipkart","listing_id":"LSTKTAHGHCZVCKRMBH4U2RJOA","sku_text":"White Malai More (XL)","fsn":"KTAHGHCZVCKRMBH4","title":"Daswani Exports Men Embroidered Straight Kurta (White)","mrp":2999,"selling_price":1193,"listing_status":"ACTIVE","platform_stock":9,"name":"Malai More · White · XL","design":"Malai More","colour":"White","size":"XL","unit_cost":500},{"platform":"flipkart","listing_id":"LSTKTAHNG5AYNYTSERTZYW4SI","sku_text":"Pista Ari Work JJ (M)","fsn":"KTAHNG5AYNYTSERT","title":"Daswani Exports Men Embroidered Straight Kurta (Light Green)","mrp":2499,"selling_price":803,"listing_status":"ACTIVE","platform_stock":20,"name":"Ari Work JJ · Pista Green · M","design":"Ari Work JJ","colour":"Pista Green","size":"M","unit_cost":350},{"platform":"flipkart","listing_id":"LSTKTAHGHCZHJ4BVTTGMDDXOC","sku_text":"White Malai More (L)","fsn":"KTAHGHCZHJ4BVTTG","title":"Daswani Exports Men Embroidered Straight Kurta (White)","mrp":2999,"selling_price":1193,"listing_status":"ACTIVE","platform_stock":11,"name":"Malai More · White · L","design":"Malai More","colour":"White","size":"L","unit_cost":500},{"platform":"flipkart","listing_id":"LSTETHHQS3KDJGJC7SFAVFQOD","sku_text":"Malai-MM-KP-Wine-XL","fsn":"ETHHQS3KDJGJC7SF","title":"Daswani Exports Men Kurta Pant Set ()","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":10,"name":"Malai Kurta-Pant Set · Wine · XL","design":"Malai Kurta-Pant Set","colour":"Wine","size":"XL","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHNH3TSSE9235ZWUDROP","sku_text":"Pink Ari Work JJ (S)","fsn":"KTAHNH3TSSE9235Z","title":"Daswani Exports Men Embroidered Straight Kurta (Pink)","mrp":2499,"selling_price":803,"listing_status":"ACTIVE","platform_stock":20,"name":"Ari Work JJ · Pink · S","design":"Ari Work JJ","colour":"Pink","size":"S","unit_cost":350},{"platform":"flipkart","listing_id":"LSTKTAHQDMFUBGZYBZJPFRQZK","sku_text":"KURTA-MULTI-S","fsn":"KTAHQDMFUBGZYBZJ","title":"Daswani Exports Men Printed Straight Kurta (Multicolor)","mrp":1999,"selling_price":623,"listing_status":"ACTIVE","platform_stock":20,"name":"Printed Kurta Multi · Multicolour · S","design":"Printed Kurta Multi","colour":"Multicolour","size":"S","unit_cost":null},{"platform":"flipkart","listing_id":"LSTETHHQS3VYGWF7GEPIIADCB","sku_text":"Malai-MM-KP-Pista Green-M","fsn":"ETHHQS3VYGWF7GEP","title":"Daswani Exports Men Kurta Pant Set ()","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":10,"name":"Malai Kurta-Pant Set · Pista Green · M","design":"Malai Kurta-Pant Set","colour":"Pista Green","size":"M","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHQ2EKZHJG7RWGKCODHK","sku_text":"MM-KP-Wine-L","fsn":"KTAHQ2EKZHJG7RWG","title":"Daswani Exports Men Embroidered Straight Kurta (Multicolor)","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":14,"name":"MM Kurta (KP) · Wine · L","design":"MM Kurta (KP)","colour":"Wine","size":"L","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHQDHXFFH94DAHLVILKI","sku_text":"Arm_Chair_Sky_Blue_M","fsn":"KTAHQDHXFFH94DAH","title":"Daswani Exports Men Floral Print, Printed Straight Kurta (Light Blue)","mrp":1999,"selling_price":623,"listing_status":"ACTIVE","platform_stock":20,"name":"Arm Chair Kurta · Sky Blue · M","design":"Arm Chair Kurta","colour":"Sky Blue","size":"M","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHNGW2ZDDTMECGVQANDL","sku_text":"Pink Ari Work JJ (L)","fsn":"KTAHNGW2ZDDTMECG","title":"Daswani Exports Men Embroidered Straight Kurta (Pink)","mrp":2499,"selling_price":803,"listing_status":"ACTIVE","platform_stock":20,"name":"Ari Work JJ · Pink · L","design":"Ari Work JJ","colour":"Pink","size":"L","unit_cost":350},{"platform":"flipkart","listing_id":"LSTKTAHQDNM4XMGC5SMOBFGUE","sku_text":"Geometric_KURTA_S","fsn":"KTAHQDNM4XMGC5SM","title":"Daswani Exports Men Printed Straight Kurta (Multicolor)","mrp":1999,"selling_price":623,"listing_status":"ACTIVE","platform_stock":20,"name":"Geometric Kurta · Multicolour · S","design":"Geometric Kurta","colour":"Multicolour","size":"S","unit_cost":null},{"platform":"flipkart","listing_id":"LSTDHTHR5ECG9ZG7DEDJDAUN1","sku_text":"Dhoti-Mirror work-Rani","fsn":"DHTHR5ECG9ZG7DED","title":"Daswani Exports Men's Mirror Work Readymade Dhoti for Festive Wear Solid Men Dhoti ()","mrp":1999,"selling_price":699,"listing_status":"ACTIVE","platform_stock":14,"name":"Dhoti Mirror Work · Rani Pink · FREE","design":"Dhoti Mirror Work","colour":"Rani Pink","size":"FREE","unit_cost":290},{"platform":"flipkart","listing_id":"LSTKTAHGHCZKZ52NJE6QJGCSX","sku_text":"Grey Malai More (XL)","fsn":"KTAHGHCZKZ52NJE6","title":"Daswani Exports Men Embroidered Straight Kurta (Grey)","mrp":2999,"selling_price":1193,"listing_status":"ACTIVE","platform_stock":7,"name":"Malai More · Grey · XL","design":"Malai More","colour":"Grey","size":"XL","unit_cost":500},{"platform":"flipkart","listing_id":"LSTKTAHNG4ZXX8YCD8200QUTB","sku_text":"Cream Ari Work JJ (2XL)","fsn":"KTAHNG4ZXX8YCD82","title":"Daswani Exports Men Embroidered Straight Kurta (Beige)","mrp":2494,"selling_price":803,"listing_status":"ACTIVE","platform_stock":20,"name":"Ari Work JJ · Cream · 2XL","design":"Ari Work JJ","colour":"Cream","size":"2XL","unit_cost":350},{"platform":"flipkart","listing_id":"LSTETHHQS3JE6ZE8HKCZYPPYG","sku_text":"Malai-MM-KP-Pista Green-XL","fsn":"ETHHQS3JE6ZE8HKC","title":"Daswani Exports Men Kurta Pant Set ()","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":10,"name":"Malai Kurta-Pant Set · Pista Green · XL","design":"Malai Kurta-Pant Set","colour":"Pista Green","size":"XL","unit_cost":null},{"platform":"flipkart","listing_id":"LSTETHHQS3HGHSZJZTA8T1SQY","sku_text":"Malai-MM-KP-Wine-M","fsn":"ETHHQS3HGHSZJZTA","title":"Daswani Exports Men Kurta Pant Set ()","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":8,"name":"Malai Kurta-Pant Set · Wine · M","design":"Malai Kurta-Pant Set","colour":"Wine","size":"M","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHGHCZZFPVG7HYFFHWVD","sku_text":"Wine Malai More (XL)","fsn":"KTAHGHCZZFPVG7HY","title":"Daswani Exports Men Embroidered Straight Kurta (Purple)","mrp":2999,"selling_price":1193,"listing_status":"ACTIVE","platform_stock":8,"name":"Malai More · Wine · XL","design":"Malai More","colour":"Wine","size":"XL","unit_cost":500},{"platform":"flipkart","listing_id":"LSTKTAHNNQM6ZCGTZFB8JLDII","sku_text":"Beige Ari Work JJ (M)","fsn":"KTAHNNQM6ZCGTZFB","title":"Daswani Exports Men Embroidered Straight Kurta (Beige)","mrp":2499,"selling_price":803,"listing_status":"ACTIVE","platform_stock":20,"name":"Ari Work JJ · Beige · M","design":"Ari Work JJ","colour":"Beige","size":"M","unit_cost":350},{"platform":"flipkart","listing_id":"LSTKTAHQ2EK6HQAFCF72XXDIX","sku_text":"MM-KP-WHT-M","fsn":"KTAHQ2EK6HQAFCF7","title":"Daswani Exports Men Embroidered Straight Kurta (White)","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":12,"name":"MM Kurta (KP) · White · M","design":"MM Kurta (KP)","colour":"White","size":"M","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHPN2YPXQVQ9WHPPEUSG","sku_text":"DE-KURTA-RED-38","fsn":"KTAHPN2YPXQVQ9WH","title":"Daswani Exports Men Printed Straight Kurta (Red)","mrp":3999,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":17,"name":"Printed Kurta (DE) · Red · 38","design":"Printed Kurta (DE)","colour":"Red","size":"38","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHGHCZWFYAUBTE7JCJFK","sku_text":"Wine Malai More (M)","fsn":"KTAHGHCZWFYAUBTE","title":"Daswani Exports Men Embroidered Straight Kurta (Purple)","mrp":2999,"selling_price":1193,"listing_status":"ACTIVE","platform_stock":12,"name":"Malai More · Wine · M","design":"Malai More","colour":"Wine","size":"M","unit_cost":500},{"platform":"flipkart","listing_id":"LSTETHHQS3KZSMZZHBV5NKTTN","sku_text":"Malai-MM-KP-WHT-M","fsn":"ETHHQS3KZSMZZHBV","title":"Daswani Exports Men Kurta Pant Set ()","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":9,"name":"Malai Kurta-Pant Set · White · M","design":"Malai Kurta-Pant Set","colour":"White","size":"M","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHQDHXHPGTQ4K8XEL0CO","sku_text":"Arm_Chair_Sky_Blue_L","fsn":"KTAHQDHXHPGTQ4K8","title":"Daswani Exports Men Floral Print, Printed Straight Kurta (Light Blue)","mrp":1999,"selling_price":623,"listing_status":"ACTIVE","platform_stock":20,"name":"Arm Chair Kurta · Sky Blue · L","design":"Arm Chair Kurta","colour":"Sky Blue","size":"L","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHNGWFBPHJG6NR7FJ1JX","sku_text":"Pink Ari Work JJ (M)","fsn":"KTAHNGWFBPHJG6NR","title":"Daswani Exports Men Embroidered Straight Kurta (Pink)","mrp":2499,"selling_price":803,"listing_status":"ACTIVE","platform_stock":20,"name":"Ari Work JJ · Pink · M","design":"Ari Work JJ","colour":"Pink","size":"M","unit_cost":350},{"platform":"flipkart","listing_id":"LSTETHHQS3K4ZH9T7HSM12UDY","sku_text":"Malai-MM-KP-Wine-XXL","fsn":"ETHHQS3K4ZH9T7HS","title":"Daswani Exports Men Kurta Pant Set ()","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":10,"name":"Malai Kurta-Pant Set · Wine · 2XL","design":"Malai Kurta-Pant Set","colour":"Wine","size":"2XL","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHNNQGAWZXJAHZE0RB0O","sku_text":"Beige Ari Work JJ (L)","fsn":"KTAHNNQGAWZXJAHZ","title":"Daswani Exports Men Embroidered Straight Kurta (Beige)","mrp":2499,"selling_price":803,"listing_status":"ACTIVE","platform_stock":19,"name":"Ari Work JJ · Beige · L","design":"Ari Work JJ","colour":"Beige","size":"L","unit_cost":350},{"platform":"flipkart","listing_id":"LSTDHTHPHJFEU6ESCWKCNJKU6","sku_text":"DHOTI-RANI-WHITE","fsn":"DHTHPHJFEU6ESCWK","title":"Daswani Exports Men's Cotton Blend Readymade Dhoti Pant Ethnic Wear Solid Men Dhoti ()","mrp":999,"selling_price":632,"listing_status":"ACTIVE","platform_stock":79,"name":"Dhoti Rani · White · FREE","design":"Dhoti Rani","colour":"White","size":"FREE","unit_cost":290},{"platform":"flipkart","listing_id":"LSTKTAHGHCZ2MY2QGHSIFGXJM","sku_text":"Grey Malai More (2XL)","fsn":"KTAHGHCZ2MY2QGHS","title":"Daswani Exports Men Embroidered Straight Kurta (Grey)","mrp":2999,"selling_price":1193,"listing_status":"ACTIVE","platform_stock":8,"name":"Malai More · Grey · 2XL","design":"Malai More","colour":"Grey","size":"2XL","unit_cost":500},{"platform":"flipkart","listing_id":"LSTETHHQS3KUQMQJ8H77C4ZKP","sku_text":"Malai-MM-KP-Pista Green-XXL","fsn":"ETHHQS3KUQMQJ8H7","title":"Daswani Exports Men Kurta Pant Set ()","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":10,"name":"Malai Kurta-Pant Set · Pista Green · 2XL","design":"Malai Kurta-Pant Set","colour":"Pista Green","size":"2XL","unit_cost":null},{"platform":"flipkart","listing_id":"LSTETHHQS3HZ4EAPQHBJHHU0Y","sku_text":"Malai-MM-KP-Grey-XXL","fsn":"ETHHQS3HZ4EAPQHB","title":"Daswani Exports Men Kurta Pant Set ()","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":10,"name":"Malai Kurta-Pant Set · Grey · 2XL","design":"Malai Kurta-Pant Set","colour":"Grey","size":"2XL","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHQDNMFZ7J2NS4IUSRFN","sku_text":"Geometric_KURTA_M","fsn":"KTAHQDNMFZ7J2NS4","title":"Daswani Exports Men Printed Straight Kurta (White)","mrp":1999,"selling_price":623,"listing_status":"ACTIVE","platform_stock":20,"name":"Geometric Kurta · White · M","design":"Geometric Kurta","colour":"White","size":"M","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHGHCZVFC3NQZV4TWFRP","sku_text":"Pista Malai More (XL)","fsn":"KTAHGHCZVFC3NQZV","title":"Daswani Exports Men Embroidered Straight Kurta (Light Green)","mrp":2999,"selling_price":1193,"listing_status":"ACTIVE","platform_stock":8,"name":"Malai More · Pista Green · XL","design":"Malai More","colour":"Pista Green","size":"XL","unit_cost":500},{"platform":"flipkart","listing_id":"LSTETHHQS3NMTKMVMDYPPK0YP","sku_text":"Malai-MM-KP-Grey-L","fsn":"ETHHQS3NMTKMVMDY","title":"Daswani Exports Men Kurta Pant Set ()","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":10,"name":"Malai Kurta-Pant Set · Grey · L","design":"Malai Kurta-Pant Set","colour":"Grey","size":"L","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHQDNM8GJVJZKV9R9NMR","sku_text":"Geometric_KURTA_L","fsn":"KTAHQDNM8GJVJZKV","title":"Daswani Exports Men Printed Straight Kurta (White)","mrp":1999,"selling_price":623,"listing_status":"ACTIVE","platform_stock":20,"name":"Geometric Kurta · White · L","design":"Geometric Kurta","colour":"White","size":"L","unit_cost":null},{"platform":"flipkart","listing_id":"LSTETHHQS3KQSZKDB7SJGXYBW","sku_text":"Malai-MM-KP-Wine-L","fsn":"ETHHQS3KQSZKDB7S","title":"Daswani Exports Men Kurta Pant Set ()","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":9,"name":"Malai Kurta-Pant Set · Wine · L","design":"Malai Kurta-Pant Set","colour":"Wine","size":"L","unit_cost":null},{"platform":"flipkart","listing_id":"LSTETHHQS3JG4FTG9GHXMEX7P","sku_text":"Malai-MM-KP-Pista Green-L","fsn":"ETHHQS3JG4FTG9GH","title":"Daswani Exports Men Kurta Pant Set ()","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":10,"name":"Malai Kurta-Pant Set · Pista Green · L","design":"Malai Kurta-Pant Set","colour":"Pista Green","size":"L","unit_cost":null},{"platform":"flipkart","listing_id":"LSTETHHQS3MFSUG6SSZV0VFXP","sku_text":"Malai-MM-KP-WHT-L","fsn":"ETHHQS3MFSUG6SSZ","title":"Daswani Exports Men Kurta Pant Set ()","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":10,"name":"Malai Kurta-Pant Set · White · L","design":"Malai Kurta-Pant Set","colour":"White","size":"L","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHGHCZCDAZCGUCVGGWK9","sku_text":"White Malai More (2XL)","fsn":"KTAHGHCZCDAZCGUC","title":"Daswani Exports Men Embroidered Straight Kurta (White)","mrp":2999,"selling_price":1193,"listing_status":"ACTIVE","platform_stock":19,"name":"Malai More · White · 2XL","design":"Malai More","colour":"White","size":"2XL","unit_cost":500},{"platform":"flipkart","listing_id":"LSTETHHQS3MBQSRFBJYYRFH32","sku_text":"Malai-MM-KP-WHT-XXL","fsn":"ETHHQS3MBQSRFBJY","title":"Daswani Exports Men Kurta Pant Set ()","mrp":4599,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":10,"name":"Malai Kurta-Pant Set · White · 2XL","design":"Malai Kurta-Pant Set","colour":"White","size":"2XL","unit_cost":null},{"platform":"flipkart","listing_id":"LSTDHTHR5E7W87QKKK8EHDMEP","sku_text":"Dhoti-Mirror work-Black","fsn":"DHTHR5E7W87QKKK8","title":"Daswani Exports Men's Mirror Work Readymade Dhoti for Festive Wear Solid Men Dhoti ()","mrp":1999,"selling_price":699,"listing_status":"ACTIVE","platform_stock":19,"name":"Dhoti Mirror Work · Black · FREE","design":"Dhoti Mirror Work","colour":"Black","size":"FREE","unit_cost":290},{"platform":"flipkart","listing_id":"LSTDHTHPHJF8SHFYYHEEHHKFA","sku_text":"DHOTI-RANI-BLACK","fsn":"DHTHPHJF8SHFYYHE","title":"Daswani Exports Men's Cotton Blend Readymade Dhoti Pant Ethnic Wear Solid Men Dhoti ()","mrp":999,"selling_price":581,"listing_status":"ACTIVE","platform_stock":15,"name":"Dhoti Rani · Black · FREE","design":"Dhoti Rani","colour":"Black","size":"FREE","unit_cost":290},{"platform":"flipkart","listing_id":"LSTTROHS2RHZQ7WV7XXSWRBFP","sku_text":"Black Cream Bottom Pant-42","fsn":"TROHS2RHZQ7WV7XX","title":"Daswani Exports Flared Men Cream Trousers ()","mrp":2500,"selling_price":680,"listing_status":"ACTIVE","platform_stock":95,"name":"Flared Bottom Pant · Black & Cream · 42","design":"Flared Bottom Pant","colour":"Black & Cream","size":"42","unit_cost":250},{"platform":"flipkart","listing_id":"LSTTROHS2RGTAWAE2TF5IF3HO","sku_text":"Black Cream Bottom Pant-44","fsn":"TROHS2RGTAWAE2TF","title":"Daswani Exports Flared Men Cream Trousers ()","mrp":2500,"selling_price":680,"listing_status":"ACTIVE","platform_stock":90,"name":"Flared Bottom Pant · Black & Cream · 44","design":"Flared Bottom Pant","colour":"Black & Cream","size":"44","unit_cost":250},{"platform":"flipkart","listing_id":"LSTKTAHNH8T453RPVAWP3PIDL","sku_text":"Pink Ari Work JJ (XL)","fsn":"KTAHNH8T453RPVAW","title":"Daswani Exports Men Embroidered Straight Kurta (Pink)","mrp":2499,"selling_price":803,"listing_status":"ACTIVE","platform_stock":20,"name":"Ari Work JJ · Pink · XL","design":"Ari Work JJ","colour":"Pink","size":"XL","unit_cost":350},{"platform":"flipkart","listing_id":"LSTKTAHPN2YHXU6S2WK79NLQI","sku_text":"KURTA-Rani-38","fsn":"KTAHPN2YHXU6S2WK","title":"Daswani Exports Men Printed Straight Kurta (Pink)","mrp":3999,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":20,"name":"Printed Kurta (DE) · Rani Pink · 38","design":"Printed Kurta (DE)","colour":"Rani Pink","size":"38","unit_cost":null},{"platform":"flipkart","listing_id":"LSTTROHS2RG3PWVTQNFDJJL3T","sku_text":"Black Cream Bottom Pant-S","fsn":"TROHS2RG3PWVTQNF","title":"Daswani Exports Flared Men Cream Trousers ()","mrp":2500,"selling_price":680,"listing_status":"ACTIVE","platform_stock":91,"name":"Flared Bottom Pant · Black & Cream · S","design":"Flared Bottom Pant","colour":"Black & Cream","size":"S","unit_cost":250},{"platform":"flipkart","listing_id":"LSTDHTHR5EHYP3JFAXCMQRS9A","sku_text":"Dhoti-Mirror work-Wine","fsn":"DHTHR5EHYP3JFAXC","title":"Daswani Exports Men's Mirror Work Readymade Dhoti for Festive Wear Solid Men Dhoti ()","mrp":1999,"selling_price":699,"listing_status":"ACTIVE","platform_stock":9,"name":"Dhoti Mirror Work · Wine · FREE","design":"Dhoti Mirror Work","colour":"Wine","size":"FREE","unit_cost":290},{"platform":"flipkart","listing_id":"LSTKTAHPN2YAACDEG9GYZKBVL","sku_text":"KURTA-White-38","fsn":"KTAHPN2YAACDEG9G","title":"Daswani Exports Men Printed Straight Kurta (White)","mrp":3999,"selling_price":1617,"listing_status":"ACTIVE","platform_stock":20,"name":"Printed Kurta (DE) · White · 38","design":"Printed Kurta (DE)","colour":"White","size":"38","unit_cost":null},{"platform":"flipkart","listing_id":"LSTTROHS2RGTYAYD2TFJUDDWO","sku_text":"Black Cream Bottom Pant-38","fsn":"TROHS2RGTYAYD2TF","title":"Daswani Exports Flared Men Cream Trousers ()","mrp":2500,"selling_price":680,"listing_status":"ACTIVE","platform_stock":93,"name":"Flared Bottom Pant · Black & Cream · 38","design":"Flared Bottom Pant","colour":"Black & Cream","size":"38","unit_cost":250},{"platform":"flipkart","listing_id":"LSTDHTHR5EFHWBDNGXSHWCHNY","sku_text":"Dhoti-Mirror work-White","fsn":"DHTHR5EFHWBDNGXS","title":"Daswani Exports Men's Mirror Work Readymade Dhoti for Festive Wear Solid Men Dhoti ()","mrp":1999,"selling_price":623,"listing_status":"ACTIVE","platform_stock":18,"name":"Dhoti Mirror Work · White · FREE","design":"Dhoti Mirror Work","colour":"White","size":"FREE","unit_cost":290},{"platform":"flipkart","listing_id":"LSTKTAHQDMFWQU5G2NZWTIFAC","sku_text":"KURTA-MULTI-M","fsn":"KTAHQDMFWQU5G2NZ","title":"Daswani Exports Men Printed Straight Kurta (Multicolor)","mrp":1999,"selling_price":623,"listing_status":"ACTIVE","platform_stock":20,"name":"Printed Kurta Multi · Multicolour · M","design":"Printed Kurta Multi","colour":"Multicolour","size":"M","unit_cost":null},{"platform":"flipkart","listing_id":"LSTKTAHQDMFPCNWZUE8LAOHXN","sku_text":"KURTA-MULTI-XL","fsn":"KTAHQDMFPCNWZUE8","title":"Daswani Exports Men Printed Straight Kurta (Multicolor)","mrp":1999,"selling_price":623,"listing_status":"ACTIVE","platform_stock":17,"name":"Printed Kurta Multi · Multicolour · XL","design":"Printed Kurta Multi","colour":"Multicolour","size":"XL","unit_cost":null},{"platform":"flipkart","listing_id":"LSTDHTHPHJFFMSFFDZUGJH1E5","sku_text":"DHOTI-RANI-MAROON","fsn":"DHTHPHJFFMSFFDZU","title":"Daswani Exports Men's Cotton Blend Readymade Dhoti Pant Ethnic Wear Solid Men Dhoti ()","mrp":999,"selling_price":591,"listing_status":"ACTIVE","platform_stock":79,"name":"Dhoti Rani · Maroon · FREE","design":"Dhoti Rani","colour":"Maroon","size":"FREE","unit_cost":290},{"platform":"flipkart","listing_id":"LSTKTAHNG3WDPYXZWYCHZ0NJM","sku_text":"Pista Ari Work JJ (XL)","fsn":"KTAHNG3WDPYXZWYC","title":"Daswani Exports Men Embroidered Straight Kurta (Light Green)","mrp":2499,"selling_price":803,"listing_status":"ACTIVE","platform_stock":20,"name":"Ari Work JJ · Pista Green · XL","design":"Ari Work JJ","colour":"Pista Green","size":"XL","unit_cost":350},{"platform":"flipkart","listing_id":"LSTKTAHGHCZ4WJE8SPYTIDHBO","sku_text":"Grey Malai More (L)","fsn":"KTAHGHCZ4WJE8SPY","title":"Daswani Exports Men Embroidered Straight Kurta (Grey)","mrp":2999,"selling_price":1193,"listing_status":"ACTIVE","platform_stock":10,"name":"Malai More · Grey · L","design":"Malai More","colour":"Grey","size":"L","unit_cost":500},{"platform":"flipkart","listing_id":"LSTKTAHGHCZSQZZWGF9VJFMLL","sku_text":"Pista Malai More (L)","fsn":"KTAHGHCZSQZZWGF9","title":"Daswani Exports Men Embroidered Straight Kurta (Light Green)","mrp":2999,"selling_price":1193,"listing_status":"ACTIVE","platform_stock":6,"name":"Malai More · Pista Green · L","design":"Malai More","colour":"Pista Green","size":"L","unit_cost":500},{"platform":"flipkart","listing_id":"LSTKTAHGHCZCZJCZZHMDVA9H4","sku_text":"Wine Malai More","fsn":"KTAHGHCZCZJCZZHM","title":"Daswani Exports Men Embroidered Straight Kurta (Purple)","mrp":2999,"selling_price":1193,"listing_status":"ACTIVE","platform_stock":7,"name":"Malai More · Wine","design":"Malai More","colour":"Wine","size":null,"unit_cost":500},{"platform":"flipkart","listing_id":"LSTTROHZGZFWQTPJBRYJPCB8W","sku_text":"Polo Pant-Black-XL","fsn":"TROHZGZFWQTPJBRY","title":"Daswani Exports Slim Fit Men Black Trousers ()","mrp":1000,"selling_price":563,"listing_status":"ACTIVE","platform_stock":19,"name":"Polo Pant · Black · XL","design":"Polo Pant","colour":"Black","size":"XL","unit_cost":250},{"platform":"flipkart","listing_id":"LSTKTAHGHCZY3KWT3JHCMI8CB","sku_text":"Pista Malai More (2XL)","fsn":"KTAHGHCZY3KWT3JH","title":"Daswani Exports Men Embroidered Straight Kurta (Light Green)","mrp":2999,"selling_price":1193,"listing_status":"ACTIVE","platform_stock":7,"name":"Malai More · Pista Green · 2XL","design":"Malai More","colour":"Pista Green","size":"2XL","unit_cost":500},{"platform":"flipkart","listing_id":"LSTKTAHNG4AKJAW9FRW7EAX91","sku_text":"Pista Ari Work JJ (L)","fsn":"KTAHNG4AKJAW9FRW","title":"Daswani Exports Men Embroidered Straight Kurta (Light Green)","mrp":2499,"selling_price":803,"listing_status":"ACTIVE","platform_stock":20,"name":"Ari Work JJ · Pista Green · L","design":"Ari Work JJ","colour":"Pista Green","size":"L","unit_cost":350},{"platform":"flipkart","listing_id":"LSTTROHRGKAWYJ2YGVV6D5XMG","sku_text":"Polo Pant-White-48","fsn":"TROHRGKAWYJ2YGVV","title":"Daswani Exports Slim Fit Men White Trousers ()","mrp":1000,"selling_price":500,"listing_status":"ACTIVE","platform_stock":16,"name":"Polo Pant · White · 48","design":"Polo Pant","colour":"White","size":"48","unit_cost":250},{"platform":"flipkart","listing_id":"LSTKTAHGHCZSTGREJC9HDSFTI","sku_text":"Pista Malai More (M)","fsn":"KTAHGHCZSTGREJC9","title":"Daswani Exports Men Embroidered Straight Kurta (Light Green)","mrp":2999,"selling_price":1193,"listing_status":"ACTIVE","platform_stock":4,"name":"Malai More · Pista Green · M","design":"Malai More","colour":"Pista Green","size":"M","unit_cost":500},{"platform":"flipkart","listing_id":"LSTTROHRGKPVXZCQRRAJWXK4J","sku_text":"Polo Pant-Black-48","fsn":"TROHRGKPVXZCQRRA","title":"Daswani Exports Slim Fit Men Black Trousers ()","mrp":999,"selling_price":524,"listing_status":"ACTIVE","platform_stock":15,"name":"Polo Pant · Black · 48","design":"Polo Pant","colour":"Black","size":"48","unit_cost":250},{"platform":"flipkart","listing_id":"LSTTROHRGKZJJ6V9HRW9JBF9D","sku_text":"Polo Pant-Black-46","fsn":"TROHRGKZJJ6V9HRW","title":"Daswani Exports Slim Fit Men Black Trousers ()","mrp":999,"selling_price":524,"listing_status":"ACTIVE","platform_stock":18,"name":"Polo Pant · Black · 46","design":"Polo Pant","colour":"Black","size":"46","unit_cost":250},{"platform":"flipkart","listing_id":"LSTTROHZGVV7SAXSRA8M14OYM","sku_text":"Polo Pant-White-XL","fsn":"TROHZGVV7SAXSRA8","title":"Daswani Exports Slim Fit Men White Trousers ()","mrp":1000,"selling_price":524,"listing_status":"ACTIVE","platform_stock":20,"name":"Polo Pant · White · XL","design":"Polo Pant","colour":"White","size":"XL","unit_cost":250},{"platform":"flipkart","listing_id":"LSTTROHZGYVQ6DFBBG2I7UMY7","sku_text":"Polo Pant-Black-S","fsn":"TROHZGYVQ6DFBBG2","title":"Daswani Exports Slim Fit Men Black Trousers ()","mrp":1000,"selling_price":524,"listing_status":"ACTIVE","platform_stock":20,"name":"Polo Pant · Black · S","design":"Polo Pant","colour":"Black","size":"S","unit_cost":250},{"platform":"flipkart","listing_id":"LSTTROHZGVUXGUKFZSCKQWAXV","sku_text":"Polo Pant-White-L","fsn":"TROHZGVUXGUKFZSC","title":"Daswani Exports Slim Fit Men White Trousers ()","mrp":1000,"selling_price":524,"listing_status":"ACTIVE","platform_stock":20,"name":"Polo Pant · White · L","design":"Polo Pant","colour":"White","size":"L","unit_cost":250},{"platform":"flipkart","listing_id":"LSTTROHZGVUZFAH6ETTKJMP0F","sku_text":"Polo Pant-White-S","fsn":"TROHZGVUZFAH6ETT","title":"Daswani Exports Slim Fit Men White Trousers ()","mrp":1000,"selling_price":524,"listing_status":"ACTIVE","platform_stock":19,"name":"Polo Pant · White · S","design":"Polo Pant","colour":"White","size":"S","unit_cost":250},{"platform":"flipkart","listing_id":"LSTTROHZGYU4YVKN2JYNJTM95","sku_text":"Polo Pant-Black-L","fsn":"TROHZGYU4YVKN2JY","title":"Daswani Exports Slim Fit Men Black Trousers ()","mrp":1000,"selling_price":524,"listing_status":"ACTIVE","platform_stock":20,"name":"Polo Pant · Black · L","design":"Polo Pant","colour":"Black","size":"L","unit_cost":250},{"platform":"flipkart","listing_id":"LSTTROHRGKB7N36VCYBRMPYF1","sku_text":"Polo Pant-White-46","fsn":"TROHRGKB7N36VCYB","title":"Daswani Exports Slim Fit Men White Trousers ()","mrp":1000,"selling_price":500,"listing_status":"ACTIVE","platform_stock":20,"name":"Polo Pant · White · 46","design":"Polo Pant","colour":"White","size":"46","unit_cost":250},{"platform":"flipkart","listing_id":"LSTTROHZGZFGYW4QEETUPR46D","sku_text":"Polo Pant-Black-XXL","fsn":"TROHZGZFGYW4QEET","title":"Daswani Exports Slim Fit Men Black Trousers ()","mrp":1000,"selling_price":524,"listing_status":"ACTIVE","platform_stock":20,"name":"Polo Pant · Black · 2XL","design":"Polo Pant","colour":"Black","size":"2XL","unit_cost":250},{"platform":"flipkart","listing_id":"LSTTROHZGVUYK7HEGYHEZSGRS","sku_text":"Polo Pant-White-XXL","fsn":"TROHZGVUYK7HEGYH","title":"Daswani Exports Slim Fit Men White Trousers ()","mrp":1000,"selling_price":498,"listing_status":"ACTIVE","platform_stock":20,"name":"Polo Pant · White · 2XL","design":"Polo Pant","colour":"White","size":"2XL","unit_cost":250},{"platform":"flipkart","listing_id":"LSTTROHZGVV6KUQSGMSGVOPNF","sku_text":"Polo Pant-White-M","fsn":"TROHZGVV6KUQSGMS","title":"Daswani Exports Slim Fit Men White Trousers ()","mrp":1000,"selling_price":524,"listing_status":"ACTIVE","platform_stock":20,"name":"Polo Pant · White · M","design":"Polo Pant","colour":"White","size":"M","unit_cost":250},{"platform":"flipkart","listing_id":"LSTTROHZGYUTCB3JP3PYLKMUT","sku_text":"Polo Pant-Black-M","fsn":"TROHZGYUTCB3JP3P","title":"Daswani Exports Slim Fit Men Black Trousers ()","mrp":1000,"selling_price":524,"listing_status":"ACTIVE","platform_stock":20,"name":"Polo Pant · Black · M","design":"Polo Pant","colour":"Black","size":"M","unit_cost":250}]$seed$::jsonb) as new_listings_added;
