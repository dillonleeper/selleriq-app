-- Prevent partial marketplace ingestion from appearing as a real account-wide decline.
-- Daily Dev only: the environment guard refuses any other database.

do $$
begin
  if coalesce((select environment from public.__seller_iq_environment limit 1), '') <> 'dev' then
    raise exception 'Refusing to run: target database is not marked dev.';
  end if;
end $$;

create or replace function public.get_sales_overview(
  p_start date, p_end date, p_prior_start date, p_prior_end date,
  p_markets text[], p_skus text[] default null
)
returns table (period text, start_date date, revenue numeric, units bigint, sessions bigint, page_views bigint)
language sql stable security invoker set search_path = ''
as $function$
  with complete_dates as materialized (
    select f.start_date
    from public.fct_sales_daily f
    where f.marketplace = any(p_markets)
      and (f.start_date between p_start and p_end or f.start_date between p_prior_start and p_prior_end)
    group by f.start_date
    having count(distinct f.marketplace) = cardinality(p_markets)
  ),
  fx as materialized (
    select d.marketplace, d.start_date,
      case when d.marketplace = 'CA'
        then coalesce(public.reporting_fx_rate('CAD', d.start_date), 1)
        else 1
      end as rate
    from (
      select distinct f.marketplace, f.start_date
      from public.fct_sales_daily f
      join complete_dates c using (start_date)
      where f.marketplace = any(p_markets)
    ) d
  )
  select case when f.start_date between p_start and p_end then 'current' else 'prior' end,
    f.start_date,
    sum(coalesce(f.ordered_product_sales_amount,0) * fx.rate)::numeric,
    sum(coalesce(f.units_ordered,0))::bigint,
    sum(coalesce(f.sessions,0))::bigint,
    sum(coalesce(f.page_views,0))::bigint
  from public.fct_sales_daily f
  join complete_dates c using (start_date)
  join fx using (marketplace,start_date)
  where f.marketplace=any(p_markets)
    and (p_skus is null or f.sku=any(p_skus))
    and (f.start_date between p_start and p_end or f.start_date between p_prior_start and p_prior_end)
  group by 1,f.start_date order by 1,f.start_date;
$function$;

grant execute on function public.get_sales_overview(date,date,date,date,text[],text[]) to anon, authenticated;
