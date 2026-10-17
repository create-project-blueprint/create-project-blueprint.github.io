// ==============================================================================
// File: server-security/cpb-auth.js
// Project: Create: Project Blueprint (CPB) Server Security & Justice Department
// Description: Shared Firebase (Google) sign-in + Supabase client for the FBIS,
//              FBOC and staff portal pages. Exposes window.CPB.
//
// Requires (before this file): firebase-app-compat.js, firebase-auth-compat.js,
// @supabase/supabase-js@2
// ==============================================================================

(function () {
    'use strict';

    const SUPABASE_URL = "https://cxwhmzfpdwwpdjogtuwq.supabase.co";
    const SUPABASE_ANON_KEY = "sb_publishable_wIZBKot3rmT6GYSArRa7fg_SP21wwaJ";

    // Public Firebase web app identifiers (not secrets)
    const FIREBASE_CONFIG = {
        apiKey: "AIzaSyB-TbC_iYvPVRhSd71Juaq9a-s33D9CjJ0",
        authDomain: "other-projects-87468.firebaseapp.com",
        projectId: "other-projects-87468",
        appId: "1:690759178180:web:c02b30cedcc8a419603691"
    };

    const ROLE_LABELS = {
        player: 'Citizen',
        clerk: 'Judicial Clerk',
        judge: 'Judge',
        fbis_agent: 'FBIS Agent',
        fboc_officer: 'FBOC Officer',
        admin: 'Administrator',
        president: 'President'
    };

    let firebaseAuth = null;
    if (window.firebase && typeof window.firebase.initializeApp === 'function') {
        if (!window.firebase.apps.length) {
            window.firebase.initializeApp(FIREBASE_CONFIG);
        }
        firebaseAuth = window.firebase.auth();
    } else {
        console.warn("Firebase library not loaded. Sign-in unavailable.");
    }

    let client = null;
    if (window.supabase && typeof window.supabase.createClient === 'function') {
        client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            accessToken: async () => {
                const fbUser = firebaseAuth?.currentUser;
                return fbUser ? await fbUser.getIdToken(false) : null;
            }
        });
    } else {
        console.warn("Supabase library not loaded. Running offline.");
    }

    const state = { user: null, profile: null, ready: false };
    const listeners = [];

    function notify() {
        listeners.forEach((fn) => {
            try { fn(state); } catch (e) { console.error(e); }
        });
    }

    // Supabase only treats a Firebase token as signed in when it carries the
    // `role: "authenticated"` claim; the firebase-claims function adds it.
    async function ensureRoleClaim(fbUser) {
        const tokenResult = await fbUser.getIdTokenResult();
        if (tokenResult.claims.role === 'authenticated') return;
        const { error } = await client.functions.invoke('firebase-claims', { method: 'POST' });
        if (error) throw error;
        await fbUser.getIdToken(true);
    }

    async function handleFirebaseUser(fbUser) {
        if (!fbUser) {
            state.user = null;
            state.profile = null;
        } else {
            state.user = { id: fbUser.uid, email: fbUser.email, name: fbUser.displayName };
            try {
                await ensureRoleClaim(fbUser);
                const { data, error } = await client.rpc('ensure_my_profile');
                if (error) throw error;
                state.profile = data;
            } catch (err) {
                console.error("Could not load your CPB profile:", err);
                state.profile = null;
            }
        }
        state.ready = true;
        notify();
    }

    if (firebaseAuth && client) {
        firebaseAuth.onAuthStateChanged(handleFirebaseUser);
    } else {
        state.ready = true;
    }

    async function signIn() {
        if (!firebaseAuth) {
            alert("Sign-in is unavailable right now. Please check your internet connection.");
            return;
        }
        try {
            await firebaseAuth.signInWithPopup(new window.firebase.auth.GoogleAuthProvider());
        } catch (err) {
            if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return;
            alert("Google sign-in failed: " + err.message);
        }
    }

    async function signOut() {
        if (!firebaseAuth) return;
        await firebaseAuth.signOut();
        window.location.reload();
    }

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function formatDate(value) {
        if (!value) return '—';
        const d = new Date(value);
        if (isNaN(d.getTime())) return String(value);
        return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function role() {
        return state.profile?.role || (state.user ? 'player' : 'anon');
    }

    // Division access, mirroring the database helpers (is_fbis, is_fboc, ...)
    const access = {
        judiciary: () => ['clerk', 'judge', 'admin', 'president'].includes(role()),
        fbis: () => ['fbis_agent', 'admin', 'president'].includes(role()),
        fboc: () => ['fboc_officer', 'admin', 'president'].includes(role()),
        admin: () => ['admin', 'president'].includes(role()),
        president: () => role() === 'president',
        anyStaff: () => ['clerk', 'judge', 'fbis_agent', 'fboc_officer', 'admin', 'president'].includes(role())
    };

    // Renders a compact sign-in / account chip into the given element
    function renderAuthChip(el) {
        if (!el) return;
        if (!state.ready) {
            el.innerHTML = `<span class="text-xs text-gray-500">Loading…</span>`;
            return;
        }
        if (!state.user) {
            el.innerHTML = `
                <button type="button" data-cpb-signin class="bg-slate-900 hover:bg-slate-800 border border-slate-700 text-white px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider transition">
                    Sign in with Google
                </button>`;
            el.querySelector('[data-cpb-signin]').addEventListener('click', signIn);
            return;
        }
        const name = state.profile?.minecraft_username || state.profile?.full_name || state.user.email;
        const staffLink = access.anyStaff()
            ? `<a href="${portalHref()}" class="text-amber-400 hover:text-amber-300 font-bold">${access.president() ? "President's Office" : 'Staff Portal'}</a>`
            : '';
        el.innerHTML = `
            <div class="flex items-center gap-3 text-xs">
                <span class="text-gray-300 truncate max-w-[10rem]" title="${escapeHtml(state.user.email)}">${escapeHtml(name)}</span>
                <span class="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-[10px] uppercase tracking-wider text-gray-300">${escapeHtml(ROLE_LABELS[role()] || role())}</span>
                ${staffLink}
                <button type="button" data-cpb-signout class="text-gray-400 hover:text-white">Sign out</button>
            </div>`;
        el.querySelector('[data-cpb-signout]').addEventListener('click', signOut);
    }

    // Portal pages live at server-security/portal/ and server-security/president/
    function portalHref() {
        const base = window.location.pathname.replace(/[^/]*$/, '');
        const depth = base.includes('/server-security/') ? base.split('/server-security/')[1].split('/').filter(Boolean).length : 0;
        const up = '../'.repeat(depth);
        return up + (access.president() ? 'president/' : 'portal/');
    }

    window.CPB = {
        client,
        state,
        ROLE_LABELS,
        access,
        role,
        signIn,
        signOut,
        escapeHtml,
        formatDate,
        renderAuthChip,
        onChange(fn) {
            listeners.push(fn);
            if (state.ready) fn(state);
        }
    };
})();
