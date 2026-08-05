-- Daily Dev profitability foundation.
-- Stores effective-dated landed cost and imported product-profit benchmarks.
-- Source tables are not directly exposed to browser roles; the UI reads only
-- the intentionally narrow get_contribution_profit RPC below.

create table if not exists public.sku_ldp_history (
  id bigint generated always as identity primary key,
  marketplace text not null check (marketplace in ('US', 'CA')),
  sku text not null,
  asin text,
  effective_from date not null,
  effective_to date,
  ldp_per_unit numeric(18, 6) not null check (ldp_per_unit >= 0),
  currency_code text not null check (currency_code in ('USD', 'CAD')),
  source_system text not null,
  source_reference text,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  unique (marketplace, sku, effective_from)
);

create index if not exists sku_ldp_history_lookup_idx
  on public.sku_ldp_history (marketplace, sku, effective_from desc);

create table if not exists public.fct_sku_profit_period (
  id bigint generated always as identity primary key,
  period_start date not null,
  period_end date not null,
  marketplace text not null check (marketplace in ('US', 'CA')),
  asin text,
  sku text not null,
  title text,
  units numeric(18, 4) not null default 0,
  refund_units numeric(18, 4) not null default 0,
  sales numeric(18, 2) not null default 0,
  promotional_discounts numeric(18, 2) not null default 0 check (promotional_discounts >= 0),
  advertising_cost numeric(18, 2) not null default 0 check (advertising_cost >= 0),
  refund_cost numeric(18, 2) not null default 0 check (refund_cost >= 0),
  amazon_fees numeric(18, 2) not null default 0 check (amazon_fees >= 0),
  ldp_cost numeric(18, 2) not null default 0 check (ldp_cost >= 0),
  shipping_cost numeric(18, 2) not null default 0 check (shipping_cost >= 0),
  indirect_expenses numeric(18, 2) not null default 0 check (indirect_expenses >= 0),
  estimated_payout numeric(18, 2),
  sessions bigint not null default 0,
  source_system text not null,
  source_reference text,
  loaded_at timestamptz not null default now(),
  check (period_end >= period_start),
  unique (period_start, period_end, marketplace, sku, source_system)
);

create index if not exists fct_sku_profit_period_query_idx
  on public.fct_sku_profit_period (period_start, period_end, marketplace, sku);

create table if not exists public.account_profit_adjustment (
  id bigint generated always as identity primary key,
  period_start date not null,
  period_end date not null,
  marketplace text not null check (marketplace in ('US', 'CA')),
  category text not null,
  amount numeric(18, 2) not null,
  allocation_status text not null default 'unallocated'
    check (allocation_status in ('unallocated', 'allocated', 'excluded')),
  source_system text not null,
  source_reference text,
  notes text,
  created_at timestamptz not null default now(),
  check (period_end >= period_start)
);

create index if not exists account_profit_adjustment_query_idx
  on public.account_profit_adjustment (period_start, period_end, marketplace, allocation_status);

create table if not exists public.profit_reconciliation_target (
  id bigint generated always as identity primary key,
  period_start date not null,
  period_end date not null,
  marketplace text not null check (marketplace in ('US', 'CA')),
  metric text not null,
  target_amount numeric(18, 2) not null,
  source_system text not null,
  source_reference text,
  created_at timestamptz not null default now(),
  unique (period_start, period_end, marketplace, metric, source_system),
  check (period_end >= period_start)
);

alter table public.sku_ldp_history enable row level security;
alter table public.fct_sku_profit_period enable row level security;
alter table public.account_profit_adjustment enable row level security;
alter table public.profit_reconciliation_target enable row level security;

revoke all on public.sku_ldp_history from public, anon, authenticated;
revoke all on public.fct_sku_profit_period from public, anon, authenticated;
revoke all on public.account_profit_adjustment from public, anon, authenticated;
revoke all on public.profit_reconciliation_target from public, anon, authenticated;

