-- ─────────────────────────────────────────────────────────────────────────
-- get_sku_sales — server-side per-SKU aggregation for the Traffic & Products
-- pages. Replaces the old pattern of pulling raw fct_sales_daily rows into the
-- browser (one row per SKU × marketplace × day) and summing client-side, which
-- silently truncated at the client .limit() for long windows (YTD) and dropped
-- the most-recent days — making YTD totals come out smaller than MTD.
--
-- This function returns exactly ONE ROW PER SKU, so the browser never depends
-- on a daily-grain row ceiling. Each row carries:
--   • the summed current-period totals (sessions, page_views, units, revenue),
--   • session-weighted conversion + avg buy-box (same math the pages used),
--   • the prior-period totals for the page's delta columns, and
--   • a `series` JSON array of per-day buckets for the charts / cadence grid.
--
-- Revenue is converted to USD here (CA × 0.74) to match the toUSD() helper in
-- the pages, so the client no longer needs per-row currency conversion.
--
-- Performance: an earlier version wrapped the scan in a single materialized
-- `base` CTE referenced three times. On the YTD window (~the whole table) that
-- forced a wide temp materialization that was re-read three times, and the
-- series sort spilled to disk — pushing the call past the role statement_timeout
-- (anon 3s / authenticated 8s) and erroring with 57014. EXPLAIN confirmed the
-- predicate matches ~all rows, so no index helps (a seq scan is correct). The
-- fix is to drop the shared CTE and aggregate cur/prv/daily directly from the
-- table (each streams the cached scan into a small hash table, no wide temp),
-- and to raise work_mem for the function so the series sort stays in RAM.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.get_sku_sales(
  p_start       date,
  p_end         date,
  p_prior_start date,
  p_prior_end   date,
  p_markets     text[],
  p_skus        text[] default null
)
returns table (
  sku           text,
  title         text,
  sessions      bigint,
  page_views    bigint,
  units         numeric,
  revenue       numeric,
  conv_rate     numeric,
  buy_box_pct   numeric,
  prev_sessions bigint,
  prev_units    numeric,
  prev_revenue  numeric,
  series        jsonb
)
language sql
stable
as $$
  with cur as (
    -- Current-period totals, one row per SKU. conv_* and buy_box_pct replicate
    -- the page math exactly: units/sessions over days with traffic, and a plain
    -- average of the daily buy-box percentages (NULLs ignored, as AVG does).
    select
      f.sku,
      max(f.title) as title,
      sum(f.sessions)::bigint as sessions,
      sum(f.page_views)::bigint as page_views,
      sum(f.units_ordered)::numeric as units,
      sum(case when f.marketplace = 'CA'
               then f.ordered_product_sales_amount * 0.74
               else f.ordered_product_sales_amount end)::numeric as revenue,
      sum(f.units_ordered) filter (where f.sessions > 0)::numeric as conv_num,
      sum(f.sessions)      filter (where f.sessions > 0)::numeric as conv_den,
      avg(f.buy_box_percentage)::numeric as buy_box_pct
    from fct_sales_daily f
    where f.sku is not null
      and f.marketplace = any (p_markets)
      and (p_skus is null or f.sku = any (p_skus))
      and f.start_date between p_start and p_end
    group by f.sku
  ),
  prv as (
    -- Prior-period totals for the delta columns (vs-prior revenue, conv change).
    select
      f.sku,
      sum(f.sessions)::bigint as prev_sessions,
      sum(f.units_ordered)::numeric as prev_units,
      sum(case when f.marketplace = 'CA'
               then f.ordered_product_sales_amount * 0.74
               else f.ordered_product_sales_amount end)::numeric as prev_revenue
    from fct_sales_daily f
    where f.sku is not null
      and f.marketplace = any (p_markets)
      and (p_skus is null or f.sku = any (p_skus))
      and f.start_date between p_prior_start and p_prior_end
    group by f.sku
  ),
  daily as (
    -- Per-SKU, per-day buckets (collapsed across marketplaces) for the charts.
    select
      f.sku,
      f.start_date as d,
      sum(f.sessions)::bigint as sessions,
      sum(f.page_views)::bigint as page_views,
      sum(f.units_ordered)::numeric as units,
      sum(case when f.marketplace = 'CA'
               then f.ordered_product_sales_amount * 0.74
               else f.ordered_product_sales_amount end)::numeric as revenue,
      case when sum(f.sessions) filter (where f.sessions > 0) > 0
           then (sum(f.units_ordered) filter (where f.sessions > 0)
                 / sum(f.sessions) filter (where f.sessions > 0)) * 100
           else 0 end as conv_rate,
      avg(f.buy_box_percentage)::numeric as buy_box_pct
    from fct_sales_daily f
    where f.sku is not null
      and f.marketplace = any (p_markets)
      and (p_skus is null or f.sku = any (p_skus))
      and f.start_date between p_start and p_end
    group by f.sku, f.start_date
  ),
  ser as (
    select
      d.sku,
      jsonb_agg(
        jsonb_build_object(
          'd',           d.d,
          'sessions',    d.sessions,
          'page_views',  d.page_views,
          'units',       d.units,
          'revenue',     d.revenue,
          'conv_rate',   d.conv_rate,
          'buy_box_pct', d.buy_box_pct
        )
        order by d.d
      ) as series
    from daily d
    group by d.sku
  )
  select
    cur.sku,
    cur.title,
    cur.sessions,
    cur.page_views,
    cur.units,
    cur.revenue,
    case when cur.conv_den > 0 then (cur.conv_num / cur.conv_den) * 100 else 0 end as conv_rate,
    cur.buy_box_pct,
    coalesce(prv.prev_sessions, 0)            as prev_sessions,
    coalesce(prv.prev_units,    0)            as prev_units,
    coalesce(prv.prev_revenue,  0)            as prev_revenue,
    coalesce(ser.series, '[]'::jsonb)         as series
  from cur
  left join prv on prv.sku = cur.sku
  left join ser on ser.sku = cur.sku;
$$;

-- Keep the per-SKU daily series sort in RAM instead of spilling to disk on the
-- long (YTD) window. Applies only for the duration of this function's calls.
alter function public.get_sku_sales(date, date, date, date, text[], text[])
  set work_mem = '64MB';

-- The pages call this with the Supabase anon key, exactly as they queried the
-- table before. The function is not SECURITY DEFINER, so any RLS on
-- fct_sales_daily still applies to the caller.
grant execute on function public.get_sku_sales(date, date, date, date, text[], text[]) to anon, authenticated;
