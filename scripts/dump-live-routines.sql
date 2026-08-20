-- Run these in the Supabase SQL editor and paste the output back.
--
-- Why this exists: several routines the app calls are live in the database but have no
-- definition in supabase/migrations/ -- get_native_sku_economics and get_finance_pnl are
-- the two the Profitability and Sales Overview pages depend on. They cannot be recovered
-- from the repo, and they cannot be read with the anon key, so the baseline migration has
-- to be generated from the live database rather than reconstructed by hand.
--
-- Do not skip this and hand-write the baseline. A reconstructed body committed as
-- `create or replace function` would overwrite the live definition with a guess the next
-- time migrations run, silently changing financial figures that currently reconcile.

-- 1. Full inventory of public routines, to see everything that has drifted.
--    Diff this list against the `create or replace function` lines in supabase/migrations/.
select
  p.proname                                    as routine,
  pg_get_function_identity_arguments(p.oid)    as args,
  p.prokind                                    as kind,      -- f = function, p = procedure
  p.prosecdef                                  as security_definer,
  pg_get_userbyid(p.proowner)                  as owner
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by p.proname, args;

-- 2. Exact source of the two routines the app calls but the repo does not define.
--    pg_get_functiondef emits a complete, replayable `CREATE OR REPLACE FUNCTION`
--    statement, which is what belongs in the baseline migration verbatim.
select pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_native_sku_economics', 'get_finance_pnl')
order by p.proname, pg_get_function_identity_arguments(p.oid);

-- 3. Current grants on those routines, so the baseline reproduces them exactly.
select
  p.proname                                 as routine,
  pg_get_function_identity_arguments(p.oid) as args,
  coalesce(array_to_string(p.proacl, E'\n'), '(default: owner + PUBLIC)') as acl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('get_native_sku_economics', 'get_finance_pnl')
order by p.proname, args;

-- 4. Does any daily table carry units? This decides whether recognized COGS can join
--    the daily series. get_native_sku_economics returns shipped_units, refunded_units,
--    and net_units_for_cogs, but no table in supabase/migrations/ has a units column at
--    a daily grain, so its unit source is unknown from the repo alone. Whatever query 2
--    reveals as that source is what a daily COGS series would have to reuse.
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and (column_name like '%unit%' or column_name like '%quantity%' or column_name = 'qty')
order by table_name, column_name;
