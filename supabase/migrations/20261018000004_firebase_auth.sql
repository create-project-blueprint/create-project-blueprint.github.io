-- ==============================================================================
-- Migration: 20261018000004_firebase_auth.sql
-- Project: Create: Project Blueprint (CPB) Federal Judiciary & High Court
-- Description: Switch identity from Supabase Auth to Firebase Auth (Supabase
--              third-party auth). Firebase UIDs are not UUIDs, so all user-ID
--              columns become text, auth.uid() is replaced by
--              public.current_user_id(), and profiles are created on demand by
--              public.ensure_my_profile() instead of an auth.users trigger.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Private settings (not exposed through the Data API)
-- ------------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.settings (
    key text primary key,
    value text not null
);

-- Set your Firebase project ID after deploying (see JUDICIARY_SETUP.md):
--   insert into private.settings (key, value) values ('firebase_project_id', '<id>')
--   on conflict (key) do update set value = excluded.value;
-- Until it is set, no Firebase token is accepted (fail closed).

create or replace function public.firebase_project_id()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select value from private.settings where key = 'firebase_project_id';
$$;

-- ------------------------------------------------------------------------------
-- 2. Caller identity: Firebase UID from a token issued for OUR Firebase project
-- ------------------------------------------------------------------------------
-- Firebase signs tokens for every Firebase project with the same keys, so the
-- issuer and audience must be checked, not just the signature.
create or replace function public.current_user_id()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select case
        when public.firebase_project_id() is not null
         and (auth.jwt() ->> 'iss') = 'https://securetoken.google.com/' || public.firebase_project_id()
         and (auth.jwt() ->> 'aud') = public.firebase_project_id()
        then nullif(auth.jwt() ->> 'sub', '')
    end;
$$;

-- ------------------------------------------------------------------------------
-- 3. Remove Supabase Auth coupling
-- ------------------------------------------------------------------------------
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

-- Drop every RLS policy on the judiciary tables (they reference columns whose
-- type changes below); they are recreated in section 7.
do $$
declare
    r record;
begin
    for r in
        select schemaname, tablename, policyname
        from pg_policies
        where schemaname = 'public'
          and tablename in ('profiles', 'profile_verifications', 'cases', 'filings', 'case_events')
    loop
        execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    end loop;
end $$;

-- Drop foreign keys to auth.users and to profiles(id) before changing types
do $$
declare
    r record;
begin
    for r in
        select con.conname, rel.relname
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace ns on ns.oid = rel.relnamespace
        where con.contype = 'f'
          and ns.nspname = 'public'
          and rel.relname in ('profiles', 'profile_verifications', 'cases', 'filings', 'case_events')
          and con.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)
    loop
        execute format('alter table public.%I drop constraint %I', r.relname, r.conname);
    end loop;
end $$;

-- ------------------------------------------------------------------------------
-- 4. User-ID columns: uuid -> text
-- ------------------------------------------------------------------------------
alter table public.profiles
    alter column id type text using id::text,
    alter column verified_by_user_id type text using verified_by_user_id::text;

alter table public.profile_verifications
    alter column user_id type text using user_id::text;

alter table public.cases
    alter column plaintiff_user_id type text using plaintiff_user_id::text,
    alter column defendant_user_id type text using defendant_user_id::text,
    alter column assigned_judge_id type text using assigned_judge_id::text,
    alter column created_by type text using created_by::text;

alter table public.filings
    alter column submitter_id type text using submitter_id::text,
    alter column reviewed_by type text using reviewed_by::text;

alter table public.case_events
    alter column actor_id type text using actor_id::text;

