-- Bounded companion RPC for metadata, diagnostics, marketplace mix, and
-- actionable inventory. Daily series and SKU drivers remain in their focused
-- RPCs so every browser request stays below the API statement timeout.

do $$
begin
  if coalesce((select environment from public.__seller_iq_environment limit 1), '') <> 'dev' then
    raise exception 'Refusing to run: target database is not marked dev.';
  end if;
end $$;

create or replace function public.get_sales_overview_context(
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
market_coverage as materialized (
  select m.marketplace, min(f.start_date) as first_date, max(f.start_date) as data_through
  from unnest(p_markets) m(marketplace)
  left join public.fct_sales_daily f on f.marketplace = m.marketplace
  group by m.marketplace
),
coverage as (
  select min(first_date) as first_date, min(data_through) as data_through,
    bool_and(first_date <= p_prior_start and data_through >= p_prior_end) as comparison_complete
  from market_coverage
),
filtered as materialized (
  select f.marketplace, f.sku, f.start_date, f.units_ordered, f.sessions, f.buy_box_percentage,
    coalesce(f.ordered_product_sales_amount, 0)
      * coalesce(public.reporting_fx_rate(case when f.marketplace = 'CA' then 'CAD' else 'USD' end, f.start_date), 1) as revenue
  from public.fct_sales_daily f
  where f.marketplace = any(p_markets)
    and (p_skus is null or f.sku = any(p_skus))
    and (f.start_date between p_start and p_end or f.start_date between p_prior_start and p_prior_end)
),
summary as (
  select
    case when sum(coalesce(sessions, 0)) filter (where start_date between p_start and p_end) > 0
      then sum(coalesce(buy_box_percentage, 0) * coalesce(sessions, 0)) filter (where start_date between p_start and p_end)
        / sum(coalesce(sessions, 0)) filter (where start_date between p_start and p_end)
    end::numeric as buy_box_pct,
    case when sum(coalesce(sessions, 0)) filter (where start_date between p_prior_start and p_prior_end) > 0
      then sum(coalesce(buy_box_percentage, 0) * coalesce(sessions, 0)) filter (where start_date between p_prior_start and p_prior_end)
        / sum(coalesce(sessions, 0)) filter (where start_date between p_prior_start and p_prior_end)
    end::numeric as prior_buy_box_pct,
    count(distinct sku) filter (where start_date between p_start and p_end and coalesce(units_ordered, 0) > 0)::integer as selling_skus
  from filtered
),
market_totals as (
  select marketplace,
    sum(revenue) filter (where start_date between p_start and p_end)::numeric as revenue,
    sum(revenue) filter (where start_date between p_prior_start and p_prior_end)::numeric as prior_revenue,
    sum(coalesce(units_ordered, 0)) filter (where start_date between p_start and p_end)::numeric as units,
    sum(coalesce(sessions, 0)) filter (where start_date between p_start and p_end)::numeric as sessions
  from filtered group by marketplace
),
latest_inventory as (
  select distinct on (i.marketplace, i.sku)
    i.marketplace, i.sku, i.snapshot_date,
    coalesce(i.available_quantity, 0) as available_quantity,
    coalesce(i.total_inbound_quantity, 0) as inbound_quantity
  from public.fct_inventory_snapshot_daily i
  where i.marketplace = any(p_markets) and i.sku is not null
    and (p_skus is null or i.sku = any(p_skus))
  order by i.marketplace, i.sku, i.snapshot_date desc
),
latest_listing as (
  select distinct on (l.marketplace, l.sku) l.marketplace, l.sku, l.status
  from public.stg_amz_listings l
  where l.marketplace = any(p_markets) and l.sku is not null
    and (p_skus is null or l.sku = any(p_skus))
  order by l.marketplace, l.sku, coalesce(l.updated_at, l.loaded_at) desc, l.id desc
),
recent_velocity as (
  select f.marketplace, f.sku,
    sum(coalesce(f.units_ordered, 0))::numeric as recent_units,
    sum(coalesce(f.units_ordered, 0))::numeric / 30 as units_per_day,
    sum(coalesce(f.ordered_product_sales_amount, 0)
      * coalesce(public.reporting_fx_rate(case when f.marketplace = 'CA' then 'CAD' else 'USD' end, f.start_date), 1))::numeric / 30 as revenue_per_day
  from public.fct_sales_daily f
  where f.marketplace = any(p_markets) and f.sku is not null
    and (p_skus is null or f.sku = any(p_skus))
    and f.start_date between p_end - 29 and p_end
  group by f.marketplace, f.sku
),
inventory_risks as (
  select i.sku, i.marketplace, i.snapshot_date, i.available_quantity, i.inbound_quantity,
    v.recent_units, v.units_per_day,
    i.available_quantity / v.units_per_day as available_days_of_cover,
    (i.available_quantity + i.inbound_quantity) / v.units_per_day as days_of_cover,
    v.revenue_per_day * 30 as estimated_monthly_revenue
  from latest_inventory i
  join latest_listing l on l.marketplace = i.marketplace and l.sku = i.sku and lower(l.status) = 'active'
  join recent_velocity v on v.marketplace = i.marketplace and v.sku = i.sku
  where v.recent_units >= 2 and v.units_per_day > 0
    and i.sku !~* '^FBA.*[.]missing'
    and (i.available_quantity + i.inbound_quantity) / v.units_per_day < 28
  order by v.revenue_per_day * 30 desc
  limit 12
)
select jsonb_build_object(
  'meta', jsonb_build_object(
    'first_date', c.first_date, 'data_through', c.data_through,
    'comparison_complete', coalesce(c.comparison_complete, false),
    'market_freshness', coalesce((select jsonb_agg(to_jsonb(mc) order by mc.marketplace) from market_coverage mc), '[]'::jsonb),
    'currency', 'USD', 'fx_method', 'effective_dated'
  ),
  'summary', coalesce((select to_jsonb(s) from summary s), '{}'::jsonb),
  'market_drivers', coalesce((select jsonb_agg(to_jsonb(m) order by coalesce(m.revenue, 0) desc) from market_totals m), '[]'::jsonb),
  'inventory_risks', coalesce((select jsonb_agg(to_jsonb(i) order by i.estimated_monthly_revenue desc) from inventory_risks i), '[]'::jsonb)
)
from coverage c;
$function$;

grant execute on function public.get_sales_overview_context(date, date, date, date, text[], text[]) to anon, authenticated;
