-- Native SKU proceeds, sourced only from SellerIQ's Amazon finance pipeline.
-- Product advertising and landed product cost are intentionally excluded.

create index if not exists idx_int_fin_pnl_comp_market_tx
  on public.int_finance_pnl_components (marketplace, transaction_id);

create table if not exists public.fct_sku_finance_daily (
  sale_date date not null,
  marketplace text not null,
  sku text not null,
  asin text,
  title text,
  gross_sales numeric not null default 0,
  promotions numeric not null default 0,
  refunds numeric not null default 0,
  amazon_fees numeric not null default 0,
  shipping numeric not null default 0,
  reimbursements numeric not null default 0,
  transaction_count integer not null default 0,
  loaded_at timestamptz not null default now(),
  primary key (sale_date, marketplace, sku)
);

create index if not exists idx_fct_sku_finance_daily_query
  on public.fct_sku_finance_daily (marketplace, sale_date, sku);

alter table public.fct_sku_finance_daily enable row level security;
revoke all on public.fct_sku_finance_daily from public, anon, authenticated;

create or replace function public.rebuild_sku_finance_daily(p_start date, p_end date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_end < p_start then
    raise exception 'p_end must be on or after p_start';
  end if;

  delete from public.fct_sku_finance_daily
  where sale_date between p_start and p_end;

  insert into public.fct_sku_finance_daily (
    sale_date, marketplace, sku, asin, title, gross_sales, promotions,
    refunds, amazon_fees, shipping, reimbursements, transaction_count
  )
  select
    c.sale_date,
    c.marketplace,
    nullif(btrim(coalesce(nullif(t.sku, ''), t.items #>> '{0,contexts,0,sku}')), '') as resolved_sku,
    max(nullif(t.items #>> '{0,contexts,0,asin}', '')),
    max(nullif(t.description, '')),
    coalesce(round(sum(c.amount_usd) filter (where c.pnl_category = 'gross_sales'), 2), 0),
    coalesce(round(sum(c.amount_usd) filter (where c.pnl_category = 'promotions'), 2), 0),
    coalesce(round(sum(c.amount_usd) filter (where c.pnl_category = 'refunds'), 2), 0),
    coalesce(round(sum(c.amount_usd) filter (where c.pnl_category = 'amazon_fees'), 2), 0),
    coalesce(round(sum(c.amount_usd) filter (where c.pnl_category = 'shipping'), 2), 0),
    coalesce(round(sum(c.amount_usd) filter (where c.pnl_category = 'reimbursements'), 2), 0),
    count(distinct c.transaction_id)::integer
  from public.int_finance_pnl_components c
  join public.stg_amz_finance_transactions t
    on t.marketplace = c.marketplace
   and t.transaction_id = c.transaction_id
  where c.sale_date between p_start and p_end
    and nullif(btrim(coalesce(nullif(t.sku, ''), t.items #>> '{0,contexts,0,sku}')), '') is not null
  group by c.sale_date, c.marketplace, resolved_sku;
end;
$$;

revoke all on function public.rebuild_sku_finance_daily(date, date) from public, anon, authenticated;

-- Keep the SKU mart synchronized whenever the established monthly finance
-- pipeline is rebuilt.
create or replace function public.rebuild_finance_pnl_month(p_month date)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform public.rebuild_int_finance_pnl_month(p_month);
  perform public.rebuild_fct_finance_pnl_month(p_month);
  perform public.rebuild_agg_finance_pnl_counts_month(p_month);
  perform public.rebuild_sku_finance_daily(
    p_month,
    (p_month + interval '1 month - 1 day')::date
  );
end;
$$;

create or replace function public.get_native_sku_profitability(
  p_start date,
  p_end date,
  p_markets text[] default array['US']::text[]
)
returns table (
  sku text,
  asin text,
  title text,
  marketplace text,
  gross_sales numeric,
  promotions numeric,
  refunds numeric,
  amazon_fees numeric,
  shipping numeric,
  reimbursements numeric,
  net_proceeds_before_ads_ldp numeric,
  transaction_count bigint,
  last_transaction_date date
)
language sql
stable
security definer
set search_path = ''
as $$
  with financial as (
    select
      f.sku,
      f.marketplace,
      max(f.title) as source_title,
      max(f.asin) as source_asin,
      round(sum(f.gross_sales), 2) as gross_sales,
      round(sum(f.promotions), 2) as promotions,
      round(sum(f.refunds), 2) as refunds,
      round(sum(f.amazon_fees), 2) as amazon_fees,
      round(sum(f.shipping), 2) as shipping,
      round(sum(f.reimbursements), 2) as reimbursements,
      round(sum(
        f.gross_sales + f.promotions + f.refunds + f.amazon_fees
        + f.shipping + f.reimbursements
      ), 2) as net_proceeds,
      sum(f.transaction_count)::bigint as transaction_count,
      max(f.sale_date) as last_transaction_date
    from public.fct_sku_finance_daily f
    where f.sale_date between p_start and p_end
      and f.marketplace = any (p_markets)
    group by f.sku, f.marketplace
  ),
  products as (
    select
      btrim(p.sku) as sku,
      p.marketplace,
      max(nullif(p.asin, '')) as asin,
      max(nullif(p.title, '')) as title
    from public.dim_product p
    where p.marketplace = any (p_markets)
      and nullif(btrim(p.sku), '') is not null
    group by btrim(p.sku), p.marketplace
  ),
  keys as (
    select sku, marketplace from products
    union
    select sku, marketplace from financial
  )
  select
    k.sku,
    coalesce(p.asin, f.source_asin),
    coalesce(p.title, f.source_title, k.sku),
    k.marketplace,
    coalesce(f.gross_sales, 0),
    coalesce(f.promotions, 0),
    coalesce(f.refunds, 0),
    coalesce(f.amazon_fees, 0),
    coalesce(f.shipping, 0),
    coalesce(f.reimbursements, 0),
    coalesce(f.net_proceeds, 0),
    coalesce(f.transaction_count, 0),
    f.last_transaction_date
  from keys k
  left join products p using (sku, marketplace)
  left join financial f using (sku, marketplace)
  order by coalesce(f.net_proceeds, 0) desc, k.sku;
$$;

revoke all on function public.get_native_sku_profitability(date, date, text[]) from public;
grant execute on function public.get_native_sku_profitability(date, date, text[]) to anon, authenticated;

create or replace function public.get_native_profitability_coverage(
  p_start date,
  p_end date,
  p_markets text[] default array['US']::text[]
)
returns table (
  pnl_category text,
  account_amount numeric,
  sku_allocated_amount numeric,
  unallocated_amount numeric,
  account_transaction_count bigint,
  sku_transaction_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with account_totals as (
    select
      f.pnl_category,
      round(sum(f.amount_usd), 2) as account_amount,
      sum(f.event_count)::bigint as account_transaction_count
    from public.fct_finance_pnl_daily f
    where f.sale_date between p_start and p_end
      and f.marketplace = any (p_markets)
    group by f.pnl_category
  ),
  sku_unpivot as (
    select d.sale_date, d.marketplace, d.transaction_count, x.pnl_category, x.amount
    from public.fct_sku_finance_daily d
    cross join lateral (values
      ('gross_sales'::text, d.gross_sales),
      ('promotions', d.promotions),
      ('refunds', d.refunds),
      ('amazon_fees', d.amazon_fees),
      ('shipping', d.shipping),
      ('reimbursements', d.reimbursements)
    ) x(pnl_category, amount)
    where d.sale_date between p_start and p_end
      and d.marketplace = any (p_markets)
  ),
  sku_totals as (
    select
      u.pnl_category,
      round(sum(u.amount), 2) as sku_allocated_amount,
      null::bigint as sku_transaction_count
    from sku_unpivot u
    group by u.pnl_category
  ),
  categories as (
    select pnl_category from account_totals
    union
    select pnl_category from sku_totals
  )
  select
    x.pnl_category,
    coalesce(a.account_amount, 0),
    coalesce(s.sku_allocated_amount, 0),
    round(coalesce(a.account_amount, 0) - coalesce(s.sku_allocated_amount, 0), 2),
    coalesce(a.account_transaction_count, 0),
    s.sku_transaction_count
  from categories x
  left join account_totals a using (pnl_category)
  left join sku_totals s using (pnl_category)
  order by abs(coalesce(a.account_amount, 0)) desc;
$$;

revoke all on function public.get_native_profitability_coverage(date, date, text[]) from public;
grant execute on function public.get_native_profitability_coverage(date, date, text[]) to anon, authenticated;

-- Initial Daily Dev backfill. Subsequent finance refreshes use the wrapper above.
select public.rebuild_sku_finance_daily(
  (select min(sale_date) from public.int_finance_pnl_components),
  (select max(sale_date) from public.int_finance_pnl_components)
);