-- Profiles left over from Supabase Auth sign-ins can never match a Firebase UID
delete from public.profiles where id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Clear references to removed profiles so the foreign keys below can be added
delete from public.profile_verifications v where not exists (select 1 from public.profiles p where p.id = v.user_id);
delete from public.filings f where not exists (select 1 from public.profiles p where p.id = f.submitter_id);
update public.profiles x set verified_by_user_id = null where verified_by_user_id is not null and not exists (select 1 from public.profiles p where p.id = x.verified_by_user_id);
update public.filings x set reviewed_by = null where reviewed_by is not null and not exists (select 1 from public.profiles p where p.id = x.reviewed_by);
update public.case_events x set actor_id = null where actor_id is not null and not exists (select 1 from public.profiles p where p.id = x.actor_id);
update public.cases x set plaintiff_user_id = null where plaintiff_user_id is not null and not exists (select 1 from public.profiles p where p.id = x.plaintiff_user_id);
update public.cases x set defendant_user_id = null where defendant_user_id is not null and not exists (select 1 from public.profiles p where p.id = x.defendant_user_id);
update public.cases x set assigned_judge_id = null where assigned_judge_id is not null and not exists (select 1 from public.profiles p where p.id = x.assigned_judge_id);
update public.cases x set created_by = null where created_by is not null and not exists (select 1 from public.profiles p where p.id = x.created_by);

-- Re-link everything to public.profiles
alter table public.profile_verifications
    add constraint profile_verifications_user_id_fkey foreign key (user_id) references public.profiles(id) on delete cascade;
alter table public.profiles
    add constraint profiles_verified_by_user_id_fkey foreign key (verified_by_user_id) references public.profiles(id) on delete set null;
alter table public.cases
    add constraint cases_plaintiff_user_id_fkey foreign key (plaintiff_user_id) references public.profiles(id) on delete set null,
    add constraint cases_defendant_user_id_fkey foreign key (defendant_user_id) references public.profiles(id) on delete set null,
    add constraint cases_assigned_judge_id_fkey foreign key (assigned_judge_id) references public.profiles(id) on delete set null,
    add constraint cases_created_by_fkey foreign key (created_by) references public.profiles(id) on delete set null;
alter table public.filings
    add constraint filings_submitter_id_fkey foreign key (submitter_id) references public.profiles(id) on delete cascade,
    add constraint filings_reviewed_by_fkey foreign key (reviewed_by) references public.profiles(id) on delete set null;
alter table public.case_events
    add constraint case_events_actor_id_fkey foreign key (actor_id) references public.profiles(id) on delete set null;

-- ------------------------------------------------------------------------------
-- 5. Role helpers (now keyed on current_user_id())
-- ------------------------------------------------------------------------------
create or replace function public.get_my_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(
        (select role from public.profiles where id = public.current_user_id()),
        'anon'
    );
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select exists (
        select 1 from public.profiles
        where id = public.current_user_id() and role in ('clerk', 'judge', 'admin')
    );
$$;

create or replace function public.is_judge()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select exists (
        select 1 from public.profiles
        where id = public.current_user_id() and role in ('judge', 'admin')
    );
$$;

create or replace function public.is_clerk()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select exists (
        select 1 from public.profiles
        where id = public.current_user_id() and role in ('clerk', 'admin')
    );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select exists (
        select 1 from public.profiles
        where id = public.current_user_id() and role = 'admin'
    );
$$;

-- ------------------------------------------------------------------------------
-- 6. Profile provisioning (replaces the auth.users trigger)
-- ------------------------------------------------------------------------------
-- Called by the site after every sign-in. Creates the caller's profile from the
-- verified Firebase token claims, or refreshes email/name/avatar.
create or replace function public.ensure_my_profile()
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id text;
    v_claims jsonb;
    v_profile public.profiles;
begin
    v_user_id := public.current_user_id();
    if v_user_id is null then
        raise exception 'Authentication required.';
    end if;

    v_claims := auth.jwt();

    insert into public.profiles (id, email, full_name, avatar_url, role, verification_status, created_at, updated_at)
    values (
        v_user_id,
        v_claims ->> 'email',
        coalesce(v_claims ->> 'name', split_part(v_claims ->> 'email', '@', 1)),
        v_claims ->> 'picture',
        'player',
        'unlinked',
        now(),
        now()
    )
    on conflict (id) do update set
        email = excluded.email,
        full_name = coalesce(public.profiles.full_name, excluded.full_name),
        avatar_url = coalesce(public.profiles.avatar_url, excluded.avatar_url),
        updated_at = now()
    returning * into v_profile;

    return v_profile;
end;
$$;

