-- Inventory actions are account-wide. Removing optional SKU predicates keeps
-- the generic PostgREST plan fast and avoids hiding urgent replenishment work
-- when the analytical product filter is in use.

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

grant execute on function public.get_sales_overview_inventory_actions(date, text[], text[]) to anon, authenticated;
