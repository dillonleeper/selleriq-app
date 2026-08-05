-- SellerIQ daily-dev performance read paths.
-- This migration is intentionally dev-only and fails closed on any other DB.

do $$
begin
  if coalesce((select environment from public.__seller_iq_environment limit 1), '') <> 'dev' then
    raise exception 'Refusing to run: target database is not marked dev.';
  end if;
end $$;

create extension if not exists pg_trgm;

-- Leading-wildcard product search cannot use ordinary btree indexes.
create index if not exists idx_dim_product_sku_trgm
  on public.dim_product using gin (lower(sku) gin_trgm_ops);
create index if not exists idx_dim_product_asin_trgm
  on public.dim_product using gin (lower(asin) gin_trgm_ops);
create index if not exists idx_dim_product_title_trgm
  on public.dim_product using gin (lower(title) gin_trgm_ops);

-- Supports the common filtered fact-table access pattern used by the app.
create index if not exists idx_fct_sales_daily_market_sku_date
  on public.fct_sales_daily (marketplace, sku, start_date)
  include (units_ordered, ordered_product_sales_amount, sessions, page_views);

create or replace function public.search_products(
  p_query text,
  p_limit integer default 20
)
returns table (sku text, asin text, title text)
language sql
stable
as $function$
  with candidates as (
    select
      d.sku,
      max(d.asin) as asin,
      max(d.title) as title,
      min(
        case
          when lower(d.sku) = lower(trim(p_query)) then 0
          when lower(d.asin) = lower(trim(p_query)) then 1
          when lower(d.sku) like lower(trim(p_query)) || '%' then 2
          when lower(d.asin) like lower(trim(p_query)) || '%' then 3
          when lower(d.title) like lower(trim(p_query)) || '%' then 4
          else 5
        end
      ) as rank
    from public.dim_product d
    where d.sku is not null
      and (
        lower(d.sku) like '%' || lower(trim(p_query)) || '%'
        or lower(d.asin) like '%' || lower(trim(p_query)) || '%'
        or lower(d.title) like '%' || lower(trim(p_query)) || '%'
      )
    group by d.sku
  )
  select c.sku, c.asin, c.title
  from candidates c
  order by c.rank, c.sku
  limit least(greatest(coalesce(p_limit, 20), 1), 500);
$function$;

create or replace function public.get_sales_overview(
  p_start date,
  p_end date,
  p_prior_start date,
  p_prior_end date,
  p_markets text[],
  p_skus text[] default null
)
returns table (
  period text,
  start_date date,
  revenue numeric,
  units bigint,
  sessions bigint,
  page_views bigint
)
language sql
stable
as $function$
  select
    case when f.start_date between p_start and p_end then 'current' else 'prior' end,
    f.start_date,
    sum(case when f.marketplace = 'CA'
             then f.ordered_product_sales_amount * 0.74
             else f.ordered_product_sales_amount end)::numeric,
    sum(coalesce(f.units_ordered, 0))::bigint,
    sum(coalesce(f.sessions, 0))::bigint,
    sum(coalesce(f.page_views, 0))::bigint
  from public.fct_sales_daily f
  where f.marketplace = any (p_markets)
    and (p_skus is null or f.sku = any (p_skus))
    and (
      f.start_date between p_start and p_end
      or f.start_date between p_prior_start and p_prior_end
    )
  group by 1, f.start_date
  order by 1, f.start_date;
$function$;

create or replace function public.get_inventory_sales_velocity(
  p_start date,
  p_markets text[]
)
returns table (
  sku text,
  marketplace text,
  total_units bigint,
  series jsonb
)
language sql
stable
as $function$
  with daily as (
    select
      f.sku,
      f.marketplace,
      f.start_date,
      sum(coalesce(f.units_ordered, 0))::bigint as units
    from public.fct_sales_daily f
    where f.sku is not null
      and f.marketplace = any (p_markets)
      and f.start_date >= p_start
    group by f.sku, f.marketplace, f.start_date
  )
  select
    d.sku,
    d.marketplace,
    sum(d.units)::bigint,
    jsonb_agg(jsonb_build_object('d', d.start_date, 'units', d.units) order by d.start_date)
  from daily d
  group by d.sku, d.marketplace;
$function$;

