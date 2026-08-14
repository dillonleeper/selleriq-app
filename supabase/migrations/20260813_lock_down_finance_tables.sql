-- Revoke browser access to the raw finance tables, for real this time.
--
-- NEXT_PUBLIC_SUPABASE_ANON_KEY ships inside the client bundle, so every table anon can
-- read is readable by anyone who loads the app. Verified with that key that all seven
-- tables supabase/migrations/ already tries to revoke are fully readable anyway, along
-- with two raw sources that were never revoked at all. See scripts/diagnose-table-grants.sql
-- for the evidence and for the two candidate root causes.
--
-- This migration is written to be correct under either cause: it re-issues the revokes,
-- enables RLS, and -- unlike the earlier attempts -- is followed by a verification query
-- so a silent failure cannot pass as success again. It is idempotent; running it twice is
-- harmless.
--
-- WHY REVOKING IS SAFE FOR THESE NINE TABLES. Every function that reads them is SECURITY
-- DEFINER, so it executes as its owner and keeps working after anon loses SELECT:
--
--   table                          read by                                    mode
--   stg_amz_finance_transactions   get_native_sku_economics                   DEFINER
--                                  rebuild_sku_finance_daily/_transaction     DEFINER
--   fct_sku_finance_daily          get_native_sku_profitability               DEFINER
--                                  get_native_profitability_coverage          DEFINER
--                                  get_native_finance_daily_series            DEFINER
--   int_finance_pnl_components     rebuild_sku_finance_daily                  DEFINER
--   fct_sku_finance_transaction    get_native_sku_finance_transactions        DEFINER
--   fct_account_fee_daily          get_native_account_fee_breakdown           DEFINER
--   sku_ldp_history                get_native_sku_economics                   DEFINER
--                                  app/api/ldp/route.ts                       service_role
--   fct_sku_profit_period          get_contribution_profit                    DEFINER
--   account_profit_adjustment      get_profit_reconciliation                  DEFINER
--   profit_reconciliation_target   get_profit_reconciliation                  DEFINER
--
-- RLS does not interfere with those functions: a table's owner bypasses RLS unless FORCE
-- is set, and these functions and tables share the postgres owner. Query 1 of the
-- diagnostic script confirms the owners; check it before trusting that sentence.
--
-- service_role is deliberately NOT revoked -- app/api/ldp/route.ts writes sku_ldp_history
-- through lib/supabaseAdmin.ts with the service key.
--
-- THE THREE P&L TABLES ARE NOW CLOSED TOO. They were left exposed in the first draft of
-- this file because get_finance_pnl was SECURITY INVOKER, so revoking them would have
-- broken Sales Overview. That decision has since been made deliberately: the section at
-- the bottom converts get_finance_pnl to SECURITY DEFINER with a pinned search_path and
-- then revokes all three. Function first, revokes second -- reversing that order leaves a
-- window where Sales Overview is broken.
--
--   fct_finance_pnl_daily          get_finance_pnl now DEFINER -> safe to revoke
--   agg_finance_pnl_counts_daily   get_finance_pnl now DEFINER -> safe to revoke
--   int_fee_type_standardization   get_finance_pnl now DEFINER -> safe to revoke
--
-- WHAT THIS MIGRATION STILL LEAVES EXPOSED, and why. Revoking any of these breaks a
-- working page, because the function that reads them is SECURITY INVOKER (it runs as
-- anon) or the browser queries the table directly:
--
--   fct_sales_daily                get_sku_sales_series and the other get_sales_overview*
--                                  and get_sku_sales* functions are all INVOKER
--   dim_product                    read directly by app/inventory/page.tsx:1040 (anon)
--                                  and by search_products, which is INVOKER
--   fct_inventory_snapshot_daily   read directly by app/inventory/page.tsx:950,967 (anon)
--   reporting_fx_rate              intentionally public: has its own read policy

alter table public.stg_amz_finance_transactions enable row level security;
revoke all on public.stg_amz_finance_transactions from anon, authenticated, public;

alter table public.fct_sku_finance_daily enable row level security;
revoke all on public.fct_sku_finance_daily from anon, authenticated, public;

alter table public.int_finance_pnl_components enable row level security;
revoke all on public.int_finance_pnl_components from anon, authenticated, public;

alter table public.fct_sku_finance_transaction enable row level security;
revoke all on public.fct_sku_finance_transaction from anon, authenticated, public;

alter table public.fct_account_fee_daily enable row level security;
revoke all on public.fct_account_fee_daily from anon, authenticated, public;

alter table public.sku_ldp_history enable row level security;
revoke all on public.sku_ldp_history from anon, authenticated, public;

alter table public.fct_sku_profit_period enable row level security;
revoke all on public.fct_sku_profit_period from anon, authenticated, public;

alter table public.account_profit_adjustment enable row level security;
revoke all on public.account_profit_adjustment from anon, authenticated, public;

alter table public.profit_reconciliation_target enable row level security;
revoke all on public.profit_reconciliation_target from anon, authenticated, public;