-- Filing sanitizer: same rules as before, keyed on Firebase identity
create or replace function public.trig_sanitize_filing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_profile public.profiles%rowtype;
begin
    -- service_role / migrations have no caller identity; staff workflows are trusted
    if public.current_user_id() is null or public.is_staff() then
        return new;
    end if;

    if tg_op = 'INSERT' then
        select * into v_profile from public.profiles where id = public.current_user_id();

        new.submitter_id := public.current_user_id();
        new.submitter_email := v_profile.email;
        new.submitter_minecraft_username := v_profile.minecraft_username;
        new.submitter_verified := coalesce(v_profile.verification_status = 'verified', false);
        new.submitter_minecraft_uuid := case when new.submitter_verified then v_profile.minecraft_uuid else null end;
        new.status := 'pending_review';
        new.review_notes := null;
        new.reviewed_by := null;
        new.docketed_case_id := null;
        new.reference_number := null; -- assigned by assign_filing_reference_trig
        new.created_at := now();
        new.updated_at := now();
    else
        -- Submitter edits may only touch the filing's content
        new.id := old.id;
        new.reference_number := old.reference_number;
        new.filing_type := old.filing_type;
        new.is_confidential := old.is_confidential;
        new.submitter_id := old.submitter_id;
        new.submitter_email := old.submitter_email;
        new.submitter_minecraft_username := old.submitter_minecraft_username;
        new.submitter_minecraft_uuid := old.submitter_minecraft_uuid;
        new.submitter_verified := old.submitter_verified;
        new.status := old.status;
        new.review_notes := old.review_notes;
        new.reviewed_by := old.reviewed_by;
        new.docketed_case_id := old.docketed_case_id;
        new.created_at := old.created_at;
        new.updated_at := now();
    end if;

    return new;
end;
$$;

-- ------------------------------------------------------------------------------
-- 7. Row Level Security policies (recreated with current_user_id())
-- ------------------------------------------------------------------------------

-- PROFILES
create policy "Users can view own profile or staff can view"
    on public.profiles for select
    to authenticated
    using (public.current_user_id() = id or public.is_staff());

-- Protected fields (role, verification, email, Minecraft identity) are blocked
-- by trig_protect_profile_fields
create policy "Users can update own display profile"
    on public.profiles for update
    to authenticated
    using (public.current_user_id() = id)
    with check (public.current_user_id() = id);

create policy "Admins can update any profile"
    on public.profiles for update
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());

-- PROFILE VERIFICATIONS
create policy "View verification request"
    on public.profile_verifications for select
    to authenticated
    using (
        public.current_user_id() = user_id
        or public.is_clerk()
        or public.is_admin()
    );

-- CASES
create policy "Read cases"
    on public.cases for select
    using (
        is_published = true
        or public.is_staff()
        or public.current_user_id() = plaintiff_user_id
        or public.current_user_id() = defendant_user_id
        or public.current_user_id() = created_by
    );

-- Clerks docket via docket_filing() and change status via update_case_status()
create policy "Judges can create cases"
    on public.cases for insert
    to authenticated
    with check (public.is_judge());

create policy "Judges can update cases"
    on public.cases for update
    to authenticated
    using (public.is_judge())
    with check (public.is_judge());

create policy "Admins can delete cases"
    on public.cases for delete
    to authenticated
    using (public.is_admin());

-- FILINGS
create policy "View filings"
    on public.filings for select
    to authenticated
    using (
        public.current_user_id() = submitter_id
        or public.is_staff()
    );

create policy "Create filings"
    on public.filings for insert
    to authenticated
    with check (public.current_user_id() = submitter_id);

create policy "Update pending filings"
    on public.filings for update
    to authenticated
    using (
        (public.current_user_id() = submitter_id and status = 'pending_review')
        or public.is_staff()
    );

create policy "Admins can delete filings"
    on public.filings for delete
    to authenticated
    using (public.is_admin());

-- CASE EVENTS
create policy "Read case events"
    on public.case_events for select
    using (
        (is_public = true and exists (select 1 from public.cases c where c.id = case_id and c.is_published = true))
        or public.is_staff()
        or exists (
            select 1 from public.cases c
            where c.id = case_id
              and (c.plaintiff_user_id = public.current_user_id() or c.defendant_user_id = public.current_user_id())
        )
    );

