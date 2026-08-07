-- Reuse one effective-dated FX lookup per market/date across Sales Overview queries.
-- Add an auditable breakdown of Amazon fees that have no source SKU.

CREATE OR REPLACE FUNCTION public.get_native_account_fee_breakdown(p_start date, p_end date, p_markets text[] DEFAULT ARRAY['US'::text])
 RETURNS TABLE(fee_type text, amount_usd numeric, transaction_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(nullif(c.raw_fee_type,''),'Other / correction') fee_type,
    round(sum(c.amount_usd),2), count(distinct c.transaction_id)::bigint
  from public.int_finance_pnl_components c
  left join public.stg_amz_finance_transactions t
    on t.marketplace=c.marketplace and t.transaction_id=c.transaction_id
  where c.sale_date between p_start and p_end and c.marketplace=any(p_markets)
    and c.pnl_category='amazon_fees'
    and nullif(btrim(coalesce(nullif(t.sku,''),t.items #>> '{0,contexts,0,sku}')),'') is null
  group by 1 having abs(sum(c.amount_usd))>=0.01
  order by abs(sum(c.amount_usd)) desc;
$function$

CREATE OR REPLACE FUNCTION public.get_sales_overview(p_start date, p_end date, p_prior_start date, p_prior_end date, p_markets text[], p_skus text[] DEFAULT NULL::text[])
 RETURNS TABLE(period text, start_date date, revenue numeric, units bigint, sessions bigint, page_views bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with fx as materialized (
    select d.marketplace, d.start_date,
      case when d.marketplace = 'CA'
        then coalesce(public.reporting_fx_rate('CAD', d.start_date), 1)
        else 1
      end as rate
    from (
      select distinct f.marketplace, f.start_date
      from public.fct_sales_daily f
      where f.marketplace = any(p_markets)
        and (f.start_date between p_start and p_end or f.start_date between p_prior_start and p_prior_end)
    ) d
  )
  select case when f.start_date between p_start and p_end then 'current' else 'prior' end,
    f.start_date,
    sum(coalesce(f.ordered_product_sales_amount,0) * fx.rate)::numeric,
    sum(coalesce(f.units_ordered,0))::bigint,
    sum(coalesce(f.sessions,0))::bigint,
    sum(coalesce(f.page_views,0))::bigint
  from public.fct_sales_daily f
  join fx using (marketplace,start_date)
  where f.marketplace=any(p_markets)
    and (p_skus is null or f.sku=any(p_skus))
    and (f.start_date between p_start and p_end or f.start_date between p_prior_start and p_prior_end)
  group by 1,f.start_date order by 1,f.start_date;
$function$

CREATE OR REPLACE FUNCTION public.get_sales_overview_market_drivers(p_start date, p_end date, p_prior_start date, p_prior_end date, p_markets text[], p_skus text[] DEFAULT NULL::text[])
 RETURNS TABLE(marketplace text, revenue numeric, prior_revenue numeric, units numeric, sessions numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with fx as materialized (
    select d.marketplace,d.start_date,
      case when d.marketplace='CA' then coalesce(public.reporting_fx_rate('CAD',d.start_date),1) else 1 end rate
    from (
      select distinct f.marketplace,f.start_date from public.fct_sales_daily f
      where f.marketplace=any(p_markets)
        and (f.start_date between p_start and p_end or f.start_date between p_prior_start and p_prior_end)
    ) d
  )
  select f.marketplace,
    sum(coalesce(f.ordered_product_sales_amount,0)*fx.rate) filter(where f.start_date between p_start and p_end)::numeric,
    sum(coalesce(f.ordered_product_sales_amount,0)*fx.rate) filter(where f.start_date between p_prior_start and p_prior_end)::numeric,
    sum(coalesce(f.units_ordered,0)) filter(where f.start_date between p_start and p_end)::numeric,
    sum(coalesce(f.sessions,0)) filter(where f.start_date between p_start and p_end)::numeric
  from public.fct_sales_daily f join fx using(marketplace,start_date)
  where f.marketplace=any(p_markets) and (p_skus is null or f.sku=any(p_skus))
    and (f.start_date between p_start and p_end or f.start_date between p_prior_start and p_prior_end)
  group by f.marketplace order by 2 desc nulls last;
$function$

CREATE OR REPLACE FUNCTION public.get_sku_sales_summary(p_start date, p_end date, p_prior_start date, p_prior_end date, p_markets text[], p_skus text[] DEFAULT NULL::text[])
 RETURNS TABLE(sku text, title text, sessions bigint, page_views bigint, units numeric, revenue numeric, conv_rate numeric, buy_box_pct numeric, prev_sessions bigint, prev_units numeric, prev_revenue numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with fx as materialized (
    select d.marketplace,d.start_date,
      case when d.marketplace='CA' then coalesce(public.reporting_fx_rate('CAD',d.start_date),1) else 1 end rate
    from (
      select distinct f.marketplace,f.start_date from public.fct_sales_daily f
      where f.marketplace=any(p_markets)
        and (f.start_date between p_start and p_end or f.start_date between p_prior_start and p_prior_end)
    ) d
  ), totals as (
    select f.sku,
      max(f.title) filter(where f.start_date between p_start and p_end) current_title,
      max(f.title) filter(where f.start_date between p_prior_start and p_prior_end) prior_title,
      sum(f.sessions) filter(where f.start_date between p_start and p_end)::bigint sessions,
      sum(f.page_views) filter(where f.start_date between p_start and p_end)::bigint page_views,
      sum(f.units_ordered) filter(where f.start_date between p_start and p_end)::numeric units,
      sum(coalesce(f.ordered_product_sales_amount,0)*fx.rate) filter(where f.start_date between p_start and p_end)::numeric revenue,
      sum(f.units_ordered) filter(where f.start_date between p_start and p_end and f.sessions>0)::numeric conv_num,
      sum(f.sessions) filter(where f.start_date between p_start and p_end and f.sessions>0)::numeric conv_den,
      case when sum(coalesce(f.sessions,0)) filter(where f.start_date between p_start and p_end)>0
        then sum(coalesce(f.buy_box_percentage,0)*coalesce(f.sessions,0)) filter(where f.start_date between p_start and p_end)
          / sum(coalesce(f.sessions,0)) filter(where f.start_date between p_start and p_end) end::numeric buy_box_pct,
      sum(f.sessions) filter(where f.start_date between p_prior_start and p_prior_end)::bigint prev_sessions,
      sum(f.units_ordered) filter(where f.start_date between p_prior_start and p_prior_end)::numeric prev_units,
      sum(coalesce(f.ordered_product_sales_amount,0)*fx.rate) filter(where f.start_date between p_prior_start and p_prior_end)::numeric prev_revenue
    from public.fct_sales_daily f join fx using(marketplace,start_date)
    where f.sku is not null and f.marketplace=any(p_markets)
      and (p_skus is null or f.sku=any(p_skus))
      and (f.start_date between p_start and p_end or f.start_date between p_prior_start and p_prior_end)
    group by f.sku
  )
  select t.sku,coalesce(t.current_title,t.prior_title,t.sku),coalesce(t.sessions,0),coalesce(t.page_views,0),
    coalesce(t.units,0),coalesce(t.revenue,0),
    case when coalesce(t.conv_den,0)>0 then (t.conv_num/t.conv_den)*100 else 0 end,
    t.buy_box_pct,coalesce(t.prev_sessions,0),coalesce(t.prev_units,0),coalesce(t.prev_revenue,0)
  from totals t
  where coalesce(t.sessions,0)<>0 or coalesce(t.units,0)<>0 or coalesce(t.revenue,0)<>0
     or coalesce(t.prev_sessions,0)<>0 or coalesce(t.prev_units,0)<>0 or coalesce(t.prev_revenue,0)<>0;
$function$

revoke all on function public.get_native_account_fee_breakdown(date,date,text[]) from public;
grant execute on function public.get_native_account_fee_breakdown(date,date,text[]) to anon,authenticated;


-- Precompute account-level fee categories so the UI never scans the raw ledger.
create index if not exists idx_int_finance_fee_breakdown
  on public.int_finance_pnl_components (pnl_category, marketplace, sale_date, transaction_id)
  include (raw_fee_type, amount_usd);

create table if not exists public.fct_account_fee_daily (
  sale_date date not null,
  marketplace text not null,
  fee_type text not null,
  amount_usd numeric not null default 0,
  transaction_count integer not null default 0,
  loaded_at timestamptz not null default now(),
  primary key (sale_date, marketplace, fee_type)
);
create index if not exists idx_fct_account_fee_daily_query
  on public.fct_account_fee_daily (marketplace, sale_date, fee_type);
alter table public.fct_account_fee_daily enable row level security;
revoke all on public.fct_account_fee_daily from public, anon, authenticated;

create or replace function public.rebuild_account_fee_daily(p_start date, p_end date)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if p_end < p_start then raise exception 'p_end must be on or after p_start'; end if;
  delete from public.fct_account_fee_daily where sale_date between p_start and p_end;
  insert into public.fct_account_fee_daily (sale_date, marketplace, fee_type, amount_usd, transaction_count)
  select c.sale_date, c.marketplace, coalesce(nullif(c.raw_fee_type, ''), 'Other / correction'),
    round(sum(c.amount_usd), 2), count(distinct c.transaction_id)::integer
  from public.int_finance_pnl_components c
  left join public.stg_amz_finance_transactions t
    on t.marketplace = c.marketplace and t.transaction_id = c.transaction_id
  where c.sale_date between p_start and p_end
    and c.pnl_category = 'amazon_fees'
    and nullif(btrim(coalesce(nullif(t.sku, ''), t.items #>> '{0,contexts,0,sku}')), '') is null
  group by c.sale_date, c.marketplace, 3
  having abs(sum(c.amount_usd)) >= 0.01;
end;
$$;
revoke all on function public.rebuild_account_fee_daily(date, date) from public, anon, authenticated;

create or replace function public.get_native_account_fee_breakdown(
  p_start date, p_end date, p_markets text[] default array['US']::text[]
)
returns table (fee_type text, amount_usd numeric, transaction_count bigint)
language sql stable security definer set search_path = ''
as $$
  select f.fee_type, round(sum(f.amount_usd), 2), sum(f.transaction_count)::bigint
  from public.fct_account_fee_daily f
  where f.sale_date between p_start and p_end and f.marketplace = any(p_markets)
  group by f.fee_type having abs(sum(f.amount_usd)) >= 0.01
  order by abs(sum(f.amount_usd)) desc;
$$;
revoke all on function public.get_native_account_fee_breakdown(date, date, text[]) from public;
grant execute on function public.get_native_account_fee_breakdown(date, date, text[]) to anon, authenticated;

create or replace function public.rebuild_finance_pnl_month(p_month date)
returns void language plpgsql set search_path = ''
as $$
begin
  perform public.rebuild_int_finance_pnl_month(p_month);
  perform public.rebuild_fct_finance_pnl_month(p_month);
  perform public.rebuild_agg_finance_pnl_counts_month(p_month);
  perform public.rebuild_sku_finance_daily(p_month, (p_month + interval '1 month - 1 day')::date);
  perform public.rebuild_account_fee_daily(p_month, (p_month + interval '1 month - 1 day')::date);
end;
$$;

select public.rebuild_account_fee_daily(
  (select min(sale_date) from public.int_finance_pnl_components),
  (select max(sale_date) from public.int_finance_pnl_components)
);
