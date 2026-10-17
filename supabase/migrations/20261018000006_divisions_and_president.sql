-- ==============================================================================
-- Migration: 20261018000006_divisions_and_president.sql
-- Project: Create: Project Blueprint (CPB) Server Security & Justice Department
-- Description: FBIS / FBOC records (tips, incident reports, inmates, Most
--              Wanted, inmate requests), division staff roles, the President
--              role, and an audit log for administrative actions.
--
-- Roles (lowest to highest authority):
--   player        - any signed-in citizen
--   clerk, judge  - Federal Judiciary staff
--   fbis_agent    - FBIS staff (tips, Most Wanted)
--   fboc_officer  - FBOC staff (incidents, inmates, requests)
--   admin         - every division + role management (except admin/president)
--   president     - everything, including appointing/removing admins
--
-- Bootstrap the first president in the SQL Editor:
--   update public.profiles set role = 'president' where email = '<your email>';
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Roles
-- ------------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
    check (role in ('player', 'clerk', 'judge', 'fbis_agent', 'fboc_officer', 'admin', 'president'));

create or replace function public.is_president()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select exists (
        select 1 from public.profiles
        where id = public.current_user_id() and role = 'president'
    );
$$;

-- Admin powers now include the president
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select exists (
        select 1 from public.profiles
        where id = public.current_user_id() and role in ('admin', 'president')
    );
$$;

-- Judiciary staff
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select exists (
        select 1 from public.profiles
        where id = public.current_user_id() and role in ('clerk', 'judge', 'admin', 'president')
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
        where id = public.current_user_id() and role in ('judge', 'admin', 'president')
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
        where id = public.current_user_id() and role in ('clerk', 'admin', 'president')
    );
$$;

create or replace function public.is_fbis()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select exists (
        select 1 from public.profiles
        where id = public.current_user_id() and role in ('fbis_agent', 'admin', 'president')
    );
$$;

create or replace function public.is_fboc()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select exists (
        select 1 from public.profiles
        where id = public.current_user_id() and role in ('fboc_officer', 'admin', 'president')
    );
$$;

-- Role changes from the website: admins may assign staff roles; only the
-- president may grant or remove admin/president. Trusted contexts (SQL editor,
-- service_role, security definer procedures) are allowed.
create or replace function public.trig_protect_profile_fields()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
    if (new.role is distinct from old.role) and current_user in ('authenticated', 'anon') then
        if not public.is_admin() then
            raise exception 'Permission denied: Only administrators may assign or change user roles.';
        end if;
        if (old.role in ('admin', 'president') or new.role in ('admin', 'president')) and not public.is_president() then
            raise exception 'Permission denied: Only the President may appoint or remove administrators.';
        end if;
    end if;

    if (
        new.verification_status is distinct from old.verification_status
        or new.minecraft_verified_at is distinct from old.minecraft_verified_at
        or new.minecraft_uuid is distinct from old.minecraft_uuid
        or new.minecraft_username is distinct from old.minecraft_username
        or new.email is distinct from old.email
        or new.verification_method is distinct from old.verification_method
        or new.verified_by_user_id is distinct from old.verified_by_user_id
    ) then
        if not public.is_admin() and current_user in ('authenticated', 'anon') then
            raise exception 'Permission denied: Direct modification of verification metadata is prohibited. Use official verification workflows.';
        end if;
    end if;

    return new;
end;
$$;