create or replace function public.get_contribution_profit(
  p_start date,
  p_end date,
  p_markets text[] default array['US']::text[],
  p_skus text[] default null
)
returns table (
  sku text,
  asin text,
  title text,
  marketplace text,
  units numeric,
  refund_units numeric,
  sales numeric,
  promotional_discounts numeric,
  advertising_cost numeric,
  refund_cost numeric,
  amazon_fees numeric,
  ldp_cost numeric,
  shipping_cost numeric,
  contribution_profit numeric,
  margin_pct numeric,
  roi_pct numeric,
  sessions bigint,
  cost_status text,
  recommendation_type text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.sku,
    max(p.asin),
    max(p.title),
    p.marketplace,
    sum(p.units),
    sum(p.refund_units),
    round(sum(p.sales), 2),
    round(sum(p.promotional_discounts), 2),
    round(sum(p.advertising_cost), 2),
    round(sum(p.refund_cost), 2),
    round(sum(p.amazon_fees), 2),
    round(sum(p.ldp_cost), 2),
    round(sum(p.shipping_cost), 2),
    round(sum(
      p.sales - p.promotional_discounts - p.advertising_cost - p.refund_cost
      - p.amazon_fees - p.ldp_cost - p.shipping_cost - p.indirect_expenses
    ), 2),
    case when sum(p.sales) <> 0 then round(
      sum(p.sales - p.promotional_discounts - p.advertising_cost - p.refund_cost
          - p.amazon_fees - p.ldp_cost - p.shipping_cost - p.indirect_expenses)
      / sum(p.sales) * 100, 2) end,
    case when sum(p.ldp_cost) <> 0 then round(
      sum(p.sales - p.promotional_discounts - p.advertising_cost - p.refund_cost
          - p.amazon_fees - p.ldp_cost - p.shipping_cost - p.indirect_expenses)
      / sum(p.ldp_cost) * 100, 2) end,
    sum(p.sessions)::bigint,
    case when sum(p.units) > 0 and sum(p.ldp_cost) = 0 then 'missing_ldp' else 'complete' end,
    case
      when sum(p.units) > 0 and sum(p.ldp_cost) = 0 then 'add_ldp'
      when sum(p.units) > 0
        and sum(p.sales - p.promotional_discounts - p.advertising_cost - p.refund_cost
               - p.amazon_fees - p.ldp_cost - p.shipping_cost - p.indirect_expenses) < 0
        then 'unprofitable_product'
      else null
    end
  from public.fct_sku_profit_period p
  where p.period_start >= p_start
    and p.period_end <= p_end
    and p.marketplace = any (p_markets)
    and (p_skus is null or p.sku = any (p_skus))
  group by p.sku, p.marketplace
  order by 14 asc;
$$;

revoke all on function public.get_contribution_profit(date, date, text[], text[]) from public;
grant execute on function public.get_contribution_profit(date, date, text[], text[]) to anon, authenticated;

create or replace function public.get_profit_reconciliation(
  p_start date,
  p_end date,
  p_marketplace text default 'US'
)
returns table (
  metric text,
  calculated_amount numeric,
  target_amount numeric,
  difference numeric,
  status text
)
language sql
stable
security definer
set search_path = ''
as $$
  with product_totals as (
    select
      round(sum(sales), 2) as sales,
      round(sum(advertising_cost), 2) as advertising_cost,
      round(sum(refund_cost), 2) as refund_cost,
      round(sum(amazon_fees), 2) as product_amazon_fees,
      round(sum(ldp_cost), 2) as ldp_cost,
      round(sum(sales - promotional_discounts - advertising_cost - refund_cost
                - amazon_fees - ldp_cost - shipping_cost - indirect_expenses), 2)
        as product_contribution_profit
    from public.fct_sku_profit_period
    where period_start >= p_start and period_end <= p_end and marketplace = p_marketplace
  ), adjustments as (
    select coalesce(sum(amount) filter (where allocation_status = 'unallocated'), 0) as amount
    from public.account_profit_adjustment
    where period_start >= p_start and period_end <= p_end and marketplace = p_marketplace
  ), calculated as (
    select 'sales'::text metric, sales amount from product_totals
    union all select 'advertising_cost', advertising_cost from product_totals
    union all select 'refund_cost', refund_cost from product_totals
    union all select 'amazon_fees', product_amazon_fees - adjustments.amount from product_totals cross join adjustments
    union all select 'ldp_cost', ldp_cost from product_totals
    union all select 'contribution_profit', product_contribution_profit + adjustments.amount from product_totals cross join adjustments
  )
  select c.metric, c.amount, t.target_amount,
    round(c.amount - t.target_amount, 2),
    case when abs(c.amount - t.target_amount) <= 0.05 then 'reconciled' else 'difference' end
  from calculated c
  left join public.profit_reconciliation_target t
    on t.period_start = p_start and t.period_end = p_end
   and t.marketplace = p_marketplace and t.metric = c.metric
  order by c.metric;
$$;

revoke all on function public.get_profit_reconciliation(date, date, text) from public;
grant execute on function public.get_profit_reconciliation(date, date, text) to anon, authenticated;