-- Verification. Run this in the same session, immediately after the statements above.
-- anon_can_select must be false and rls_enabled must be true on all nine rows. If any row
-- still says true/false, the revoke was undone by something outside this file and cause B
-- in the diagnostic script is the one to chase.
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  has_table_privilege('anon', c.oid, 'SELECT') as anon_can_select,
  has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_can_select,
  has_table_privilege('service_role', c.oid, 'SELECT') as service_role_can_select
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'stg_amz_finance_transactions', 'fct_sku_finance_daily', 'int_finance_pnl_components',
    'fct_sku_finance_transaction', 'fct_account_fee_daily', 'sku_ldp_history',
    'fct_sku_profit_period', 'account_profit_adjustment', 'profit_reconciliation_target'
  )
order by c.relname;

-- After applying, confirm the app still works: the Profitability page (all three RPCs),
-- the Sales Overview page, the Inventory page, and the LDP editor under app/api/ldp.
-- All of those go through SECURITY DEFINER functions or the service key, so they should be
-- unaffected -- but this migration removes read access from the key the browser uses, so
-- it is worth clicking through rather than assuming.

-- ---------------------------------------------------------------------------
-- STEP 3: close fct_finance_pnl_daily and friends.
--
-- Converts get_finance_pnl to SECURITY DEFINER so it keeps reading these three tables
-- after anon loses SELECT. Verbatim from the live definition recorded in
-- 20260813_baseline_live_routines.sql, with exactly three changes:
--
--   1. security definer      -- runs as the function owner, not the caller
--   2. set search_path = ''  -- mandatory with DEFINER; stops search_path hijacking
--   3. public.-qualified table references, because (2) empties the search path
--
-- The signature and RETURNS TABLE list are byte-identical to the live version, so
-- CREATE OR REPLACE succeeds (it cannot alter a return type). The body references only
-- pg_catalog built-ins besides those three tables -- min, bool_or, sum, coalesce,
-- initcap, replace, round, ::int -- and pg_catalog is always implicitly on the search
-- path, so `set search_path = ''` does not break them.
--
-- CREATE OR REPLACE preserves the existing owner and the existing EXECUTE grants, so
-- anon keeps its right to call this function.

create or replace function public.get_finance_pnl(p_start date, p_end date, p_marketplace text default null::text)
 returns table(pnl_category text, widget_line text, display_order integer, include_in_operating_sum boolean, is_expandable boolean, amount_usd numeric, event_count integer, deferred_count integer)
 language sql
 stable
 security definer
 set search_path = ''
 set work_mem to '64MB'
as $function$
    with cat as (
        select pnl_category,
               min(widget_line) as widget_line,
               min(display_order) as display_order,
               bool_or(include_in_operating_sum) as include_in_operating_sum,
               bool_or(is_expandable) as is_expandable
        from public.int_fee_type_standardization
        group by pnl_category
    ),
    amt as (
        select pnl_category, sum(amount_usd) as amount_usd
        from public.fct_finance_pnl_daily
        where sale_date between p_start and p_end
          and (p_marketplace is null or marketplace = p_marketplace)
        group by pnl_category
    ),
    cnt as (
        select pnl_category,
               sum(txn_count)::int as event_count,
               sum(deferred_count)::int as deferred_count
        from public.agg_finance_pnl_counts_daily
        where sale_date between p_start and p_end
          and (p_marketplace is null or marketplace = p_marketplace)
        group by pnl_category
    )
    select
        a.pnl_category,
        coalesce(c.widget_line, initcap(replace(a.pnl_category, '_', ' '))),
        coalesce(c.display_order, 99),
        coalesce(c.include_in_operating_sum, true),
        coalesce(c.is_expandable, false),
        round(a.amount_usd, 2),
        coalesce(n.event_count, 0)::int,
        coalesce(n.deferred_count, 0)::int
    from amt a
    left join cat c using (pnl_category)
    left join cnt n using (pnl_category)
    order by coalesce(c.display_order, 99);
$function$;

-- Only now, with the function no longer running as the caller, is it safe to revoke.
alter table public.fct_finance_pnl_daily enable row level security;
revoke all on public.fct_finance_pnl_daily from anon, authenticated, public;
alter table public.agg_finance_pnl_counts_daily enable row level security;
revoke all on public.agg_finance_pnl_counts_daily from anon, authenticated, public;
alter table public.int_fee_type_standardization enable row level security;
revoke all on public.int_fee_type_standardization from anon, authenticated, public;

-- Step 3 verification. anon_can_select must be false and rls_enabled true on all three.
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  has_table_privilege('anon', c.oid, 'SELECT') as anon_can_select,
  has_table_privilege('service_role', c.oid, 'SELECT') as service_role_can_select
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'fct_finance_pnl_daily', 'agg_finance_pnl_counts_daily', 'int_fee_type_standardization'
  )
order by c.relname;

-- And confirm the function actually flipped: security_definer must be true, config must
-- pin search_path, and anon must still hold EXECUTE (CREATE OR REPLACE preserves it, but
-- this is the assumption the whole step rests on -- if anon lost EXECUTE, Sales Overview
-- returns 404 PGRST202 rather than a permission error, which is easy to misdiagnose).
select
  p.proname,
  p.prosecdef as security_definer,
  p.proconfig as config,
  pg_get_userbyid(p.proowner) as owner,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'get_finance_pnl';

-- ---------------------------------------------------------------------------
-- OPTIONAL FOLLOW-UP 2: stop the bleeding for future tables.
-- If query 4 of scripts/diagnose-table-grants.sql shows default privileges handing tables
-- to anon, then every new table is exposed the moment it is created and per-table revokes
-- will keep losing. Substitute the actual granting role reported by that query.
--
-- alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
