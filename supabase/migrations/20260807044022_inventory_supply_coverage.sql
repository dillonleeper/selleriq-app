-- Count confirmed inbound supply before escalating a stock-risk action. The
-- base read model remains independently callable for migration compatibility.

do $$
begin
  if coalesce((select environment from public.__seller_iq_environment limit 1), '') <> 'dev' then
    raise exception 'Refusing to run: target database is not marked dev.';
  end if;
end $$;

alter function public.get_sales_overview_insights(date, date, date, date, text[], text[])
  rename to get_sales_overview_insights_base;

create function public.get_sales_overview_insights(
  p_start date,
  p_end date,
  p_prior_start date,
  p_prior_end date,
  p_markets text[],
  p_skus text[] default null
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
with payload as materialized (
  select public.get_sales_overview_insights_base(
    p_start, p_end, p_prior_start, p_prior_end, p_markets, p_skus
  ) as value
),
eligible_risks as (
  select
    risk || jsonb_build_object(
      'available_days_of_cover',
        coalesce((risk->>'available_quantity')::numeric / nullif((risk->>'units_per_day')::numeric, 0), 0),
      'days_of_cover',
        coalesce(((risk->>'available_quantity')::numeric + (risk->>'inbound_quantity')::numeric)
          / nullif((risk->>'units_per_day')::numeric, 0), 0)
    ) as risk
  from payload,
    lateral jsonb_array_elements(payload.value->'inventory_risks') risk
  where ((risk->>'available_quantity')::numeric + (risk->>'inbound_quantity')::numeric)
      / nullif((risk->>'units_per_day')::numeric, 0) < 28
),
risks as (
  select coalesce(
    jsonb_agg(risk order by (risk->>'estimated_monthly_revenue')::numeric desc),
    '[]'::jsonb
  ) as value
  from eligible_risks
)
select jsonb_set(payload.value, '{inventory_risks}', risks.value, true)
from payload cross join risks;
$function$;

grant execute on function public.get_sales_overview_insights(date, date, date, date, text[], text[]) to anon, authenticated;
