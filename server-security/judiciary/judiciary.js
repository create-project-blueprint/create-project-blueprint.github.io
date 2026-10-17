// ==============================================================================
// File: server-security/judiciary/judiciary.js
// Project: Create: Project Blueprint (CPB) Federal Judiciary & High Court
// Description: Firebase Auth (Google) sign-in, Supabase data access, Minecraft Identity
//              Verification, Public Docket loading, Filing submissions, and
//              Clerk/Judicial Workbench management.
// ==============================================================================

(function() {
    'use strict';

    // --------------------------------------------------------------------------
    // 1. Configuration & Supabase Client Initialization
    // --------------------------------------------------------------------------
    const SUPABASE_URL = "https://cxwhmzfpdwwpdjogtuwq.supabase.co";
    const SUPABASE_ANON_KEY = "sb_publishable_wIZBKot3rmT6GYSArRa7fg_SP21wwaJ";

    // Firebase web app config (Firebase Console > Project settings > Your apps).
    // These values are public identifiers, not secrets.
    const FIREBASE_CONFIG = {
        apiKey: "AIzaSyB-TbC_iYvPVRhSd71Juaq9a-s33D9CjJ0",
        authDomain: "other-projects-87468.firebaseapp.com",
        projectId: "other-projects-87468",
        appId: "1:690759178180:web:c02b30cedcc8a419603691"
    };

    // Firebase handles sign-in; Supabase receives the Firebase ID token on every request
    let firebaseAuth = null;
    if (window.firebase && typeof window.firebase.initializeApp === 'function') {
        window.firebase.initializeApp(FIREBASE_CONFIG);
        firebaseAuth = window.firebase.auth();
    } else {
        console.warn("Firebase library not yet loaded. Sign-in unavailable.");
    }

    let supabaseClient = null;
    if (window.supabase && typeof window.supabase.createClient === 'function') {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            accessToken: async () => {
                const fbUser = firebaseAuth?.currentUser;
                return fbUser ? await fbUser.getIdToken(false) : null;
            }
        });
    } else {
        console.warn("Supabase library not yet loaded. Initializing offline mode.");
    }

    // Application Global State
    window.CPB_JUDICIARY = {
        client: supabaseClient,
        currentUser: null,
        currentProfile: null,
        publishedCases: [],
        sampleCases: getSampleCasesData(),
        activeFilter: 'all',
        searchQuery: '',
        userFilings: []
    };

    // --------------------------------------------------------------------------
    // 2. Safe HTML Escaping (XSS Prevention)
    // --------------------------------------------------------------------------
    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function formatDate(dateStr) {
        if (!dateStr) return 'N/A';
        try {
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return String(dateStr);
            return d.toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
            });
        } catch (e) {
            return String(dateStr);
        }
    }

    // --------------------------------------------------------------------------
    // 3. Authentication & Profile Management
    // --------------------------------------------------------------------------
    async function initAuth() {
        if (!supabaseClient || !firebaseAuth) {
            handleUserSignedOut();
            return;
        }

        // Fires once on page load (restored session or null) and on every sign-in/out
        firebaseAuth.onAuthStateChanged(async (fbUser) => {
            try {
                if (fbUser) {
                    await handleUserSignedIn(fbUser);
                } else {
                    handleUserSignedOut();
                }
            } catch (err) {
                console.error("Failed to initialize authentication:", err);
                handleUserSignedOut();
            }
        });
    }

    // Supabase only treats a Firebase token as signed in when it carries the
    // `role: "authenticated"` claim. New users get it from the firebase-claims
    // edge function, then we force-refresh the token to pick it up.
    async function ensureSupabaseRoleClaim(fbUser) {
        const tokenResult = await fbUser.getIdTokenResult();
        if (tokenResult.claims.role === 'authenticated') return;

        const { error } = await supabaseClient.functions.invoke('firebase-claims', { method: 'POST' });
        if (error) throw error;
        await fbUser.getIdToken(true);
    }

    async function handleUserSignedIn(fbUser) {
        window.CPB_JUDICIARY.currentUser = { id: fbUser.uid, email: fbUser.email };

        try {
            await ensureSupabaseRoleClaim(fbUser);

            // Creates the profile on first sign-in, refreshes email/name otherwise
            const { data: profile, error } = await supabaseClient.rpc('ensure_my_profile');
            if (error) {
                console.warn("Profile provisioning error:", error);
            }

            window.CPB_JUDICIARY.currentProfile = profile || {
                id: fbUser.uid,
                email: fbUser.email,
                full_name: fbUser.displayName || fbUser.email?.split('@')[0] || 'Player',
                role: 'player',
                verification_status: 'unlinked',
                minecraft_username: null,
                minecraft_uuid: null
            };
        } catch (e) {
            console.error("Profile retrieval error:", e);
        }

        renderAuthHeader();
        updateFilingFormsAuthBanner();
    }

    function handleUserSignedOut() {
        window.CPB_JUDICIARY.currentUser = null;
        window.CPB_JUDICIARY.currentProfile = null;
        renderAuthHeader();
        updateFilingFormsAuthBanner();
    }

    async function signInWithGoogle() {
        if (!supabaseClient || !firebaseAuth) {
            alert("Sign-in services are offline. Please check your internet connection.");
            return;
        }

        try {
            await firebaseAuth.signInWithPopup(new window.firebase.auth.GoogleAuthProvider());
            // onAuthStateChanged handles the rest
        } catch (err) {
            if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return;
            console.error("Sign in failed:", err);
            alert("Google Sign-in failed: " + err.message +
                  "\n\nPlease ensure Google is enabled under Firebase Console > Authentication > Sign-in method, and this site's domain is listed under Authorized domains.");
        }
    }

    async function signOut() {
        if (!firebaseAuth) return;
        try {
            await firebaseAuth.signOut();
            window.location.reload();
        } catch (err) {
            console.error("Sign out error:", err);
        }
    }

    function renderAuthHeader() {
        const container = document.getElementById('authHeaderArea');
        if (!container) return;

        const user = window.CPB_JUDICIARY.currentUser;
        const profile = window.CPB_JUDICIARY.currentProfile;

        if (!user) {
            // Unauthenticated state
            container.innerHTML = `
                <button onclick="window.CPB_JUDICIARY.signInWithGoogle()" 
                    class="bg-slate-900 hover:bg-slate-800 text-amber-300 border border-amber-600/50 hover:border-amber-400 px-3.5 py-2 rounded text-xs font-bold tracking-wider uppercase transition shadow-md flex items-center space-x-2">
                    <!-- Google "G" Icon -->
                    <svg class="w-4 h-4" viewBox="0 0 48 48">
                        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                    </svg>
                    <span>Sign in with Google</span>
                </button>
            `;
            return;
        }

        // Authenticated state
        const mcName = profile?.minecraft_username;
        const vStatus = profile?.verification_status || 'unlinked';
        const role = profile?.role || 'player';

        let badgeHtml = '';
        if (vStatus === 'verified') {
            badgeHtml = `<span class="bg-emerald-950 text-emerald-400 border border-emerald-800 text-[10px] px-1.5 py-0.5 rounded font-mono font-bold">VERIFIED</span>`;
        } else if (vStatus === 'pending_verification') {
            badgeHtml = `<button onclick="window.CPB_JUDICIARY.openMinecraftVerifyModal()" class="bg-amber-950 text-amber-400 border border-amber-800 text-[10px] px-1.5 py-0.5 rounded font-mono font-bold hover:bg-amber-900 transition">PENDING</button>`;
        } else {
            badgeHtml = `<button onclick="window.CPB_JUDICIARY.openMinecraftVerifyModal()" class="bg-slate-800 text-gray-400 border border-slate-700 text-[10px] px-1.5 py-0.5 rounded font-mono font-bold hover:text-white transition">LINK IGN</button>`;
        }

        let roleBadge = '';
        if (role !== 'player') {
            roleBadge = `<span class="bg-purple-950 text-purple-300 border border-purple-800 text-[10px] px-1.5 py-0.5 rounded font-mono font-bold uppercase">${escapeHtml(role)}</span>`;
        }

        const avatarUrl = mcName 
            ? `https://mc-heads.net/avatar/${encodeURIComponent(mcName)}/28`
            : (profile?.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.email || 'Player')}&background=1e293b&color=fbbf24&size=28`);

        const displayName = mcName || user.email?.split('@')[0] || 'Citizen';

        container.innerHTML = `
            <div class="relative group">
                <button class="bg-slate-900 hover:bg-slate-800 border border-amber-600/40 rounded-lg py-1.5 px-3 flex items-center space-x-2.5 transition">
                    <img src="${avatarUrl}" alt="Avatar" class="w-6 h-6 rounded bg-slate-950 border border-slate-700" onerror="this.src='https://ui-avatars.com/api/?name=P&size=28'">
                    <span class="text-xs font-bold text-white max-w-[120px] truncate">${escapeHtml(displayName)}</span>
                    ${badgeHtml}
                    ${roleBadge}
                    <svg class="w-3.5 h-3.5 text-gray-400 group-hover:text-amber-400 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                    </svg>
                </button>

                <!-- Dropdown Menu -->
                <div class="absolute right-0 mt-1 w-56 bg-slate-950 border border-amber-600/40 rounded-xl shadow-2xl py-2 hidden group-hover:block z-50 text-xs">
                    <div class="px-3.5 py-2 border-b border-slate-800 text-gray-400">
                        <div class="font-bold text-white truncate">${escapeHtml(user.email || displayName)}</div>
                        <div class="text-[11px] text-gray-500 font-mono mt-0.5">Role: ${escapeHtml(role.toUpperCase())}</div>
                    </div>

                    <a href="javascript:void(0)" onclick="window.CPB_JUDICIARY.openMyFilingsModal()" 
                        class="block px-3.5 py-2 text-gray-200 hover:bg-amber-950/40 hover:text-amber-300 transition flex items-center justify-between">
                        <span>My Case Filings</span>
                        <span class="text-[10px] font-mono text-gray-500">History</span>
                    </a>

                    <a href="javascript:void(0)" onclick="window.CPB_JUDICIARY.openMinecraftVerifyModal()" 
                        class="block px-3.5 py-2 text-gray-200 hover:bg-amber-950/40 hover:text-amber-300 transition flex items-center justify-between">
                        <span>Minecraft Identity</span>
                        <span class="text-[10px] font-mono ${vStatus === 'verified' ? 'text-emerald-400' : 'text-amber-400'}">${vStatus.toUpperCase()}</span>
                    </a>

                    ${(role === 'clerk' || role === 'judge' || role === 'admin') ? `
                        <a href="javascript:void(0)" onclick="window.CPB_JUDICIARY.openWorkbenchModal()" 
                            class="block px-3.5 py-2 text-amber-400 hover:bg-amber-950/60 font-bold transition flex items-center justify-between border-t border-slate-800/80">
                            <span>Judicial Workbench</span>
                            <span class="text-[10px] bg-amber-950 border border-amber-700/60 text-amber-300 px-1 rounded">STAFF</span>
                        </a>
                    ` : ''}

                    <div class="border-t border-slate-800 mt-1 pt-1">
                        <a href="javascript:void(0)" onclick="window.CPB_JUDICIARY.signOut()" 
                            class="block px-3.5 py-2 text-red-400 hover:bg-red-950/40 transition">
                            Sign Out
                        </a>
                    </div>
                </div>
            </div>
        `;
    }

    function updateFilingFormsAuthBanner() {
        const user = window.CPB_JUDICIARY.currentUser;
        const profile = window.CPB_JUDICIARY.currentProfile;

        const banners = document.querySelectorAll('.filing-auth-banner');
        banners.forEach(banner => {
            if (!user) {
                banner.innerHTML = `
                    <div class="bg-amber-950/40 border border-amber-800/60 p-3 rounded-lg text-xs text-amber-300 flex items-center justify-between">
                        <span>⚠️ You must sign in with Google to submit an official petition.</span>
                        <button type="button" onclick="window.CPB_JUDICIARY.signInWithGoogle()" 
                            class="bg-amber-600 hover:bg-amber-500 text-white font-bold px-2.5 py-1 rounded text-[11px] uppercase tracking-wider transition">
                            Sign In
                        </button>
                    </div>
                `;
            } else {
                const vStatus = profile?.verification_status || 'unlinked';
                const ign = profile?.minecraft_username;
                let statusText = '';

                if (vStatus === 'verified') {
                    statusText = `<span class="text-emerald-400 font-bold">✓ Verified as ${escapeHtml(ign)}</span>`;
                } else if (vStatus === 'pending_verification') {
                    statusText = `<span class="text-amber-400 font-semibold">⏳ Minecraft Identity Pending (${escapeHtml(ign)})</span> • <button type="button" onclick="window.CPB_JUDICIARY.openMinecraftVerifyModal()" class="underline text-amber-300">View Token</button>`;
                } else {
                    statusText = `<span class="text-gray-400">Minecraft Identity Unlinked</span> • <button type="button" onclick="window.CPB_JUDICIARY.openMinecraftVerifyModal()" class="text-amber-400 underline font-semibold">Link Minecraft IGN</button>`;
                }

                banner.innerHTML = `
                    <div class="bg-slate-950 p-2.5 rounded-lg border border-slate-800 text-[11px] text-gray-300 flex justify-between items-center">
                        <div><span class="text-gray-500">Submitter:</span> <span class="font-bold text-white">${escapeHtml(user.email)}</span></div>
                        <div>${statusText}</div>
                    </div>
                `;
            }
        });
    }

    // --------------------------------------------------------------------------
    // 4. Minecraft Verification Flow
    // --------------------------------------------------------------------------
    function openMinecraftVerifyModal() {
        const user = window.CPB_JUDICIARY.currentUser;
        if (!user) {
            alert("Please sign in with Google first before linking a Minecraft profile.");
            signInWithGoogle();
            return;
        }

        const profile = window.CPB_JUDICIARY.currentProfile;
        const modal = document.getElementById('minecraftVerifyModal');
        if (!modal) return;

        const currentIgnEl = document.getElementById('mcCurrentIgn');
        const currentStatusEl = document.getElementById('mcCurrentStatus');
        const tokenContainer = document.getElementById('mcTokenContainer');
        const tokenCodeEl = document.getElementById('mcTokenCode');
        const ignInput = document.getElementById('mcUsernameInput');

        if (currentIgnEl) currentIgnEl.textContent = profile?.minecraft_username || 'None Linked';
        if (currentStatusEl) {
            const st = profile?.verification_status || 'unlinked';
            currentStatusEl.textContent = st.toUpperCase();
            currentStatusEl.className = `text-xs font-mono font-bold ${
                st === 'verified' ? 'text-emerald-400' : (st === 'pending_verification' ? 'text-amber-400' : 'text-gray-400')
            }`;
        }

        if (profile?.verification_status === 'pending_verification') {
            if (supabaseClient) {
                supabaseClient
                    .from('profile_verifications')
                    .select('verification_token, expires_at')
                    .eq('user_id', user.id)
                    .maybeSingle()
                    .then(({ data }) => {
                        if (data && data.verification_token) {
                            if (tokenContainer) tokenContainer.classList.remove('hidden');
                            if (tokenCodeEl) tokenCodeEl.textContent = data.verification_token;
                        } else {
                            if (tokenContainer) tokenContainer.classList.add('hidden');
                        }
                    });
            } else {
                if (tokenContainer) tokenContainer.classList.add('hidden');
            }
        } else {
            if (tokenContainer) tokenContainer.classList.add('hidden');
        }

        if (ignInput) ignInput.value = profile?.minecraft_username || '';

        openModal('minecraftVerifyModal');
    }

    async function handleMinecraftLinkSubmit(e) {
        if (e) e.preventDefault();
        const user = window.CPB_JUDICIARY.currentUser;
        if (!user) {
            alert("Please sign in with Google first.");
            return;
        }

        const input = document.getElementById('mcUsernameInput');
        const ign = input?.value?.trim();
        if (!ign || ign.length < 3 || ign.length > 16) {
            alert("Please enter a valid Minecraft username (3-16 characters).");
            return;
        }

        const btn = document.getElementById('mcLinkSubmitBtn');
        const originalText = btn ? btn.textContent : '';
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Resolving with Mojang...';
        }

        try {
            // First step: Attempt to resolve canonical UUID from public Mojang registry
            let resolvedUuid = null;
            let canonicalName = ign;

            try {
                // Try PlayerDB or Ashcon public Mojang proxy (handles browser CORS)
                const lookupRes = await fetch(`https://playerdb.co/api/player/minecraft/${encodeURIComponent(ign)}`);
                if (lookupRes.ok) {
                    const lookupData = await lookupRes.json();
                    if (lookupData.success && lookupData.data && lookupData.data.player) {
                        canonicalName = lookupData.data.player.username;
                        resolvedUuid = lookupData.data.player.id;
                    }
                }
            } catch (mojangErr) {
                console.warn("Public Mojang proxy lookup failed, continuing with direct procedure:", mojangErr);
            }

            // Call Supabase stored procedure to register token binding
            if (supabaseClient) {
                const { data, error } = await supabaseClient.rpc('request_minecraft_linking', {
                    p_minecraft_username: canonicalName,
                    p_minecraft_uuid: resolvedUuid || ''
                });

                if (error) {
                    throw error;
                }

                if (window.CPB_JUDICIARY.currentProfile) {
                    window.CPB_JUDICIARY.currentProfile.minecraft_username = canonicalName;
                    window.CPB_JUDICIARY.currentProfile.minecraft_uuid = resolvedUuid;
                    window.CPB_JUDICIARY.currentProfile.verification_status = 'pending_verification';
                    window.CPB_JUDICIARY.currentProfile.verification_token = data.verification_token;
                }

                // Update UI in modal
                const tokenContainer = document.getElementById('mcTokenContainer');
                const tokenCodeEl = document.getElementById('mcTokenCode');
                const currentIgnEl = document.getElementById('mcCurrentIgn');
                const currentStatusEl = document.getElementById('mcCurrentStatus');

                if (currentIgnEl) currentIgnEl.textContent = canonicalName;
                if (currentStatusEl) {
                    currentStatusEl.textContent = 'PENDING_VERIFICATION';
                    currentStatusEl.className = 'text-xs font-mono font-bold text-amber-400';
                }
                if (tokenContainer) tokenContainer.classList.remove('hidden');
                if (tokenCodeEl) tokenCodeEl.textContent = data.verification_token;

                renderAuthHeader();
                updateFilingFormsAuthBanner();

                alert(`Minecraft identity request registered for "${canonicalName}".\n\nVerification Token: ${data.verification_token}\n\nExecute "/verify ${data.verification_token}" in-game or provide this code to a judicial clerk to complete verification.`);
            } else {
                alert("Database offline: Identity linking simulated. Real verification requires active Supabase connection.");
            }
        } catch (err) {
            console.error("Minecraft link error:", err);
            alert("Error linking Minecraft identity: " + (err.message || err));
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = originalText;
            }
        }
    }

    // --------------------------------------------------------------------------
    // 5. Public Docket & Case Loading
    // --------------------------------------------------------------------------
    async function loadPublishedCases() {
        const grid = document.getElementById('docketGrid');
        if (!grid) return;

        // Show loading placeholder
        grid.innerHTML = `
            <div class="col-span-1 md:col-span-2 text-center py-12">
                <div class="inline-block w-8 h-8 border-4 border-amber-600/30 border-t-amber-500 rounded-full animate-spin mb-3"></div>
                <p class="text-xs font-mono text-amber-400/80 uppercase tracking-widest">Querying Federal High Court Records...</p>
            </div>
        `;

        if (!supabaseClient) {
            // Render sample demonstration cases
            renderCases(window.CPB_JUDICIARY.sampleCases, true);
            return;
        }

        try {
            const { data, error } = await supabaseClient
                .from('cases')
                .select('*')
                .eq('is_published', true)
                .order('created_at', { ascending: false });

            if (error) {
                console.warn("Could not load cases from Supabase (falling back to sample lore):", error);
                renderCases(window.CPB_JUDICIARY.sampleCases, true);
                return;
            }

            if (data && data.length > 0) {
                window.CPB_JUDICIARY.publishedCases = data;
                renderCases(data, false);
            } else {
                // Database is empty or freshly initialized; show sample cases with clear label
                renderCases(window.CPB_JUDICIARY.sampleCases, true);
            }
        } catch (err) {
            console.error("Failed to query cases:", err);
            renderCases(window.CPB_JUDICIARY.sampleCases, true);
        }
    }

    function renderCases(casesList, isSampleData) {
        const grid = document.getElementById('docketGrid');
        if (!grid) return;

        const category = window.CPB_JUDICIARY.activeFilter;
        const query = window.CPB_JUDICIARY.searchQuery.toLowerCase().trim();

        // Filter list
        const filtered = casesList.filter(c => {
            const matchesCat = (category === 'all') || (c.case_type === category) || (category === 'appeals' && c.case_type === 'appeal');
            if (!matchesCat) return false;

            if (!query) return true;
            const fullText = `${c.docket_number} ${c.title} ${c.summary} ${c.matter} ${c.plaintiff_name} ${c.defendant_name} ${c.assigned_judge}`.toLowerCase();
            return fullText.includes(query);
        });

        if (filtered.length === 0) {
            grid.innerHTML = `
                <div class="col-span-1 md:col-span-2 text-center py-12 bg-slate-900/40 rounded-xl border border-slate-800">
                    <p class="text-sm font-semibold text-gray-400 mb-1">No matching docket records found.</p>
                    <p class="text-xs text-gray-500">Try adjusting your search criteria or resetting filters.</p>
                    <button onclick="window.CPB_JUDICIARY.resetSearch()" class="mt-4 px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded text-xs font-bold uppercase tracking-wider transition">Reset Search</button>
                </div>
            `;
            return;
        }

        let html = '';
        filtered.forEach(item => {
            const docketNum = escapeHtml(item.docket_number);
            const title = escapeHtml(item.title);
            const matter = escapeHtml(item.matter || 'Adjudication');
            const summary = escapeHtml(item.summary);
            const judge = escapeHtml(item.assigned_judge || 'Tribunal Magistrate');
            const nextSession = escapeHtml(item.next_session || 'As Scheduled by Chamber');
            const status = escapeHtml(item.status || 'in_deliberation');
            const caseId = escapeHtml(item.id || item.sampleKey);

            let statusBadge = '';
            if (status === 'verdict_rendered') {
                statusBadge = `<span class="text-[11px] font-bold text-emerald-400 uppercase mono-font">JUDGMENT RENDERED</span>`;
            } else if (status === 'hearing_scheduled') {
                statusBadge = `<span class="text-[11px] font-bold text-blue-400 uppercase mono-font">HEARING SCHEDULED</span>`;
            } else {
                statusBadge = `<span class="text-[11px] font-bold text-amber-400 uppercase mono-font">IN DELIBERATION</span>`;
            }

            const recordBadge = isSampleData 
                ? `<span class="text-[9px] bg-slate-800 text-gray-400 border border-slate-700 px-1.5 py-0.5 rounded mono-font">DEMONSTRATION RECORD</span>`
                : `<span class="text-[9px] bg-emerald-950 text-emerald-400 border border-emerald-800 px-1.5 py-0.5 rounded mono-font">OFFICIAL COURT RECORD</span>`;

            html += `
                <div class="court-card rounded-xl p-6 flex flex-col justify-between" data-category="${escapeHtml(item.case_type)}">
                    <div>
                        <div class="flex justify-between items-start mb-3">
                            <div class="flex items-center space-x-2">
                                <span class="docket-badge">${docketNum}</span>
                                ${recordBadge}
                            </div>
                            ${statusBadge}
                        </div>
                        <h3 class="text-lg font-bold text-white mb-1 court-font">${title}</h3>
                        <p class="text-xs text-amber-300/80 mb-3 mono-font">Matter: ${matter}</p>
                        <p class="text-xs text-gray-300 leading-relaxed mb-4">${summary}</p>
                        <div class="text-[11px] text-gray-400 bg-slate-900/80 p-3 rounded border border-slate-800 mb-4 space-y-1">
                            <div><span class="text-gray-500">PRESIDING:</span> ${judge}</div>
                            <div><span class="text-gray-500">SESSION:</span> ${nextSession}</div>
                        </div>
                    </div>
                    <button onclick="window.CPB_JUDICIARY.viewCaseDetails('${caseId}')" 
                        class="w-full bg-slate-800 hover:bg-amber-600 hover:text-white text-gray-300 text-xs font-bold py-2.5 rounded transition uppercase tracking-wider">
                        Examine Pleadings & Exhibits
                    </button>
                </div>
            `;
        });

        grid.innerHTML = html;
    }

    async function viewCaseDetails(caseIdOrKey) {
        // Look up case data from published cases or sample cases
        let caseData = window.CPB_JUDICIARY.publishedCases.find(c => c.id === caseIdOrKey || c.docket_number === caseIdOrKey);
        let isSample = false;

        if (!caseData) {
            caseData = window.CPB_JUDICIARY.sampleCases.find(c => c.sampleKey === caseIdOrKey || c.docket_number === caseIdOrKey);
            isSample = true;
        }

        if (!caseData) {
            console.error("Case not found:", caseIdOrKey);
            return;
        }

        const modalTitle = document.getElementById('caseModalTitle');
        const modalContent = document.getElementById('caseModalContent');
        if (!modalTitle || !modalContent) return;

        modalTitle.textContent = `Docket ${caseData.docket_number}`;

        const litigants = `${escapeHtml(caseData.plaintiff_name)} vs. ${escapeHtml(caseData.defendant_name)}`;
        const matter = escapeHtml(caseData.matter || 'Adjudication');
        const judge = escapeHtml(caseData.assigned_judge || 'Appointed Magistrate');
        const summary = escapeHtml(caseData.summary);
        const pleadings = escapeHtml(caseData.pleadings || 'Pleadings on file with Clerk of Court.');
        const currentOrder = escapeHtml(caseData.current_order || 'Under active judicial consideration.');

        // Initial content structure
        modalContent.innerHTML = `
            <div class="bg-black/60 p-4 rounded-xl border border-amber-950 font-mono text-xs space-y-2">
                <div class="flex justify-between"><span class="text-gray-500">LITIGANTS:</span> <span class="text-white">${litigants}</span></div>
                <div class="flex justify-between"><span class="text-gray-500">MATTER:</span> <span class="text-amber-400 font-bold">${matter}</span></div>
                <div class="flex justify-between"><span class="text-gray-500">MAGISTRATE:</span> <span class="text-gray-300">${judge}</span></div>
            </div>

            <div>
                <h5 class="text-xs font-bold uppercase text-amber-400 court-font mb-1">Case Summary</h5>
                <p class="text-xs bg-slate-950 p-3 rounded border border-slate-800 text-gray-300 leading-relaxed">${summary}</p>
            </div>

            <div>
                <h5 class="text-xs font-bold uppercase text-amber-400 court-font mb-1">Claims & Pleadings</h5>
                <p class="text-xs bg-slate-950 p-3 rounded border border-slate-800 text-gray-300 leading-relaxed">${pleadings}</p>
            </div>

            <div>
                <h5 class="text-xs font-bold uppercase text-emerald-400 court-font mb-1">Current Court Order / Finding</h5>
                <p class="text-xs bg-slate-950 p-3 rounded border border-slate-800 text-white font-mono leading-relaxed">${currentOrder}</p>
            </div>

            <div>
                <h5 class="text-xs font-bold uppercase text-cyan-400 court-font mb-2">Chronology & Case Events</h5>
                <div id="caseEventsTimeline" class="space-y-2 font-mono text-xs">
                    <p class="text-gray-500 italic">Loading case events...</p>
                </div>
            </div>
        `;

        openModal('caseModal');

        // Fetch events from Supabase or fallback
        const eventsContainer = document.getElementById('caseEventsTimeline');
        if (!eventsContainer) return;

        if (supabaseClient && !isSample && caseData.id) {
            try {
                const { data: events, error } = await supabaseClient
                    .from('case_events')
                    .select('*')
                    .eq('case_id', caseData.id)
                    .order('created_at', { ascending: true });

                if (!error && events && events.length > 0) {
                    let evHtml = '';
                    events.forEach(ev => {
                        evHtml += `
                            <div class="p-2.5 bg-slate-950 rounded border border-slate-800/80">
                                <div class="flex justify-between text-gray-500 text-[10px] mb-1">
                                    <span>${escapeHtml(ev.event_type.toUpperCase())} • BY ${escapeHtml(ev.actor_name || 'Court Officer')}</span>
                                    <span>${formatDate(ev.created_at)}</span>
                                </div>
                                <div class="text-gray-300">${escapeHtml(ev.description)}</div>
                            </div>
                        `;
                    });
                    eventsContainer.innerHTML = evHtml;
                    return;
                }
            } catch (e) {
                console.warn("Event query error:", e);
            }
        }

        // Sample fallback events
        const sampleEvents = caseData.events || [
            { type: 'FILING_DOCKETED', by: 'Clerk of Court', date: 'Season 3.1', desc: 'Case received and formally entered into court docket.' },
            { type: 'INITIAL_ORDER', by: judge, date: 'Season 3.1', desc: currentOrder }
        ];

        let sHtml = '';
        sampleEvents.forEach(ev => {
            sHtml += `
                <div class="p-2.5 bg-slate-950 rounded border border-slate-800/80">
                    <div class="flex justify-between text-gray-500 text-[10px] mb-1">
                        <span>${escapeHtml(ev.type || 'COURT_ACTION')} • BY ${escapeHtml(ev.by || 'Court Officer')}</span>
                        <span>${escapeHtml(ev.date || 'Recent')}</span>
                    </div>
                    <div class="text-gray-300">${escapeHtml(ev.desc || ev.description)}</div>
                </div>
            `;
        });
        eventsContainer.innerHTML = sHtml;
    }

    // --------------------------------------------------------------------------
    // 6. Real Filing Workflows (Lawsuits, Appeals, Whistleblower Tips)
    // --------------------------------------------------------------------------
    async function handlePetitionSubmit(e) {
        if (e) e.preventDefault();

        const user = window.CPB_JUDICIARY.currentUser;
        if (!user) {
            alert("Authentication Required: Please sign in with Google to file a petition.");
            signInWithGoogle();
            return;
        }

        const profile = window.CPB_JUDICIARY.currentProfile;
        const defendantInput = document.getElementById('petitionDefendant');
        const matterSelect = document.getElementById('petitionMatter');
        const detailsText = document.getElementById('petitionDetails');
        const reliefInput = document.getElementById('petitionRelief');

        const defendant = defendantInput?.value?.trim();
        const matter = matterSelect?.value;
        const details = detailsText?.value?.trim();
        const relief = reliefInput?.value?.trim();

        if (!defendant || !details || !relief) {
            alert("Please complete all required filing fields.");
            return;
        }

        const submitBtn = e.target.querySelector('button[type="submit"]');
        const originalText = submitBtn ? submitBtn.textContent : '';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Transmitting to Clerk...';
        }

        try {
            const plaintiffName = profile?.minecraft_username || profile?.full_name || user.email?.split('@')[0] || 'Citizen';

            if (supabaseClient) {
                const { data, error } = await supabaseClient
                    .from('filings')
                    .insert({
                        filing_type: 'lawsuit',
                        submitter_id: user.id,
                        submitter_email: user.email,
                        submitter_minecraft_username: profile?.minecraft_username || null,
                        submitter_minecraft_uuid: profile?.minecraft_uuid || null,
                        submitter_verified: profile?.verification_status === 'verified',
                        target_party_name: defendant,
                        title: `${plaintiffName} v. ${defendant}`,
                        details: details,
                        relief_sought: relief,
                        is_confidential: false,
                        status: 'pending_review'
                    })
                    .select()
                    .single();

                if (error) throw error;

                closeModal('petitionModal');
                e.target.reset();

                alert(`Official Lawsuit Filed!\n\nReference Number: ${data.reference_number}\nStatus: PENDING CLERK REVIEW\n\nYour petition has been securely recorded. You may track its progress under "My Case Filings".`);
            } else {
                alert("Database offline: Filing recorded locally in offline demonstration mode.");
                closeModal('petitionModal');
            }
        } catch (err) {
            console.error("Filing submission error:", err);
            alert("Error submitting filing: " + (err.message || err));
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        }
    }

    async function handleAppealSubmit(e) {
        if (e) e.preventDefault();

        const user = window.CPB_JUDICIARY.currentUser;
        if (!user) {
            alert("Authentication Required: Please sign in with Google to file an appeal.");
            signInWithGoogle();
            return;
        }

        const profile = window.CPB_JUDICIARY.currentProfile;
        const sanctionInput = document.getElementById('appealSanction');
        const groundsText = document.getElementById('appealGrounds');

        const sanction = sanctionInput?.value?.trim();
        const grounds = groundsText?.value?.trim();

        if (!sanction || !grounds) {
            alert("Please complete the sanction and grounds for appeal.");
            return;
        }

        const submitBtn = e.target.querySelector('button[type="submit"]');
        const originalText = submitBtn ? submitBtn.textContent : '';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Filing Appellate Brief...';
        }

        try {
            const appellantName = profile?.minecraft_username || profile?.full_name || user.email?.split('@')[0] || 'Appellant';

            if (supabaseClient) {
                const { data, error } = await supabaseClient
                    .from('filings')
                    .insert({
                        filing_type: 'appeal',
                        submitter_id: user.id,
                        submitter_email: user.email,
                        submitter_minecraft_username: profile?.minecraft_username || null,
                        submitter_minecraft_uuid: profile?.minecraft_uuid || null,
                        submitter_verified: profile?.verification_status === 'verified',
                        target_party_name: 'Staff Sanctions Division',
                        title: `Appeal of Sanction: ${sanction} (by ${appellantName})`,
                        details: grounds,
                        relief_sought: 'Sentence Reduction or Sanction Revocation',
                        is_confidential: false,
                        status: 'pending_review'
                    })
                    .select()
                    .single();

                if (error) throw error;

                closeModal('appealModal');
                e.target.reset();

                alert(`Appellate Brief Registered!\n\nReference Number: ${data.reference_number}\nStatus: PENDING REVIEW BY APPELLATE BENCH\n\nYour petition has been recorded for review.`);
            } else {
                alert("Database offline: Appeal recorded locally in demonstration mode.");
                closeModal('appealModal');
            }
        } catch (err) {
            console.error("Appeal error:", err);
            alert("Error submitting appeal: " + (err.message || err));
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        }
    }

    async function handleTipSubmit(e) {
        if (e) e.preventDefault();

        const user = window.CPB_JUDICIARY.currentUser;
        if (!user) {
            alert("Please sign in with Google to submit an authenticated confidential tip.");
            signInWithGoogle();
            return;
        }

        const targetInput = document.getElementById('tipSuspectInput');
        const detailsText = document.getElementById('tipDetailsInput');

        const target = targetInput?.value?.trim() || 'Unidentified Suspect';
        const details = detailsText?.value?.trim();

        if (!details) {
            alert("Please provide the tip information.");
            return;
        }

        try {
            if (supabaseClient) {
                const { data, error } = await supabaseClient
                    .from('filings')
                    .insert({
                        filing_type: 'tip',
                        submitter_id: user.id,
                        submitter_email: user.email,
                        target_party_name: target,
                        title: `Confidential Tip: ${target}`,
                        details: details,
                        is_confidential: true,
                        status: 'pending_review'
                    })
                    .select()
                    .single();

                if (error) throw error;

                closeModal('tipModal');
                e.target.reset();
                alert(`Confidential Tip Encrypted & Lodged.\nReference: ${data.reference_number}\nThis tip is protected under Judicial Secrecy rules.`);
            }
        } catch (err) {
            console.error("Tip submission error:", err);
            alert("Error submitting tip: " + err.message);
        }
    }

    // --------------------------------------------------------------------------
    // 7. My Filings User Dashboard
    // --------------------------------------------------------------------------
    async function openMyFilingsModal() {
        const user = window.CPB_JUDICIARY.currentUser;
        if (!user) {
            alert("Please sign in with Google to view your filings.");
            return;
        }

        const listContainer = document.getElementById('myFilingsList');
        if (!listContainer) return;

        listContainer.innerHTML = '<p class="text-xs text-gray-500 font-mono italic">Loading your court filings...</p>';
        openModal('myFilingsModal');

        if (!supabaseClient) {
            listContainer.innerHTML = '<p class="text-xs text-gray-400">Database offline. Connect Supabase to track real filings.</p>';
            return;
        }

        try {
            const { data, error } = await supabaseClient
                .from('filings')
                .select('*')
                .eq('submitter_id', user.id)
                .order('created_at', { ascending: false });

            if (error) throw error;

            if (!data || data.length === 0) {
                listContainer.innerHTML = `
                    <div class="text-center py-8 text-gray-500 text-xs">
                        <p class="mb-2">You have not submitted any petitions, appeals, or tips yet.</p>
                        <button onclick="closeModal('myFilingsModal'); openModal('petitionModal');" class="text-amber-400 font-bold hover:underline">File a Lawsuit Now →</button>
                    </div>
                `;
                return;
            }

            let html = '';
            data.forEach(item => {
                const ref = escapeHtml(item.reference_number);
                const title = escapeHtml(item.title);
                const type = escapeHtml(item.filing_type.toUpperCase());
                const date = formatDate(item.created_at);
                const status = escapeHtml(item.status);
                const notes = item.review_notes ? escapeHtml(item.review_notes) : null;

                let stBadge = '';
                if (status === 'docketed') {
                    stBadge = `<span class="bg-emerald-950 text-emerald-400 border border-emerald-800 text-[10px] px-2 py-0.5 rounded font-mono font-bold">DOCKETED</span>`;
                } else if (status === 'rejected') {
                    stBadge = `<span class="bg-red-950 text-red-400 border border-red-800 text-[10px] px-2 py-0.5 rounded font-mono font-bold">DISMISSED</span>`;
                } else {
                    stBadge = `<span class="bg-amber-950 text-amber-400 border border-amber-800 text-[10px] px-2 py-0.5 rounded font-mono font-bold">PENDING REVIEW</span>`;
                }

                html += `
                    <div class="p-3.5 bg-slate-950 rounded-xl border border-slate-800 space-y-2">
                        <div class="flex justify-between items-start">
                            <div>
                                <span class="font-mono text-xs text-amber-400 font-bold">${ref}</span>
                                <span class="text-[10px] text-gray-500 font-mono ml-2">[${type}]</span>
                            </div>
                            ${stBadge}
                        </div>
                        <h4 class="text-white text-xs font-bold">${title}</h4>
                        <div class="text-[11px] text-gray-400">Filed: ${date}</div>
                        ${notes ? `<div class="p-2 bg-slate-900 rounded text-[11px] text-amber-300 font-mono">Clerk Note: ${notes}</div>` : ''}
                    </div>
                `;
            });

            listContainer.innerHTML = html;
        } catch (err) {
            console.error("Filings loading error:", err);
            listContainer.innerHTML = `<p class="text-xs text-red-400">Failed to load filings: ${escapeHtml(err.message)}</p>`;
        }
    }

    // --------------------------------------------------------------------------
    // 8. Judicial Chamber / Clerk Workbench (Staff Tools)
    // --------------------------------------------------------------------------
    async function openWorkbenchModal() {
        const profile = window.CPB_JUDICIARY.currentProfile;
        if (!profile || (profile.role !== 'clerk' && profile.role !== 'judge' && profile.role !== 'admin')) {
            alert("Access restricted to authorized Judicial and Clerk officers.");
            return;
        }

        openModal('workbenchModal');
        await loadWorkbenchPendingFilings();
    }

    async function loadWorkbenchPendingFilings() {
        const container = document.getElementById('workbenchFilingsContainer');
        if (!container) return;

        const profile = window.CPB_JUDICIARY.currentProfile;
        const role = profile?.role || 'player';

        container.innerHTML = '<p class="text-xs text-gray-500 font-mono italic">Loading pending court submissions...</p>';

        if (!supabaseClient) return;

        try {
            const { data, error } = await supabaseClient
                .from('filings')
                .select('*')
                .in('status', ['pending_review', 'under_investigation'])
                .order('created_at', { ascending: true });

            if (error) throw error;

            if (!data || data.length === 0) {
                container.innerHTML = `
                    <div class="space-y-4">
                        <div class="bg-slate-900/60 p-3 rounded-lg border border-slate-800 text-xs flex justify-between items-center">
                            <span class="text-gray-400">Officer Level: <strong class="text-amber-400 uppercase font-mono">${escapeHtml(role)}</strong></span>
                            <div class="space-x-2">
                                ${(role === 'clerk' || role === 'admin') ? `
                                    <button onclick="window.CPB_JUDICIARY.verifyPlayerPrompt()" class="bg-blue-900 hover:bg-blue-800 text-blue-200 px-2.5 py-1 rounded text-[11px] font-mono transition">
                                        Manual Verify Player
                                    </button>
                                ` : ''}
                                ${role === 'admin' ? `
                                    <button onclick="window.CPB_JUDICIARY.adminSetUserRolePrompt()" class="bg-purple-900 hover:bg-purple-800 text-purple-200 px-2.5 py-1 rounded text-[11px] font-mono transition">
                                        Assign User Role
                                    </button>
                                ` : ''}
                            </div>
                        </div>
                        <p class="text-xs text-gray-500 py-6 text-center">No pending filings awaiting review.</p>
                    </div>
                `;
                return;
            }

            const petitions = data.filter(f => f.filing_type === 'lawsuit' || f.filing_type === 'appeal');
            const tips = data.filter(f => f.filing_type === 'tip' || f.is_confidential);

            let html = `
                <div class="bg-slate-900/60 p-3 rounded-lg border border-slate-800 text-xs flex justify-between items-center mb-4">
                    <span class="text-gray-400">Officer Level: <strong class="text-amber-400 uppercase font-mono">${escapeHtml(role)}</strong></span>
                    <div class="space-x-2">
                        ${(role === 'clerk' || role === 'admin') ? `
                            <button onclick="window.CPB_JUDICIARY.verifyPlayerPrompt()" class="bg-blue-900 hover:bg-blue-800 text-blue-200 px-2.5 py-1 rounded text-[11px] font-mono transition">
                                Manual Verify Player
                            </button>
                        ` : ''}
                        ${role === 'admin' ? `
                            <button onclick="window.CPB_JUDICIARY.adminSetUserRolePrompt()" class="bg-purple-900 hover:bg-purple-800 text-purple-200 px-2.5 py-1 rounded text-[11px] font-mono transition">
                                Assign User Role
                            </button>
                        ` : ''}
                    </div>
                </div>
            `;

            // Section 1: Official Legal Filings (Lawsuits & Appeals)
            html += `<h4 class="text-xs font-bold text-amber-400 court-font uppercase tracking-wider mb-2">Docketing Queue: Petitions & Appeals (${petitions.length})</h4>`;
            if (petitions.length === 0) {
                html += `<p class="text-xs text-gray-500 italic mb-4">No petitions or appeals awaiting docketing.</p>`;
            } else {
                html += `<div class="space-y-3 mb-6">`;
                petitions.forEach(item => {
                    const id = escapeHtml(item.id);
                    const ref = escapeHtml(item.reference_number);
                    const title = escapeHtml(item.title);
                    const submitter = escapeHtml(item.submitter_minecraft_username || item.submitter_email);
                    const details = escapeHtml(item.details);
                    const relief = escapeHtml(item.relief_sought || 'None stated');
                    const isVerified = item.submitter_verified;

                    html += `
                        <div class="p-4 bg-slate-950 rounded-xl border border-slate-800 space-y-3">
                            <div class="flex justify-between items-start">
                                <div>
                                    <span class="font-mono text-xs text-amber-400 font-bold">${ref}</span>
                                    <span class="text-[10px] text-gray-500 font-mono ml-2">[${escapeHtml(item.filing_type.toUpperCase())}]</span>
                                </div>
                                <span class="text-[10px] ${isVerified ? 'text-emerald-400' : 'text-amber-400'} font-mono">
                                    ${isVerified ? 'VERIFIED SUBMITTER' : 'PROVISIONAL / UNVERIFIED'}
                                </span>
                            </div>
                            <h4 class="text-sm font-bold text-white">${title}</h4>
                            <div class="text-xs text-gray-300 bg-slate-900 p-2.5 rounded border border-slate-800/80 leading-relaxed">${details}</div>
                            <div class="text-[11px] text-amber-300 font-mono">Demands: ${relief}</div>
                            <div class="pt-2 flex justify-end space-x-2">
                                <button onclick="window.CPB_JUDICIARY.rejectFilingPrompt('${id}')" 
                                    class="px-3 py-1.5 bg-slate-800 hover:bg-red-950 hover:text-red-300 text-gray-300 rounded text-xs transition">
                                    Dismiss
                                </button>
                                <button onclick="window.CPB_JUDICIARY.docketFilingPrompt('${id}')" 
                                    class="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white font-bold rounded text-xs uppercase tracking-wider transition">
                                    Docket as Official Case
                                </button>
                            </div>
                        </div>
                    `;
                });
                html += `</div>`;
            }

            // Section 2: Confidential Intelligence Tips
            html += `<h4 class="text-xs font-bold text-red-400 court-font uppercase tracking-wider mb-2">Confidential Source Intelligence (${tips.length})</h4>`;
            if (tips.length === 0) {
                html += `<p class="text-xs text-gray-500 italic mb-2">No confidential intelligence tips on file.</p>`;
            } else {
                html += `<div class="space-y-3">`;
                tips.forEach(item => {
                    const id = escapeHtml(item.id);
                    const ref = escapeHtml(item.reference_number);
                    const title = escapeHtml(item.title);
                    const target = escapeHtml(item.target_party_name || 'Unidentified Suspect');
                    const details = escapeHtml(item.details);
                    const currentStatus = escapeHtml(item.status);

                    html += `
                        <div class="p-4 bg-red-950/20 rounded-xl border border-red-900/40 space-y-3">
                            <div class="flex justify-between items-start">
                                <div>
                                    <span class="font-mono text-xs text-red-400 font-bold">${ref}</span>
                                    <span class="text-[10px] bg-red-950 text-red-300 border border-red-800 px-1.5 py-0.5 rounded font-mono ml-2">CONFIDENTIAL INTELLIGENCE</span>
                                </div>
                                <span class="text-[10px] text-gray-400 font-mono">Status: ${currentStatus.toUpperCase()}</span>
                            </div>
                            <h4 class="text-sm font-bold text-white">${title}</h4>
                            <div class="text-xs text-gray-400 font-mono">Target / Suspect: <span class="text-red-300 font-bold">${target}</span></div>
                            <div class="text-xs text-gray-300 bg-slate-950 p-2.5 rounded border border-slate-800 leading-relaxed">${details}</div>
                            <div class="p-2 bg-amber-950/30 border border-amber-900/40 rounded text-[11px] text-amber-300 italic">
                                Judicial Secrecy Enforced: Tips cannot be docketed into public cases. To prosecute, initiate an official indictment.
                            </div>
                            <div class="pt-2 flex justify-end space-x-2">
                                <button onclick="window.CPB_JUDICIARY.reviewTipPrompt('${id}', 'reject')" 
                                    class="px-3 py-1.5 bg-slate-800 hover:bg-red-950 hover:text-red-300 text-gray-300 rounded text-xs transition">
                                    Dismiss Tip
                                </button>
                                <button onclick="window.CPB_JUDICIARY.reviewTipPrompt('${id}', 'close')" 
                                    class="px-3 py-1.5 bg-slate-800 hover:bg-emerald-950 hover:text-emerald-300 text-gray-300 rounded text-xs transition">
                                    Close / Resolved
                                </button>
                                <button onclick="window.CPB_JUDICIARY.reviewTipPrompt('${id}', 'investigate')" 
                                    class="px-3 py-1.5 bg-blue-900 hover:bg-blue-800 text-blue-200 font-bold rounded text-xs uppercase tracking-wider transition">
                                    Mark Under Investigation
                                </button>
                            </div>
                        </div>
                    `;
                });
                html += `</div>`;
            }

            container.innerHTML = html;
        } catch (err) {
            console.error("Workbench filings error:", err);
            container.innerHTML = `<p class="text-xs text-red-400">Failed to load: ${escapeHtml(err.message)}</p>`;
        }
    }

    async function docketFilingPrompt(filingId) {
        const judge = prompt("Enter Presiding Judge / Chamber name:", "Chief Justice K. Sterling");
        if (!judge) return;
        const order = prompt("Enter Initial Judicial Order:", "Filing docketed for formal review. Preliminary status conference scheduled.");
        if (!order) return;

        try {
            const { data, error } = await supabaseClient.rpc('docket_filing', {
                p_filing_id: filingId,
                p_assigned_judge: judge,
                p_initial_order: order
            });

            if (error) throw error;

            alert(`Filing successfully docketed under official case #${data.docket_number}!`);
            await loadWorkbenchPendingFilings();
            await loadPublishedCases();
        } catch (err) {
            console.error("Docketing error:", err);
            alert("Error docketing filing: " + (err.message || err));
        }
    }

    async function rejectFilingPrompt(filingId) {
        const reason = prompt("Enter reason for dismissal / rejection:", "Filing lacks jurisdictional standing or sufficient evidence.");
        if (!reason) return;

        try {
            const { error } = await supabaseClient
                .from('filings')
                .update({
                    status: 'rejected',
                    review_notes: reason,
                    reviewed_by: window.CPB_JUDICIARY.currentUser.id,
                    updated_at: new Date().toISOString()
                })
                .eq('id', filingId);

            if (error) throw error;

            alert("Filing marked as dismissed.");
            await loadWorkbenchPendingFilings();
        } catch (err) {
            console.error("Dismissal error:", err);
            alert("Error dismissing filing: " + err.message);
        }
    }

    async function reviewTipPrompt(filingId, action) {
        const notes = prompt(`Enter review notes for action [${action}]:`, action === 'investigate' ? 'Transferred to FBIS investigation team.' : 'Matter completed.');
        if (notes === null) return;

        try {
            const { data, error } = await supabaseClient.rpc('review_confidential_tip', {
                p_filing_id: filingId,
                p_action: action,
                p_notes: notes
            });

            if (error) throw error;

            alert(`Tip status successfully updated to "${data.status}".`);
            await loadWorkbenchPendingFilings();
        } catch (err) {
            console.error("Tip review error:", err);
            alert("Error reviewing tip: " + (err.message || err));
        }
    }

    async function verifyPlayerPrompt() {
        const targetUserId = prompt("Enter citizen Supabase User ID (UUID):");
        if (!targetUserId) return;
        const username = prompt("Enter confirmed Minecraft Java Username:");
        if (!username) return;
        const uuid = prompt("Enter confirmed Minecraft Java UUID (36-char with hyphens):");
        if (!uuid) return;

        try {
            const { error } = await supabaseClient.rpc('verify_minecraft_profile', {
                p_target_user_id: targetUserId.trim(),
                p_verified_username: username.trim(),
                p_verified_uuid: uuid.trim().toLowerCase()
            });

            if (error) throw error;

            alert(`Citizen ${username} successfully verified and bound to UUID ${uuid}.`);
        } catch (err) {
            console.error("Verification error:", err);
            alert("Failed to verify player: " + (err.message || err));
        }
    }

    async function adminSetUserRolePrompt() {
        const targetUserId = prompt("Enter user Supabase User ID (UUID):");
        if (!targetUserId) return;
        const newRole = prompt("Enter new role (player, clerk, judge, admin):", "clerk");
        if (!newRole) return;

        try {
            const { error } = await supabaseClient.rpc('admin_set_user_role', {
                p_target_user_id: targetUserId.trim(),
                p_new_role: newRole.trim().toLowerCase()
            });

            if (error) throw error;

            alert(`User role successfully updated to "${newRole}".`);
            await loadWorkbenchPendingFilings();
        } catch (err) {
            console.error("Role update error:", err);
            alert("Failed to update role: " + (err.message || err));
        }
    }

    // --------------------------------------------------------------------------
    // 9. Sample Lore Data (Demonstration & Offline Fallback)
    // --------------------------------------------------------------------------
    function getSampleCasesData() {
        return [
            {
                sampleKey: 'granite',
                docket_number: 'CTBE-CV-2026-0042',
                case_type: 'civil',
                title: 'Granite Ridge Construction Co. v. Aether Rail Co.',
                matter: 'Modular Tunnel Bore Patent Infringement',
                summary: 'Plaintiff claims defendant replicated proprietary drill contraption schematics without payment of the statutory licensing fee. Emergency stay on construction issued.',
                plaintiff_name: 'Granite Ridge Construction Co.',
                defendant_name: 'Aether Rail Transport',
                assigned_judge: 'Chief Justice K. Sterling',
                next_session: 'Saturday 19:00 CST • Chamber Alpha',
                status: 'in_deliberation',
                current_order: 'Temporary restraining order granted pending mechanical inspection by FBIS Forensics Lab.',
                pleadings: 'Granite Ridge requests 800 Brass Ingots in royalties and an immediate cease-and-desist injunction on further tunneling through Sector 4.',
                events: [
                    { type: 'FILING_DOCKETED', by: 'Clerk of Court', date: '6 Days Ago', desc: 'Formal statement of claim filed by Granite Ridge Construction.' },
                    { type: 'INJUNCTION_ISSUED', by: 'Chief Justice K. Sterling', date: '4 Days Ago', desc: 'Preliminary injunction issued halting unapproved tunneling.' },
                    { type: 'EVIDENCE_RECEIVED', by: 'FBIS Forensics Lab', date: 'Yesterday', desc: 'Mechanical analysis comparing drill gear ratios submitted.' }
                ]
            },
            {
                sampleKey: 'rivera',
                docket_number: 'CTBE-CR-2026-0019',
                case_type: 'criminal',
                title: 'Federal Prosecution v. Marcus "The Ghost" Rivera',
                matter: 'Kinetic Overdrive Sabotage & Bank Theft',
                summary: 'Defendant convicted on 3 counts of intentional kinetic ramming. Full judgment ordered: 30 days custodial remand in FBOC Facility 01 plus 1,500 Brass Ingot compensation.',
                plaintiff_name: 'CTBE Federal Prosecution',
                defendant_name: 'Marcus Rivera',
                assigned_judge: 'Senior Magistrate D. Vance',
                next_session: 'Sentence Executed • Remanded to FBOC',
                status: 'verdict_rendered',
                current_order: 'Defendant found guilty. Sentenced to 30 In-Game Days at FBOC Facility 01 (The Obsidian Redoubt) + 1,500 Brass Ingot fine.',
                pleadings: 'Defendant claimed mechanical clutch failure. FBIS forensic logs proved manual throttle override clocked at 256 RPM.',
                events: [
                    { type: 'INDICTMENT_RETURNED', by: 'Federal Grand Jury', date: '14 Days Ago', desc: 'Indictment returned on 3 felony sabotage counts.' },
                    { type: 'TRIAL_CONDUCTED', by: 'Senior Magistrate D. Vance', date: '5 Days Ago', desc: 'Full bench trial held in Chamber Alpha.' },
                    { type: 'RULING_RENDERED', by: 'Senior Magistrate D. Vance', date: '3 Days Ago', desc: 'Guilty verdict entered. Custodial remand executed.' }
                ]
            },
            {
                sampleKey: 'sector4',
                docket_number: 'CTBE-AP-2026-0008',
                case_type: 'appeal',
                title: 'In Re: Sector 4 Mainland Rail Easement',
                matter: 'Rail Corridor Right-of-Way Dispute',
                summary: 'Local township disputes federal eminent domain declaration over a 16-block wide rail corridor connecting mainland hub stations.',
                plaintiff_name: 'Township of Pine Valley',
                defendant_name: 'Department of Transportation',
                assigned_judge: 'Appellate Tribunal Panel',
                next_session: 'Saturday 19:00 CST • Chamber Beta',
                status: 'hearing_scheduled',
                current_order: 'Scheduled for oral argument on Saturday at 19:00 CST in High Court voice chamber.',
                pleadings: 'Township requests rerouting around the valley or mandatory noise mitigation and acoustic tunnels.',
                events: [
                    { type: 'APPEAL_LODGED', by: 'Pine Valley Council', date: '8 Days Ago', desc: 'Petition for Appellate Review filed.' },
                    { type: 'BRIEFS_ACCEPTED', by: 'Clerk of Court', date: '4 Days Ago', desc: 'Legal briefs submitted by municipal and DOT counsel.' },
                    { type: 'DATE_SCHEDULED', by: 'Appellate Tribunal', date: '2 Days Ago', desc: 'Hearing set for Saturday 19:00 CST.' }
                ]
            },
            {
                sampleKey: 'vance_appeal',
                docket_number: 'CTBE-AP-2026-0015',
                case_type: 'appeal',
                title: 'Petition of Silas Vance (Facility 03)',
                matter: 'Sentence Reduction for Restitution Service',
                summary: 'Inmate petitioner requests early conditional discharge from Camp Delta after fulfilling full restitution quota of 500 crushed alloy blocks for public infrastructure.',
                plaintiff_name: 'Silas Vance (#CTBE-5291)',
                defendant_name: 'FBOC Camp Delta Administration',
                assigned_judge: 'Magistrate Chen (Parole Division)',
                next_session: 'Thursday 18:30 CST • Parole Board',
                status: 'in_deliberation',
                current_order: 'Warden report verified. Restitution work credits confirmed.',
                pleadings: 'Inmate has completed all assigned labor hours with zero disciplinary marks. FBOC recommends early probation.',
                events: [
                    { type: 'PAROLE_PETITION_FILED', by: 'Inmate Advocate', date: '5 Days Ago', desc: 'Parole request lodged under Article IV.' },
                    { type: 'LABOR_VERIFIED', by: 'FBOC Warden', date: '2 Days Ago', desc: 'Certification of 500 crushed alloy blocks completed.' }
                ]
            }
        ];
    }

    // --------------------------------------------------------------------------
    // 10. Filter & Search Handlers
    // --------------------------------------------------------------------------
    function filterDocket(category) {
        window.CPB_JUDICIARY.activeFilter = category;
        document.querySelectorAll('.docket-filter-btn').forEach(btn => {
            btn.classList.remove('bg-amber-600', 'text-white');
            btn.classList.add('bg-slate-800', 'text-gray-300');
        });
        if (event && event.target) {
            event.target.classList.remove('bg-slate-800', 'text-gray-300');
            event.target.classList.add('bg-amber-600', 'text-white');
        }

        const cases = window.CPB_JUDICIARY.publishedCases.length > 0 
            ? window.CPB_JUDICIARY.publishedCases 
            : window.CPB_JUDICIARY.sampleCases;
        renderCases(cases, window.CPB_JUDICIARY.publishedCases.length === 0);
    }

    function handleDocketSearch() {
        const input = document.getElementById('docketSearchInput');
        window.CPB_JUDICIARY.searchQuery = input?.value || '';

        const cases = window.CPB_JUDICIARY.publishedCases.length > 0 
            ? window.CPB_JUDICIARY.publishedCases 
            : window.CPB_JUDICIARY.sampleCases;
        renderCases(cases, window.CPB_JUDICIARY.publishedCases.length === 0);
        document.getElementById('docket')?.scrollIntoView({ behavior: 'smooth' });
    }

    function quickDocket(term) {
        const input = document.getElementById('docketSearchInput');
        if (input) input.value = term;
        handleDocketSearch();
    }

    function resetSearch() {
        const input = document.getElementById('docketSearchInput');
        if (input) input.value = '';
        window.CPB_JUDICIARY.searchQuery = '';
        window.CPB_JUDICIARY.activeFilter = 'all';
        filterDocket('all');
    }

    // --------------------------------------------------------------------------
    // 11. Modal Window Management
    // --------------------------------------------------------------------------
    function openModal(id) {
        const modal = document.getElementById(id);
        if (modal) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }
    }

    function closeModal(id) {
        const modal = document.getElementById(id);
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
    }

    // Export methods to global namespace
    window.CPB_JUDICIARY.signInWithGoogle = signInWithGoogle;
    window.CPB_JUDICIARY.signOut = signOut;
    window.CPB_JUDICIARY.openMinecraftVerifyModal = openMinecraftVerifyModal;
    window.CPB_JUDICIARY.handleMinecraftLinkSubmit = handleMinecraftLinkSubmit;
    window.CPB_JUDICIARY.loadPublishedCases = loadPublishedCases;
    window.CPB_JUDICIARY.viewCaseDetails = viewCaseDetails;
    window.CPB_JUDICIARY.handlePetitionSubmit = handlePetitionSubmit;
    window.CPB_JUDICIARY.handleAppealSubmit = handleAppealSubmit;
    window.CPB_JUDICIARY.handleTipSubmit = handleTipSubmit;
    window.CPB_JUDICIARY.openMyFilingsModal = openMyFilingsModal;
    window.CPB_JUDICIARY.openWorkbenchModal = openWorkbenchModal;
    window.CPB_JUDICIARY.loadWorkbenchPendingFilings = loadWorkbenchPendingFilings;
    window.CPB_JUDICIARY.docketFilingPrompt = docketFilingPrompt;
    window.CPB_JUDICIARY.rejectFilingPrompt = rejectFilingPrompt;
    window.CPB_JUDICIARY.reviewTipPrompt = reviewTipPrompt;
    window.CPB_JUDICIARY.verifyPlayerPrompt = verifyPlayerPrompt;
    window.CPB_JUDICIARY.adminSetUserRolePrompt = adminSetUserRolePrompt;
    window.CPB_JUDICIARY.filterDocket = filterDocket;
    window.CPB_JUDICIARY.handleDocketSearch = handleDocketSearch;
    window.CPB_JUDICIARY.quickDocket = quickDocket;
    window.CPB_JUDICIARY.resetSearch = resetSearch;
    window.CPB_JUDICIARY.openModal = openModal;
    window.CPB_JUDICIARY.closeModal = closeModal;

    // Backward-compatibility wrappers for inline onclicks in HTML
    window.openModal = openModal;
    window.closeModal = closeModal;
    window.viewCaseDetails = viewCaseDetails;
    window.filterDocket = filterDocket;
    window.handleDocketSearch = handleDocketSearch;
    window.quickDocket = quickDocket;
    window.handlePetitionSubmit = handlePetitionSubmit;
    window.handleAppealSubmit = handleAppealSubmit;

    // Initial boot on DOM ready
    document.addEventListener('DOMContentLoaded', () => {
        initAuth();
        loadPublishedCases();

        // Close modal when clicking outside
        window.addEventListener('click', (e) => {
            ['caseModal', 'petitionModal', 'appealModal', 'codeModal', 'minecraftVerifyModal', 'myFilingsModal', 'workbenchModal', 'tipModal'].forEach(id => {
                const modal = document.getElementById(id);
                if (e.target === modal) {
                    closeModal(id);
                }
            });
        });
    });

})();
