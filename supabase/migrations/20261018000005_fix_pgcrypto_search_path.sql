-- ==============================================================================
-- Migration: 20261018000005_fix_pgcrypto_search_path.sql
-- Project: Create: Project Blueprint (CPB) Federal Judiciary & High Court
-- Description: On Supabase, pgcrypto is installed in the `extensions` schema, so
--              gen_random_bytes() is not visible to functions pinned to
--              `search_path = public, pg_temp`. Add `extensions` to the path of
--              the only function that uses it.
-- ==============================================================================

alter function public.request_minecraft_linking(text, text)
    set search_path = public, extensions, pg_temp;
