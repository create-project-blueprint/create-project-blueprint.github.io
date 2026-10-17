const fs = require('fs');
const path = require('path');

console.log('--- CPB Federal Judiciary Static & Schema Verification Test Suite ---');

let failureCount = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failureCount++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

// 1. Check file existence
const requiredFiles = [
  'server-security/judiciary/index.html',
  'server-security/judiciary/judiciary.js',
  'supabase/migrations/20261017000001_initial_judiciary_schema.sql',
  'supabase/migrations/20261017000002_seed_published_cases.sql',
  'supabase/migrations/20261017000003_verification_and_workbench_functions.sql',
  'supabase/migrations/20261018000004_firebase_auth.sql',
  'supabase/functions/verify-minecraft/index.ts',
  'supabase/functions/firebase-claims/index.ts',
  'JUDICIARY_SETUP.md'
];

for (const file of requiredFiles) {
  assert(fs.existsSync(file), `File exists: ${file}`);
}

// 2. DOM ID Consistency Check
const html = fs.readFileSync('server-security/judiciary/index.html', 'utf8');
const js = fs.readFileSync('server-security/judiciary/judiciary.js', 'utf8');

const idRegex = /getElementById\(['"]([^'"]+)['"]\)/g;
let match;
const usedIds = new Set();
while ((match = idRegex.exec(js)) !== null) {
  usedIds.add(match[1]);
}

const missingIds = [];
for (const id of usedIds) {
  const inHtml = html.includes(`id="${id}"`) || html.includes(`id='${id}'`);
  const inJsTemplate = js.includes(`id="${id}"`) || js.includes(`id='${id}'`);
  if (!inHtml && !inJsTemplate) {
    missingIds.push(id);
  }
}

assert(missingIds.length === 0, `All ${usedIds.size} getElementById references match elements in index.html or dynamic templates (missing: ${missingIds.join(', ')})`);

// 3. Security checks in judiciary.js
assert(
  !js.includes('service_role') && !js.includes('POSTGRES_PASSWORD'),
  'No leaked privileged secrets or service_role keys in client JS'
);

assert(
  js.includes('escapeHtml'),
  'judiciary.js uses HTML escaping for untrusted database/user input'
);

assert(
  js.includes('GoogleAuthProvider') && js.includes('accessToken') && js.includes('ensure_my_profile'),
  'judiciary.js signs in with Firebase (Google) and passes the Firebase token to Supabase'
);

assert(
  js.includes('review_confidential_tip'),
  'judiciary.js integrates dedicated confidential tip review workflow'
);

assert(
  js.includes('admin_set_user_role'),
  'judiciary.js integrates administrative role assignment procedure'
);

// 4. Schema and Migration Checks
const m1 = fs.readFileSync('supabase/migrations/20261017000001_initial_judiciary_schema.sql', 'utf8');
const m2 = fs.readFileSync('supabase/migrations/20261017000002_seed_published_cases.sql', 'utf8');
const m3 = fs.readFileSync('supabase/migrations/20261017000003_verification_and_workbench_functions.sql', 'utf8');

assert(/create\s+table\s+(if\s+not\s+exists\s+)?public\.profiles/i.test(m1), 'Migration 1 defines public.profiles');
assert(/create\s+table\s+(if\s+not\s+exists\s+)?public\.profile_verifications/i.test(m1), 'Migration 1 defines isolated public.profile_verifications');
assert(/create\s+table\s+(if\s+not\s+exists\s+)?public\.cases/i.test(m1), 'Migration 1 defines public.cases');
assert(/create\s+table\s+(if\s+not\s+exists\s+)?public\.filings/i.test(m1), 'Migration 1 defines public.filings');
assert(/create\s+table\s+(if\s+not\s+exists\s+)?public\.case_events/i.test(m1), 'Migration 1 defines public.case_events');

// Anti-privilege escalation & RLS checks
assert(m1.includes('trig_protect_profile_fields'), 'Migration 1 defines anti-privilege escalation trigger');
assert(!m1.includes('verification_token text unique,'), 'Sensitive verification_token column removed from public.profiles');
assert(m1.includes('chk_tip_confidential'), 'Migration 1 enforces that tips must be confidential');
assert(m1.includes('set search_path = public, pg_temp'), 'Migration 1 enforces safe search_path on functions');

assert(m1.includes('alter table public.profiles enable row level security;'), 'RLS enabled on profiles');
assert(m1.includes('alter table public.profile_verifications enable row level security;'), 'RLS enabled on profile_verifications');
assert(m1.includes('alter table public.cases enable row level security;'), 'RLS enabled on cases');
assert(m1.includes('alter table public.filings enable row level security;'), 'RLS enabled on filings');
assert(m1.includes('alter table public.case_events enable row level security;'), 'RLS enabled on case_events');

// Migration 2 Idempotency
assert(m2.includes('CTBE-CV-2026-0042'), 'Migration 2 seeds sample historical civil case');
assert(m2.includes('CTBE-CR-2026-0019'), 'Migration 2 seeds sample criminal case');
assert(m2.includes('on conflict (id) do nothing;'), 'Migration 2 uses deterministic event IDs and idempotent conflict resolution');

// Migration 3 Workflows & Controls
assert(m3.includes('create or replace function public.request_minecraft_linking'), 'Migration 3 includes request_minecraft_linking function');
assert(m3.includes('create or replace function public.verify_minecraft_profile'), 'Migration 3 includes verify_minecraft_profile function');
assert(m3.includes('create or replace function public.docket_filing'), 'Migration 3 includes docket_filing function');
assert(m3.includes('create or replace function public.review_confidential_tip'), 'Migration 3 includes review_confidential_tip function');
assert(m3.includes('create or replace function public.update_case_status'), 'Migration 3 includes update_case_status function');
assert(m3.includes('create or replace function public.admin_set_user_role'), 'Migration 3 includes admin_set_user_role function');
assert(m3.includes('for update'), 'Migration 3 implements transactional row locking');
assert(m3.includes('revoke all on function'), 'Migration 3 revokes unauthenticated/public execution on functions');

// 5. Edge Function Check
const edgeFunc = fs.readFileSync('supabase/functions/verify-minecraft/index.ts', 'utf8');
assert(edgeFunc.includes('api.mojang.com/users/profiles/minecraft/'), 'Edge Function queries official Mojang API for Java profiles');
assert(edgeFunc.includes('profile_verifications'), 'Edge Function checks isolated profile_verifications table');
assert(edgeFunc.includes('SUPABASE_SERVICE_ROLE_KEY'), 'Edge Function utilizes isolated server-side service role key');

console.log(`\nTest results: ${failureCount === 0 ? 'ALL STATIC CHECKS PASSED!' : `${failureCount} FAILURES`}`);
process.exit(failureCount === 0 ? 0 : 1);
