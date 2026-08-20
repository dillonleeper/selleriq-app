-- Baseline: routines that were live in the database but had no definition in this repo.
--
-- Authored 2026-08-13, re-captured and applied 2026-08-20. Renamed from
-- 20260813_baseline_live_routines.sql on application, for the same reason given in
-- 20260820121000_native_finance_daily_series.sql: an 8-digit prefix is not a valid
-- Supabase CLI version and 20260813 sorts behind the ledger head.
--
-- Captured from the live database with pg_get_functiondef (see scripts/dump-live-routines.sql).
-- The two function bodies below are that output VERBATIM -- not reconstructed, not tidied.
-- Do not "improve" them here. This file exists so the repo stops drifting from the
-- database, which means it has to record what is actually running, warts included:
--
--   * get_finance_pnl is SECURITY DEFINER with `set search_path to ''`, and references
--     int_fee_type_standardization / fct_finance_pnl_daily / agg_finance_pnl_counts_daily
--     schema-qualified (which the empty search_path requires). It also carries
--     `SET work_mem TO '64MB'`.
--
--     RE-CAPTURED 2026-08-20. The original version of this file recorded the function as
--     SECURITY INVOKER with no search_path and unqualified references, which was accurate
--     when it was written on 08-13 but went stale the same week:
--
--       - the function was hardened to SECURITY DEFINER + search_path='' afterwards, and
--       - 20260813_lock_down_finance_tables.sql (commit 3d7ebbf) revoked anon and
--         authenticated from the underlying finance tables.
--
--     Those two together mean SECURITY DEFINER is now load-bearing: it is the only reason
--     the browser's anon client can still read the P&L at all. Applying the 08-13 capture
--     would have flipped the function back to SECURITY INVOKER, and every anon call would
--     have failed with `permission denied for table fct_finance_pnl_daily` — silently
--     reverting the lockdown's companion fix and breaking the Profitability page.
--
--     The lesson this file exists to teach applies to the file itself: a "verbatim
--     capture" is only true as of its capture date. Re-dump before applying it if any
--     time has passed. scripts/dump-live-routines.sql is the tool.
--
--     One gotcha when you do re-dump and compare: the body stored in the database has
--     CRLF line endings, because it was created from a CRLF-checked-out file and
--     core.autocrlf is on for these repos. A naive diff against a fresh LF dump reports
--     every single line as changed. Compare with line endings normalized
--     (`diff --strip-trailing-cr`) before concluding anything has drifted. The 08-20
--     re-capture below is byte-identical to the live definition once normalized.
--   * get_native_sku_economics wraps get_native_sku_profitability, which is defined in
--     20260807_native_profitability.sql. This file must therefore be applied after it.
--
-- The GRANT/REVOKE statements at the end are the one part NOT taken verbatim: query 3 of
-- scripts/dump-live-routines.sql (the proacl dump) was not captured. They are inferred
-- from the fact that the browser's anon client calls both functions successfully, and
-- they follow the pattern every other function in supabase/migrations/ uses. Note that
-- CREATE OR REPLACE FUNCTION does not reset privileges on a function that already exists,
-- so on the live database these lines are effectively a no-op; they matter only when
-- replaying this migration into a fresh environment. Verify them with query 3 when
-- convenient.

