
-- Reconcile account-level differences by their own metric while retaining a
-- signed contribution-profit adjustment. Positive amounts increase profit;
-- negative amounts decrease it.

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
      round(sum(amazon_fees), 2) as amazon_fees,
      round(sum(ldp_cost), 2) as ldp_cost,
      round(sum(sales - promotional_discounts - advertising_cost - refund_cost
                - amazon_fees - ldp_cost - shipping_cost - indirect_expenses), 2)
        as product_contribution_profit
    from public.fct_sku_profit_period
    where period_start >= p_start and period_end <= p_end and marketplace = p_marketplace
  ), adjustment_totals as (
    select
      coalesce(sum(amount) filter (
        where allocation_status = 'unallocated' and category = 'advertising_cost'
      ), 0) as advertising_cost,
      coalesce(sum(amount) filter (
        where allocation_status = 'unallocated' and category = 'refund_cost'
      ), 0) as refund_cost,
      coalesce(sum(amount) filter (
        where allocation_status = 'unallocated' and category = 'amazon_fees'
      ), 0) as amazon_fees,
      coalesce(sum(amount) filter (
        where allocation_status = 'unallocated' and category = 'ldp_cost'
      ), 0) as ldp_cost,
      coalesce(sum(amount) filter (where allocation_status = 'unallocated'), 0)
        as contribution_profit
    from public.account_profit_adjustment
    where period_start >= p_start and period_end <= p_end and marketplace = p_marketplace
  ), calculated as (
    select 'sales'::text metric, p.sales amount
    from product_totals p
    union all select 'advertising_cost', p.advertising_cost - a.advertising_cost
      from product_totals p cross join adjustment_totals a
    union all select 'refund_cost', p.refund_cost - a.refund_cost
      from product_totals p cross join adjustment_totals a
    union all select 'amazon_fees', p.amazon_fees - a.amazon_fees
      from product_totals p cross join adjustment_totals a
    union all select 'ldp_cost', p.ldp_cost - a.ldp_cost
      from product_totals p cross join adjustment_totals a
    union all select 'contribution_profit',
      p.product_contribution_profit + a.contribution_profit
      from product_totals p cross join adjustment_totals a
  )
  select c.metric, c.amount, t.target_amount,
    round(c.amount - t.target_amount, 2),
    case
      when t.target_amount is null then 'no_target'
      when abs(c.amount - t.target_amount) <= 0.05 then 'reconciled'
      else 'difference'
    end
  from calculated c
  left join public.profit_reconciliation_target t
    on t.period_start = p_start and t.period_end = p_end
   and t.marketplace = p_marketplace and t.metric = c.metric
  order by c.metric;
$$;

revoke all on function public.get_profit_reconciliation(date, date, text) from public;
grant execute on function public.get_profit_reconciliation(date, date, text) to anon, authenticated;


