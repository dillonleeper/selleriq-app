-- Why is anon reading tables that supabase/migrations/ revokes?
--
-- Confirmed from outside the database, with the anon key from .env.local: all seven
-- tables the repo revokes are fully readable, and none of them behave like RLS is on
-- (RLS enabled with no policy returns 0 rows, not data):
--
--   sku_ldp_history               180 rows      revoked in 20260805_profitability_foundation.sql:93
--   fct_sku_profit_period         214 rows      revoked in 20260805_profitability_foundation.sql:94
--   account_profit_adjustment       2 rows      revoked in 20260805_profitability_foundation.sql:95
--   profit_reconciliation_target    6 rows      revoked in 20260805_profitability_foundation.sql:96
--   fct_sku_finance_transaction 129,980 rows    revoked in 20260807_finance_traceability.sql:99
--   fct_sku_finance_daily        27,565 rows    revoked in 20260807_native_profitability.sql:28
--   fct_account_fee_daily           578 rows    revoked in 20260807_sales_overview_fx_and_fee_breakdown.sql:147
--
-- Seven for seven is a systematic failure, not a per-table quirk. Grepping the repo rules
-- out the usual suspects: there is no `grant ... on all tables`, no `alter default
-- privileges`, no `disable row level security`, and no permissive policy on any of them
-- (the only policy in the repo is the deliberate public one on reporting_fx_rate).
--
-- Two candidate causes remain, and they cannot be told apart without catalog access:
--
--   A. Those migration statements never ran here. The repo is already known to be a
--      partial mirror rather than the source of truth -- get_native_sku_economics and
--      get_finance_pnl were live with no definition in the repo at all. If the working
--      pattern is "write SQL in the dashboard, sometimes also commit a file", the revoke
--      lines may simply never have executed. Complication: the FUNCTIONS defined in those
--      same files do exist and work, so the files were not wholly skipped.
--
--   B. Something re-granted afterwards, outside the repo. A dashboard action, a manual
--      `grant select on all tables in schema public to anon`, or default privileges
--      attached to the creating role handing SELECT to anon on every new table.
--
-- Query 1 settles it: if anon holds an explicit grant, look at whether pg_default_acl
-- (query 4) explains it. Query 3 shows whether the `enable row level security` lines took
-- effect either -- if RLS is off as well, that points hard at cause A.
--
-- All read-only.

-- 1. Actual privileges on each table. This is the ground truth.
select
  c.relname as table_name,
  pg_get_userbyid(c.relowner) as owner,
  coalesce(array_to_string(c.relacl, E'\n'), '(no explicit acl: owner-only + defaults)') as acl
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p', 'v', 'm')
  and c.relname in (
    'sku_ldp_history', 'fct_sku_profit_period', 'account_profit_adjustment',
    'profit_reconciliation_target', 'fct_sku_finance_transaction', 'fct_sku_finance_daily',
    'fct_account_fee_daily', 'stg_amz_finance_transactions', 'int_finance_pnl_components',
    'fct_finance_pnl_daily', 'agg_finance_pnl_counts_daily', 'int_fee_type_standardization',
    'fct_sales_daily', 'dim_product', 'fct_inventory_snapshot_daily'
  )
order by c.relname;

-- 2. The same thing as a flat grantee list, easier to scan for anon/authenticated/PUBLIC.
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated', 'PUBLIC', 'public', 'service_role')
group by table_name, grantee
order by table_name, grantee;

-- 3. Did the `enable row level security` lines take effect? And are there policies?
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced,
  (select count(*) from pg_policy p where p.polrelid = c.oid) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p')
order by c.relrowsecurity desc, c.relname;

-- 4. Default privileges. If this grants tables to anon, every future table is exposed on
--    creation and any one-off revoke is a losing game.
select
  pg_get_userbyid(d.defaclrole) as granting_role,
  coalesce(nsp.nspname, '(all schemas)') as schema,
  d.defaclobjtype as object_type,   -- r = table, f = function, S = sequence, T = type
  array_to_string(d.defaclacl, E'\n') as default_acl
from pg_default_acl d
left join pg_namespace nsp on nsp.oid = d.defaclnamespace
order by granting_role, schema, object_type;

-- 5. Every table in public that anon can currently read, ranked by exposure. Anything
--    here is reachable by anyone who loads the app, because NEXT_PUBLIC_SUPABASE_ANON_KEY
--    is shipped in the client bundle.
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  (select count(*) from pg_policy p where p.polrelid = c.oid) as policy_count,
  has_table_privilege('anon', c.oid, 'SELECT') as anon_can_select
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p')
  and has_table_privilege('anon', c.oid, 'SELECT')
order by c.relname;
