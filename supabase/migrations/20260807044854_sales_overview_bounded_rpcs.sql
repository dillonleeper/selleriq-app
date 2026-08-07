-- Small, independently planned Sales Overview reads. These are intentionally
-- parallelizable and keep each PostgREST request below the browser role's
-- statement timeout.

do $$
begin
  if coalesce((select environment from public.__seller_iq_environment limit 1), '') <> 'dev' then
    raise exception 'Refusing to run: target database is not marked dev.';
  end if;
end $$;

create or replace function public.get_sales_overview_meta(
  p_prior_start date, p_prior_end date, p_markets text[]
)
returns jsonb language sql stable security invoker set search_path = ''
as $function$
  with market_coverage as (
    select m.marketplace, min(f.start_date) as first_date, max(f.start_date) as data_through
    from unnest(p_markets) m(marketplace)
    left join public.fct_sales_daily f on f.marketplace = m.marketplace
    group by m.marketplace
  )
  select jsonb_build_object(
    'first_date', min(first_date),
    'data_through', min(data_through),
    'comparison_complete', coalesce(bool_and(first_date <= p_prior_start and data_through >= p_prior_end), false),
    'market_freshness', coalesce(jsonb_agg(to_jsonb(market_coverage) order by marketplace), '[]'::jsonb),
    'currency', 'USD', 'fx_method', 'effective_dated'
  ) from market_coverage;
$function$;

create or replace function public.get_sales_overview_summary(
  p_start date, p_end date, p_prior_start date, p_prior_end date,
  p_markets text[], p_skus text[] default null
)
returns table (buy_box_pct numeric, prior_buy_box_pct numeric, selling_skus integer)
language sql stable security invoker set search_path = ''
as $function$
  select
    case when sum(coalesce(f.sessions, 0)) filter (where f.start_date between p_start and p_end) > 0
      then sum(coalesce(f.buy_box_percentage, 0) * coalesce(f.sessions, 0)) filter (where f.start_date between p_start and p_end)
        / sum(coalesce(f.sessions, 0)) filter (where f.start_date between p_start and p_end)
    end::numeric,
    case when sum(coalesce(f.sessions, 0)) filter (where f.start_date between p_prior_start and p_prior_end) > 0
      then sum(coalesce(f.buy_box_percentage, 0) * coalesce(f.sessions, 0)) filter (where f.start_date between p_prior_start and p_prior_end)
        / sum(coalesce(f.sessions, 0)) filter (where f.start_date between p_prior_start and p_prior_end)
    end::numeric,
    count(distinct f.sku) filter (where f.start_date between p_start and p_end and coalesce(f.units_ordered, 0) > 0)::integer
  from public.fct_sales_daily f
  where f.marketplace = any(p_markets)
    and (p_skus is null or f.sku = any(p_skus))
    and (f.start_date between p_start and p_end or f.start_date between p_prior_start and p_prior_end);
$function$;

create or replace function public.get_sales_overview_market_drivers(
  p_start date, p_end date, p_prior_start date, p_prior_end date,
  p_markets text[], p_skus text[] default null
)
returns table (marketplace text, revenue numeric, prior_revenue numeric, units numeric, sessions numeric)
language sql stable security invoker set search_path = ''
as $function$
  select f.marketplace,
    sum(coalesce(f.ordered_product_sales_amount, 0) * coalesce(public.reporting_fx_rate(case when f.marketplace = 'CA' then 'CAD' else 'USD' end, f.start_date), 1)) filter (where f.start_date between p_start and p_end)::numeric,
    sum(coalesce(f.ordered_product_sales_amount, 0) * coalesce(public.reporting_fx_rate(case when f.marketplace = 'CA' then 'CAD' else 'USD' end, f.start_date), 1)) filter (where f.start_date between p_prior_start and p_prior_end)::numeric,
    sum(coalesce(f.units_ordered, 0)) filter (where f.start_date between p_start and p_end)::numeric,
    sum(coalesce(f.sessions, 0)) filter (where f.start_date between p_start and p_end)::numeric
  from public.fct_sales_daily f
  where f.marketplace = any(p_markets)
    and (p_skus is null or f.sku = any(p_skus))
    and (f.start_date between p_start and p_end or f.start_date between p_prior_start and p_prior_end)
  group by f.marketplace order by 2 desc nulls last;
$function$;

create or replace function public.get_sales_overview_inventory_actions(
  p_end date, p_markets text[], p_skus text[] default null
)
returns table (
  sku text, marketplace text, snapshot_date date,
  available_quantity integer, inbound_quantity integer,
  recent_units numeric, units_per_day numeric,
  available_days_of_cover numeric, days_of_cover numeric,
  estimated_monthly_revenue numeric
)
language sql stable security invoker set search_path = ''
as $function$
  with latest_inventory as (
    select distinct on (i.marketplace, i.sku)
      i.marketplace, i.sku, i.snapshot_date,
      coalesce(i.available_quantity, 0) as available_quantity,
      coalesce(i.total_inbound_quantity, 0) as inbound_quantity
    from public.fct_inventory_snapshot_daily i
    where i.marketplace = any(p_markets) and i.sku is not null
    order by i.marketplace, i.sku, i.snapshot_date desc
  ),
  latest_listing as (
    select distinct on (l.marketplace, l.sku) l.marketplace, l.sku, l.status
    from public.stg_amz_listings l
    where l.marketplace = any(p_markets) and l.sku is not null
    order by l.marketplace, l.sku, coalesce(l.updated_at, l.loaded_at) desc, l.id desc
  ),
  recent_velocity as (
    select f.marketplace, f.sku,
      sum(coalesce(f.units_ordered, 0))::numeric as recent_units,
      sum(coalesce(f.units_ordered, 0))::numeric / 30 as units_per_day,
      sum(coalesce(f.ordered_product_sales_amount, 0) * coalesce(public.reporting_fx_rate(case when f.marketplace = 'CA' then 'CAD' else 'USD' end, f.start_date), 1))::numeric / 30 as revenue_per_day
    from public.fct_sales_daily f
    where f.marketplace = any(p_markets) and f.sku is not null
      and f.start_date between p_end - 29 and p_end
    group by f.marketplace, f.sku
  )
  select i.sku, i.marketplace, i.snapshot_date, i.available_quantity, i.inbound_quantity,
    v.recent_units, v.units_per_day,
    i.available_quantity / v.units_per_day,
    (i.available_quantity + i.inbound_quantity) / v.units_per_day,
    v.revenue_per_day * 30
  from latest_inventory i
  join latest_listing l on l.marketplace = i.marketplace and l.sku = i.sku and lower(l.status) = 'active'
  join recent_velocity v on v.marketplace = i.marketplace and v.sku = i.sku
  where v.recent_units >= 2 and v.units_per_day > 0
    and i.sku !~* '^FBA.*[.]missing'
    and (i.available_quantity + i.inbound_quantity) / v.units_per_day < 28
  order by v.revenue_per_day * 30 desc
  limit 12;
$function$;

grant execute on function public.get_sales_overview_meta(date, date, text[]) to anon, authenticated;
grant execute on function public.get_sales_overview_summary(date, date, date, date, text[], text[]) to anon, authenticated;
grant execute on function public.get_sales_overview_market_drivers(date, date, date, date, text[], text[]) to anon, authenticated;
grant execute on function public.get_sales_overview_inventory_actions(date, text[], text[]) to anon, authenticated;
