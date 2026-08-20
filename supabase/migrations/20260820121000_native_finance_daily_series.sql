-- Daily finance series for the Profitability page trend charts.
--
-- Apply after 20260820120500_baseline_live_routines.sql.
--
-- Authored 2026-08-13, applied 2026-08-20. Renamed from
-- 20260813_native_finance_daily_series.sql on application: an 8-digit prefix is not a
-- valid Supabase CLI migration version, so it could not be recorded in
-- supabase_migrations.schema_migrations, and 20260813 sorts behind the ledger head
-- (20260818160241) which makes db push treat it as out-of-order and db reset replay it
-- before migrations that already shipped.
--
-- The money side is the same aggregation get_native_profitability_coverage performs, with
-- the sale_date grain kept. The COGS side is lifted from get_native_sku_economics (now
-- recorded in the baseline migration) so the trend and the Tier 1 cards agree: same table,
-- same date expression, same transaction_type filter, same LDP lateral join, same
-- greatest(shipped - refunded, 0) at the daily grain.
--
-- TWO GRAINS ARE RETURNED ON PURPOSE, because the page mixes them:
--   * gross_sales .. net_proceeds come from fct_finance_pnl_daily (ACCOUNT level) and tie
--     to the Gross revenue card, which reads coverage account_amount.
--   * net_proceeds_sku_allocated comes from fct_sku_finance_daily (SKU allocated), which is
--     what get_native_sku_profitability -- and therefore get_native_sku_economics -- sums.
--     proceeds_after_cogs is built from it, so it ties to the Proceeds after COGS card.
-- They differ by whatever Amazon did not attach to a SKU: the "Account-level" column in
-- the reconciliation panel. Plot revenue from the account columns and after-COGS from the
-- SKU-allocated one, or the trend will not match the cards above it.
--
-- ONE INHERITED QUIRK, WORTH KNOWING BEFORE READING A DAILY VALUE. The money and the units
-- are dated off different columns, and this function reproduces that rather than silently
-- correcting it:
--   * money  -> fct_*_daily.sale_date, derived from int_finance_pnl_components.sale_date
--   * units  -> stg_amz_finance_transactions.posted_date::date
-- get_native_sku_economics already combines these two bases, so period totals reconcile
-- exactly. Within the period, though, a given day's COGS can be attributed to a different
-- date than that day's proceeds. Read the trend as a shape, not as a daily ledger.
--
-- advertising_cost is returned for forward compatibility and stays 0 until Amazon Ads is
-- connected. Do not label anything derived from this series as net or contribution profit
-- while that column is empty.

