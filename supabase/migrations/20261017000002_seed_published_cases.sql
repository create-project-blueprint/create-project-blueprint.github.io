-- ==============================================================================
-- Migration: 20261017000002_seed_published_cases.sql
-- Project: Create: Project Blueprint (CPB) Federal Judiciary & High Court
-- Description: Seed initial published lore cases and historical case events.
--              Fully idempotent: Safe to rerun without duplicating events or
--              overwriting existing live records.
-- ==============================================================================

do $$
declare
    v_case_1_id uuid := 'a0000000-0000-0000-0000-000000000001'::uuid;
    v_case_2_id uuid := 'a0000000-0000-0000-0000-000000000002'::uuid;
    v_case_3_id uuid := 'a0000000-0000-0000-0000-000000000003'::uuid;
    v_case_4_id uuid := 'a0000000-0000-0000-0000-000000000004'::uuid;
begin
    -- 1. Civil Case: Granite Ridge Construction v. Aether Rail Transport
    insert into public.cases (
        id, docket_number, case_type, title, summary, matter,
        plaintiff_name, defendant_name, status, assigned_judge,
        current_order, pleadings, next_session, is_published, created_at, updated_at
    )
    values (
        v_case_1_id,
        'CTBE-CV-2026-0042',
        'civil',
        'Granite Ridge Construction Co. v. Aether Rail Co.',
        'Plaintiff claims defendant replicated proprietary drill contraption schematics without payment of the statutory licensing fee. Emergency stay on construction issued.',
        'Modular Tunnel Bore Patent Infringement',
        'Granite Ridge Construction Co.',
        'Aether Rail Transport',
        'in_deliberation',
        'Chief Justice K. Sterling',
        'Temporary restraining order granted pending mechanical inspection by FBIS Forensics Lab.',
        'Granite Ridge requests 800 Brass Ingots in royalties and an immediate cease-and-desist injunction on further tunneling through Sector 4.',
        'Saturday 19:00 CST • Chamber Alpha',
        true,
        now() - interval '6 days',
        now() - interval '1 day'
    )
    on conflict (docket_number) do nothing;

    -- Events for Case 1 (Deterministic UUIDs guarantee zero duplicates upon rerun)
    insert into public.case_events (id, case_id, event_type, description, actor_name, is_public, created_at)
    values
        ('e0000000-0000-0000-0000-000000000001'::uuid, v_case_1_id, 'filing_docketed', 'Formal statement of claim filed by Granite Ridge Construction legal representative.', 'Clerk of Court', true, now() - interval '6 days'),
        ('e0000000-0000-0000-0000-000000000002'::uuid, v_case_1_id, 'injunction_issued', 'Preliminary injunction issued prohibiting operation of bore unit at Sector 4 border.', 'Chief Justice K. Sterling', true, now() - interval '4 days'),
        ('e0000000-0000-0000-0000-000000000003'::uuid, v_case_1_id, 'evidence_received', 'FBIS Forensics Lab submitted telemetry report on drill gear ratio comparison.', 'FBIS Forensics Director', true, now() - interval '1 day')
    on conflict (id) do nothing;


    -- 2. Criminal Case: Federal Government v. Marcus Rivera
    insert into public.cases (
        id, docket_number, case_type, title, summary, matter,
        plaintiff_name, defendant_name, status, assigned_judge,
        current_order, pleadings, next_session, is_published, created_at, updated_at
    )
    values (
        v_case_2_id,
        'CTBE-CR-2026-0019',
        'criminal',
        'Federal Prosecution v. Marcus "The Ghost" Rivera',
        'Defendant convicted on 3 counts of intentional kinetic ramming. Full judgment ordered: 30 days custodial remand in FBOC Facility 01 plus 1,500 Brass Ingot compensation.',
        'Kinetic Overdrive Sabotage & Bank Theft',
        'CTBE Federal Prosecution',
        'Marcus "The Ghost" Rivera',
        'verdict_rendered',
        'Senior Magistrate D. Vance',
        'Defendant found guilty. Sentenced to 30 In-Game Days at FBOC Facility 01 (The Obsidian Redoubt) + 1,500 Brass Ingot fine.',
        'Defendant claimed a mechanical clutch failure. FBIS forensic logs proved manual throttle override clocked at 256 RPM.',
        'Sentence Executed • Remanded to FBOC',
        true,
        now() - interval '14 days',
        now() - interval '3 days'
    )
    on conflict (docket_number) do nothing;

    -- Events for Case 2
    insert into public.case_events (id, case_id, event_type, description, actor_name, is_public, created_at)
    values
        ('e0000000-0000-0000-0000-000000000004'::uuid, v_case_2_id, 'filing_docketed', 'Indictment returned by Federal Grand Jury on kinetic sabotage charges.', 'Federal Prosecutor', true, now() - interval '14 days'),
        ('e0000000-0000-0000-0000-000000000005'::uuid, v_case_2_id, 'hearing_conducted', 'Formal trial hearing held in High Court Chamber Alpha. Witnesses examined.', 'Senior Magistrate D. Vance', true, now() - interval '5 days'),
        ('e0000000-0000-0000-0000-000000000006'::uuid, v_case_2_id, 'ruling_rendered', 'Guilty verdict entered. Custodial order transmitted to FBOC Obsidian Redoubt command.', 'Senior Magistrate D. Vance', true, now() - interval '3 days')
    on conflict (id) do nothing;


    -- 3. Appellate Case: In Re: Sector 4 Mainland Rail Easement
    insert into public.cases (
        id, docket_number, case_type, title, summary, matter,
        plaintiff_name, defendant_name, status, assigned_judge,
        current_order, pleadings, next_session, is_published, created_at, updated_at
    )
    values (
        v_case_3_id,
        'CTBE-AP-2026-0008',
        'appeal',
        'In Re: Sector 4 Mainland Rail Easement',
        'Local township disputes federal eminent domain declaration over a 16-block wide rail corridor connecting mainland hub stations.',
        'Rail Corridor Right-of-Way Dispute',
        'Township of Pine Valley',
        'Department of Transportation',
        'hearing_scheduled',
        'Appellate Tribunal Panel',
        'Scheduled for oral argument on Saturday at 19:00 CST in High Court voice chamber.',
        'Township requests rerouting around the valley or mandatory noise mitigation and acoustic tunnels.',
        'Saturday 19:00 CST • Chamber Beta',
        true,
        now() - interval '8 days',
        now() - interval '2 days'
    )
    on conflict (docket_number) do nothing;

    -- Events for Case 3
    insert into public.case_events (id, case_id, event_type, description, actor_name, is_public, created_at)
    values
        ('e0000000-0000-0000-0000-000000000007'::uuid, v_case_3_id, 'filing_docketed', 'Petition for Appellate Review filed by Pine Valley Council.', 'Clerk of Court', true, now() - interval '8 days'),
        ('e0000000-0000-0000-0000-000000000008'::uuid, v_case_3_id, 'briefs_submitted', 'Appellate briefs submitted by municipal representatives and Dept of Transportation.', 'Clerk of Court', true, now() - interval '4 days'),
        ('e0000000-0000-0000-0000-000000000009'::uuid, v_case_3_id, 'hearing_scheduled', 'Hearing date set for Saturday 19:00 CST.', 'Appellate Tribunal Panel', true, now() - interval '2 days')
    on conflict (id) do nothing;


    -- 4. Appellate Case: Petition of Silas Vance (Facility 03)
    insert into public.cases (
        id, docket_number, case_type, title, summary, matter,
        plaintiff_name, defendant_name, status, assigned_judge,
        current_order, pleadings, next_session, is_published, created_at, updated_at
    )
    values (
        v_case_4_id,
        'CTBE-AP-2026-0015',
        'appeal',
        'Petition of Silas Vance (Facility 03)',
        'Inmate petitioner requests early conditional discharge from Camp Delta after fulfilling full restitution quota of 500 crushed alloy blocks for public infrastructure.',
        'Sentence Reduction for Restitution Service',
        'Silas Vance (#CTBE-5291)',
        'FBOC Camp Delta Administration',
        'in_deliberation',
        'Magistrate Chen (Parole Division)',
        'Warden report verified. Restitution work credits confirmed.',
        'Inmate has completed all assigned labor hours with zero disciplinary marks. FBOC recommends early probation.',
        'Thursday 18:30 CST • Parole Board',
        true,
        now() - interval '5 days',
        now() - interval '1 day'
    )
    on conflict (docket_number) do nothing;

    -- Events for Case 4
    insert into public.case_events (id, case_id, event_type, description, actor_name, is_public, created_at)
    values
        ('e0000000-0000-0000-0000-000000000010'::uuid, v_case_4_id, 'filing_docketed', 'Parole petition submitted by inmate advocate.', 'Clerk of Court', true, now() - interval '5 days'),
        ('e0000000-0000-0000-0000-000000000011'::uuid, v_case_4_id, 'report_filed', 'FBOC Warden certification of good conduct and 500 alloy blocks crushed received.', 'FBOC Warden', true, now() - interval '2 days'),
        ('e0000000-0000-0000-0000-000000000012'::uuid, v_case_4_id, 'deliberation_underway', 'Reviewing compliance with Precedent 24-01 regarding accidental boiler overpressure.', 'Magistrate Chen', true, now() - interval '1 day')
    on conflict (id) do nothing;

end $$;
