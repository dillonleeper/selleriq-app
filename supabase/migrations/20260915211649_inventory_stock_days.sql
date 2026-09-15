-- Which days, per SKU + marketplace, a unit was actually fulfillable — the
-- one fact the replenishment rate calculation needs that isn't cheap to get
-- client-side (it requires scanning day-level inventory snapshots, not just
-- the latest one). Everything else — windowing, the in-stock-day median,
-- the low-confidence fallback — stays in the app, next to the equivalent
-- sales-side logic in get_inventory_sales_velocity.
--
-- Mirrors get_inventory_sales_velocity's shape (p_start + p_markets, grouped
-- per sku/marketplace) so the two can be fetched and joined the same way.

create or replace function public.get_inventory_stock_days(
  p_start date,
  p_markets text[]
)
returns table (
  sku text,
  marketplace text,
  stock_days jsonb
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    i.sku,
    i.marketplace,
    jsonb_agg(i.snapshot_date order by i.snapshot_date)
  from public.fct_inventory_snapshot_daily i
  where i.marketplace = any (p_markets)
    and i.snapshot_date >= p_start
    and i.sku is not null
    and coalesce(i.fulfillable_quantity, 0) > 0
  group by i.sku, i.marketplace;
$function$;

-- Supports the new range scan (marketplace + date, filtered by
-- fulfillable_quantity) without a full-table scan on every call.
create index if not exists idx_fct_inventory_snapshot_market_date
  on public.fct_inventory_snapshot_daily (marketplace, snapshot_date)
  include (sku, fulfillable_quantity);

revoke all on function public.get_inventory_stock_days(date, text[]) from public;
grant execute on function public.get_inventory_stock_days(date, text[]) to anon, authenticated, service_role;
