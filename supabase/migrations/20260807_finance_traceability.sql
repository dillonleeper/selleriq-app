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
