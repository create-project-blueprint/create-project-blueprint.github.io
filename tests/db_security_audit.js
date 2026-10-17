const { Client } = require('pg');
const fs = require('fs');

async function runSecurityAudit() {
  console.log('================================================================');
  console.log('   CPB Federal Judiciary Live Database Security Audit Suite     ');
  console.log('   Engine: PostgreSQL 15 on Docker                             ');
  console.log('================================================================\n');

  const client = new Client({
    connectionString: 'postgresql://postgres:postgres@localhost:5433/postgres'
  });

  await client.connect();
  let failures = 0;
  let passes = 0;
  const FIREBASE_PROJECT = 'cpb-test-project';

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passes++;
    } else {
      console.error(`[FAIL] ${testName} - ${details}`);
      failures++;
    }
  }

  try {
    console.log('Step 1: Setting up mock Supabase auth infrastructure...');
    await client.query(`
      create extension if not exists "uuid-ossp";
      create extension if not exists "pgcrypto";

      -- Setup mock Supabase roles
      do $$
      begin
        if not exists (select from pg_roles where rolname = 'anon') then
          create role anon nologin;
        end if;
        if not exists (select from pg_roles where rolname = 'authenticated') then
          create role authenticated nologin;
        end if;
        if not exists (select from pg_roles where rolname = 'service_role') then
          create role service_role nologin;
        end if;
      end $$;

      -- Create auth schema and auth.users table
      create schema if not exists auth;
      create table if not exists auth.users (
        id uuid primary key default gen_random_uuid(),
        email text unique,
        raw_user_meta_data jsonb default '{}'::jsonb,
        created_at timestamptz default now()
      );

      -- Supabase auth.uid() function simulator
      create or replace function auth.uid()
      returns uuid
      language sql
      stable
      as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$;

      create or replace function auth.jwt()
      returns jsonb
      language sql
      stable
      as $$
        select nullif(current_setting('request.jwt.claims', true), '')::jsonb;
      $$;

      grant usage on schema public to anon, authenticated, service_role;
      grant usage on schema auth to anon, authenticated, service_role;
      grant all on all tables in schema public to postgres;
      grant select on auth.users to authenticated, anon;
    `);

    console.log('Step 2: Applying Migration 1 (Core Schema & Security Controls)...');
    const m1 = fs.readFileSync('supabase/migrations/20261017000001_initial_judiciary_schema.sql', 'utf8');
    await client.query(m1);
    await client.query(`
      grant select, insert, update on public.profiles to authenticated;
      grant select, insert, update on public.profile_verifications to authenticated;
      grant select, insert, update on public.cases to authenticated;
      grant select on public.cases to anon;
      grant select, insert, update on public.filings to authenticated;
      grant select, insert, update on public.case_events to authenticated;
      grant select on public.case_events to anon;
      grant usage, select on all sequences in schema public to authenticated;
    `);

    console.log('Step 3: Applying Migration 2 (Published Lore Seed)...');
    const m2 = fs.readFileSync('supabase/migrations/20261017000002_seed_published_cases.sql', 'utf8');
    await client.query(m2);

    console.log('Step 3b: Testing Migration 2 Idempotency (re-running seed)...');
    await client.query(m2);
    const countCheck = await client.query('select count(*) from public.cases;');
    const eventsCheck = await client.query('select count(*) from public.case_events;');
    assert(parseInt(countCheck.rows[0].count) === 4, 'Migration 2 idempotent on cases (4 cases present)');
    assert(parseInt(eventsCheck.rows[0].count) === 12, 'Migration 2 idempotent on events (12 events, no duplicates created)');

    console.log('Step 4: Applying Migration 3 (Stored Procedures & Workflows)...');
    const m3 = fs.readFileSync('supabase/migrations/20261017000003_verification_and_workbench_functions.sql', 'utf8');
    await client.query(m3);

    console.log('Step 4b: Applying Migration 4 (Firebase Auth identity)...');
    const m4 = fs.readFileSync('supabase/migrations/20261018000004_firebase_auth.sql', 'utf8');
    await client.query(m4);
    await client.query(`
      insert into private.settings (key, value) values ('firebase_project_id', '${FIREBASE_PROJECT}')
      on conflict (key) do update set value = excluded.value;
    `);

    // Helper to run query as a specific Firebase user.
    // `set local` only takes effect inside a transaction, so wrap each call in one.
    async function asUser(userId, role, sql, claimOverrides = {}) {
      const claims = userId ? {
        sub: userId,
        iss: `https://securetoken.google.com/${FIREBASE_PROJECT}`,
        aud: FIREBASE_PROJECT,
        role,
        email: `${userId}@cpb.test`,
        name: userId,
        ...claimOverrides
      } : { role };
      await client.query('begin');
      try {
        await client.query(`set local role ${role}`);
        await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        const result = await client.query(sql);
        await client.query('commit');
        // Multi-statement SQL returns an array of results; return the last one
        return Array.isArray(result) ? result[result.length - 1] : result;
      } catch (e) {
        await client.query('rollback');
        throw e;
      }
    }

    console.log('\nStep 5: Provisioning Test User Accounts (ensure_my_profile)...');
    // Firebase UIDs: 28-char strings, not UUIDs
    const adminId = 'AdminFirebaseUid000000000001';
    const judgeId = 'JudgeFirebaseUid000000000002';
    const clerkId = 'ClerkFirebaseUid000000000003';
    const playerId = 'PlayerFirebaseUid00000000004';
    const attackerId = 'HackerFirebaseUid00000000005';

    for (const id of [adminId, judgeId, clerkId, playerId, attackerId]) {
      await asUser(id, 'authenticated', 'select public.ensure_my_profile();');
    }
    const provisioned = await client.query('select count(*) from public.profiles;');
    assert(parseInt(provisioned.rows[0].count) === 5, 'ensure_my_profile creates profiles for Firebase users');

    await client.query(`
      -- Set roles via superuser (as in the SQL editor)
      update public.profiles set role = 'admin', verification_status = 'verified', minecraft_username = 'AdminMaster' where id = '${adminId}';
      update public.profiles set role = 'judge', verification_status = 'verified', minecraft_username = 'JudgeDredd' where id = '${judgeId}';
      update public.profiles set role = 'clerk', verification_status = 'verified', minecraft_username = 'ClerkBob' where id = '${clerkId}';
    `);

    console.log('\n--- EXECUTING AUTHORIZATION & SECURITY TESTS ---\n');

    // --------------------------------------------------------------------------
    // Test 0: Firebase token validation
    // --------------------------------------------------------------------------
    const foreignProject = await asUser(adminId, 'authenticated', 'select public.current_user_id() as uid, public.is_admin() as admin;', {
      iss: 'https://securetoken.google.com/someone-elses-project',
      aud: 'someone-elses-project'
    });
    assert(foreignProject.rows[0].uid === null && foreignProject.rows[0].admin === false,
      'Token from another Firebase project gets no identity (even with an admin UID)');

    let foreignProvisionBlocked = false;
    try {
      await asUser('IntruderUid', 'authenticated', 'select public.ensure_my_profile();', {
        iss: 'https://securetoken.google.com/someone-elses-project',
        aud: 'someone-elses-project'
      });
    } catch (e) {
      foreignProvisionBlocked = e.message.includes('Authentication required');
    }
    assert(foreignProvisionBlocked, 'Token from another Firebase project cannot create a profile');

    // --------------------------------------------------------------------------
    // Test 1: Anonymous User Permissions
    // --------------------------------------------------------------------------
    const anonCases = await asUser('', 'anon', 'select count(*) from public.cases;');
    assert(parseInt(anonCases.rows[0].count) === 4, 'Anonymous user can view published cases');

    let anonFilingsBlocked = false;
    try {
      await asUser('', 'anon', 'select * from public.filings;');
    } catch (e) {
      anonFilingsBlocked = true;
    }
    assert(anonFilingsBlocked, 'Anonymous user cannot read filings table (blocked)');

    // --------------------------------------------------------------------------
    // Test 2: Profile Privilege Escalation (Attacker Attempt)
    // --------------------------------------------------------------------------
    let roleEscalationBlocked = false;
    try {
      await asUser(attackerId, 'authenticated', `
        update public.profiles set role = 'admin' where id = '${attackerId}';
      `);
    } catch (e) {
      roleEscalationBlocked = true;
    }
    assert(roleEscalationBlocked, 'Attacker cannot elevate own role to admin (Blocked by trigger)');

    let verificationEscalationBlocked = false;
    try {
      await asUser(attackerId, 'authenticated', `
        update public.profiles set verification_status = 'verified' where id = '${attackerId}';
      `);
    } catch (e) {
      verificationEscalationBlocked = true;
    }
    assert(verificationEscalationBlocked, 'Attacker cannot self-verify verification_status (Blocked by trigger)');

    let legitimateProfileUpdatePassed = false;
    try {
      await asUser(attackerId, 'authenticated', `
        update public.profiles set full_name = 'Reformed Citizen' where id = '${attackerId}';
      `);
      legitimateProfileUpdatePassed = true;
    } catch (e) {
      legitimateProfileUpdatePassed = false;
    }
    assert(legitimateProfileUpdatePassed, 'Citizen can update legitimate display profile fields');

    // --------------------------------------------------------------------------
    // Test 3: Sensitive Verification Data Seclusion
    // --------------------------------------------------------------------------
    // Player requests Minecraft linking
    const linkResult = await asUser(playerId, 'authenticated', `
      select public.request_minecraft_linking('HonestMiner', '069a79f4-44e9-4726-a5be-fca90e38aaf5') as res;
    `);
    const token = linkResult.rows[0].res.verification_token;
    assert(token && token.startsWith('CPB-'), 'Token generated and returned to user via stored procedure');

    // Attacker tries to read HonestMiner's verification token from profile_verifications
    const stolenTokens = await asUser(attackerId, 'authenticated', `
      select * from public.profile_verifications where user_id = '${playerId}';
    `);
    assert(stolenTokens.rows.length === 0, 'Attacker cannot read another user token from profile_verifications (RLS protected)');

    // --------------------------------------------------------------------------
    // Test 4: Confidential Tips Protection & Secrecy
    // --------------------------------------------------------------------------
    // Player submits confidential tip
    const tipResult = await asUser(playerId, 'authenticated', `
      insert into public.filings (
        filing_type, submitter_id, submitter_email, target_party_name, title, details, is_confidential, status
      ) values (
        'tip', '${playerId}', 'citizen@cpb.court', 'SuspectX', 'Secret Warehouse Contraband', 'Illegal brass stash in Sector 9', true, 'pending_review'
      ) returning id, reference_number;
    `);
    const tipId = tipResult.rows[0].id;
    assert(tipId !== undefined, 'Confidential tip successfully lodged with reference number');

    // Attacker tries to view HonestMiner's tip
    const snoopedTips = await asUser(attackerId, 'authenticated', `
      select * from public.filings where id = '${tipId}';
    `);
    assert(snoopedTips.rows.length === 0, 'Confidential tip hidden from other citizens (RLS protected)');

    // Clerk attempts to docket the tip into a public case (MUST FAIL!)
    let tipDocketBlocked = false;
    try {
      await asUser(clerkId, 'authenticated', `
        select public.docket_filing('${tipId}', 'Magistrate', 'Initial Order');
      `);
    } catch (e) {
      tipDocketBlocked = e.message.includes('Confidential tips cannot be converted into public docketed cases');
    }
    assert(tipDocketBlocked, 'Confidential tip strictly rejected by docket_filing (Protected against public conversion)');

    // Staff conducts official confidential tip review
    const tipReviewResult = await asUser(clerkId, 'authenticated', `
      select public.review_confidential_tip('${tipId}', 'investigate', 'Forwarded to FBIS undercover squad') as res;
    `);
    assert(tipReviewResult.rows[0].res.status === 'under_investigation', 'Staff successfully placed tip under investigation without publishing');

    // --------------------------------------------------------------------------
    // Test 5: Transactional Lawsuit Docketing & Duplicate Protection
    // --------------------------------------------------------------------------
    // Player submits civil lawsuit
    const lawsuitResult = await asUser(playerId, 'authenticated', `
      insert into public.filings (
        filing_type, submitter_id, submitter_email, target_party_name, title, details, relief_sought, is_confidential, status
      ) values (
        'lawsuit', '${playerId}', 'citizen@cpb.court', 'Cogwheel Corp', 'Breach of Rotational Power Agreement', 'Failed to deliver 128 RPM stress units.', '100 Brass Ingots', false, 'pending_review'
      ) returning id;
    `);
    const lawsuitFilingId = lawsuitResult.rows[0].id;

    // Clerk dockets the filing
    const docketResult = await asUser(clerkId, 'authenticated', `
      select public.docket_filing('${lawsuitFilingId}', 'Magistrate Vance', 'Trial scheduled for Sunday.') as res;
    `);
    const newDocketNumber = docketResult.rows[0].res.docket_number;
    assert(newDocketNumber && newDocketNumber.startsWith('CTBE-CV-'), `Lawsuit docketed under official identifier ${newDocketNumber}`);

    // Attempt duplicate docketing on the same filing (MUST FAIL!)
    let duplicateDocketBlocked = false;
    try {
      await asUser(clerkId, 'authenticated', `
        select public.docket_filing('${lawsuitFilingId}', 'Another Judge', 'Duplicate order');
      `);
    } catch (e) {
      duplicateDocketBlocked = e.message.includes('has already been processed');
    }
    assert(duplicateDocketBlocked, 'Duplicate docketing blocked by transactional status check and row lock');

    // --------------------------------------------------------------------------
    // Test 6: Staff Separation of Capabilities (Clerk vs Judge vs Admin)
    // --------------------------------------------------------------------------
    // Get newly created case ID
    const caseId = docketResult.rows[0].res.case_id;

    // Clerk attempts to issue a binding judicial verdict (MUST FAIL!)
    let clerkVerdictBlocked = false;
    try {
      await asUser(clerkId, 'authenticated', `
        select public.update_case_status('${caseId}', 'verdict_rendered', 'Guilty - 500 ingots fine', 'Verdict rendered');
      `);
    } catch (e) {
      clerkVerdictBlocked = e.message.includes('Only appointed Judges or Administrators');
    }
    assert(clerkVerdictBlocked, 'Clerk blocked from rendering verdicts or judicial orders');

    // Judge issues binding judicial verdict (MUST SUCCEED)
    let judgeVerdictPassed = false;
    try {
      await asUser(judgeId, 'authenticated', `
        select public.update_case_status('${caseId}', 'verdict_rendered', 'Guilty - 500 ingots fine', 'Verdict rendered by Judge');
      `);
      judgeVerdictPassed = true;
    } catch (e) {
      judgeVerdictPassed = false;
    }
    assert(judgeVerdictPassed, 'Judge successfully issued binding court order and verdict');

    // Clerk or Judge attempts to assign admin role to another user (MUST FAIL!)
    let unauthorizedRoleAssignmentBlocked = false;
    try {
      await asUser(judgeId, 'authenticated', `
        select public.admin_set_user_role('${playerId}', 'admin');
      `);
    } catch (e) {
      unauthorizedRoleAssignmentBlocked = e.message.includes('Only system administrators');
    }
    assert(unauthorizedRoleAssignmentBlocked, 'Judge blocked from promoting accounts to admin');

    // Admin assigns clerk role to player (MUST SUCCEED)
    let adminRoleAssignmentPassed = false;
    try {
      await asUser(adminId, 'authenticated', `
        select public.admin_set_user_role('${playerId}', 'clerk');
      `);
      adminRoleAssignmentPassed = true;
    } catch (e) {
      adminRoleAssignmentPassed = false;
    }
    assert(adminRoleAssignmentPassed, 'Admin successfully elevated citizen to clerk role');

    // --------------------------------------------------------------------------
    // Test 7: Minecraft Verification & Single-Account Binding
    // --------------------------------------------------------------------------
    // Clerk verifies HonestMiner
    const verifySuccess = await asUser(clerkId, 'authenticated', `
      select public.verify_minecraft_profile('${playerId}', 'HonestMiner', '069a79f4-44e9-4726-a5be-fca90e38aaf5');
    `);
    assert(verifySuccess.rows[0].verify_minecraft_profile === true, 'Clerk successfully verified Minecraft profile');

    // Attacker attempts to bind the same verified UUID to their account (MUST FAIL!)
    let duplicateUuidBlocked = false;
    try {
      await asUser(clerkId, 'authenticated', `
        select public.verify_minecraft_profile('${attackerId}', 'MinerImposter', '069a79f4-44e9-4726-a5be-fca90e38aaf5');
      `);
    } catch (e) {
      duplicateUuidBlocked = e.message.includes('already verified for citizen profile');
    }
    assert(duplicateUuidBlocked, 'Duplicate UUID verification strictly blocked by conflict check and unique index');

    // --------------------------------------------------------------------------
    // Test 8: Forged Filings & Direct Case Edits
    // --------------------------------------------------------------------------
    const forged = await asUser(attackerId, 'authenticated', `
      insert into public.filings (
        filing_type, submitter_id, submitter_email, submitter_minecraft_uuid, submitter_verified,
        title, details, status, reference_number, review_notes
      ) values (
        'lawsuit', '${attackerId}', 'fake@x.com', '069a79f4-44e9-4726-a5be-fca90e38aaf5', true,
        'Forged', 'x', 'docketed', 'FAKE-1', 'approved'
      ) returning submitter_email, submitter_verified, submitter_minecraft_uuid, status, reference_number, review_notes;
    `);
    const f = forged.rows[0];
    assert(
      f.submitter_email === `${attackerId}@cpb.test` && f.submitter_verified === false && f.submitter_minecraft_uuid === null &&
      f.status === 'pending_review' && f.reference_number.startsWith('FIL-') && f.review_notes === null,
      'Player-forged filing fields are overwritten by the server'
    );

    // The sanitizer rewrites submitter_id to the caller, so the filing lands on the attacker's own account
    const impersonated = await asUser(attackerId, 'authenticated', `
      insert into public.filings (filing_type, submitter_id, title, details)
      values ('lawsuit', '${playerId}', 'Impersonated', 'x') returning submitter_id;
    `);
    assert(impersonated.rows[0].submitter_id === attackerId, 'Player cannot file under another user ID');

    const clerkDirectEdit = await asUser(clerkId, 'authenticated', `
      update public.cases set status = 'dismissed' where id = '${caseId}' returning id;
    `);
    assert(clerkDirectEdit.rows.length === 0, 'Clerk cannot bypass judge-only rules by editing cases directly');

    console.log('\n================================================================');
    if (failures === 0) {
      console.log(`   RESULT: ALL ${passes} LIVE DATABASE SECURITY TESTS PASSED!`);
      console.log('================================================================\n');
    } else {
      console.error(`   RESULT: ${failures} LIVE DATABASE SECURITY TESTS FAILED!     `);
      console.log('================================================================\n');
    }

  } catch (err) {
    console.error('Audit suite encountered unexpected execution error:', err);
    failures++;
  } finally {
    await client.end();
  }

  process.exit(failures === 0 ? 0 : 1);
}

runSecurityAudit();
