# Create: Project Blueprint (CPB) — Federal Judiciary & High Court
## Supabase, Firebase Sign-In, and Minecraft Verification Setup Guide

This document details the configuration required to activate Firebase (Google) sign-in, apply the database schema, deploy the Minecraft identity verification edge function, and grant judicial administrative access for the CPB Federal Judiciary system.

---

### Supabase Project Overview
- **Project URL:** `https://cxwhmzfpdwwpdjogtuwq.supabase.co`
- **Project Reference:** `cxwhmzfpdwwpdjogtuwq`
- **Publishable Key:** `sb_publishable_wIZBKot3rmT6GYSArRa7fg_SP21wwaJ` (configured in `server-security/judiciary/judiciary.js`)

---

## 1. Firebase Authentication (Google Sign-In)

Firebase handles sign-in; Supabase stores all judiciary data and accepts Firebase ID tokens via **Third-Party Auth**. Sign-in only identifies the returning web user — Minecraft ownership is proven separately via the in-game `/verify` token or a clerk (see Section 5). Everything below works on Firebase's free **Spark** plan: the `role` claim Supabase requires is added by the `firebase-claims` Supabase Edge Function instead of a Firebase Cloud Function.

### Step 1.1: Create the Firebase Project & Web App
1. Go to the **[Firebase Console](https://console.firebase.google.com/)** and create a project (e.g. `cpb-judiciary`). Google Analytics is not needed.
2. Note the **Project ID** (Project settings > General).
3. Under **Your apps**, click the web icon (`</>`) to register a web app. Copy `apiKey`, `authDomain`, `projectId`, and `appId` into `FIREBASE_CONFIG` at the top of `server-security/judiciary/judiciary.js`. These are public identifiers, not secrets.

### Step 1.2: Enable Google Sign-In
1. Go to **Authentication** > **Sign-in method** > **Add new provider** > **Google**, enable it, set a support email, and save.
2. Go to **Authentication** > **Settings** > **Authorized domains** and add `create-project-blueprint.github.io`.

### Step 1.3: Create a Service Account Key (for the `firebase-claims` function)
1. Go to **Project settings** > **Service accounts** > **Generate new private key**. A JSON file downloads.
2. **Keep this file secret** — never commit it to the repository. You will paste it into a Supabase secret in Step 2.2, then you can delete the local copy.

---

## 2. Supabase Configuration

### Step 2.1: Register Firebase as a Third-Party Auth Provider
1. Open the **[Supabase Dashboard](https://supabase.com/dashboard/project/cxwhmzfpdwwpdjogtuwq)**.
2. Go to **Authentication** > **Sign In / Providers** > **Third-Party Auth** > **Add provider** > **Firebase**, enter your Firebase **Project ID**, and save.
   *(Supabase rejects tokens from Firebase projects that are not registered here.)*

### Step 2.2: Set Edge Function Secrets
```powershell
npx supabase secrets set FIREBASE_PROJECT_ID=your-firebase-project-id
npx supabase secrets set FIREBASE_SERVICE_ACCOUNT="$(Get-Content -Raw path\to\service-account.json)"
```

### Step 2.3: Tell the Database Your Firebase Project ID
After the migrations are applied (Section 3), run this in the **SQL Editor**. Until it is set, the database accepts no Firebase sign-ins (it checks each token's issuer and audience against this value):
```sql
insert into private.settings (key, value) values ('firebase_project_id', 'your-firebase-project-id')
on conflict (key) do update set value = excluded.value;
```

### Step 2.4: Deploy the Claims Function
```powershell
npx supabase functions deploy firebase-claims --no-verify-jwt
```
On a user's first sign-in, the site calls this function, which verifies their Firebase ID token and adds the `role: "authenticated"` custom claim; the site then refreshes the token. Without that claim Supabase treats the user as anonymous.

---

## 3. Applying Database Migrations

Three version-controlled migrations are prepared in `supabase/migrations/`:
1. `20261017000001_initial_judiciary_schema.sql`: Sequences, `profiles`, `cases`, `filings`, `case_events`, `auth.users` trigger, and RLS policies.
2. `20261017000002_seed_published_cases.sql`: Seeds official historical CPB High Court dockets (`CTBE-CV-2026-0042`, `CTBE-CR-2026-0019`, `CTBE-AP-2026-0008`, `CTBE-AP-2026-0015`) and associated case history events.
3. `20261017000003_verification_and_workbench_functions.sql`: Stored procedures for player linking token requests, clerk verification, docketing filings into cases, and updating judicial orders.

### Method A: Via Supabase Dashboard SQL Editor (No CLI Authentication Required)
1. In the Supabase Dashboard, open **SQL Editor**.
2. Click **New query**.
3. Open `supabase/migrations/20261017000001_initial_judiciary_schema.sql` on your computer, copy all contents, paste into the SQL Editor, and click **Run**.
4. Repeat for:
   - `supabase/migrations/20261017000002_seed_published_cases.sql`
   - `supabase/migrations/20261017000003_verification_and_workbench_functions.sql`

### Method B: Via Supabase CLI
If you have your Supabase access token or database password:
```powershell
# 1. Login to Supabase CLI (opens browser authentication)
npx supabase login

# 2. Link your local directory to the remote project
npx supabase link --project-ref cxwhmzfpdwwpdjogtuwq

# 3. Push migrations to the remote database
npx supabase db push
```

---

## 4. Initial Judicial & Clerk Role Provisioning

When a user signs in with Google (via Firebase) for the first time, the site calls `ensure_my_profile()`, which creates their profile in `public.profiles` with the default role of `'player'`.

To elevate yourself or designated staff to Clerk, Judge, or Admin:

1. Sign in once on the website using **Sign in with Google**.
2. In the **Supabase Dashboard** > **SQL Editor**, run the following query (replace with your email and Minecraft username):

```sql
UPDATE public.profiles
SET 
    role = 'admin',                    -- Options: 'clerk', 'judge', 'admin'
    verification_status = 'verified',
    minecraft_username = 'YourMinecraftIGN',
    minecraft_uuid = '069a79f4-44e9-4726-a5be-fca90e38aaf5', -- Optional: your Java UUID
    minecraft_verified_at = now()
WHERE email = 'your-google-email@gmail.com';
```

Once elevated:
- Reloading the Judiciary page will show an **ADMIN** / **JUDGE** / **CLERK** badge in the user header.
- The dropdown menu will display **Staff Workbench**, allowing staff to review incoming lawsuits, appeals, and confidential tips, docket them into published cases, or verify player identities.

---

## 5. Minecraft Identity Verification Architecture

### Why This Design?
Website sign-in (Google) cannot prove who owns a Minecraft Java account: Mojang only exposes ownership through Xbox Live XSTS token exchange, which Microsoft restricts to approved partners. Ownership is therefore proven in-game instead.

### The CPB Secure Solution
To prevent impersonation while remaining 100% reliable and compatible with Minecraft Java Edition:
1. **Firebase (Google) Authentication:** Identifies the returning web user; Supabase accepts the Firebase ID token.
2. **Canonical UUID Resolution:** When the player inputs their Minecraft IGN in the Judiciary UI, the system resolves their immutable Mojang Java Edition UUID via the official Mojang API (`https://api.mojang.com/users/profiles/minecraft/{username}`).
3. **Verification Token:** The system issues a cryptographically secure 8-character token (`CPB-XXXXXXXX`) stored in the private `public.profile_verifications` table (expires after 2 hours).
4. **Verification Finalization:**
   - **In-Game Command (Automated):** The CPB Minecraft server runs a lightweight command or webhook `/verify CPB-XXXXXXXX` calling the `verify-minecraft` Edge Function.
   - **Staff Verification (Clerk Workbench):** Alternatively, Clerks and Judges can confirm a player's in-game identity directly from the Staff Workbench with one click.
5. **Single-Account Binding:** A verified Minecraft UUID can only ever be bound to one CPB profile at a time (`idx_profiles_verified_uuid` unique constraint).

### Deploying the Verification Edge Function (Optional for automated in-game verification)
If you wish to automate verification via a Minecraft server plugin/datapack:
```powershell
npx supabase functions deploy verify-minecraft --no-verify-jwt
```
The Minecraft server POSTs `{ "action": "confirm_ingame", "verification_token": "CPB-XXXXXXXX", "in_game_uuid": "player-uuid", "in_game_username": "player-name" }` to `https://cxwhmzfpdwwpdjogtuwq.supabase.co/functions/v1/verify-minecraft` with the header `x-server-secret: <MINECRAFT_SERVER_WEBHOOK_SECRET>`. The function then marks the profile as verified using the service role key. Set the secret with `npx supabase secrets set MINECRAFT_SERVER_WEBHOOK_SECRET=<long random value>`.

---

## 6. Verification and Testing

You can run the automated validation test suite locally anytime:
```powershell
node tests/test_judiciary.js
```
The test verifies:
- File existence and paths.
- HTML and JavaScript DOM ID consistency (all 24 dynamic hooks matched).
- Absence of leaked secrets or service role keys in client code.
- Presence of strict XSS escaping across all dynamic docket and modal renderings.
- Migration syntax and RLS enablement.
- Edge function configuration.
