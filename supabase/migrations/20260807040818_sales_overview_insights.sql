-- Trustworthy Sales Overview read model: effective-dated FX, freshness,
-- equal-window comparisons, ranked drivers, and inventory-supported actions.

do $$
begin
  if coalesce((select environment from public.__seller_iq_environment limit 1), '') <> 'dev' then
    raise exception 'Refusing to run: target database is not marked dev.';
  end if;
end $$;

create table if not exists public.reporting_fx_rate (
  from_currency text not null,
  to_currency text not null default 'USD',
  effective_from date not null,
  rate numeric(18, 8) not null check (rate > 0),
  source_system text not null,
  created_at timestamptz not null default now(),
  primary key (from_currency, to_currency, effective_from)
);

alter table public.reporting_fx_rate enable row level security;

drop policy if exists reporting_fx_rate_read on public.reporting_fx_rate;
create policy reporting_fx_rate_read
  on public.reporting_fx_rate for select
  to anon, authenticated
  using (true);

grant select on public.reporting_fx_rate to anon, authenticated;

insert into public.reporting_fx_rate
  (from_currency, to_currency, effective_from, rate, source_system)
values
  ('USD', 'USD', date '1900-01-01', 1, 'identity'),
  ('CAD', 'USD', date '1900-01-01', 0.74, 'selleriq_config_baseline')
on conflict (from_currency, to_currency, effective_from) do nothing;

create or replace function public.reporting_fx_rate(
  p_from_currency text,
  p_effective_date date,
  p_to_currency text default 'USD'
)
returns numeric
language sql
stable
security invoker
set search_path = ''
as $function$
  select r.rate
  from public.reporting_fx_rate r
  where r.from_currency = upper(p_from_currency)
    and r.to_currency = upper(p_to_currency)
    and r.effective_from <= p_effective_date
  order by r.effective_from desc
  limit 1;
$function$;

grant execute on function public.reporting_fx_rate(text, date, text) to anon, authenticated;

create index if not exists idx_inventory_market_sku_snapshot
  on public.fct_inventory_snapshot_daily (marketplace, sku, snapshot_date desc)
  include (available_quantity, total_inbound_quantity);