CREATE OR REPLACE FUNCTION public.get_finance_pnl(p_start date, p_end date, p_marketplace text DEFAULT NULL::text)
 RETURNS TABLE(pnl_category text, widget_line text, display_order integer, include_in_operating_sum boolean, is_expandable boolean, amount_usd numeric, event_count integer, deferred_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET work_mem TO '64MB'
AS $function$
    with cat as (
        select pnl_category,
               min(widget_line) as widget_line,
               min(display_order) as display_order,
               bool_or(include_in_operating_sum) as include_in_operating_sum,
               bool_or(is_expandable) as is_expandable
        from public.int_fee_type_standardization
        group by pnl_category
    ),
    amt as (
        select pnl_category, sum(amount_usd) as amount_usd
        from public.fct_finance_pnl_daily
        where sale_date between p_start and p_end
          and (p_marketplace is null or marketplace = p_marketplace)
        group by pnl_category
    ),
    cnt as (
        select pnl_category,
               sum(txn_count)::int as event_count,
               sum(deferred_count)::int as deferred_count
        from public.agg_finance_pnl_counts_daily
        where sale_date between p_start and p_end
          and (p_marketplace is null or marketplace = p_marketplace)
        group by pnl_category
    )
    select
        a.pnl_category,
        coalesce(c.widget_line, initcap(replace(a.pnl_category, '_', ' '))),
        coalesce(c.display_order, 99),
        coalesce(c.include_in_operating_sum, true),
        coalesce(c.is_expandable, false),
        round(a.amount_usd, 2),
        coalesce(n.event_count, 0)::int,
        coalesce(n.deferred_count, 0)::int
    from amt a
    left join cat c using (pnl_category)
    left join cnt n using (pnl_category)
    order by coalesce(c.display_order, 99);
$function$;

CREATE OR REPLACE FUNCTION public.get_native_sku_economics(p_start date, p_end date, p_markets text[] DEFAULT ARRAY['US'::text])
 RETURNS TABLE(sku text, asin text, title text, marketplace text, gross_sales numeric, promotions numeric, refunds numeric, amazon_fees numeric, shipping numeric, reimbursements numeric, net_proceeds_before_ads_ldp numeric, transaction_count bigint, last_transaction_date date, shipped_units numeric, refunded_units numeric, net_units_for_cogs numeric, ldp_cost numeric, proceeds_after_ldp_before_ads numeric, ldp_coverage_pct numeric, missing_ldp_units numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with base as (
    select * from public.get_native_sku_profitability(p_start, p_end, p_markets)
  ),
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
      and t.marketplace = any(p_markets)
      and t.transaction_type in ('Shipment', 'Refund')
      and nullif(btrim(coalesce(nullif(t.sku, ''), t.items #>> '{0,contexts,0,sku}')), '') is not null
    group by t.posted_date::date, t.marketplace,
      nullif(btrim(coalesce(nullif(t.sku, ''), t.items #>> '{0,contexts,0,sku}')), '')
  ),
  costed as (
    select
      u.*,
      l.ldp_per_unit,
      case when l.id is not null then greatest(u.shipped_units - u.refunded_units, 0) * l.ldp_per_unit else 0 end as ldp_cost,
      case when l.id is not null then u.shipped_units else 0 end as covered_shipped_units,
      case when l.id is null then u.shipped_units else 0 end as missing_ldp_units
    from unit_days u
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
  costs as (
    select
      marketplace, sku,
      sum(shipped_units) as shipped_units,
      sum(refunded_units) as refunded_units,
      sum(greatest(shipped_units - refunded_units, 0)) as net_units_for_cogs,
      round(sum(ldp_cost), 2) as ldp_cost,
      round(case when sum(shipped_units) > 0
        then 100 * sum(covered_shipped_units) / sum(shipped_units) else 100 end, 1) as coverage,
      sum(missing_ldp_units) as missing_ldp_units
    from costed group by marketplace, sku
  )
  select
    b.sku, b.asin, b.title, b.marketplace,
    b.gross_sales, b.promotions, b.refunds, b.amazon_fees,
    b.shipping, b.reimbursements, b.net_proceeds_before_ads_ldp,
    b.transaction_count, b.last_transaction_date,
    coalesce(c.shipped_units, 0), coalesce(c.refunded_units, 0),
    coalesce(c.net_units_for_cogs, 0), coalesce(c.ldp_cost, 0),
    round(b.net_proceeds_before_ads_ldp - coalesce(c.ldp_cost, 0), 2),
    coalesce(c.coverage, 100), coalesce(c.missing_ldp_units, 0)
  from base b
  left join costs c on c.marketplace = b.marketplace and c.sku = b.sku
  order by b.net_proceeds_before_ads_ldp desc, b.sku;
$function$;

-- Inferred, not captured. See the header note above.
revoke all on function public.get_finance_pnl(date, date, text) from public;
grant execute on function public.get_finance_pnl(date, date, text) to anon, authenticated;

revoke all on function public.get_native_sku_economics(date, date, text[]) from public;
grant execute on function public.get_native_sku_economics(date, date, text[]) to anon, authenticated;
