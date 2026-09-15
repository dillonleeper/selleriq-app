-- One bounded read supplies the recommendation engine with daily, time-aligned evidence.
-- Results are grouped into one JSON array per SKU to stay below PostgREST row limits.

create or replace function public.get_recommendation_diagnostic_series(
  p_start date, p_end date, p_markets text[], p_skus text[]
)
returns table(sku text, points jsonb)
language sql stable security invoker set search_path = ''
as $function$
  with requested_skus as (
    select distinct requested.sku
    from unnest(p_skus[1:50]) requested(sku)
    where requested.sku is not null and requested.sku <> ''
  ),
  days as (
    select generate_series(p_start, p_end, interval '1 day')::date as d
  ),
  selected_markets as (
    select distinct unnest(p_markets) as marketplace
  ),
  sales as (
    select
      f.sku, f.start_date as d,
      sum(f.sessions)::bigint as sessions,
      sum(f.units_ordered)::numeric as units,
      sum(coalesce(f.ordered_product_sales_amount, 0)
        * coalesce(public.reporting_fx_rate(case when f.marketplace = 'CA' then 'CAD' else 'USD' end, f.start_date), 1))::numeric as revenue,
      case when sum(f.sessions) filter (where f.sessions > 0) > 0
        then sum(f.units_ordered) filter (where f.sessions > 0)::numeric
          / nullif(sum(f.sessions) filter (where f.sessions > 0)::numeric, 0) * 100 end as conv_rate,
      case when sum(coalesce(f.sessions, 0)) > 0
        then sum(coalesce(f.buy_box_percentage, 0) * coalesce(f.sessions, 0))::numeric
          / nullif(sum(coalesce(f.sessions, 0))::numeric, 0) end as buy_box_pct,
      count(distinct f.marketplace)::integer as sales_market_count
    from public.fct_sales_daily f
    join requested_skus requested on requested.sku = f.sku
    where f.marketplace = any(p_markets) and f.start_date between p_start and p_end
    group by f.sku, f.start_date
  ),
  inventory_market_daily as (
    select requested.sku, day.d, market.marketplace, snapshot.snapshot_date, snapshot.available_quantity
    from requested_skus requested cross join days day cross join selected_markets market
    left join lateral (
      select i.snapshot_date, i.available_quantity
      from public.fct_inventory_snapshot_daily i
      where i.sku = requested.sku and i.marketplace = market.marketplace
        and i.snapshot_date between day.d - 2 and day.d
      order by i.snapshot_date desc limit 1
    ) snapshot on true
  ),
  inventory as (
    select sku, d, count(snapshot_date)::integer as inventory_market_count,
      sum(available_quantity)::bigint as available_quantity
    from inventory_market_daily group by sku, d
  ),
  grid as (
    select
      requested.sku, day.d, sales.sessions, sales.units, sales.revenue,
      sales.conv_rate, sales.buy_box_pct, coalesce(sales.sales_market_count, 0) as sales_market_count,
      (select count(*)::integer from selected_markets) as selected_market_count,
      coalesce(inventory.inventory_market_count, 0) as inventory_market_count,
      inventory.available_quantity
    from requested_skus requested cross join days day
    left join sales on sales.sku = requested.sku and sales.d = day.d
    left join inventory on inventory.sku = requested.sku and inventory.d = day.d
  )
  select grid.sku, jsonb_agg(jsonb_build_object(
    'd', grid.d, 'sessions', grid.sessions, 'units', grid.units, 'revenue', grid.revenue,
    'conv_rate', grid.conv_rate, 'buy_box_pct', grid.buy_box_pct,
    'sales_market_count', grid.sales_market_count, 'selected_market_count', grid.selected_market_count,
    'inventory_market_count', grid.inventory_market_count, 'available_quantity', grid.available_quantity
  ) order by grid.d) as points
  from grid group by grid.sku order by grid.sku;
$function$;

revoke all on function public.get_recommendation_diagnostic_series(date,date,text[],text[]) from public;
grant execute on function public.get_recommendation_diagnostic_series(date,date,text[],text[]) to anon, authenticated, service_role;

