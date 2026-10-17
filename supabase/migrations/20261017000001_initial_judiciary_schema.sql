-- ==============================================================================
-- Migration: 20261017000001_initial_judiciary_schema.sql
-- Project: Create: Project Blueprint (CPB) Federal Judiciary & High Court
-- Description: Core schema, sequences, triggers, security helper functions, RLS,
--              and anti-privilege-escalation controls.
-- ==============================================================================

-- Enable required extensions
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ------------------------------------------------------------------------------
-- 1. Sequences for Server-Generated Official Identifiers
-- ------------------------------------------------------------------------------
create sequence if not exists public.docket_cv_seq start with 43;
create sequence if not exists public.docket_cr_seq start with 20;
create sequence if not exists public.docket_ap_seq start with 16;
create sequence if not exists public.filing_ref_seq start with 101;

-- ------------------------------------------------------------------------------
-- 2. Profiles Table
-- ------------------------------------------------------------------------------
create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    email text,
    full_name text,
    avatar_url text,
    minecraft_username text check (minecraft_username is null or minecraft_username ~ '^[a-zA-Z0-9_]{3,16}$'),
    minecraft_uuid text check (minecraft_uuid is null or minecraft_uuid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    minecraft_verified_at timestamptz,
    verification_status text not null default 'unlinked'
        check (verification_status in ('unlinked', 'pending_verification', 'verified', 'rejected')),
    verification_method text check (verification_method is null or verification_method in ('automated_ingame', 'manual_clerk', 'manual_admin')),
    verified_by_user_id uuid references auth.users(id) on delete set null,
    role text not null default 'player'
        check (role in ('player', 'clerk', 'judge', 'admin')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- Ensure a verified Minecraft UUID cannot be linked to multiple accounts simultaneously
create unique index if not exists idx_profiles_verified_uuid 
    on public.profiles (minecraft_uuid) 
    where (verification_status = 'verified');

create index if not exists idx_profiles_role on public.profiles(role);
create index if not exists idx_profiles_verification_status on public.profiles(verification_status);

-- ------------------------------------------------------------------------------
-- 3. Dedicated Private Verification Table (Secludes sensitive verification tokens)
-- ------------------------------------------------------------------------------
create table if not exists public.profile_verifications (
    user_id uuid primary key references public.profiles(id) on delete cascade,
    target_minecraft_username text not null check (target_minecraft_username ~ '^[a-zA-Z0-9_]{3,16}$'),
    target_minecraft_uuid text not null check (target_minecraft_uuid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    verification_token text unique not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default (now() + interval '2 hours')
);

create index if not exists idx_verifications_token on public.profile_verifications(verification_token);
create index if not exists idx_verifications_target_uuid on public.profile_verifications(target_minecraft_uuid);

-- ------------------------------------------------------------------------------
-- 4. Cases Table
-- ------------------------------------------------------------------------------
create table if not exists public.cases (
    id uuid primary key default gen_random_uuid(),
    docket_number text unique not null,
    case_type text not null check (case_type in ('civil', 'criminal', 'appeal')),
    title text not null,
    summary text not null,
    matter text not null,
    plaintiff_name text not null,
    plaintiff_uuid text check (plaintiff_uuid is null or plaintiff_uuid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    plaintiff_user_id uuid references auth.users(id) on delete set null,
    defendant_name text not null,
    defendant_uuid text check (defendant_uuid is null or defendant_uuid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    defendant_user_id uuid references auth.users(id) on delete set null,
    status text not null default 'pending_review'
        check (status in ('pending_review', 'in_deliberation', 'hearing_scheduled', 'verdict_rendered', 'appealed', 'dismissed', 'closed')),
    assigned_judge text,
    assigned_judge_id uuid references auth.users(id) on delete set null,
    current_order text,
    pleadings text,
    next_session text,
    hearing_at timestamptz,
    is_published boolean not null default false,
    originating_filing_id uuid,
    created_by uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_cases_published on public.cases(is_published);
create index if not exists idx_cases_type on public.cases(case_type);
create index if not exists idx_cases_status on public.cases(status);
create index if not exists idx_cases_docket on public.cases(docket_number);

-- ------------------------------------------------------------------------------
-- 5. Filings Table (Lawsuits, Appeals, and Confidential Tips)
-- ------------------------------------------------------------------------------
create table if not exists public.filings (
    id uuid primary key default gen_random_uuid(),
    reference_number text unique not null,
    filing_type text not null check (filing_type in ('lawsuit', 'appeal', 'tip')),
    submitter_id uuid not null references auth.users(id) on delete cascade,
    submitter_email text,
    submitter_minecraft_username text check (submitter_minecraft_username is null or submitter_minecraft_username ~ '^[a-zA-Z0-9_]{3,16}$'),
    submitter_minecraft_uuid text check (submitter_minecraft_uuid is null or submitter_minecraft_uuid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    submitter_verified boolean not null default false,
    target_party_name text,
    target_party_uuid text check (target_party_uuid is null or target_party_uuid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    case_id uuid references public.cases(id) on delete set null,
    title text not null,
    details text not null,
    relief_sought text,
    evidence_urls text,
    is_confidential boolean not null default false,
    status text not null default 'pending_review'
        check (status in ('pending_review', 'under_investigation', 'docketed', 'rejected', 'closed')),
    review_notes text,
    reviewed_by uuid references auth.users(id) on delete set null,
    docketed_case_id uuid references public.cases(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    -- Enforce that tips are strictly confidential by definition
    constraint chk_tip_confidential check (filing_type <> 'tip' or is_confidential = true)
);

create index if not exists idx_filings_submitter on public.filings(submitter_id);
create index if not exists idx_filings_status on public.filings(status);
create index if not exists idx_filings_type on public.filings(filing_type);
create index if not exists idx_filings_ref on public.filings(reference_number);
create index if not exists idx_filings_confidential on public.filings(is_confidential);

-- ------------------------------------------------------------------------------
-- 6. Case Events Table (Chronology, Rulings, Filings docketed)
-- ------------------------------------------------------------------------------
create table if not exists public.case_events (
    id uuid primary key default gen_random_uuid(),
    case_id uuid not null references public.cases(id) on delete cascade,
    event_type text not null,
    description text not null,
    actor_id uuid references auth.users(id) on delete set null,
    actor_name text,
    is_public boolean not null default true,
    created_at timestamptz not null default now()
);

create index if not exists idx_case_events_case on public.case_events(case_id);
create index if not exists idx_case_events_public on public.case_events(is_public);

-- ------------------------------------------------------------------------------
-- 7. Helper Functions for Server-Side ID Generation
-- ------------------------------------------------------------------------------

-- Generate official docket number server-side (e.g. CTBE-CV-2026-0043)
create or replace function public.generate_docket_number(p_case_type text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_seq_val bigint;
    v_prefix text;
    v_year text;
begin
    v_year := to_char(current_date, 'YYYY');
    if p_case_type = 'civil' then
        v_prefix := 'CTBE-CV-' || v_year || '-';
        v_seq_val := nextval('public.docket_cv_seq');
    elsif p_case_type = 'criminal' then
        v_prefix := 'CTBE-CR-' || v_year || '-';
        v_seq_val := nextval('public.docket_cr_seq');
    elsif p_case_type = 'appeal' then
        v_prefix := 'CTBE-AP-' || v_year || '-';
        v_seq_val := nextval('public.docket_ap_seq');
    else
        v_prefix := 'CTBE-MISC-' || v_year || '-';
        v_seq_val := nextval('public.docket_cv_seq');
    end if;

    return v_prefix || lpad(v_seq_val::text, 4, '0');
end;
$$;

-- Generate official filing reference number (e.g. FIL-2026-0101)
create or replace function public.generate_filing_reference()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_seq_val bigint;
    v_year text;
begin
    v_year := to_char(current_date, 'YYYY');
    v_seq_val := nextval('public.filing_ref_seq');
    return 'FIL-' || v_year || '-' || lpad(v_seq_val::text, 4, '0');
end;
$$;

-- Trigger to automatically assign reference_number on new filing
create or replace function public.trig_assign_filing_reference()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if new.reference_number is null or new.reference_number = '' then
        new.reference_number := public.generate_filing_reference();
    end if;
    return new;
end;
$$;

drop trigger if exists assign_filing_reference_trig on public.filings;
create trigger assign_filing_reference_trig
    before insert on public.filings
    for each row
    execute function public.trig_assign_filing_reference();

-- ------------------------------------------------------------------------------
-- 8. Role & Authorization Helper Functions (Security Definer with safe search path)
-- ------------------------------------------------------------------------------
create or replace function public.get_my_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(
        (select role from public.profiles where id = auth.uid()),
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
        where id = auth.uid() and role in ('clerk', 'judge', 'admin')
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
        where id = auth.uid() and role in ('judge', 'admin')
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
        where id = auth.uid() and role in ('clerk', 'admin')
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
        where id = auth.uid() and role = 'admin'
    );
$$;

-- ------------------------------------------------------------------------------
-- 9. Trigger to Block Profile Privilege Escalation
-- ------------------------------------------------------------------------------
-- Prevents users, clerks, or judges from changing role or verification metadata
-- directly through table update queries. Only explicit admins can change roles.
-- Verification metadata can only be updated via verified stored procedures.
-- NOTE: Deliberately SECURITY INVOKER. Inside a SECURITY DEFINER function,
-- current_user is the function owner, which would make the 'authenticated'
-- check below never match and silently allow self-verification.
create or replace function public.trig_protect_profile_fields()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
    -- 1. Role modification check: ONLY admins can modify role from the client.
    -- Trusted contexts (SQL editor as postgres, service_role, security definer
    -- procedures like admin_set_user_role) are allowed, so the first admin can be granted.
    if (new.role is distinct from old.role) then
        if not public.is_admin() and current_user in ('authenticated', 'anon') then
            raise exception 'Permission denied: Only administrators may assign or change user roles.';
        end if;
    end if;

    -- 2. Sensitive verification metadata checks
    if (
        new.verification_status is distinct from old.verification_status
        or new.minecraft_verified_at is distinct from old.minecraft_verified_at
        or new.minecraft_uuid is distinct from old.minecraft_uuid
        or new.minecraft_username is distinct from old.minecraft_username
        or new.email is distinct from old.email
        or new.verification_method is distinct from old.verification_method
        or new.verified_by_user_id is distinct from old.verified_by_user_id
    ) then
        -- Allow if admin or if invoked inside a trusted security definer procedure
        -- (In Supabase, client-initiated direct updates run under role 'authenticated')
        if not public.is_admin() and current_user in ('authenticated', 'anon') then
            raise exception 'Permission denied: Direct modification of verification metadata is prohibited. Use official verification workflows.';
        end if;
    end if;

    return new;
end;
$$;

drop trigger if exists protect_profile_fields_trig on public.profiles;
create trigger protect_profile_fields_trig
    before update on public.profiles
    for each row
    execute function public.trig_protect_profile_fields();

-- ------------------------------------------------------------------------------
-- 9b. Trigger to Sanitize Player-Submitted Filings
-- ------------------------------------------------------------------------------
-- Players must not be able to forge identity/verification fields or pre-set
-- review outcomes. Submitter identity is derived from the server-side profile,
-- and workflow fields are server-controlled. Staff (and service_role / stored
-- procedures acting for staff) pass through unchanged.
create or replace function public.trig_sanitize_filing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_profile public.profiles%rowtype;
begin
    -- service_role / migrations have no auth.uid(); staff workflows are trusted
    if auth.uid() is null or public.is_staff() then
        return new;
    end if;

    if tg_op = 'INSERT' then
        select * into v_profile from public.profiles where id = auth.uid();

        new.submitter_id := auth.uid();
        new.submitter_email := (select email from auth.users where id = auth.uid());
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

-- Named "aa_" so it fires before assign_filing_reference_trig (triggers fire alphabetically)
drop trigger if exists aa_sanitize_filing_trig on public.filings;
create trigger aa_sanitize_filing_trig
    before insert or update on public.filings
    for each row
    execute function public.trig_sanitize_filing();

-- ------------------------------------------------------------------------------
-- 10. User Provisioning Trigger (auth.users -> public.profiles)
-- ------------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    insert into public.profiles (
        id,
        email,
        full_name,
        avatar_url,
        role,
        verification_status,
        created_at,
        updated_at
    )
    values (
        new.id,
        new.email,
        coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
        new.raw_user_meta_data->>'avatar_url',
        'player',
        'unlinked',
        now(),
        now()
    )
    on conflict (id) do update set
        email = excluded.email,
        full_name = coalesce(public.profiles.full_name, excluded.full_name),
        avatar_url = coalesce(public.profiles.avatar_url, excluded.avatar_url),
        updated_at = now();

    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- ------------------------------------------------------------------------------
-- 11. Row Level Security (RLS) Policies
-- ------------------------------------------------------------------------------

-- Enable RLS on all tables
alter table public.profiles enable row level security;
alter table public.profile_verifications enable row level security;
alter table public.cases enable row level security;
alter table public.filings enable row level security;
alter table public.case_events enable row level security;

-- PROFILES POLICIES
-- Users can view their own profile; staff can view all profiles
create policy "Users can view own profile or staff can view"
    on public.profiles for select
    to authenticated
    using (auth.uid() = id or public.is_staff());

-- Users can update their own display fields (full_name, avatar_url)
-- Protected fields (role, verification) are blocked by trig_protect_profile_fields
-- NO recursive subqueries in check clause!
create policy "Users can update own display profile"
    on public.profiles for update
    to authenticated
    using (auth.uid() = id)
    with check (auth.uid() = id);

-- Admins can update any profile
create policy "Admins can update any profile"
    on public.profiles for update
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());

-- PROFILE VERIFICATIONS POLICIES
-- Users can view their own pending verification; clerks/admins can inspect pending requests
create policy "View verification request"
    on public.profile_verifications for select
    to authenticated
    using (
        auth.uid() = user_id
        or public.is_clerk()
        or public.is_admin()
    );

-- (Direct inserts, updates, and deletes to profile_verifications are restricted to
--  SECURITY DEFINER stored procedures and service_role).

-- CASES POLICIES
-- Public can read published cases; staff & litigants can view unpublished
create policy "Read cases"
    on public.cases for select
    using (
        is_published = true
        or public.is_staff()
        or auth.uid() = plaintiff_user_id
        or auth.uid() = defendant_user_id
        or auth.uid() = created_by
    );

-- Only judges/admins may write cases directly. Clerks docket via docket_filing()
-- and change status via update_case_status(), which enforce capability separation
-- (clerks may not issue orders, render verdicts, or change publication).
create policy "Judges can create cases"
    on public.cases for insert
    to authenticated
    with check (public.is_judge());

create policy "Judges can update cases"
    on public.cases for update
    to authenticated
    using (public.is_judge())
    with check (public.is_judge());

-- Only admins can delete cases
create policy "Admins can delete cases"
    on public.cases for delete
    to authenticated
    using (public.is_admin());

-- FILINGS POLICIES
-- Submitter can view own filings; staff can review all filings
-- Note: is_confidential tips are restricted to submitter and staff
create policy "View filings"
    on public.filings for select
    to authenticated
    using (
        auth.uid() = submitter_id
        or public.is_staff()
    );

-- Any authenticated user can create a filing for themselves
create policy "Create filings"
    on public.filings for insert
    to authenticated
    with check (
        auth.uid() = submitter_id
    );

-- Submitter can update their filing only while still pending_review
create policy "Update pending filings"
    on public.filings for update
    to authenticated
    using (
        (auth.uid() = submitter_id and status = 'pending_review')
        or public.is_staff()
    );

-- Only admins can delete filings
create policy "Admins can delete filings"
    on public.filings for delete
    to authenticated
    using (public.is_admin());

-- CASE EVENTS POLICIES
-- Public events on published cases are viewable by anyone; staff and litigants can view all
create policy "Read case events"
    on public.case_events for select
    using (
        (is_public = true and exists (select 1 from public.cases c where c.id = case_id and c.is_published = true))
        or public.is_staff()
        or exists (
            select 1 from public.cases c 
            where c.id = case_id and (c.plaintiff_user_id = auth.uid() or c.defendant_user_id = auth.uid())
        )
    );

-- Staff can insert case events
create policy "Staff can insert case events"
    on public.case_events for insert
    to authenticated
    with check (public.is_staff());

-- Staff can modify case events
create policy "Staff can modify case events"
    on public.case_events for update
    to authenticated
    using (public.is_staff());

-- Admins can delete case events
create policy "Admins can delete case events"
    on public.case_events for delete
    to authenticated
    using (public.is_admin());

-- ------------------------------------------------------------------------------
-- 12. Function Permissions and Execution Grants
-- ------------------------------------------------------------------------------
-- Revoke execution from PUBLIC and anon for sensitive internal helpers
revoke all on function public.generate_docket_number(text) from public, anon;
revoke all on function public.generate_filing_reference() from public, anon;
revoke all on function public.trig_assign_filing_reference() from public, anon;
revoke all on function public.trig_protect_profile_fields() from public, anon;
revoke all on function public.trig_sanitize_filing() from public, anon;
revoke all on function public.handle_new_user() from public, anon;

-- Grant execution to authenticated for role helpers
grant execute on function public.get_my_role() to authenticated, anon;
grant execute on function public.is_staff() to authenticated, anon;
grant execute on function public.is_judge() to authenticated, anon;
grant execute on function public.is_clerk() to authenticated, anon;
grant execute on function public.is_admin() to authenticated, anon;
