// ==============================================================================
// File: server-security/fbis/fbis.js
// Description: Live Most Wanted list and real tip submission for the FBIS page.
//              Loaded after the page's inline script, so the functions below
//              replace the static demo versions.
// ==============================================================================

(function () {
    'use strict';

    const CPB = window.CPB;
    const esc = CPB.escapeHtml;
    const liveWanted = {};

    const THREAT = {
        extreme: { label: 'EXTREME THREAT', badge: 'bg-red-600', bounty: 'text-red-400' },
        high: { label: 'HIGH THREAT', badge: 'bg-red-600', bounty: 'text-amber-400' },
        moderate: { label: 'MODERATE THREAT', badge: 'bg-amber-600', bounty: 'text-amber-400' },
        low: { label: 'LOW THREAT', badge: 'bg-slate-600', bounty: 'text-gray-300' }
    };

    function wantedCard(w) {
        const t = THREAT[w.threat_level] || THREAT.moderate;
        return `
            <div class="wanted-card rounded-xl p-6 flex flex-col justify-between overflow-hidden">
                <div class="absolute top-0 right-0 ${t.badge} text-white text-[10px] font-bold px-3 py-1 rounded-bl uppercase tracking-wider mono-font">
                    ${t.label}
                </div>
                <div>
                    <div class="h-44 bg-slate-900 rounded-lg border border-slate-800 mb-4 flex flex-col items-center justify-center relative overflow-hidden">
                        <div class="scanner-line w-full absolute top-0"></div>
                        <div class="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center text-gray-500 mb-2 border border-slate-700">
                            <svg class="w-8 h-8 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
                            </svg>
                        </div>
                        <span class="text-xs font-mono text-cyan-400">CASE ${esc(w.wanted_number)}</span>
                    </div>
                    <div class="flex justify-between items-start mb-2 gap-2">
                        <h3 class="text-xl font-bold text-white heading-font break-all">"${esc(w.name)}"</h3>
                        <span class="text-xs mono-font ${t.bounty} font-bold whitespace-nowrap">${esc(w.bounty || '')}</span>
                    </div>
                    ${w.alias ? `<p class="text-xs text-gray-400 mb-3">Known Alias: ${esc(w.alias)}</p>` : ''}
                    <div class="text-xs space-y-1.5 text-gray-300 bg-slate-900/80 p-3 rounded-lg border border-slate-800 mb-4 font-mono">
                        <div><span class="text-gray-500">OFFENSE:</span> ${esc(w.offense)}</div>
                        ${w.last_seen ? `<div><span class="text-gray-500">LAST SEEN:</span> ${esc(w.last_seen)}</div>` : ''}
                        ${w.status_note ? `<div><span class="text-gray-500">STATUS:</span> ${esc(w.status_note)}</div>` : ''}
                    </div>
                </div>
                <button type="button" data-wanted-id="${esc(w.id)}" class="w-full bg-slate-800 hover:bg-cyan-600 hover:text-white text-gray-300 text-xs font-bold py-2.5 rounded transition uppercase tracking-wider">
                    Inspect Classified Casefile
                </button>
            </div>`;
    }

    async function loadWanted() {
        const grid = document.getElementById('wantedGrid');
        if (!grid || !CPB.client) return;

        const { data, error } = await CPB.client
            .from('fbis_wanted')
            .select('*')
            .eq('is_public', true)
            .eq('status', 'wanted')
            .order('created_at', { ascending: true });

        if (error) {
            console.warn("Could not load Most Wanted list (showing archived copy):", error);
            return;
        }

        data.forEach((w) => { liveWanted[w.id] = w; });
        grid.innerHTML = data.length
            ? data.map(wantedCard).join('')
            : `<p class="text-sm text-gray-400 md:col-span-3">No active fugitives. All targets are in custody.</p>`;
        grid.querySelectorAll('[data-wanted-id]').forEach((btn) => {
            btn.addEventListener('click', () => window.viewFugitiveDetails(btn.dataset.wantedId));
        });
    }

    // Live records by id; falls back to the page's built-in demo casefiles
    const staticViewFugitive = window.viewFugitiveDetails;
    window.viewFugitiveDetails = function (key) {
        const w = liveWanted[key];
        if (!w) return staticViewFugitive(key);

        const t = THREAT[w.threat_level] || THREAT.moderate;
        document.getElementById('fugitiveModalTitle').textContent = `Casefile: "${w.name}" (${w.wanted_number})`;
        document.getElementById('fugitiveModalContent').innerHTML = `
            <div class="bg-black/60 p-4 rounded-xl border border-cyan-950 font-mono text-xs space-y-2">
                ${w.alias ? `<div class="flex justify-between gap-4"><span class="text-gray-500">KNOWN ALIAS:</span> <span class="text-white text-right">${esc(w.alias)}</span></div>` : ''}
                <div class="flex justify-between gap-4"><span class="text-gray-500">THREAT LEVEL:</span> <span class="text-red-400 font-bold">${t.label}</span></div>
                ${w.bounty ? `<div class="flex justify-between gap-4"><span class="text-gray-500">BOUNTY REWARD:</span> <span class="text-cyan-400 font-bold">${esc(w.bounty)}</span></div>` : ''}
            </div>
            ${section('Investigation Summary', w.summary || w.offense, 'text-gray-300')}
            ${w.modus_operandi ? section('Modus Operandi & Methods', w.modus_operandi, 'text-gray-300') : ''}
            ${w.field_instructions ? section('Citizen & Field Directives', w.field_instructions, 'text-amber-300') : ''}
        `;
        openModal('fugitiveModal');
    };

    function section(title, body, color) {
        return `
            <div>
                <h5 class="text-xs font-bold uppercase text-cyan-400 mono-font mb-1">${esc(title)}</h5>
                <p class="text-xs bg-slate-950 p-3 rounded border border-slate-800 ${color} leading-relaxed whitespace-pre-line">${esc(body)}</p>
            </div>`;
    }

    function renderTipAuth() {
        const notice = document.getElementById('tipAuthNotice');
        const submit = document.getElementById('tipSubmitBtn');
        if (!notice || !submit) return;

        if (!CPB.state.ready) {
            notice.textContent = 'Checking sign-in…';
            submit.disabled = true;
        } else if (!CPB.state.user) {
            notice.innerHTML = `You need to sign in to file a tip. <button type="button" class="text-cyan-400 font-bold underline" data-cpb-tip-signin>Sign in with Google</button>`;
            notice.querySelector('[data-cpb-tip-signin]').addEventListener('click', CPB.signIn);
            submit.disabled = true;
        } else {
            const who = CPB.state.profile?.minecraft_username || CPB.state.user.email;
            notice.innerHTML = `Filing as <strong class="text-white">${esc(who)}</strong>. Only FBIS staff will see this.`;
            submit.disabled = false;
        }
    }

    window.handleTipSubmit = async function (e) {
        e.preventDefault();
        if (!CPB.state.user) {
            CPB.signIn();
            return;
        }

        const submit = document.getElementById('tipSubmitBtn');
        submit.disabled = true;
        try {
            const { data, error } = await CPB.client.rpc('submit_fbis_tip', {
                p_suspect_name: document.getElementById('tipSuspect').value,
                p_category: document.getElementById('tipCategory').value,
                p_location: document.getElementById('tipLocation').value,
                p_details: document.getElementById('tipDetails').value,
                p_evidence_urls: document.getElementById('tipEvidence').value
            });
            if (error) throw error;

            alert(`Tip received by FBIS. Your reference number is ${data.reference_number}.`);
            closeModal('tipModal');
            e.target.reset();
        } catch (err) {
            alert("Your tip could not be sent: " + (err.message || err));
        } finally {
            submit.disabled = false;
            renderTipAuth();
        }
    };

    CPB.onChange(() => {
        CPB.renderAuthChip(document.getElementById('cpbAuthChip'));
        renderTipAuth();
    });

    CPB.renderAuthChip(document.getElementById('cpbAuthChip'));
    renderTipAuth();
    loadWanted();
})();