create policy "Staff can insert case events"
    on public.case_events for insert
    to authenticated
    with check (public.is_staff());

create policy "Staff can modify case events"
    on public.case_events for update
    to authenticated
    using (public.is_staff());

create policy "Admins can delete case events"
    on public.case_events for delete
    to authenticated
    using (public.is_admin());

-- ------------------------------------------------------------------------------
-- 8. Workflow procedures (recreated with current_user_id() and text user IDs)
-- ------------------------------------------------------------------------------
drop function if exists public.verify_minecraft_profile(uuid, text, text);
drop function if exists public.admin_set_user_role(uuid, text);

create or replace function public.request_minecraft_linking(
    p_minecraft_username text,
    p_minecraft_uuid text
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user_id text;
    v_clean_username text;
    v_clean_uuid text;
    v_token text;
    v_existing_verified_id text;
begin
    v_user_id := public.current_user_id();
    if v_user_id is null then
        raise exception 'Authentication required to link Minecraft profile.';
    end if;

    v_clean_username := trim(p_minecraft_username);
    v_clean_uuid := lower(trim(p_minecraft_uuid));

    if v_clean_username is null or not (v_clean_username ~ '^[a-zA-Z0-9_]{3,16}$') then
        raise exception 'Invalid Minecraft username format. Must be 3-16 alphanumeric or underscore characters.';
    end if;

    if v_clean_uuid is not null and v_clean_uuid <> '' then
        if not (v_clean_uuid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
            raise exception 'Invalid Minecraft UUID format.';
        end if;

        select id into v_existing_verified_id
        from public.profiles
        where minecraft_uuid = v_clean_uuid and verification_status = 'verified' and id <> v_user_id;

        if v_existing_verified_id is not null then
            raise exception 'This Minecraft account is already verified by another CPB profile. Contact server administration for dispute resolution.';
        end if;
    end if;

    v_token := 'CPB-' || upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8));

    insert into public.profile_verifications (
        user_id, target_minecraft_username, target_minecraft_uuid, verification_token, created_at, expires_at
    )
    values (
        v_user_id,
        v_clean_username,
        coalesce(nullif(v_clean_uuid, ''), '00000000-0000-0000-0000-000000000000'),
        v_token,
        now(),
        now() + interval '2 hours'
    )
    on conflict (user_id) do update set
        target_minecraft_username = excluded.target_minecraft_username,
        target_minecraft_uuid = excluded.target_minecraft_uuid,
        verification_token = excluded.verification_token,
        created_at = now(),
        expires_at = now() + interval '2 hours';

    update public.profiles
    set minecraft_username = v_clean_username,
        verification_status = 'pending_verification',
        updated_at = now()
    where id = v_user_id;

    return json_build_object(
        'status', 'pending_verification',
        'minecraft_username', v_clean_username,
        'minecraft_uuid', v_clean_uuid,
        'verification_token', v_token,
        'expires_in_minutes', 120
    );
end;
$$;

