-- Sales Overview: stop withholding the current period when no comparison is possible
--
-- Symptom (live, 2026-08-20). On the deployed site the Year to date, Last quarter,
-- Last 12 months and Last 365 days presets reported nearly every day in range as an
-- "incomplete day" and rendered an empty view. The short presets were clean.
--
-- Reproduced against dev by rebuilding each preset's RPC arguments exactly as
-- app/page.tsx builds them (components/dateRange.ts computeRange, then comparisonWindow
-- for comparisonMode='previous_period', p_end clamped to data_through):
--
--   preset         current window          prior window            req  before  after
--   mtd            2026-08-01..08-18       2026-07-14..07-31        18      18     18
--   qtd            2026-07-01..08-18       2026-05-13..06-30        49      49     49
--   last_90d       2026-05-22..08-18       2026-02-22..05-21        89      89     89
--   last_quarter   2026-04-01..06-30       2025-12-31..2026-03-31   91      90     91
--   ytd            2026-01-01..08-18       2025-05-16..2025-12-31  230       0    230
--   last_12m       2025-08-01..2026-07-31  2024-08-01..2025-07-31  365       0    212
--   last_365d      2025-08-20..2026-08-18  2024-08-21..2025-08-19  364       0    230
--
-- (last_12m and last_365d do not reach their full request because their CURRENT windows
-- start before first_date = 2026-01-01. Those days have no data to show and are now
-- reported honestly by the frontend instead of being blamed on marketplace loading.)
--
-- Cause. paired_dates INNER JOINed the current and prior day series on ordinality and
-- kept a pair only when BOTH days were in available_dates. complete_dates was built from
-- paired_dates, and every later join filtered on it -- so a prior window outside the data
-- did not merely disable the comparison, it deleted the current period too. YTD is the
-- clean proof: its current window is entirely covered by data, yet the function returned
-- zero rows. last_quarter was the same fault one day wide, its prior window starting
-- 2025-12-31, one day before first_date.
--
-- Fix. Separate two causes that were being treated identically:
--
--   partner exists                     -> compare. Unchanged.
--   partner is inside the data era but
--     absent                           -> drop the day. Unchanged. This is the partial
--                                         marketplace ingestion that
--                                         20260810_sales_overview_paired_complete_dates
--                                         was written to guard against ("Pair current and
--                                         prior dates so partial marketplace ingestion
--                                         cannot bias comparisons").
--   no partner could exist -- it
--     predates the warehouse, or the
--     prior series is shorter than the
--     current one                      -> keep the day, prev_date null. The history does
--                                         not reach back that far. That is not an
--                                         ingestion fault, and withholding real current
--                                         data over it is strictly worse than showing it
--                                         without a comparison.
--
-- Verified in a rolled-back transaction: the three short presets are byte-identical
-- before and after, and last_90d current-period revenue and units are unchanged
-- (1687153.59 / 60637), which is the check that the rewritten complete_dates does not
-- duplicate rows through its union.
--
-- KNOWN ASYMMETRY, accepted deliberately. last_quarter now returns 91 current days
-- against 90 prior days, because 2026-04-01's partner (2025-12-31) predates the
-- warehouse. Period-over-period totals for that preset therefore compare 91 days to 90.
-- The alternative is the old behaviour, which hid a real day of sales to keep the two
-- sides symmetric. Showing the data and accepting a 1-in-91 asymmetry is the better
-- trade, but it is a trade -- if exact symmetry matters more for a given preset, clamp
-- the requested prior window in comparisonWindow() instead.
--
-- Bodies below are pg_get_functiondef output from the live database with ONLY the
-- paired_dates/complete_dates block rewritten. Every other line is verbatim, so the
-- aggregation, FX handling and SKU filtering cannot have drifted in transcription.

do $$
begin
  if coalesce((select environment from public.__seller_iq_environment limit 1), '') <> 'dev' then
    raise exception 'Refusing to run: target database is not marked dev.';
  end if;
end $$;

-- get_sales_overview
CREATE OR REPLACE FUNCTION public.get_sales_overview(p_start date, p_end date, p_prior_start date, p_prior_end date, p_markets text[], p_skus text[] DEFAULT NULL::text[])
 RETURNS TABLE(period text, start_date date, revenue numeric, units bigint, sessions bigint, page_views bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with available_dates as materialized (
    select f.start_date from public.fct_sales_daily f
    where f.marketplace=any(p_markets)
      and (f.start_date between p_start and p_end or f.start_date between p_prior_start and p_prior_end)
    group by f.start_date having count(distinct f.marketplace)=cardinality(p_markets)
  ), history_start as materialized (
    select min(f.start_date) first_date from public.fct_sales_daily f
     where f.marketplace=any(p_markets)
  ), paired_dates as materialized (
    -- A current day keeps its place unless its prior partner is missing for a reason that
    -- could bias the comparison. Two different situations were previously treated
    -- identically, and conflating them is what blanked the long presets:
    --
    --   partner exists                -> compare (unchanged)
    --   partner is inside the data
    --     era but absent              -> DROP the day. This is the partial marketplace
    --                                    ingestion this pairing exists to guard against.
    --                                    Unchanged behaviour.
    --   no partner could exist: it
    --     predates the warehouse, or
    --     the prior series is shorter
    --     than the current one        -> KEEP the day, prev_date null. The history simply
    --                                    does not reach back that far. That is not an
    --                                    ingestion fault and is no reason to withhold the
    --                                    current period, which is what used to happen:
    --                                    YTD returned zero rows despite its current
    --                                    window being fully loaded.
    select c.dt::date curr_date,
           case when p.dt::date in(select start_date from available_dates)
                then p.dt::date end prev_date
    from generate_series(p_start,p_end,interval '1 day') with ordinality c(dt,ord)
    left join generate_series(p_prior_start,p_prior_end,interval '1 day') with ordinality p(dt,ord) using(ord)
    where c.dt::date in(select start_date from available_dates)
      and (p.dt::date in(select start_date from available_dates)
        or p.dt is null
        or p.dt::date < (select first_date from history_start))
  ), complete_dates as materialized (
    select curr_date start_date from paired_dates
    union all select prev_date from paired_dates where prev_date is not null
  ), fx as materialized (
    select d.marketplace,d.start_date,
      case when d.marketplace='CA' then coalesce(public.reporting_fx_rate('CAD',d.start_date),1) else 1 end rate
    from (
      select distinct f.marketplace,f.start_date from public.fct_sales_daily f
      join complete_dates c using(start_date) where f.marketplace=any(p_markets)
    ) d
  )
  select case when f.start_date between p_start and p_end then 'current' else 'prior' end,
    f.start_date,sum(coalesce(f.ordered_product_sales_amount,0)*fx.rate)::numeric,
    sum(coalesce(f.units_ordered,0))::bigint,sum(coalesce(f.sessions,0))::bigint,sum(coalesce(f.page_views,0))::bigint
  from public.fct_sales_daily f join complete_dates c using(start_date) join fx using(marketplace,start_date)
  where f.marketplace=any(p_markets) and (p_skus is null or f.sku=any(p_skus))
    and (f.start_date between p_start and p_end or f.start_date between p_prior_start and p_prior_end)
  group by 1,f.start_date order by 1,f.start_date;
$function$;

-- get_sales_overview_summary
CREATE OR REPLACE FUNCTION public.get_sales_overview_summary(p_start date, p_end date, p_prior_start date, p_prior_end date, p_markets text[], p_skus text[] DEFAULT NULL::text[])
 RETURNS TABLE(buy_box_pct numeric, prior_buy_box_pct numeric, selling_skus integer)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with available_dates as materialized (
    select f.start_date from public.fct_sales_daily f where f.marketplace=any(p_markets)
      and (f.start_date between p_start and p_end or f.start_date between p_prior_start and p_prior_end)
    group by f.start_date having count(distinct f.marketplace)=cardinality(p_markets)
  ), history_start as materialized (
    select min(f.start_date) first_date from public.fct_sales_daily f
     where f.marketplace=any(p_markets)
  ), paired_dates as materialized (
    -- A current day keeps its place unless its prior partner is missing for a reason that
    -- could bias the comparison. Two different situations were previously treated
    -- identically, and conflating them is what blanked the long presets:
    --
    --   partner exists                -> compare (unchanged)
    --   partner is inside the data
    --     era but absent              -> DROP the day. This is the partial marketplace
    --                                    ingestion this pairing exists to guard against.
    --                                    Unchanged behaviour.
    --   no partner could exist: it
    --     predates the warehouse, or
    --     the prior series is shorter
    --     than the current one        -> KEEP the day, prev_date null. The history simply
    --                                    does not reach back that far. That is not an
    --                                    ingestion fault and is no reason to withhold the
    --                                    current period, which is what used to happen:
    --                                    YTD returned zero rows despite its current
    --                                    window being fully loaded.
    select c.dt::date curr_date,
           case when p.dt::date in(select start_date from available_dates)
                then p.dt::date end prev_date
    from generate_series(p_start,p_end,interval '1 day') with ordinality c(dt,ord)
    left join generate_series(p_prior_start,p_prior_end,interval '1 day') with ordinality p(dt,ord) using(ord)
    where c.dt::date in(select start_date from available_dates)
      and (p.dt::date in(select start_date from available_dates)
        or p.dt is null
        or p.dt::date < (select first_date from history_start))
  ), complete_dates as materialized (
    select curr_date start_date from paired_dates
    union all select prev_date from paired_dates where prev_date is not null
  )
  select
    case when sum(coalesce(f.sessions,0)) filter(where f.start_date between p_start and p_end)>0
      then sum(coalesce(f.buy_box_percentage,0)*coalesce(f.sessions,0)) filter(where f.start_date between p_start and p_end)
      /sum(coalesce(f.sessions,0)) filter(where f.start_date between p_start and p_end) end::numeric,
    case when sum(coalesce(f.sessions,0)) filter(where f.start_date between p_prior_start and p_prior_end)>0
      then sum(coalesce(f.buy_box_percentage,0)*coalesce(f.sessions,0)) filter(where f.start_date between p_prior_start and p_prior_end)
      /sum(coalesce(f.sessions,0)) filter(where f.start_date between p_prior_start and p_prior_end) end::numeric,
    count(distinct f.sku) filter(where f.start_date between p_start and p_end and coalesce(f.units_ordered,0)>0)::integer
  from public.fct_sales_daily f join complete_dates c using(start_date)
  where f.marketplace=any(p_markets) and (p_skus is null or f.sku=any(p_skus));
$function$;

-- get_sales_overview_market_drivers
CREATE OR REPLACE FUNCTION public.get_sales_overview_market_drivers(p_start date, p_end date, p_prior_start date, p_prior_end date, p_markets text[], p_skus text[] DEFAULT NULL::text[])
 RETURNS TABLE(marketplace text, revenue numeric, prior_revenue numeric, units numeric, sessions numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with available_dates as materialized (
    select f.start_date from public.fct_sales_daily f where f.marketplace=any(p_markets)
      and (f.start_date between p_start and p_end or f.start_date between p_prior_start and p_prior_end)
    group by f.start_date having count(distinct f.marketplace)=cardinality(p_markets)
  ), history_start as materialized (
    select min(f.start_date) first_date from public.fct_sales_daily f
     where f.marketplace=any(p_markets)
  ), paired_dates as materialized (
    -- A current day keeps its place unless its prior partner is missing for a reason that
    -- could bias the comparison. Two different situations were previously treated
    -- identically, and conflating them is what blanked the long presets:
    --
    --   partner exists                -> compare (unchanged)
    --   partner is inside the data
    --     era but absent              -> DROP the day. This is the partial marketplace
    --                                    ingestion this pairing exists to guard against.
    --                                    Unchanged behaviour.
    --   no partner could exist: it
    --     predates the warehouse, or
    --     the prior series is shorter
    --     than the current one        -> KEEP the day, prev_date null. The history simply
    --                                    does not reach back that far. That is not an
    --                                    ingestion fault and is no reason to withhold the
    --                                    current period, which is what used to happen:
    --                                    YTD returned zero rows despite its current
    --                                    window being fully loaded.
    select c.dt::date curr_date,
           case when p.dt::date in(select start_date from available_dates)
                then p.dt::date end prev_date
    from generate_series(p_start,p_end,interval '1 day') with ordinality c(dt,ord)
    left join generate_series(p_prior_start,p_prior_end,interval '1 day') with ordinality p(dt,ord) using(ord)
    where c.dt::date in(select start_date from available_dates)
      and (p.dt::date in(select start_date from available_dates)
        or p.dt is null
        or p.dt::date < (select first_date from history_start))
  ), complete_dates as materialized (
    select curr_date start_date from paired_dates
    union all select prev_date from paired_dates where prev_date is not null
  ), fx as materialized (
    select d.marketplace,d.start_date,case when d.marketplace='CA' then coalesce(public.reporting_fx_rate('CAD',d.start_date),1) else 1 end rate
    from(select distinct f.marketplace,f.start_date from public.fct_sales_daily f join complete_dates c using(start_date) where f.marketplace=any(p_markets))d
  )
  select f.marketplace,
    sum(coalesce(f.ordered_product_sales_amount,0)*fx.rate) filter(where f.start_date between p_start and p_end)::numeric,
    sum(coalesce(f.ordered_product_sales_amount,0)*fx.rate) filter(where f.start_date between p_prior_start and p_prior_end)::numeric,
    sum(coalesce(f.units_ordered,0)) filter(where f.start_date between p_start and p_end)::numeric,
    sum(coalesce(f.sessions,0)) filter(where f.start_date between p_start and p_end)::numeric
  from public.fct_sales_daily f join complete_dates c using(start_date) join fx using(marketplace,start_date)
  where f.marketplace=any(p_markets) and (p_skus is null or f.sku=any(p_skus))
  group by f.marketplace order by 2 desc nulls last;
$function$;