create or replace function public.get_native_finance_daily_series(
  p_start date,
  p_end date,
  p_markets text[] default array['US']::text[]
)
returns table (
  sale_date date,
  gross_sales numeric,
  promotions numeric,
  refunds numeric,
  amazon_fees numeric,
  shipping numeric,
  reimbursements numeric,
  net_proceeds numeric,
  net_proceeds_sku_allocated numeric,
  shipped_units numeric,
  refunded_units numeric,
  net_units_for_cogs numeric,
  recognized_cogs numeric,
  proceeds_after_cogs numeric,
  ldp_coverage_pct numeric,
  -- Shipped units excluded from the columns above because the SKU has no row in
  -- base_keys. get_native_sku_economics drops these silently via its final left join;
  -- this surfaces them instead. Normally 0. If it is not, the SKU has shipment
  -- transactions but is missing from dim_product AND from fct_sku_finance_daily, which
  -- is an upstream data problem worth chasing rather than a reporting one.
  unmatched_shipped_units numeric,
  advertising_cost numeric,
  -- Ledger components, NOT transactions. One Amazon transaction contributes a row per
  -- pnl_category, so this is deliberately not called transaction_count: summing
  -- event_count across categories would overcount transactions several times over.
  -- get_finance_pnl gets an exact count only by grouping per category first.
  ledger_event_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with ledger as (
    select
      f.sale_date,
      coalesce(round(sum(f.amount_usd) filter (where f.pnl_category = 'gross_sales'), 2), 0) as gross_sales,
      coalesce(round(sum(f.amount_usd) filter (where f.pnl_category = 'promotions'), 2), 0) as promotions,
      coalesce(round(sum(f.amount_usd) filter (where f.pnl_category = 'refunds'), 2), 0) as refunds,
      coalesce(round(sum(f.amount_usd) filter (where f.pnl_category = 'amazon_fees'), 2), 0) as amazon_fees,
      coalesce(round(sum(f.amount_usd) filter (where f.pnl_category = 'shipping'), 2), 0) as shipping,
      coalesce(round(sum(f.amount_usd) filter (where f.pnl_category = 'reimbursements'), 2), 0) as reimbursements,
      -- Same six signed components, in the same order, as the page's INCLUDED_CATEGORIES.
      coalesce(round(sum(f.amount_usd) filter (
        where f.pnl_category in (
          'gross_sales', 'promotions', 'refunds',
          'amazon_fees', 'shipping', 'reimbursements'
        )
      ), 2), 0) as net_proceeds,
      coalesce(round(sum(f.amount_usd) filter (where f.pnl_category = 'advertising_cost'), 2), 0) as advertising_cost,
      coalesce(sum(f.event_count), 0)::bigint as ledger_event_count
    from public.fct_finance_pnl_daily f
    where f.sale_date between p_start and p_end
      and f.marketplace = any (p_markets)
    group by f.sale_date
  ),
  sku_ledger as (
    select
      d.sale_date,
      round(sum(
        d.gross_sales + d.promotions + d.refunds + d.amazon_fees
        + d.shipping + d.reimbursements
      ), 2) as net_proceeds_sku_allocated
    from public.fct_sku_finance_daily d
    where d.sale_date between p_start and p_end
      and d.marketplace = any (p_markets)
    group by d.sale_date
  ),
  -- Lifted from get_native_sku_economics. Reads the staging table directly: no join to
  -- int_finance_pnl_components, so there is no per-category fan-out to collapse. The
  -- ::numeric cast is only guarded by nullif, exactly as the live function guards it -- a
  -- non-numeric quantityShipped would abort both, which is the intended shared behavior.
  unit_days as (
    select
      t.posted_date::date as sale_date,
      t.marketplace,
      nullif(btrim(coalesce(nullif(t.sku, ''), t.items #>> '{0,contexts,0,sku}')), '') as sku,
      sum(case when t.transaction_type = 'Shipment'
        then coalesce(nullif(t.items #>> '{0,contexts,0,quantityShipped}', '')::numeric, 0) else 0 end) as shipped_units,
      sum(case when t.transaction_type = 'Refund'
        then coalesce(nullif(t.items #>> '{0,contexts,0,quantityShipped}', '')::numeric, 0) else 0 end) as refunded_units
    from public.stg_amz_finance_transactions t
    where t.posted_date >= p_start::timestamptz
      and t.posted_date < (p_end + 1)::timestamptz
      and t.marketplace = any (p_markets)
      and t.transaction_type in ('Shipment', 'Refund')
      and nullif(btrim(coalesce(nullif(t.sku, ''), t.items #>> '{0,contexts,0,sku}')), '') is not null
    group by t.posted_date::date, t.marketplace,
      nullif(btrim(coalesce(nullif(t.sku, ''), t.items #>> '{0,contexts,0,sku}')), '')
  ),
  -- The SKU universe get_native_sku_economics reports on. It builds its rows from
  -- get_native_sku_profitability (dim_product UNION fct_sku_finance_daily) and then LEFT
  -- JOINs unit costs onto them, so a SKU with shipments but no row on either side is
  -- dropped from its output entirely. The units side here is restricted to the same
  -- universe, otherwise this series would count units -- and eventually COGS -- that the
  -- Tier 1 cards do not, and the two would stop reconciling.
  base_keys as (
    select distinct btrim(p.sku) as sku, p.marketplace
    from public.dim_product p
    where p.marketplace = any (p_markets)
      and nullif(btrim(p.sku), '') is not null
    union
    select distinct d.sku, d.marketplace
    from public.fct_sku_finance_daily d
    where d.sale_date between p_start and p_end
      and d.marketplace = any (p_markets)
  ),
  matched as (
    select u.*
    from unit_days u
    join base_keys k on k.marketplace = u.marketplace and k.sku = u.sku
  ),
  unmatched as (
    select u.sale_date, sum(u.shipped_units) as unmatched_shipped_units
    from unit_days u
    left join base_keys k on k.marketplace = u.marketplace and k.sku = u.sku
    where k.sku is null
    group by u.sale_date
  ),
  -- LDP as of the day, USD rows only. The currency_code = 'USD' filter (rather than an FX
  -- conversion) is what get_native_sku_economics does; app/api/ldp/route.ts only ever
  -- writes USD, so a non-USD row would be skipped by both and show as uncovered.
  costed as (
    select
      u.sale_date,
      u.shipped_units,
      u.refunded_units,
      greatest(u.shipped_units - u.refunded_units, 0) as net_units,
      case when l.id is not null
        then greatest(u.shipped_units - u.refunded_units, 0) * l.ldp_per_unit
        else 0 end as ldp_cost,
      case when l.id is not null then u.shipped_units else 0 end as covered_shipped_units
    from matched u
    left join lateral (
      select h.id, h.ldp_per_unit
      from public.sku_ldp_history h
      where h.marketplace = u.marketplace
        and h.sku = u.sku
        and h.currency_code = 'USD'
        and h.effective_from <= u.sale_date
        and (h.effective_to is null or h.effective_to >= u.sale_date)
      order by h.effective_from desc
      limit 1
    ) l on true
  ),
  cogs as (
    select
      x.sale_date,
      sum(x.shipped_units) as shipped_units,
      sum(x.refunded_units) as refunded_units,
      sum(x.net_units) as net_units_for_cogs,
      round(sum(x.ldp_cost), 2) as recognized_cogs,
      -- Coverage is against SHIPPED units, matching get_native_sku_economics.
      round(case when sum(x.shipped_units) > 0
        then 100 * sum(x.covered_shipped_units) / sum(x.shipped_units)
        else 100 end, 1) as ldp_coverage_pct
    from costed x
    group by x.sale_date
  ),
  -- A date can have ledger activity with no shipped units, or units with no ledger row.
  dates as (
    select sale_date from ledger
    union
    select sale_date from sku_ledger
    union
    select sale_date from cogs
    union
    select sale_date from unmatched
  )
  select
    d.sale_date,
    coalesce(l.gross_sales, 0),
    coalesce(l.promotions, 0),
    coalesce(l.refunds, 0),
    coalesce(l.amazon_fees, 0),
    coalesce(l.shipping, 0),
    coalesce(l.reimbursements, 0),
    coalesce(l.net_proceeds, 0),
    coalesce(s.net_proceeds_sku_allocated, 0),
    coalesce(c.shipped_units, 0),
    coalesce(c.refunded_units, 0),
    coalesce(c.net_units_for_cogs, 0),
    coalesce(c.recognized_cogs, 0),
    round(coalesce(s.net_proceeds_sku_allocated, 0) - coalesce(c.recognized_cogs, 0), 2),
    coalesce(c.ldp_coverage_pct, 100),
    coalesce(m.unmatched_shipped_units, 0),
    coalesce(l.advertising_cost, 0),
    coalesce(l.ledger_event_count, 0)::bigint
  from dates d
  left join ledger l on l.sale_date = d.sale_date
  left join sku_ledger s on s.sale_date = d.sale_date
  left join cogs c on c.sale_date = d.sale_date
  left join unmatched m on m.sale_date = d.sale_date
  order by d.sale_date;
$$;

revoke all on function public.get_native_finance_daily_series(date, date, text[]) from public;
grant execute on function public.get_native_finance_daily_series(date, date, text[]) to anon, authenticated;

-- Reconciliation check. Run after applying. The bounds CTE reproduces the page's
-- last_90d preset (components/dateRange.ts lastNDays: current_date - 90 through
-- yesterday), so this always matches what the page is showing.
--
-- The first six diffs must be EXACTLY 0. Ledger components are stored pre-rounded to 2
-- decimals and unit sums are never rounded, so regrouping by day instead of by SKU cannot
-- change those totals.
--
-- The last two are allowed to differ by cents. ldp_per_unit is numeric(18,6), so each
-- day's net_units * ldp_per_unit carries sub-cent precision; get_native_sku_economics
-- rounds per (marketplace, sku) while this function rounds per sale_date, and summing
-- differently-rounded intermediates is not associative. Cents mean rounding. A wrong
-- shipped/refunded classification or a wrong LDP lookup would show up at percentage
-- scale, not cents -- and net_units_diff above would be non-zero too.
--
-- with bounds as (
--   select (current_date - 90) as p_start, (current_date - 1) as p_end, array['US'] as p_markets
-- ),
-- series as (
--   select s.* from bounds b,
--     lateral public.get_native_finance_daily_series(b.p_start, b.p_end, b.p_markets) s
-- ),
-- economics as (
--   select e.* from bounds b,
--     lateral public.get_native_sku_economics(b.p_start, b.p_end, b.p_markets) e
-- ),
-- coverage as (
--   select c.* from bounds b,
--     lateral public.get_native_profitability_coverage(b.p_start, b.p_end, b.p_markets) c
-- )
-- select
--   round((select sum(gross_sales) from series)
--         - (select account_amount from coverage where pnl_category = 'gross_sales'), 2) as gross_diff,
--   round((select sum(net_proceeds) from series)
--         - (select sum(account_amount) from coverage where pnl_category in (
--             'gross_sales', 'promotions', 'refunds',
--             'amazon_fees', 'shipping', 'reimbursements')), 2) as account_net_diff,
--   round((select sum(net_proceeds_sku_allocated) from series)
--         - (select sum(net_proceeds_before_ads_ldp) from economics), 2) as sku_net_diff,
--   (select sum(shipped_units) from series)
--     - (select sum(shipped_units) from economics) as shipped_units_diff,
--   (select sum(refunded_units) from series)
--     - (select sum(refunded_units) from economics) as refunded_units_diff,
--   (select sum(net_units_for_cogs) from series)
--     - (select sum(net_units_for_cogs) from economics) as net_units_diff,
--   round((select sum(recognized_cogs) from series)
--         - (select sum(ldp_cost) from economics), 2) as cogs_diff_cents_ok,
--   round((select sum(proceeds_after_cogs) from series)
--         - (select sum(proceeds_after_ldp_before_ads) from economics), 2) as after_cogs_diff_cents_ok;