create or replace function public.verify_minecraft_profile(
    p_target_user_id text,
    p_verified_username text,
    p_verified_uuid text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_existing_id text;
    v_clean_username text;
    v_clean_uuid text;
begin
    if not public.is_clerk() and not public.is_admin() then
        raise exception 'Access denied: Judicial Clerk or Administrator authorization required to verify identities.';
    end if;

    v_clean_username := trim(p_verified_username);
    v_clean_uuid := lower(trim(p_verified_uuid));

    if not (v_clean_username ~ '^[a-zA-Z0-9_]{3,16}$') then
        raise exception 'Invalid Minecraft username syntax.';
    end if;

    if not (v_clean_uuid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
        raise exception 'Invalid Minecraft UUID format.';
    end if;

    select id into v_existing_id
    from public.profiles
    where minecraft_uuid = v_clean_uuid and verification_status = 'verified' and id <> p_target_user_id;

    if v_existing_id is not null then
        raise exception 'Conflict: That Minecraft UUID is already verified for citizen profile %.', v_existing_id;
    end if;

    update public.profiles
    set minecraft_username = v_clean_username,
        minecraft_uuid = v_clean_uuid,
        verification_status = 'verified',
        verification_method = 'manual_clerk',
        verified_by_user_id = public.current_user_id(),
        minecraft_verified_at = now(),
        updated_at = now()
    where id = p_target_user_id;

    delete from public.profile_verifications where user_id = p_target_user_id;

    return true;
end;
$$;

create or replace function public.docket_filing(
    p_filing_id uuid,
    p_assigned_judge text default 'Chamber Magistrate',
    p_initial_order text default 'Filing accepted and docketed for judicial review.'
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_filing public.filings%rowtype;
    v_case_type text;
    v_docket_num text;
    v_new_case_id uuid;
    v_actor_id text;
begin
    if not public.is_staff() then
        raise exception 'Access denied: Clerk or Judicial authorization required to docket cases.';
    end if;

    v_actor_id := public.current_user_id();

    select * into v_filing
    from public.filings
    where id = p_filing_id
    for update;

    if not found then
        raise exception 'Filing with ID % not found.', p_filing_id;
    end if;

    if v_filing.status <> 'pending_review' then
        raise exception 'Filing % has already been processed (current status: %).', p_filing_id, v_filing.status;
    end if;

    if v_filing.filing_type = 'tip' or v_filing.is_confidential then
        raise exception 'Confidential tips cannot be converted into public docketed cases via normal docketing. A separate, sanitized indictment must be created by authorized prosecutors or magistrates.';
    end if;

    if v_filing.filing_type = 'appeal' then
        v_case_type := 'appeal';
    else
        v_case_type := 'civil';
    end if;

    v_docket_num := public.generate_docket_number(v_case_type);

    insert into public.cases (
        docket_number, case_type, title, summary, matter,
        plaintiff_name, plaintiff_uuid, plaintiff_user_id,
        defendant_name, defendant_uuid,
        status, assigned_judge, assigned_judge_id, current_order, pleadings,
        is_published, originating_filing_id, created_by, created_at, updated_at
    )
    values (
        v_docket_num,
        v_case_type,
        v_filing.title,
        v_filing.details,
        coalesce(v_filing.relief_sought, 'Formal Judicial Adjudication'),
        coalesce(v_filing.submitter_minecraft_username, v_filing.submitter_email, 'Petitioner'),
        v_filing.submitter_minecraft_uuid,
        v_filing.submitter_id,
        coalesce(v_filing.target_party_name, 'Respondent / Server State'),
        v_filing.target_party_uuid,
        'in_deliberation',
        p_assigned_judge,
        v_actor_id,
        p_initial_order,
        v_filing.details,
        true,
        v_filing.id,
        v_actor_id,
        now(),
        now()
    )
    returning id into v_new_case_id;

    update public.filings
    set status = 'docketed',
        reviewed_by = v_actor_id,
        docketed_case_id = v_new_case_id,
        updated_at = now()
    where id = p_filing_id;

    insert into public.case_events (case_id, event_type, description, actor_id, actor_name, is_public, created_at)
    values (
        v_new_case_id,
        'filing_docketed',
        'Filing #' || v_filing.reference_number || ' accepted and docketed under official number ' || v_docket_num || '.',
        v_actor_id,
        coalesce((select full_name from public.profiles where id = v_actor_id), 'Clerk of Court'),
        true,
        now()
    );

    return json_build_object(
        'case_id', v_new_case_id,
        'docket_number', v_docket_num,
        'status', 'docketed'
    );
end;
$$;

create or replace function public.review_confidential_tip(
    p_filing_id uuid,
    p_action text,
    p_notes text default null
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_filing public.filings%rowtype;
    v_new_status text;
begin
    if not public.is_staff() then
        raise exception 'Access denied: Judicial or Clerk authorization required.';
    end if;

    select * into v_filing
    from public.filings
    where id = p_filing_id
    for update;

    if not found then
        raise exception 'Filing % not found.', p_filing_id;
    end if;

    if v_filing.filing_type <> 'tip' and not v_filing.is_confidential then
        raise exception 'This review workflow is strictly reserved for confidential tips.';
    end if;

    if p_action = 'investigate' then
        v_new_status := 'under_investigation';
    elsif p_action = 'close' then
        v_new_status := 'closed';
    elsif p_action = 'reject' then
        v_new_status := 'rejected';
    else
        raise exception 'Invalid tip action (must be investigate, close, or reject).';
    end if;

    update public.filings
    set status = v_new_status,
        review_notes = p_notes,
        reviewed_by = public.current_user_id(),
        updated_at = now()
    where id = p_filing_id;

    return json_build_object(
        'filing_id', p_filing_id,
        'reference_number', v_filing.reference_number,
        'status', v_new_status
    );
end;
$$;

create or replace function public.update_case_status(
    p_case_id uuid,
    p_status text,
    p_current_order text default null,
    p_event_desc text default null,
    p_is_published boolean default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_old_status text;
    v_actor_name text;
begin
    if not public.is_staff() then
        raise exception 'Access denied: Staff authorization required.';
    end if;

    if p_status not in ('pending_review', 'in_deliberation', 'hearing_scheduled', 'verdict_rendered', 'appealed', 'dismissed', 'closed') then
        raise exception 'Invalid case status: %.', p_status;
    end if;

    if (
        p_current_order is not null
        or p_status in ('verdict_rendered', 'dismissed', 'closed')
        or p_is_published is not null
    ) then
        if not public.is_judge() and not public.is_admin() then
            raise exception 'Access denied: Only appointed Judges or Administrators may issue court orders, render verdicts, or modify publication status.';
        end if;
    end if;

    select status into v_old_status from public.cases where id = p_case_id;
    if not found then
        raise exception 'Case % not found.', p_case_id;
    end if;

    select coalesce(full_name, email, 'Court Officer') into v_actor_name
    from public.profiles where id = public.current_user_id();

    update public.cases
    set status = p_status,
        current_order = coalesce(p_current_order, current_order),
        is_published = coalesce(p_is_published, is_published),
        updated_at = now()
    where id = p_case_id;

    if p_event_desc is not null and length(trim(p_event_desc)) > 0 then
        insert into public.case_events (case_id, event_type, description, actor_id, actor_name, is_public, created_at)
        values (p_case_id, 'status_changed', p_event_desc, public.current_user_id(), v_actor_name, true, now());
    end if;

    return true;
end;
$$;

create or replace function public.admin_set_user_role(
    p_target_user_id text,
    p_new_role text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if not public.is_admin() then
        raise exception 'Access denied: Only system administrators may assign staff roles.';
    end if;

    if p_new_role not in ('player', 'clerk', 'judge', 'admin') then
        raise exception 'Invalid role: % (must be player, clerk, judge, or admin).', p_new_role;
    end if;

    update public.profiles
    set role = p_new_role,
        updated_at = now()
    where id = p_target_user_id;

    return true;
end;
$$;

-- ------------------------------------------------------------------------------
-- 9. Function permissions
-- ------------------------------------------------------------------------------
revoke all on function public.firebase_project_id() from public, anon, authenticated;
revoke all on function public.trig_sanitize_filing() from public, anon;

grant execute on function public.current_user_id() to authenticated, anon;

revoke all on function public.ensure_my_profile() from public, anon;
revoke all on function public.request_minecraft_linking(text, text) from public, anon;
revoke all on function public.verify_minecraft_profile(text, text, text) from public, anon;
revoke all on function public.docket_filing(uuid, text, text) from public, anon;
revoke all on function public.review_confidential_tip(uuid, text, text) from public, anon;
revoke all on function public.update_case_status(uuid, text, text, text, boolean) from public, anon;
revoke all on function public.admin_set_user_role(text, text) from public, anon;

grant execute on function public.ensure_my_profile() to authenticated;
grant execute on function public.request_minecraft_linking(text, text) to authenticated;
grant execute on function public.verify_minecraft_profile(text, text, text) to authenticated;
grant execute on function public.docket_filing(uuid, text, text) to authenticated;
grant execute on function public.review_confidential_tip(uuid, text, text) to authenticated;
grant execute on function public.update_case_status(uuid, text, text, text, boolean) to authenticated;
grant execute on function public.admin_set_user_role(text, text) to authenticated;
