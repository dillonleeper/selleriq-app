-- Fix daily conversion precision and expose a source-backed traffic/inventory timeline.
-- Daily inventory is attributed only when a snapshot exists on the same day or within the prior two days.

create or replace function public.get_sku_sales_series(
  p_start date, p_end date, p_markets text[], p_sku text
)
returns table(
  d date, sessions bigint, page_views bigint, units numeric, revenue numeric,
  conv_rate numeric, buy_box_pct numeric
)
language sql stable security invoker set search_path = ''
as $function$
  select
    f.start_date,
    sum(f.sessions)::bigint,
    sum(f.page_views)::bigint,
    sum(f.units_ordered)::numeric,
    sum(coalesce(f.ordered_product_sales_amount, 0)
      * coalesce(public.reporting_fx_rate(case when f.marketplace = 'CA' then 'CAD' else 'USD' end, f.start_date), 1))::numeric,
    case when sum(f.sessions) filter (where f.sessions > 0) > 0
      then (sum(f.units_ordered) filter (where f.sessions > 0)::numeric
        / nullif(sum(f.sessions) filter (where f.sessions > 0)::numeric, 0)) * 100
      else 0::numeric end,
    case when sum(coalesce(f.sessions, 0)) > 0
      then sum(coalesce(f.buy_box_percentage, 0) * coalesce(f.sessions, 0))::numeric
        / nullif(sum(coalesce(f.sessions, 0))::numeric, 0) end
  from public.fct_sales_daily f
  where f.sku = p_sku
    and f.marketplace = any(p_markets)
    and f.start_date between p_start and p_end
  group by f.start_date
  order by f.start_date;
$function$;

create or replace function public.get_sku_traffic_inventory_diagnostic(
  p_start date, p_end date, p_markets text[], p_sku text
)
returns table(
  d date, sessions bigint, page_views bigint, units numeric, revenue numeric,
  conv_rate numeric, buy_box_pct numeric, sales_market_count integer,
  selected_market_count integer, inventory_snapshot_date date,
  inventory_age_days integer, inventory_market_count integer,
  available_quantity bigint, fulfillable_quantity bigint,
  reserved_customerorders bigint, reserved_fc_transfers bigint,
  reserved_fc_processing bigint, inbound_quantity bigint
)
language sql stable security invoker set search_path = ''
as $function$
  with days as (
    select generate_series(p_start, p_end, interval '1 day')::date as d
  ),
  selected_markets as (
    select distinct unnest(p_markets) as marketplace
  ),
  sales as (
    select
      f.start_date as d,
      sum(f.sessions)::bigint as sessions,
      sum(f.page_views)::bigint as page_views,
      sum(f.units_ordered)::numeric as units,
      sum(coalesce(f.ordered_product_sales_amount, 0)
        * coalesce(public.reporting_fx_rate(case when f.marketplace = 'CA' then 'CAD' else 'USD' end, f.start_date), 1))::numeric as revenue,
      case when sum(f.sessions) filter (where f.sessions > 0) > 0
        then (sum(f.units_ordered) filter (where f.sessions > 0)::numeric
          / nullif(sum(f.sessions) filter (where f.sessions > 0)::numeric, 0)) * 100 end as conv_rate,
      case when sum(coalesce(f.sessions, 0)) > 0
        then sum(coalesce(f.buy_box_percentage, 0) * coalesce(f.sessions, 0))::numeric
          / nullif(sum(coalesce(f.sessions, 0))::numeric, 0) end as buy_box_pct,
      count(distinct f.marketplace)::integer as sales_market_count
    from public.fct_sales_daily f
    where f.sku = p_sku
      and f.marketplace = any(p_markets)
      and f.start_date between p_start and p_end
    group by f.start_date
  ),
  inventory_market_daily as (
    select
      day.d, market.marketplace, snapshot.snapshot_date,
      snapshot.available_quantity, snapshot.fulfillable_quantity,
      snapshot.reserved_customerorders, snapshot.reserved_fc_transfers,
      snapshot.reserved_fc_processing, snapshot.total_inbound_quantity
    from days day
    cross join selected_markets market
    left join lateral (
      select
        i.snapshot_date, i.available_quantity, i.fulfillable_quantity,
        i.reserved_customerorders, i.reserved_fc_transfers,
        i.reserved_fc_processing, i.total_inbound_quantity
      from public.fct_inventory_snapshot_daily i
      where i.sku = p_sku
        and i.marketplace = market.marketplace
        and i.snapshot_date <= day.d
        and i.snapshot_date >= day.d - 2
      order by i.snapshot_date desc
      limit 1
    ) snapshot on true
  ),
  inventory as (
    select
      i.d,
      max(i.snapshot_date) as inventory_snapshot_date,
      max(i.d - i.snapshot_date)::integer as inventory_age_days,
      count(i.snapshot_date)::integer as inventory_market_count,
      sum(i.available_quantity)::bigint as available_quantity,
      sum(i.fulfillable_quantity)::bigint as fulfillable_quantity,
      sum(i.reserved_customerorders)::bigint as reserved_customerorders,
      sum(i.reserved_fc_transfers)::bigint as reserved_fc_transfers,
      sum(i.reserved_fc_processing)::bigint as reserved_fc_processing,
      sum(i.total_inbound_quantity)::bigint as inbound_quantity
    from inventory_market_daily i
    group by i.d
  )
  select
    day.d, sales.sessions, sales.page_views, sales.units, sales.revenue,
    sales.conv_rate, sales.buy_box_pct, coalesce(sales.sales_market_count, 0),
    (select count(*)::integer from selected_markets),
    inventory.inventory_snapshot_date, inventory.inventory_age_days,
    coalesce(inventory.inventory_market_count, 0), inventory.available_quantity,
    inventory.fulfillable_quantity, inventory.reserved_customerorders,
    inventory.reserved_fc_transfers, inventory.reserved_fc_processing,
    inventory.inbound_quantity
  from days day
  left join sales on sales.d = day.d
  left join inventory on inventory.d = day.d
  order by day.d;
$function$;

grant execute on function public.get_sku_sales_series(date,date,text[],text)
  to anon, authenticated, service_role;
grant execute on function public.get_sku_traffic_inventory_diagnostic(date,date,text[],text)
  to anon, authenticated, service_role;