create or replace function public.get_sku_sales_summary(
  p_start date,
  p_end date,
  p_prior_start date,
  p_prior_end date,
  p_markets text[],
  p_skus text[] default null
)
returns table (
  sku text, title text, sessions bigint, page_views bigint, units numeric,
  revenue numeric, conv_rate numeric, buy_box_pct numeric,
  prev_sessions bigint, prev_units numeric, prev_revenue numeric
)
language sql
stable
as $function$
  with totals as (
    select
      f.sku,
      max(f.title) filter (where f.start_date between p_start and p_end) as title,
      sum(f.sessions) filter (where f.start_date between p_start and p_end)::bigint as sessions,
      sum(f.page_views) filter (where f.start_date between p_start and p_end)::bigint as page_views,
      sum(f.units_ordered) filter (where f.start_date between p_start and p_end)::numeric as units,
      sum(case when f.marketplace = 'CA' then f.ordered_product_sales_amount * 0.74
               else f.ordered_product_sales_amount end)
        filter (where f.start_date between p_start and p_end)::numeric as revenue,
      sum(f.units_ordered) filter (where f.start_date between p_start and p_end and f.sessions > 0)::numeric as conv_num,
      sum(f.sessions) filter (where f.start_date between p_start and p_end and f.sessions > 0)::numeric as conv_den,
      avg(f.buy_box_percentage) filter (where f.start_date between p_start and p_end)::numeric as buy_box_pct,
      sum(f.sessions) filter (where f.start_date between p_prior_start and p_prior_end)::bigint as prev_sessions,
      sum(f.units_ordered) filter (where f.start_date between p_prior_start and p_prior_end)::numeric as prev_units,
      sum(case when f.marketplace = 'CA' then f.ordered_product_sales_amount * 0.74
               else f.ordered_product_sales_amount end)
        filter (where f.start_date between p_prior_start and p_prior_end)::numeric as prev_revenue
    from public.fct_sales_daily f
    where f.sku is not null
      and f.marketplace = any (p_markets)
      and (p_skus is null or f.sku = any (p_skus))
      and (f.start_date between p_start and p_end
           or f.start_date between p_prior_start and p_prior_end)
    group by f.sku
  )
  select
    t.sku, coalesce(t.title, t.sku), coalesce(t.sessions, 0), coalesce(t.page_views, 0),
    coalesce(t.units, 0), coalesce(t.revenue, 0),
    case when coalesce(t.conv_den, 0) > 0 then (t.conv_num / t.conv_den) * 100 else 0 end,
    t.buy_box_pct, coalesce(t.prev_sessions, 0), coalesce(t.prev_units, 0),
    coalesce(t.prev_revenue, 0)
  from totals t
  where coalesce(t.sessions, 0) <> 0 or coalesce(t.units, 0) <> 0 or coalesce(t.revenue, 0) <> 0;
$function$;

create or replace function public.get_sku_sales_series(
  p_start date,
  p_end date,
  p_markets text[],
  p_sku text
)
returns table (
  d date, sessions bigint, page_views bigint, units numeric, revenue numeric,
  conv_rate numeric, buy_box_pct numeric
)
language sql
stable
as $function$
  select
    f.start_date,
    sum(f.sessions)::bigint,
    sum(f.page_views)::bigint,
    sum(f.units_ordered)::numeric,
    sum(case when f.marketplace = 'CA' then f.ordered_product_sales_amount * 0.74
             else f.ordered_product_sales_amount end)::numeric,
    case when sum(f.sessions) filter (where f.sessions > 0) > 0
         then (sum(f.units_ordered) filter (where f.sessions > 0)
               / sum(f.sessions) filter (where f.sessions > 0)) * 100
         else 0 end,
    avg(f.buy_box_percentage)::numeric
  from public.fct_sales_daily f
  where f.sku = p_sku
    and f.marketplace = any (p_markets)
    and f.start_date between p_start and p_end
  group by f.start_date
  order by f.start_date;
$function$;

create or replace function public.get_sku_sales_cadence(
  p_start date,
  p_end date,
  p_markets text[],
  p_skus text[] default null
)
returns table (
  sku text, d date, units numeric, revenue numeric
)
language sql
stable
as $function$
  select
    f.sku,
    f.start_date,
    sum(f.units_ordered)::numeric,
    sum(case when f.marketplace = 'CA' then f.ordered_product_sales_amount * 0.74
             else f.ordered_product_sales_amount end)::numeric
  from public.fct_sales_daily f
  where f.sku is not null
    and f.marketplace = any (p_markets)
    and (p_skus is null or f.sku = any (p_skus))
    and f.start_date between p_start and p_end
  group by f.sku, f.start_date
  order by f.sku, f.start_date;
$function$;

grant execute on function public.search_products(text, integer) to anon, authenticated;
grant execute on function public.get_sales_overview(date, date, date, date, text[], text[]) to anon, authenticated;
grant execute on function public.get_inventory_sales_velocity(date, text[]) to anon, authenticated;
grant execute on function public.get_sku_sales_summary(date, date, date, date, text[], text[]) to anon, authenticated;
grant execute on function public.get_sku_sales_series(date, date, text[], text) to anon, authenticated;
grant execute on function public.get_sku_sales_cadence(date, date, text[], text[]) to anon, authenticated;
