-- Keep SKU movement analysis complete when a SKU sold only in the comparison
-- window (for example, a discontinued or newly stockout SKU). The previous
-- implementation filtered those rows out after aggregation, understating the
-- largest revenue declines.

do $$
begin
  if coalesce((select environment from public.__seller_iq_environment limit 1), '') <> 'dev' then
    raise exception 'Refusing to run: target database is not marked dev.';
  end if;
end $$;

create or replace function public.get_sku_sales_summary(
  p_start date, p_end date, p_prior_start date, p_prior_end date,
  p_markets text[], p_skus text[] default null
)
returns table (
  sku text, title text, sessions bigint, page_views bigint, units numeric,
  revenue numeric, conv_rate numeric, buy_box_pct numeric,
  prev_sessions bigint, prev_units numeric, prev_revenue numeric
)
language sql stable security invoker set search_path = ''
as $function$
  with totals as (
    select f.sku,
      max(f.title) filter (where f.start_date between p_start and p_end) as current_title,
      max(f.title) filter (where f.start_date between p_prior_start and p_prior_end) as prior_title,
      sum(f.sessions) filter (where f.start_date between p_start and p_end)::bigint as sessions,
      sum(f.page_views) filter (where f.start_date between p_start and p_end)::bigint as page_views,
      sum(f.units_ordered) filter (where f.start_date between p_start and p_end)::numeric as units,
      sum(coalesce(f.ordered_product_sales_amount, 0) * coalesce(public.reporting_fx_rate(case when f.marketplace = 'CA' then 'CAD' else 'USD' end, f.start_date), 1)) filter (where f.start_date between p_start and p_end)::numeric as revenue,
      sum(f.units_ordered) filter (where f.start_date between p_start and p_end and f.sessions > 0)::numeric as conv_num,
      sum(f.sessions) filter (where f.start_date between p_start and p_end and f.sessions > 0)::numeric as conv_den,
      case when sum(coalesce(f.sessions, 0)) filter (where f.start_date between p_start and p_end) > 0
        then sum(coalesce(f.buy_box_percentage, 0) * coalesce(f.sessions, 0)) filter (where f.start_date between p_start and p_end)
          / sum(coalesce(f.sessions, 0)) filter (where f.start_date between p_start and p_end)
      end::numeric as buy_box_pct,
      sum(f.sessions) filter (where f.start_date between p_prior_start and p_prior_end)::bigint as prev_sessions,
      sum(f.units_ordered) filter (where f.start_date between p_prior_start and p_prior_end)::numeric as prev_units,
      sum(coalesce(f.ordered_product_sales_amount, 0) * coalesce(public.reporting_fx_rate(case when f.marketplace = 'CA' then 'CAD' else 'USD' end, f.start_date), 1)) filter (where f.start_date between p_prior_start and p_prior_end)::numeric as prev_revenue
    from public.fct_sales_daily f
    where f.sku is not null
      and f.marketplace = any(p_markets)
      and (p_skus is null or f.sku = any(p_skus))
      and (f.start_date between p_start and p_end or f.start_date between p_prior_start and p_prior_end)
    group by f.sku
  )
  select t.sku, coalesce(t.current_title, t.prior_title, t.sku),
    coalesce(t.sessions, 0), coalesce(t.page_views, 0), coalesce(t.units, 0), coalesce(t.revenue, 0),
    case when coalesce(t.conv_den, 0) > 0 then (t.conv_num / t.conv_den) * 100 else 0 end,
    t.buy_box_pct, coalesce(t.prev_sessions, 0), coalesce(t.prev_units, 0), coalesce(t.prev_revenue, 0)
  from totals t
  where coalesce(t.sessions, 0) <> 0
     or coalesce(t.units, 0) <> 0
     or coalesce(t.revenue, 0) <> 0
     or coalesce(t.prev_sessions, 0) <> 0
     or coalesce(t.prev_units, 0) <> 0
     or coalesce(t.prev_revenue, 0) <> 0;
$function$;

revoke execute on function public.get_sku_sales_summary(date, date, date, date, text[], text[]) from public;
grant execute on function public.get_sku_sales_summary(date, date, date, date, text[], text[]) to anon, authenticated;
