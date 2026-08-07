-- Lazy, SKU-scoped transaction evidence for SellerIQ native profitability.
-- Returns normalized finance components only; raw Amazon JSON remains private.

create index if not exists idx_stg_amz_finance_resolved_sku
  on public.stg_amz_finance_transactions (
    marketplace,
    (nullif(btrim(coalesce(nullif(sku, ''), items #>> '{0,contexts,0,sku}')), '')),
    transaction_id
  );

create or replace function public.get_native_sku_finance_transactions(
  p_start date,
  p_end date,
  p_marketplace text,
  p_sku text,
  p_limit integer default 100
)
returns table (
  sale_date date,
  transaction_id text,
  order_id text,
  transaction_type text,
  transaction_status text,
  description text,
  gross_sales numeric,
  promotions numeric,
  refunds numeric,
  amazon_fees numeric,
  shipping numeric,
  reimbursements numeric,
  net_proceeds numeric,
  has_unmapped_component boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.sale_date,
    c.transaction_id,
    max(coalesce(c.order_id, t.order_id)) as order_id,
    max(c.transaction_type) as transaction_type,
    max(c.transaction_status) as transaction_status,
    max(nullif(t.description, '')) as description,
    coalesce(round(sum(c.amount_usd) filter (where c.pnl_category = 'gross_sales'), 2), 0),
    coalesce(round(sum(c.amount_usd) filter (where c.pnl_category = 'promotions'), 2), 0),
    coalesce(round(sum(c.amount_usd) filter (where c.pnl_category = 'refunds'), 2), 0),
    coalesce(round(sum(c.amount_usd) filter (where c.pnl_category = 'amazon_fees'), 2), 0),
    coalesce(round(sum(c.amount_usd) filter (where c.pnl_category = 'shipping'), 2), 0),
    coalesce(round(sum(c.amount_usd) filter (where c.pnl_category = 'reimbursements'), 2), 0),
    round(sum(c.amount_usd) filter (
      where c.pnl_category in (
        'gross_sales', 'promotions', 'refunds',
        'amazon_fees', 'shipping', 'reimbursements'
      )
    ), 2),
    bool_or(c.is_unmapped)
  from public.stg_amz_finance_transactions t
  join public.int_finance_pnl_components c
    on c.marketplace = t.marketplace
   and c.transaction_id = t.transaction_id
  where c.sale_date between p_start and p_end
    and t.marketplace = p_marketplace
    and nullif(
      btrim(coalesce(nullif(t.sku, ''), t.items #>> '{0,contexts,0,sku}')),
      ''
    ) = btrim(p_sku)
  group by c.sale_date, c.transaction_id
  order by c.sale_date desc, c.transaction_id desc
  limit least(greatest(coalesce(p_limit, 100), 1), 100);
$$;

revoke all on function public.get_native_sku_finance_transactions(
  date, date, text, text, integer
) from public;

grant execute on function public.get_native_sku_finance_transactions(
  date, date, text, text, integer
) to anon, authenticated;


-- Precompute normalized transaction evidence so row expansion never scans the raw ledger.
create table if not exists public.fct_sku_finance_transaction (
  sale_date date not null, marketplace text not null, sku text not null,
  transaction_id text not null, order_id text, transaction_type text,
  transaction_status text, description text,
  gross_sales numeric not null default 0, promotions numeric not null default 0,
  refunds numeric not null default 0, amazon_fees numeric not null default 0,
  shipping numeric not null default 0, reimbursements numeric not null default 0,
  net_proceeds numeric not null default 0,
  has_unmapped_component boolean not null default false,
  loaded_at timestamptz not null default now(),
  primary key (sale_date, marketplace, sku, transaction_id)
);
create index if not exists idx_fct_sku_finance_transaction_lookup
  on public.fct_sku_finance_transaction (marketplace, sku, sale_date desc, transaction_id);
alter table public.fct_sku_finance_transaction enable row level security;
revoke all on public.fct_sku_finance_transaction from public, anon, authenticated;

create or replace function public.rebuild_sku_finance_transaction(p_start date, p_end date)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if p_end < p_start then raise exception 'p_end must be on or after p_start'; end if;
  delete from public.fct_sku_finance_transaction where sale_date between p_start and p_end;
  insert into public.fct_sku_finance_transaction (
    sale_date, marketplace, sku, transaction_id, order_id, transaction_type,
    transaction_status, description, gross_sales, promotions, refunds,
    amazon_fees, shipping, reimbursements, net_proceeds, has_unmapped_component
  )
  select c.sale_date, c.marketplace,
    nullif(btrim(coalesce(nullif(t.sku, ''), t.items #>> '{0,contexts,0,sku}')), ''),
    c.transaction_id, max(coalesce(c.order_id, t.order_id)), max(c.transaction_type),
    max(c.transaction_status), max(nullif(t.description, '')),
    coalesce(round(sum(c.amount_usd) filter (where c.pnl_category = 'gross_sales'), 2), 0),
    coalesce(round(sum(c.amount_usd) filter (where c.pnl_category = 'promotions'), 2), 0),
    coalesce(round(sum(c.amount_usd) filter (where c.pnl_category = 'refunds'), 2), 0),
    coalesce(round(sum(c.amount_usd) filter (where c.pnl_category = 'amazon_fees'), 2), 0),
    coalesce(round(sum(c.amount_usd) filter (where c.pnl_category = 'shipping'), 2), 0),
    coalesce(round(sum(c.amount_usd) filter (where c.pnl_category = 'reimbursements'), 2), 0),
    coalesce(round(sum(c.amount_usd) filter (where c.pnl_category in (
      'gross_sales', 'promotions', 'refunds', 'amazon_fees', 'shipping', 'reimbursements'
    )), 2), 0),
    bool_or(c.is_unmapped)
  from public.int_finance_pnl_components c
  join public.stg_amz_finance_transactions t
    on t.marketplace = c.marketplace and t.transaction_id = c.transaction_id
  where c.sale_date between p_start and p_end
    and nullif(btrim(coalesce(nullif(t.sku, ''), t.items #>> '{0,contexts,0,sku}')), '') is not null
  group by c.sale_date, c.marketplace, 3, c.transaction_id;
end;
$$;
revoke all on function public.rebuild_sku_finance_transaction(date, date) from public, anon, authenticated;

create or replace function public.get_native_sku_finance_transactions(
  p_start date, p_end date, p_marketplace text, p_sku text, p_limit integer default 100
)
returns table (
  sale_date date, transaction_id text, order_id text, transaction_type text,
  transaction_status text, description text, gross_sales numeric, promotions numeric,
  refunds numeric, amazon_fees numeric, shipping numeric, reimbursements numeric,
  net_proceeds numeric, has_unmapped_component boolean
)
language sql stable security definer set search_path = ''
as $$
  select f.sale_date, f.transaction_id, f.order_id, f.transaction_type,
    f.transaction_status, f.description, f.gross_sales, f.promotions, f.refunds,
    f.amazon_fees, f.shipping, f.reimbursements, f.net_proceeds, f.has_unmapped_component
  from public.fct_sku_finance_transaction f
  where f.sale_date between p_start and p_end
    and f.marketplace = p_marketplace and f.sku = btrim(p_sku)
  order by f.sale_date desc, f.transaction_id desc
  limit least(greatest(coalesce(p_limit, 100), 1), 100);
$$;
revoke all on function public.get_native_sku_finance_transactions(date, date, text, text, integer) from public;
grant execute on function public.get_native_sku_finance_transactions(date, date, text, text, integer) to anon, authenticated;

create or replace function public.rebuild_finance_pnl_month(p_month date)
returns void language plpgsql set search_path = ''
as $$
begin
  perform public.rebuild_int_finance_pnl_month(p_month);
  perform public.rebuild_fct_finance_pnl_month(p_month);
  perform public.rebuild_agg_finance_pnl_counts_month(p_month);
  perform public.rebuild_sku_finance_daily(p_month, (p_month + interval '1 month - 1 day')::date);
  perform public.rebuild_account_fee_daily(p_month, (p_month + interval '1 month - 1 day')::date);
  perform public.rebuild_sku_finance_transaction(p_month, (p_month + interval '1 month - 1 day')::date);
end;
$$;

select public.rebuild_sku_finance_transaction(
  (select min(sale_date) from public.int_finance_pnl_components),
  (select max(sale_date) from public.int_finance_pnl_components)
);
