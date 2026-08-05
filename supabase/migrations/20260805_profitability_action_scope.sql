-- Keep the initial action list focused on SKUs with selling activity.

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

