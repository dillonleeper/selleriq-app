-- Pin search_path on the three rebuild_*_month callees.
--
-- This makes the 2026-08-10 .. 2026-08-20 outage unrepeatable. It is not the same fix
-- that was applied by hand on 08-20 (that one was an ALTER against the live database and
-- left no record here); this is the durable version, and it is deliberately placed on the
-- CALLEES rather than the caller.
--
-- What broke
-- ----------
-- The nightly finance transform failed on every run for ten days with:
--
--   relation "int_finance_pnl_components" does not exist
--   CONTEXT: PL/pgSQL function public.rebuild_int_finance_pnl_month(date) line 11
--
-- The table was never missing. public.rebuild_finance_pnl_month is defined with
-- `set search_path = ''` (see 20260807_finance_traceability.sql line 159, and the same
-- wrapper redefined again in 20260807_native_profitability.sql and
-- 20260807_sales_overview_fx_and_fee_breakdown.sql). The three inner functions it
-- PERFORMs carried no proconfig of their own, and a plpgsql function without its own
-- search_path setting inherits the CALLER's. So they executed with an empty path and
-- every unqualified table reference in their bodies stopped resolving.
--
-- Nothing alerted. Every get_* reporting RPC survived the same empty path because their
-- bodies are schema-qualified, so the dashboard kept serving correct-looking data while
-- the rebuild silently stopped advancing past 2026-08-05. The only signal was
-- `[FIN TRANSFORM] failed` in the orchestrator's run summary.
--
-- Why the callees and not the wrapper
-- -----------------------------------
-- Three separate committed migrations recreate the wrapper with `set search_path = ''`.
-- Pinning the wrapper here would be undone by any replay of those files, and fighting
-- them would mean editing three historical migrations. Pinning the callees instead makes
-- the wrapper's setting irrelevant: it can be recreated with an empty path as often as it
-- likes, because its body qualifies its PERFORM calls as public.rebuild_*, and each
-- callee now establishes its own path on entry.
--
-- An explicit path also satisfies the "Function Search Path Mutable" advisory — the
-- finding is a *mutable* path, not a non-empty one — so this does not trade one lint for
-- another.
--
-- Scope
-- -----
-- Only these three needed it. rebuild_sku_finance_daily, rebuild_account_fee_daily and
-- rebuild_sku_finance_transaction already carry `search_path=''` AND fully qualify every
-- reference in their bodies, so they are correct as they stand and are left alone.
--
-- ALTER FUNCTION, not CREATE OR REPLACE: this changes only the functions' proconfig and
-- deliberately does not touch their bodies, which live in earlier migrations.
-- Idempotent — safe to re-run.

alter function public.rebuild_int_finance_pnl_month(date)
  set search_path = public, pg_temp;

alter function public.rebuild_fct_finance_pnl_month(date)
  set search_path = public, pg_temp;

alter function public.rebuild_agg_finance_pnl_counts_month(date)
  set search_path = public, pg_temp;

-- Guard: fail this migration if any of the three is still inheriting. Without this, a
-- future rename or signature change would make the ALTERs above silently no-op targets
-- and the bug could return unnoticed — which is exactly how it went undetected the first
-- time.
do $$
declare
  v_unpinned text;
begin
  select string_agg(p.proname, ', ' order by p.proname)
    into v_unpinned
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('rebuild_int_finance_pnl_month',
                       'rebuild_fct_finance_pnl_month',
                       'rebuild_agg_finance_pnl_counts_month')
     and (p.proconfig is null
          or not exists (select 1
                           from unnest(p.proconfig) AS cfg
                          where cfg like 'search_path=%'
                            and cfg <> 'search_path='''''));

  if v_unpinned is not null then
    raise exception
      'These finance rebuild functions still inherit search_path from their caller: %. '
      'The nightly rebuild will fail with "relation ... does not exist". See the header '
      'of this migration.', v_unpinned;
  end if;
end $$;

-- Verify:
--   SELECT p.proname, p.proconfig
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname LIKE 'rebuild_%finance%'
--    ORDER BY p.proname;
--
-- Then confirm the chain runs end to end:
--   SELECT public.rebuild_finance_pnl_month(date_trunc('month', CURRENT_DATE)::date);