create or replace function public.get_sales_overview_insights(
  p_start date,
  p_end date,
  p_prior_start date,
  p_prior_end date,
  p_markets text[],
  p_skus text[] default null
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
with
market_coverage as (
  select
    m.marketplace,
    min(f.start_date) as first_date,
    max(f.start_date) as data_through
  from unnest(p_markets) m(marketplace)
  left join public.fct_sales_daily f on f.marketplace = m.marketplace
  group by m.marketplace
),
coverage as (
  select
    min(first_date) as first_date,
    min(data_through) as data_through,
    bool_and(first_date <= p_prior_start and data_through >= p_prior_end) as comparison_complete
  from market_coverage
),
filtered as (
  select
    f.*,
    coalesce(public.reporting_fx_rate(
      case when f.marketplace = 'CA' then 'CAD' else 'USD' end,
      f.start_date
    ), 1) as usd_rate
  from public.fct_sales_daily f
  where f.marketplace = any(p_markets)
    and (p_skus is null or f.sku = any(p_skus))
    and (
      f.start_date between p_start and p_end
      or f.start_date between p_prior_start and p_prior_end
    )
),
daily as (
  select
    case when start_date between p_start and p_end then 'current' else 'prior' end as period,
    start_date,
    sum(coalesce(ordered_product_sales_amount, 0) * usd_rate)::numeric as revenue,
    sum(coalesce(units_ordered, 0))::bigint as units,
    sum(coalesce(sessions, 0))::bigint as sessions,
    sum(coalesce(page_views, 0))::bigint as page_views
  from filtered
  group by 1, start_date
),
sku_totals as (
  select
    sku,
    coalesce(max(title) filter (where start_date between p_start and p_end), max(title), sku) as title,
    sum(coalesce(ordered_product_sales_amount, 0) * usd_rate) filter (where start_date between p_start and p_end)::numeric as revenue,
    sum(coalesce(units_ordered, 0)) filter (where start_date between p_start and p_end)::numeric as units,
    sum(coalesce(sessions, 0)) filter (where start_date between p_start and p_end)::numeric as sessions,
    sum(coalesce(page_views, 0)) filter (where start_date between p_start and p_end)::numeric as page_views,
    case when sum(coalesce(sessions, 0)) filter (where start_date between p_start and p_end) > 0
      then 100 * sum(coalesce(units_ordered, 0)) filter (where start_date between p_start and p_end)
        / sum(coalesce(sessions, 0)) filter (where start_date between p_start and p_end)
    end::numeric as conversion_rate,
    case when sum(coalesce(sessions, 0)) filter (where start_date between p_start and p_end) > 0
      then sum(coalesce(buy_box_percentage, 0) * coalesce(sessions, 0)) filter (where start_date between p_start and p_end)
        / sum(coalesce(sessions, 0)) filter (where start_date between p_start and p_end)
    end::numeric as buy_box_pct,
    sum(coalesce(ordered_product_sales_amount, 0) * usd_rate) filter (where start_date between p_prior_start and p_prior_end)::numeric as prior_revenue,
    sum(coalesce(units_ordered, 0)) filter (where start_date between p_prior_start and p_prior_end)::numeric as prior_units,
    sum(coalesce(sessions, 0)) filter (where start_date between p_prior_start and p_prior_end)::numeric as prior_sessions
  from filtered
  where sku is not null
  group by sku
),
sku_ranked as (
  select *, coalesce(revenue, 0) - coalesce(prior_revenue, 0) as revenue_delta
  from sku_totals
  order by abs(coalesce(revenue, 0) - coalesce(prior_revenue, 0)) desc
  limit 20
),
market_totals as (
  select
    marketplace,
    sum(coalesce(ordered_product_sales_amount, 0) * usd_rate) filter (where start_date between p_start and p_end)::numeric as revenue,
    sum(coalesce(ordered_product_sales_amount, 0) * usd_rate) filter (where start_date between p_prior_start and p_prior_end)::numeric as prior_revenue,
    sum(coalesce(units_ordered, 0)) filter (where start_date between p_start and p_end)::numeric as units,
    sum(coalesce(sessions, 0)) filter (where start_date between p_start and p_end)::numeric as sessions
  from filtered
  group by marketplace
),
latest_inventory as (
  select distinct on (i.marketplace, i.sku)
    i.marketplace, i.sku, i.snapshot_date,
    coalesce(i.available_quantity, 0) as available_quantity,
    coalesce(i.total_inbound_quantity, 0) as inbound_quantity
  from public.fct_inventory_snapshot_daily i
  where i.marketplace = any(p_markets)
    and i.sku is not null
    and (p_skus is null or i.sku = any(p_skus))
  order by i.marketplace, i.sku, i.snapshot_date desc
),
velocity as (
  select sku, sum(coalesce(units_ordered, 0))::numeric / greatest(p_end - p_start + 1, 1) as units_per_day
  from filtered
  where start_date between p_start and p_end and sku is not null
  group by sku
),
inventory_risks as (
  select
    i.sku, i.marketplace, i.snapshot_date, i.available_quantity, i.inbound_quantity,
    v.units_per_day,
    case when v.units_per_day > 0 then i.available_quantity / v.units_per_day end as days_of_cover
  from latest_inventory i
  join velocity v using (sku)
  where v.units_per_day > 0
    and i.available_quantity / v.units_per_day < 28
  order by i.available_quantity / v.units_per_day
  limit 12
)
select jsonb_build_object(
  'meta', jsonb_build_object(
    'first_date', c.first_date,
    'data_through', c.data_through,
    'comparison_complete', coalesce(c.comparison_complete, false),
    'market_freshness', coalesce((select jsonb_agg(to_jsonb(mc) order by mc.marketplace) from market_coverage mc), '[]'::jsonb),
    'currency', 'USD',
    'fx_method', 'effective_dated'
  ),
  'series', coalesce((select jsonb_agg(to_jsonb(d) order by d.period, d.start_date) from daily d), '[]'::jsonb),
  'sku_drivers', coalesce((select jsonb_agg(to_jsonb(s) order by abs(s.revenue_delta) desc) from sku_ranked s), '[]'::jsonb),
  'market_drivers', coalesce((select jsonb_agg(to_jsonb(m) order by coalesce(m.revenue, 0) desc) from market_totals m), '[]'::jsonb),
  'inventory_risks', coalesce((select jsonb_agg(to_jsonb(i) order by i.days_of_cover) from inventory_risks i), '[]'::jsonb)
)
from coverage c;
$function$;

grant execute on function public.get_sales_overview_insights(date, date, date, date, text[], text[]) to anon, authenticated;

-- Replace fixed conversion constants in shared sales read paths.
create or replace function public.get_sales_overview(
  p_start date, p_end date, p_prior_start date, p_prior_end date,
  p_markets text[], p_skus text[] default null
)
returns table (period text, start_date date, revenue numeric, units bigint, sessions bigint, page_views bigint)
language sql stable security invoker set search_path = ''
as $function$
  select
    case when f.start_date between p_start and p_end then 'current' else 'prior' end,
    f.start_date,
    sum(coalesce(f.ordered_product_sales_amount, 0) * coalesce(public.reporting_fx_rate(case when f.marketplace = 'CA' then 'CAD' else 'USD' end, f.start_date), 1))::numeric,
    sum(coalesce(f.units_ordered, 0))::bigint,
    sum(coalesce(f.sessions, 0))::bigint,
    sum(coalesce(f.page_views, 0))::bigint
  from public.fct_sales_daily f
  where f.marketplace = any(p_markets)
    and (p_skus is null or f.sku = any(p_skus))
    and (f.start_date between p_start and p_end or f.start_date between p_prior_start and p_prior_end)
  group by 1, f.start_date order by 1, f.start_date;
$function$;

create or replace function public.get_sku_sales_summary(
  p_start date, p_end date, p_prior_start date, p_prior_end date,
  p_markets text[], p_skus text[] default null
)
returns table (
  sku text, title text, sessions bigint, page_views bigint, units numeric,
  revenue numeric, conv_rate numeric, buy_box_pct numeric,
  prev_sessions bigint, prev_units numeric, prev_revenue numeric
)
language sql stable security invoker set search_path = ''
as $function$
  with totals as (
    select f.sku,
      max(f.title) filter (where f.start_date between p_start and p_end) as title,
      sum(f.sessions) filter (where f.start_date between p_start and p_end)::bigint as sessions,
      sum(f.page_views) filter (where f.start_date between p_start and p_end)::bigint as page_views,
      sum(f.units_ordered) filter (where f.start_date between p_start and p_end)::numeric as units,
      sum(coalesce(f.ordered_product_sales_amount, 0) * coalesce(public.reporting_fx_rate(case when f.marketplace = 'CA' then 'CAD' else 'USD' end, f.start_date), 1)) filter (where f.start_date between p_start and p_end)::numeric as revenue,
      sum(f.units_ordered) filter (where f.start_date between p_start and p_end and f.sessions > 0)::numeric as conv_num,
      sum(f.sessions) filter (where f.start_date between p_start and p_end and f.sessions > 0)::numeric as conv_den,
      case when sum(coalesce(f.sessions, 0)) filter (where f.start_date between p_start and p_end) > 0
        then sum(coalesce(f.buy_box_percentage, 0) * coalesce(f.sessions, 0)) filter (where f.start_date between p_start and p_end)
          / sum(coalesce(f.sessions, 0)) filter (where f.start_date between p_start and p_end)
      end::numeric as buy_box_pct,
      sum(f.sessions) filter (where f.start_date between p_prior_start and p_prior_end)::bigint as prev_sessions,
      sum(f.units_ordered) filter (where f.start_date between p_prior_start and p_prior_end)::numeric as prev_units,
      sum(coalesce(f.ordered_product_sales_amount, 0) * coalesce(public.reporting_fx_rate(case when f.marketplace = 'CA' then 'CAD' else 'USD' end, f.start_date), 1)) filter (where f.start_date between p_prior_start and p_prior_end)::numeric as prev_revenue
    from public.fct_sales_daily f
    where f.sku is not null and f.marketplace = any(p_markets)
      and (p_skus is null or f.sku = any(p_skus))
      and (f.start_date between p_start and p_end or f.start_date between p_prior_start and p_prior_end)
    group by f.sku
  )
  select t.sku, coalesce(t.title, t.sku), coalesce(t.sessions, 0), coalesce(t.page_views, 0),
    coalesce(t.units, 0), coalesce(t.revenue, 0),
    case when coalesce(t.conv_den, 0) > 0 then (t.conv_num / t.conv_den) * 100 else 0 end,
    t.buy_box_pct, coalesce(t.prev_sessions, 0), coalesce(t.prev_units, 0), coalesce(t.prev_revenue, 0)
  from totals t
  where coalesce(t.sessions, 0) <> 0 or coalesce(t.units, 0) <> 0 or coalesce(t.revenue, 0) <> 0;
$function$;

create or replace function public.get_sku_sales_series(
  p_start date, p_end date, p_markets text[], p_sku text
)
returns table (d date, sessions bigint, page_views bigint, units numeric, revenue numeric, conv_rate numeric, buy_box_pct numeric)
language sql stable security invoker set search_path = ''
as $function$
  select f.start_date, sum(f.sessions)::bigint, sum(f.page_views)::bigint, sum(f.units_ordered)::numeric,
    sum(coalesce(f.ordered_product_sales_amount, 0) * coalesce(public.reporting_fx_rate(case when f.marketplace = 'CA' then 'CAD' else 'USD' end, f.start_date), 1))::numeric,
    case when sum(f.sessions) filter (where f.sessions > 0) > 0
      then (sum(f.units_ordered) filter (where f.sessions > 0) / sum(f.sessions) filter (where f.sessions > 0)) * 100 else 0 end,
    case when sum(coalesce(f.sessions, 0)) > 0 then sum(coalesce(f.buy_box_percentage, 0) * coalesce(f.sessions, 0)) / sum(coalesce(f.sessions, 0)) end::numeric
  from public.fct_sales_daily f
  where f.sku = p_sku and f.marketplace = any(p_markets) and f.start_date between p_start and p_end
  group by f.start_date order by f.start_date;
$function$;

create or replace function public.get_sku_sales_cadence(
  p_start date, p_end date, p_markets text[], p_skus text[] default null
)
returns table (sku text, d date, units numeric, revenue numeric)
language sql stable security invoker set search_path = ''
as $function$
  select f.sku, f.start_date, sum(f.units_ordered)::numeric,
    sum(coalesce(f.ordered_product_sales_amount, 0) * coalesce(public.reporting_fx_rate(case when f.marketplace = 'CA' then 'CAD' else 'USD' end, f.start_date), 1))::numeric
  from public.fct_sales_daily f
  where f.sku is not null and f.marketplace = any(p_markets)
    and (p_skus is null or f.sku = any(p_skus)) and f.start_date between p_start and p_end
  group by f.sku, f.start_date order by f.sku, f.start_date;
$function$;