-- ------------------------------------------------------------------------------
-- 2. Audit log
-- ------------------------------------------------------------------------------
create table if not exists public.audit_log (
    id uuid primary key default gen_random_uuid(),
    actor_id text references public.profiles(id) on delete set null,
    actor_name text,
    action text not null,
    target_type text not null,
    target_id text,
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists idx_audit_log_created on public.audit_log(created_at desc);

-- Internal helper; only called from security definer functions/triggers
create or replace function public.log_action(p_action text, p_target_type text, p_target_id text, p_details jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    insert into public.audit_log (actor_id, actor_name, action, target_type, target_id, details)
    values (
        public.current_user_id(),
        (select coalesce(minecraft_username, full_name, email) from public.profiles where id = public.current_user_id()),
        p_action,
        p_target_type,
        p_target_id,
        coalesce(p_details, '{}'::jsonb)
    );
end;
$$;

-- ------------------------------------------------------------------------------
-- 3. Tables
-- ------------------------------------------------------------------------------
create sequence if not exists public.fbis_tip_seq start with 1001;
create sequence if not exists public.fboc_incident_seq start with 1001;
create sequence if not exists public.fboc_request_seq start with 1001;
create sequence if not exists public.fboc_inmate_seq start with 9001;
create sequence if not exists public.fbis_wanted_seq start with 101;

-- FBIS intelligence / griefing tips (visible to FBIS staff only)
create table if not exists public.fbis_tips (
    id uuid primary key default gen_random_uuid(),
    reference_number text unique not null,
    submitter_id text references public.profiles(id) on delete set null,
    submitter_email text,
    submitter_minecraft_username text,
    suspect_name text not null check (length(suspect_name) between 1 and 100),
    category text not null check (category in ('contraption_ramming', 'schematic_theft', 'duplication', 'rail_sabotage', 'espionage', 'other')),
    location text check (location is null or length(location) <= 200),
    details text not null check (length(details) between 1 and 5000),
    evidence_urls text check (evidence_urls is null or length(evidence_urls) <= 2000),
    status text not null default 'new' check (status in ('new', 'investigating', 'actioned', 'dismissed')),
    staff_notes text check (staff_notes is null or length(staff_notes) <= 5000),
    reviewed_by text references public.profiles(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_fbis_tips_status on public.fbis_tips(status, created_at desc);
create index if not exists idx_fbis_tips_submitter on public.fbis_tips(submitter_id, created_at desc);

-- FBIS Most Wanted (public when is_public)
create table if not exists public.fbis_wanted (
    id uuid primary key default gen_random_uuid(),
    wanted_number text unique not null default ('FBIS-W-' || nextval('public.fbis_wanted_seq')),
    name text not null check (length(name) between 1 and 100),
    alias text check (alias is null or length(alias) <= 200),
    offense text not null check (length(offense) between 1 and 500),
    threat_level text not null default 'moderate' check (threat_level in ('extreme', 'high', 'moderate', 'low')),
    bounty text check (bounty is null or length(bounty) <= 100),
    last_seen text check (last_seen is null or length(last_seen) <= 200),
    status_note text check (status_note is null or length(status_note) <= 200),
    summary text check (summary is null or length(summary) <= 5000),
    modus_operandi text check (modus_operandi is null or length(modus_operandi) <= 5000),
    field_instructions text check (field_instructions is null or length(field_instructions) <= 5000),
    status text not null default 'wanted' check (status in ('wanted', 'captured', 'cleared')),
    is_public boolean not null default true,
    created_by text references public.profiles(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_fbis_wanted_public on public.fbis_wanted(is_public, status);

-- FBOC inmate roster (public when is_public)
create table if not exists public.fboc_inmates (
    id uuid primary key default gen_random_uuid(),
    inmate_number text unique not null default ('CTBE-' || nextval('public.fboc_inmate_seq')),
    name text not null check (length(name) between 1 and 100),
    alias text check (alias is null or length(alias) <= 200),
    minecraft_uuid text check (minecraft_uuid is null or minecraft_uuid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    offense text not null check (length(offense) between 1 and 1000),
    sentence text check (sentence is null or length(sentence) <= 500),
    facility text not null default 'redoubt' check (facility in ('redoubt', 'kinetic', 'andesite')),
    security_level text not null default 'medium' check (security_level in ('maximum', 'medium', 'restitution')),
    custody_status text not null default 'incarcerated'
        check (custody_status in ('incarcerated', 'solitary', 'work_detail', 'paroled', 'released', 'escaped', 'transferred')),
    intake_date text check (intake_date is null or length(intake_date) <= 100),
    behavior_log text check (behavior_log is null or length(behavior_log) <= 5000),
    parole_status text check (parole_status is null or length(parole_status) <= 200),
    case_id uuid references public.cases(id) on delete set null,
    is_public boolean not null default true,
    created_by text references public.profiles(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_fboc_inmates_public on public.fboc_inmates(is_public, custody_status);

-- FBOC incident reports: escapes, custody breaches, contraband (FBOC staff only)
create table if not exists public.fboc_incidents (
    id uuid primary key default gen_random_uuid(),
    reference_number text unique not null,
    submitter_id text references public.profiles(id) on delete set null,
    submitter_email text,
    submitter_minecraft_username text,
    category text not null check (category in ('escape', 'custody_breach', 'contraband', 'weapon', 'griefing', 'other')),
    subject_name text check (subject_name is null or length(subject_name) <= 100),
    location text check (location is null or length(location) <= 200),
    details text not null check (length(details) between 1 and 5000),
    inmate_id uuid references public.fboc_inmates(id) on delete set null,
    status text not null default 'new' check (status in ('new', 'responding', 'resolved', 'dismissed')),
    staff_notes text check (staff_notes is null or length(staff_notes) <= 5000),
    reviewed_by text references public.profiles(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_fboc_incidents_status on public.fboc_incidents(status, created_at desc);
create index if not exists idx_fboc_incidents_submitter on public.fboc_incidents(submitter_id, created_at desc);

-- FBOC requests: visitation, commissary, parole (requester sees own + staff response)
create table if not exists public.fboc_requests (
    id uuid primary key default gen_random_uuid(),
    reference_number text unique not null,
    request_type text not null check (request_type in ('visitation', 'commissary', 'parole')),
    requester_id text references public.profiles(id) on delete set null,
    requester_email text,
    requester_minecraft_username text,
    inmate_id uuid references public.fboc_inmates(id) on delete set null,
    inmate_label text check (inmate_label is null or length(inmate_label) <= 200),
    timeslot text check (timeslot is null or length(timeslot) <= 200),
    amount integer check (amount is null or amount between 1 and 1000000),
    details text check (details is null or length(details) <= 5000),
    status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'completed')),
    staff_response text check (staff_response is null or length(staff_response) <= 2000),
    reviewed_by text references public.profiles(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists idx_fboc_requests_status on public.fboc_requests(status, created_at desc);
create index if not exists idx_fboc_requests_requester on public.fboc_requests(requester_id, created_at desc);

-- ------------------------------------------------------------------------------
-- 4. Integrity triggers
-- ------------------------------------------------------------------------------
-- Staff may change workflow fields, but never who submitted a record or its
-- reference number. Columns to freeze are passed as trigger arguments.
create or replace function public.trig_freeze_columns()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
    v_col text;
begin
    if current_user in ('authenticated', 'anon') then
        foreach v_col in array tg_argv loop
            if (to_jsonb(new) -> v_col) is distinct from (to_jsonb(old) -> v_col) then
                raise exception 'Permission denied: % cannot be changed.', v_col;
            end if;
        end loop;
    end if;
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists freeze_fbis_tips_trig on public.fbis_tips;
create trigger freeze_fbis_tips_trig before update on public.fbis_tips
    for each row execute function public.trig_freeze_columns(
        'id', 'reference_number', 'submitter_id', 'submitter_email', 'submitter_minecraft_username',
        'suspect_name', 'category', 'location', 'details', 'evidence_urls', 'created_at');

drop trigger if exists freeze_fboc_incidents_trig on public.fboc_incidents;
create trigger freeze_fboc_incidents_trig before update on public.fboc_incidents
    for each row execute function public.trig_freeze_columns(
        'id', 'reference_number', 'submitter_id', 'submitter_email', 'submitter_minecraft_username',
        'category', 'subject_name', 'location', 'details', 'created_at');

drop trigger if exists freeze_fboc_requests_trig on public.fboc_requests;
create trigger freeze_fboc_requests_trig before update on public.fboc_requests
    for each row execute function public.trig_freeze_columns(
        'id', 'reference_number', 'request_type', 'requester_id', 'requester_email', 'requester_minecraft_username',
        'inmate_label', 'timeslot', 'amount', 'details', 'created_at');

drop trigger if exists freeze_fboc_inmates_trig on public.fboc_inmates;
create trigger freeze_fboc_inmates_trig before update on public.fboc_inmates
    for each row execute function public.trig_freeze_columns('id', 'inmate_number', 'created_by', 'created_at');

drop trigger if exists freeze_fbis_wanted_trig on public.fbis_wanted;
create trigger freeze_fbis_wanted_trig before update on public.fbis_wanted
    for each row execute function public.trig_freeze_columns('id', 'wanted_number', 'created_by', 'created_at');

-- Record who created roster / Most Wanted entries, and audit every change
create or replace function public.trig_audit_registry()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row jsonb;
begin
    if tg_op = 'INSERT' then
        new.created_by := coalesce(public.current_user_id(), new.created_by);
    end if;

    v_row := to_jsonb(case when tg_op = 'DELETE' then old else new end);
    perform public.log_action(
        lower(tg_op),
        tg_table_name,
        v_row ->> 'id',
        jsonb_build_object('name', v_row ->> 'name', 'status', coalesce(v_row ->> 'custody_status', v_row ->> 'status'))
    );

    return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists audit_fboc_inmates_trig on public.fboc_inmates;
create trigger audit_fboc_inmates_trig before insert or update or delete on public.fboc_inmates
    for each row execute function public.trig_audit_registry();

drop trigger if exists audit_fbis_wanted_trig on public.fbis_wanted;
create trigger audit_fbis_wanted_trig before insert or update or delete on public.fbis_wanted
    for each row execute function public.trig_audit_registry();

-- ------------------------------------------------------------------------------
-- 5. Submission procedures (signed-in users; rate limited)
-- ------------------------------------------------------------------------------
-- Returns the caller's profile or raises; enforces 5 submissions / hour / table
create or replace function public.assert_can_submit(p_table text)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_profile public.profiles;
    v_recent integer;
begin
    select * into v_profile from public.profiles where id = public.current_user_id();
    if v_profile.id is null then
        raise exception 'Authentication required. Please sign in first.';
    end if;

    execute format(
        'select count(*) from public.%I where %I = $1 and created_at > now() - interval ''1 hour''',
        p_table,
        case when p_table = 'fboc_requests' then 'requester_id' else 'submitter_id' end
    ) into v_recent using v_profile.id;

    if v_recent >= 5 then
        raise exception 'Too many submissions. Please wait an hour before submitting again.';
    end if;

    return v_profile;
end;
$$;

create or replace function public.submit_fbis_tip(
    p_suspect_name text,
    p_category text,
    p_location text,
    p_details text,
    p_evidence_urls text default null
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_profile public.profiles;
    v_ref text;
begin
    v_profile := public.assert_can_submit('fbis_tips');
    v_ref := 'FBIS-' || to_char(current_date, 'YYYY') || '-' || nextval('public.fbis_tip_seq');

    insert into public.fbis_tips (
        reference_number, submitter_id, submitter_email, submitter_minecraft_username,
        suspect_name, category, location, details, evidence_urls
    ) values (
        v_ref, v_profile.id, v_profile.email, v_profile.minecraft_username,
        trim(p_suspect_name), p_category, nullif(trim(p_location), ''), trim(p_details), nullif(trim(p_evidence_urls), '')
    );

    return json_build_object('reference_number', v_ref);
end;
$$;

create or replace function public.submit_fboc_incident(
    p_category text,
    p_subject_name text,
    p_location text,
    p_details text
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_profile public.profiles;
    v_ref text;
begin
    v_profile := public.assert_can_submit('fboc_incidents');
    v_ref := 'FBOC-' || to_char(current_date, 'YYYY') || '-' || nextval('public.fboc_incident_seq');

    insert into public.fboc_incidents (
        reference_number, submitter_id, submitter_email, submitter_minecraft_username,
        category, subject_name, location, details
    ) values (
        v_ref, v_profile.id, v_profile.email, v_profile.minecraft_username,
        p_category, nullif(trim(p_subject_name), ''), nullif(trim(p_location), ''), trim(p_details)
    );

    return json_build_object('reference_number', v_ref);
end;
$$;

create or replace function public.submit_fboc_request(
    p_request_type text,
    p_inmate_id uuid,
    p_inmate_label text,
    p_timeslot text default null,
    p_amount integer default null,
    p_details text default null
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_profile public.profiles;
    v_ref text;
    v_inmate public.fboc_inmates;
begin
    v_profile := public.assert_can_submit('fboc_requests');

    if p_inmate_id is not null then
        select * into v_inmate from public.fboc_inmates where id = p_inmate_id and is_public = true;
        if v_inmate.id is null then
            raise exception 'Inmate not found on the public roster.';
        end if;
    end if;

    if p_request_type = 'commissary' and (p_amount is null or p_amount < 1) then
        raise exception 'Commissary deposits need an amount.';
    end if;

    v_ref := 'FBOC-R-' || to_char(current_date, 'YYYY') || '-' || nextval('public.fboc_request_seq');

    insert into public.fboc_requests (
        reference_number, request_type, requester_id, requester_email, requester_minecraft_username,
        inmate_id, inmate_label, timeslot, amount, details
    ) values (
        v_ref, p_request_type, v_profile.id, v_profile.email, v_profile.minecraft_username,
        v_inmate.id,
        coalesce(nullif(trim(p_inmate_label), ''), case when v_inmate.id is not null then v_inmate.name || ' (#' || v_inmate.inmate_number || ')' end),
        nullif(trim(p_timeslot), ''),
        case when p_request_type = 'commissary' then p_amount end,
        nullif(trim(p_details), '')
    );

    return json_build_object('reference_number', v_ref);
end;
$$;

-- ------------------------------------------------------------------------------
-- 6. Role management (replaces the version from migration 4)
-- ------------------------------------------------------------------------------
create or replace function public.admin_set_user_role(
    p_target_user_id text,
    p_new_role text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_old_role text;
begin
    if not public.is_admin() then
        raise exception 'Access denied: Only system administrators may assign staff roles.';
    end if;

    if p_new_role not in ('player', 'clerk', 'judge', 'fbis_agent', 'fboc_officer', 'admin', 'president') then
        raise exception 'Invalid role: %.', p_new_role;
    end if;

    if p_target_user_id = public.current_user_id() then
        raise exception 'You cannot change your own role.';
    end if;

    select role into v_old_role from public.profiles where id = p_target_user_id;
    if v_old_role is null then
        raise exception 'User % not found.', p_target_user_id;
    end if;

    if (v_old_role in ('admin', 'president') or p_new_role in ('admin', 'president')) and not public.is_president() then
        raise exception 'Access denied: Only the President may appoint or remove administrators.';
    end if;

    update public.profiles
    set role = p_new_role,
        updated_at = now()
    where id = p_target_user_id;

    perform public.log_action('set_role', 'profile', p_target_user_id,
        jsonb_build_object('from', v_old_role, 'to', p_new_role));

    return true;
end;
$$;

-- ------------------------------------------------------------------------------
-- 7. Row Level Security
-- ------------------------------------------------------------------------------
alter table public.audit_log enable row level security;
alter table public.fbis_tips enable row level security;
alter table public.fbis_wanted enable row level security;
alter table public.fboc_inmates enable row level security;
alter table public.fboc_incidents enable row level security;
alter table public.fboc_requests enable row level security;

-- AUDIT LOG: admins/president read; written only by security definer code
create policy "Admins read audit log"
    on public.audit_log for select to authenticated
    using (public.is_admin());

-- FBIS TIPS: FBIS staff only (submitters get a reference number; tips stay confidential)
create policy "FBIS staff read tips"
    on public.fbis_tips for select to authenticated
    using (public.is_fbis());
create policy "FBIS staff update tips"
    on public.fbis_tips for update to authenticated
    using (public.is_fbis()) with check (public.is_fbis());
create policy "Admins delete tips"
    on public.fbis_tips for delete to authenticated
    using (public.is_admin());

-- MOST WANTED: public entries readable by everyone; FBIS staff manage
create policy "Read public wanted or FBIS staff"
    on public.fbis_wanted for select
    using (is_public = true or public.is_fbis());
create policy "FBIS staff create wanted"
    on public.fbis_wanted for insert to authenticated
    with check (public.is_fbis());
create policy "FBIS staff update wanted"
    on public.fbis_wanted for update to authenticated
    using (public.is_fbis()) with check (public.is_fbis());
create policy "FBIS staff delete wanted"
    on public.fbis_wanted for delete to authenticated
    using (public.is_fbis());

-- INMATES: public entries readable by everyone; FBOC staff manage
create policy "Read public inmates or FBOC staff"
    on public.fboc_inmates for select
    using (is_public = true or public.is_fboc());
create policy "FBOC staff create inmates"
    on public.fboc_inmates for insert to authenticated
    with check (public.is_fboc());
create policy "FBOC staff update inmates"
    on public.fboc_inmates for update to authenticated
    using (public.is_fboc()) with check (public.is_fboc());
create policy "FBOC staff delete inmates"
    on public.fboc_inmates for delete to authenticated
    using (public.is_fboc());

-- INCIDENTS: FBOC staff only
create policy "FBOC staff read incidents"
    on public.fboc_incidents for select to authenticated
    using (public.is_fboc());
create policy "FBOC staff update incidents"
    on public.fboc_incidents for update to authenticated
    using (public.is_fboc()) with check (public.is_fboc());
create policy "Admins delete incidents"
    on public.fboc_incidents for delete to authenticated
    using (public.is_admin());

-- REQUESTS: requester sees own; FBOC staff see and answer all
create policy "Read own requests or FBOC staff"
    on public.fboc_requests for select to authenticated
    using (requester_id = public.current_user_id() or public.is_fboc());
create policy "FBOC staff update requests"
    on public.fboc_requests for update to authenticated
    using (public.is_fboc()) with check (public.is_fboc());
create policy "Admins delete requests"
    on public.fboc_requests for delete to authenticated
    using (public.is_admin());

-- ------------------------------------------------------------------------------
-- 8. Grants (RLS above decides which rows)
-- ------------------------------------------------------------------------------
grant select on public.fbis_wanted, public.fboc_inmates to anon, authenticated;
grant insert, update, delete on public.fbis_wanted, public.fboc_inmates to authenticated;
grant select, update, delete on public.fbis_tips, public.fboc_incidents, public.fboc_requests to authenticated;
grant select on public.audit_log to authenticated;
-- Inmate / Most Wanted numbers come from column defaults evaluated as the caller
grant usage on sequence public.fboc_inmate_seq, public.fbis_wanted_seq to authenticated;

revoke all on function public.log_action(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.assert_can_submit(text) from public, anon, authenticated;
revoke all on function public.trig_freeze_columns() from public, anon;
revoke all on function public.trig_audit_registry() from public, anon;

revoke all on function public.submit_fbis_tip(text, text, text, text, text) from public, anon;
revoke all on function public.submit_fboc_incident(text, text, text, text) from public, anon;
revoke all on function public.submit_fboc_request(text, uuid, text, text, integer, text) from public, anon;
grant execute on function public.submit_fbis_tip(text, text, text, text, text) to authenticated;
grant execute on function public.submit_fboc_incident(text, text, text, text) to authenticated;
grant execute on function public.submit_fboc_request(text, uuid, text, text, integer, text) to authenticated;

grant execute on function public.is_president() to authenticated, anon;
grant execute on function public.is_fbis() to authenticated, anon;
grant execute on function public.is_fboc() to authenticated, anon;

-- ------------------------------------------------------------------------------
-- 9. Seed the existing public roster and Most Wanted list (idempotent)
-- ------------------------------------------------------------------------------
insert into public.fboc_inmates (id, inmate_number, name, alias, offense, sentence, facility, security_level, custody_status, intake_date, behavior_log, parole_status)
values
    ('b0000000-0000-0000-0000-000000000001', 'CTBE-8821', 'Marcus Rivera', 'The Ghost',
     'Kinetic Overdrive Sabotage, High-Pressure Boiler Detonation, Central Bank Vault Breach',
     '30 In-Game Days Detention + 1,500 Brass Ingot Restitution', 'redoubt', 'maximum', 'solitary', 'Season 3.1 - Week 2',
     'Multiple contraband tool fabrication attempts detected by automated magnetic screening. Zero privileges granted.', 'Ineligible until Week 6'),
    ('b0000000-0000-0000-0000-000000000002', 'CTBE-7419', 'Elena Volkov', 'Vector',
     'Schematic Infiltration, Blueprint Intellectual Property Theft from Granite Ridge Co., Identity Forgery',
     '14 In-Game Days Detention + Full Return of Stolen Schematics', 'kinetic', 'medium', 'incarcerated', 'Season 3.1 - Week 3',
     'Cooperative with FBIS investigators. Currently assisting with forensic decryption of altered schematics.', 'Eligible in 3 In-Game Days'),
    ('b0000000-0000-0000-0000-000000000003', 'CTBE-6104', 'Viktor Kozlov', 'Iron Viktor',
     'Operating Rogue Armored Rail Train, Unsanctioned Armed Train Raids, Illegal TNT Cannon Mounts',
     '45 In-Game Days Detention + Permanent Forfeiture of Rail Stock', 'redoubt', 'maximum', 'incarcerated', 'Season 3.1 - Week 1',
     'Refused initial inventory surrender. Confined to Bedrock Cell C-4 with redstone-suppression dampeners.', 'Appeal Pending with Federal Judiciary'),
    ('b0000000-0000-0000-0000-000000000004', 'CTBE-5291', 'Silas Vance', 'Crank',
     'Unlicensed High-Heat Boiler Operation, Accidental Factory Explosion at Sector 4',
     'Crushing 500 Andesite Alloy Blocks + Community Rail Repair', 'andesite', 'restitution', 'work_detail', 'Season 3.1 - Week 4',
     'Exemplary behavior. Recommended for early parole and mechanic re-certification.', 'Parole Hearing Scheduled')
on conflict (id) do nothing;

insert into public.fbis_wanted (id, wanted_number, name, alias, offense, threat_level, bounty, last_seen, status_note, summary, modus_operandi, field_instructions)
values
    ('c0000000-0000-0000-0000-000000000001', 'FBIS-W-001', 'Phantom_Builder', 'K. Vance / Ghost Operator',
     'High-Speed Kinetic Ram Griefing', 'extreme', '500 Brass', 'Sector 9 Nether Portal (X: 820, Z: -1240)', 'ARMED WITH REINFORCED WRENCH',
     'Accused of deploying an unsanctioned reinforced railway ram that smashed through two regional trading depots in Sector 9. Operates cloaked under speed-boosted train assemblies.',
     'Constructs temporary track spurs at odd server hours, triggers mechanical kinetic overclocks, and vanishes via nether portal links before moderators arrive.',
     'Do not attempt to disable moving trains manually without FBIS Magnetic Anchors. Report coordinates immediately to Tactical Strike Force.'),
    ('c0000000-0000-0000-0000-000000000002', 'FBIS-W-002', 'RedstoneRipper', 'CircuitBreaker / Anon_09',
     'Chunk-Border Tick Desync & Dupe Loop', 'high', '350 Brass', 'Mainland Border Swamp (X: -2100, Z: 400)', 'SUSPECTED CLANDESTINE REPOSITORY',
     'Suspected of operating an illegal sub-chunk tick loop that causes localized server lag spikes and duplicate brass casting.',
     'Hides piston clock networks in deep dark caves underneath claims, utilizing redstone dust loops to disrupt tick timing.',
     'Inspect suspicious high-heat chunk borders. Collect schematic ballistics evidence for verification.'),
    ('c0000000-0000-0000-0000-000000000003', 'FBIS-W-003', 'ShadowOperator', 'BluePrintLeak / D. Richter',
     'Corporate Extortion & Trade Secret Theft', 'moderate', '250 Brass', 'Granite Ridge Outskirts Depot', 'ACTIVE SURVEILLANCE WARRANT',
     'Infiltrated the design bureau of Granite Ridge Construction Company and copied proprietary tunnel bore schematics for black-market resale.',
     'Disguises as commercial subcontractors, downloads blueprint data into unauthorized schematic tables, and flees to remote factions.',
     'Flag all unlicensed tunnel bores operating with Granite Ridge serial numbers.')
on conflict (id) do nothing;
