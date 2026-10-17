-- ==============================================================================
-- Migration: 20261017000003_verification_and_workbench_functions.sql
-- Project: Create: Project Blueprint (CPB) Federal Judiciary & High Court
-- Description: Server-side stored procedures for clerk/judge workflow, Minecraft
--              verification, confidential tip handling, transactional docketing,
--              and administrative role assignment.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Request Minecraft Linking (Player Action)
-- ------------------------------------------------------------------------------
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
    v_user_id uuid;
    v_clean_username text;
    v_clean_uuid text;
    v_token text;
    v_existing_verified_id uuid;
begin
    v_user_id := auth.uid();
    if v_user_id is null then
        raise exception 'Authentication required to link Minecraft profile.';
    end if;

    v_clean_username := trim(p_minecraft_username);
    v_clean_uuid := lower(trim(p_minecraft_uuid));

    -- Validate input format
    if v_clean_username is null or not (v_clean_username ~ '^[a-zA-Z0-9_]{3,16}$') then
        raise exception 'Invalid Minecraft username format. Must be 3-16 alphanumeric or underscore characters.';
    end if;

    if v_clean_uuid is not null and v_clean_uuid <> '' then
        if not (v_clean_uuid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
            raise exception 'Invalid Minecraft UUID format.';
        end if;

        -- Check if this UUID is already verified by another account
        select id into v_existing_verified_id
        from public.profiles
        where minecraft_uuid = v_clean_uuid and verification_status = 'verified' and id <> v_user_id;

        if v_existing_verified_id is not null then
            raise exception 'This Minecraft account is already verified by another CPB profile. Contact server administration for dispute resolution.';
        end if;
    end if;

    -- Generate a unique 8-character cryptographic verification token
    v_token := 'CPB-' || upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8));

    -- Store token exclusively in the isolated private verification table
    insert into public.profile_verifications (
        user_id,
        target_minecraft_username,
        target_minecraft_uuid,
        verification_token,
        created_at,
        expires_at
    )
    values (
        v_user_id,
        v_clean_username,
        coalesce(v_clean_uuid, '00000000-0000-0000-0000-000000000000'),
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

    -- Update profile status to pending_verification (do NOT set verified UUID or verified timestamp)
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

-- ------------------------------------------------------------------------------
-- 2. Confirm Minecraft Profile Verification (Staff / Clerk / Admin Action)
-- ------------------------------------------------------------------------------
create or replace function public.verify_minecraft_profile(
    p_target_user_id uuid,
    p_verified_username text,
    p_verified_uuid text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_existing_id uuid;
    v_clean_username text;
    v_clean_uuid text;
begin
    -- Only clerks and admins are authorized to verify player profiles
    if not public.is_clerk() and not public.is_admin() then
        raise exception 'Access denied: Judicial Clerk or Administrator authorization required to verify identities.';
    end if;

    v_clean_username := trim(p_verified_username);
    v_clean_uuid := lower(trim(p_verified_uuid));

    -- Input syntax validation
    if not (v_clean_username ~ '^[a-zA-Z0-9_]{3,16}$') then
        raise exception 'Invalid Minecraft username syntax.';
    end if;

    if not (v_clean_uuid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
        raise exception 'Invalid Minecraft UUID format.';
    end if;

    -- Conflict check: Cannot verify a UUID already verified by another profile
    select id into v_existing_id
    from public.profiles
    where minecraft_uuid = v_clean_uuid and verification_status = 'verified' and id <> p_target_user_id;

    if v_existing_id is not null then
        raise exception 'Conflict: That Minecraft UUID is already verified for citizen profile %.', v_existing_id;
    end if;

    -- Update target profile with verified status and audit actor
    update public.profiles
    set minecraft_username = v_clean_username,
        minecraft_uuid = v_clean_uuid,
        verification_status = 'verified',
        verification_method = 'manual_clerk',
        verified_by_user_id = auth.uid(),
        minecraft_verified_at = now(),
        updated_at = now()
    where id = p_target_user_id;

    -- Clean up pending verification record
    delete from public.profile_verifications where user_id = p_target_user_id;

    return true;
end;
$$;

-- ------------------------------------------------------------------------------
-- 3. Convert Filing into Official Docketed Case (Clerk/Judge Action)
-- ------------------------------------------------------------------------------
-- Transactional, safe against concurrency, locks the filing row, rejects already-
-- processed filings, and strictly rejects confidential tips.
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
begin
    -- Only clerks, judges, and admins may docket filings
    if not public.is_staff() then
        raise exception 'Access denied: Clerk or Judicial authorization required to docket cases.';
    end if;

    -- Concurrency control: Lock the filing row for update
    select * into v_filing
    from public.filings
    where id = p_filing_id
    for update;

    if not found then
        raise exception 'Filing with ID % not found.', p_filing_id;
    end if;

    -- Reject already processed filings
    if v_filing.status <> 'pending_review' then
        raise exception 'Filing % has already been processed (current status: %).', p_filing_id, v_filing.status;
    end if;

    -- REJECT CONFIDENTIAL TIPS: Tips must NEVER be converted to public docketed cases!
    if v_filing.filing_type = 'tip' or v_filing.is_confidential then
        raise exception 'Confidential tips cannot be converted into public docketed cases via normal docketing. A separate, sanitized indictment must be created by authorized prosecutors or magistrates.';
    end if;

    -- Map filing type to case type
    if v_filing.filing_type = 'lawsuit' then
        v_case_type := 'civil';
    elsif v_filing.filing_type = 'appeal' then
        v_case_type := 'appeal';
    else
        v_case_type := 'civil';
    end if;

    -- Generate official server docket number
    v_docket_num := public.generate_docket_number(v_case_type);

    -- Insert official case
    insert into public.cases (
        docket_number,
        case_type,
        title,
        summary,
        matter,
        plaintiff_name,
        plaintiff_uuid,
        plaintiff_user_id,
        defendant_name,
        defendant_uuid,
        status,
        assigned_judge,
        assigned_judge_id,
        current_order,
        pleadings,
        is_published,
        originating_filing_id,
        created_by,
        created_at,
        updated_at
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
        auth.uid(),
        p_initial_order,
        v_filing.details,
        true, -- Published upon official docketing
        v_filing.id,
        auth.uid(),
        now(),
        now()
    )
    returning id into v_new_case_id;

    -- Update filing status to docketed
    update public.filings
    set status = 'docketed',
        reviewed_by = auth.uid(),
        docketed_case_id = v_new_case_id,
        updated_at = now()
    where id = p_filing_id;

    -- Create initial case event
    insert into public.case_events (
        case_id,
        event_type,
        description,
        actor_id,
        actor_name,
        is_public,
        created_at
    )
    values (
        v_new_case_id,
        'filing_docketed',
        'Filing #' || v_filing.reference_number || ' accepted and docketed under official number ' || v_docket_num || '.',
        auth.uid(),
        coalesce((select full_name from public.profiles where id = auth.uid()), 'Clerk of Court'),
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

-- ------------------------------------------------------------------------------
-- 4. Review Confidential Tip (Dedicated Staff Workflow)
-- ------------------------------------------------------------------------------
-- Keeps tips confidential, allows investigation or dismissal, and never publishes.
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
        reviewed_by = auth.uid(),
        updated_at = now()
    where id = p_filing_id;

    return json_build_object(
        'filing_id', p_filing_id,
        'reference_number', v_filing.reference_number,
        'status', v_new_status
    );
end;
$$;

-- ------------------------------------------------------------------------------
-- 5. Update Case Status & Orders (Separated Capabilities)
-- ------------------------------------------------------------------------------
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

    -- Validate status value
    if p_status not in ('pending_review', 'in_deliberation', 'hearing_scheduled', 'verdict_rendered', 'appealed', 'dismissed', 'closed') then
        raise exception 'Invalid case status: %.', p_status;
    end if;

    -- Capability separation: Only judges and admins may render verdicts, issue orders, or alter publication
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
    from public.profiles where id = auth.uid();

    update public.cases
    set status = p_status,
        current_order = coalesce(p_current_order, current_order),
        is_published = coalesce(p_is_published, is_published),
        updated_at = now()
    where id = p_case_id;

    if p_event_desc is not null and length(trim(p_event_desc)) > 0 then
        insert into public.case_events (
            case_id,
            event_type,
            description,
            actor_id,
            actor_name,
            is_public,
            created_at
        )
        values (
            p_case_id,
            'status_changed',
            p_event_desc,
            auth.uid(),
            v_actor_name,
            true,
            now()
        );
    end if;

    return true;
end;
$$;

-- ------------------------------------------------------------------------------
-- 6. Administrative Role Assignment
-- ------------------------------------------------------------------------------
-- Strictly restricted to administrators
create or replace function public.admin_set_user_role(
    p_target_user_id uuid,
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
-- 7. Revoke and Grant Permissions on Stored Procedures
-- ------------------------------------------------------------------------------
revoke all on function public.request_minecraft_linking(text, text) from public, anon;
revoke all on function public.verify_minecraft_profile(uuid, text, text) from public, anon;
revoke all on function public.docket_filing(uuid, text, text) from public, anon;
revoke all on function public.review_confidential_tip(uuid, text, text) from public, anon;
revoke all on function public.update_case_status(uuid, text, text, text, boolean) from public, anon;
revoke all on function public.admin_set_user_role(uuid, text) from public, anon;

grant execute on function public.request_minecraft_linking(text, text) to authenticated;
grant execute on function public.verify_minecraft_profile(uuid, text, text) to authenticated;
grant execute on function public.docket_filing(uuid, text, text) to authenticated;
grant execute on function public.review_confidential_tip(uuid, text, text) to authenticated;
grant execute on function public.update_case_status(uuid, text, text, text, boolean) to authenticated;
grant execute on function public.admin_set_user_role(uuid, text) to authenticated;
