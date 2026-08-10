-- Pair current and prior dates so partial marketplace ingestion cannot bias comparisons.
do $$
begin
  if coalesce((select environment from public.__seller_iq_environment limit 1), '') <> 'dev' then
    raise exception 'Refusing to run: target database is not marked dev.';
  end if;
end $$;

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
  ), paired_dates as materialized (
    select c.dt::date curr_date,p.dt::date prev_date
    from generate_series(p_start,p_end,interval '1 day') with ordinality c(dt,ord)
    join generate_series(p_prior_start,p_prior_end,interval '1 day') with ordinality p(dt,ord) using(ord)
    where c.dt::date in(select start_date from available_dates)
      and p.dt::date in(select start_date from available_dates)
  ), complete_dates as materialized (
    select curr_date start_date from paired_dates union all select prev_date from paired_dates
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
  ), paired_dates as materialized (
    select c.dt::date curr_date,p.dt::date prev_date
    from generate_series(p_start,p_end,interval '1 day') with ordinality c(dt,ord)
    join generate_series(p_prior_start,p_prior_end,interval '1 day') with ordinality p(dt,ord) using(ord)
    where c.dt::date in(select start_date from available_dates) and p.dt::date in(select start_date from available_dates)
  ), complete_dates as materialized (
    select curr_date start_date from paired_dates union all select prev_date from paired_dates
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
  ), paired_dates as materialized (
    select c.dt::date curr_date,p.dt::date prev_date
    from generate_series(p_start,p_end,interval '1 day') with ordinality c(dt,ord)
    join generate_series(p_prior_start,p_prior_end,interval '1 day') with ordinality p(dt,ord) using(ord)
    where c.dt::date in(select start_date from available_dates) and p.dt::date in(select start_date from available_dates)
  ), complete_dates as materialized (
    select curr_date start_date from paired_dates union all select prev_date from paired_dates
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

grant execute on function public.get_sales_overview(date,date,date,date,text[],text[]) to anon, authenticated;
grant execute on function public.get_sales_overview_market_drivers(date,date,date,date,text[],text[]) to anon, authenticated;
grant execute on function public.get_sales_overview_summary(date,date,date,date,text[],text[]) to anon, authenticated;
