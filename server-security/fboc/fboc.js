// ==============================================================================
// File: server-security/fboc/fboc.js
// Description: Live inmate roster, incident reports, and visitation /
//              commissary / parole requests for the FBOC page. Loaded after the
//              page's inline script, so the functions below replace the static
//              demo versions.
// ==============================================================================

(function () {
    'use strict';

    const CPB = window.CPB;
    const esc = CPB.escapeHtml;
    const liveInmates = {};

    const FACILITY = {
        redoubt: 'Facility 01 - The Obsidian Redoubt',
        kinetic: 'Facility 02 - Deepslate Kinetic Vault',
        andesite: 'Facility 03 - Andesite Restitution Works'
    };
    const FACILITY_SHORT = { redoubt: 'Facility 01 (Redoubt)', kinetic: 'Facility 02 (Vault)', andesite: 'Facility 03 (Andesite)' };
    const LEVEL = {
        maximum: { badge: 'MAX SECURITY', color: 'red', label: 'Level V (Maximum)' },
        medium: { badge: 'MED SECURITY', color: 'amber', label: 'Level III (Medium)' },
        restitution: { badge: 'RESTITUTION', color: 'emerald', label: 'Level I (Minimum)' }
    };
    const CUSTODY = {
        incarcerated: 'Active Custody',
        solitary: 'Solitary Confinement',
        work_detail: 'Restitution Labor Detail',
        paroled: 'Paroled',
        released: 'Released',
        escaped: 'ESCAPED - At Large',
        transferred: 'Transferred'
    };

    // Static Tailwind class names so the CDN build picks them up
    const COLORS = {
        red: { text: 'text-red-400', bg: 'bg-red-950', hover: 'hover:bg-red-700' },
        amber: { text: 'text-amber-400', bg: 'bg-amber-950', hover: 'hover:bg-amber-700' },
        emerald: { text: 'text-emerald-400', bg: 'bg-emerald-950', hover: 'hover:bg-emerald-700' }
    };

    function inmateCard(i) {
        const lvl = LEVEL[i.security_level] || LEVEL.medium;
        const c = COLORS[lvl.color];
        const escaped = i.custody_status === 'escaped';
        return `
            <div class="inmate-card rounded-lg p-5 flex flex-col justify-between" data-category="${esc(i.security_level)}">
                <div>
                    <div class="flex justify-between items-start mb-3">
                        <span class="text-[11px] mono-font ${c.text} font-bold">#${esc(i.inmate_number)}</span>
                        <span class="${escaped ? 'bg-red-600 text-white' : `${c.bg} ${c.text}`} text-[10px] px-2 py-0.5 rounded font-bold uppercase">${escaped ? 'ESCAPED' : lvl.badge}</span>
                    </div>
                    <h4 class="text-lg font-bold text-white mb-1">${esc(i.name)}</h4>
                    ${i.alias ? `<p class="text-xs text-gray-400 mb-3">Alias: "${esc(i.alias)}"</p>` : '<div class="mb-3"></div>'}
                    <div class="text-xs space-y-1.5 text-gray-300 mb-4 bg-slate-900/80 p-2.5 rounded border border-slate-800">
                        <div><span class="text-gray-500">Offense:</span> ${esc(i.offense)}</div>
                        ${i.sentence ? `<div><span class="text-gray-500">Sentence:</span> ${esc(i.sentence)}</div>` : ''}
                        <div><span class="text-gray-500">Assigned:</span> ${esc(FACILITY_SHORT[i.facility] || i.facility)}</div>
                    </div>
                </div>
                <button type="button" data-inmate-id="${esc(i.id)}" class="w-full bg-slate-800 ${c.hover} text-white text-xs font-semibold py-2 rounded transition">
                    View Inmate Record
                </button>
            </div>`;
    }

    async function loadInmates() {
        if (!CPB.client) return;

        const { data, error } = await CPB.client
            .from('fboc_inmates')
            .select('*')
            .eq('is_public', true)
            .not('custody_status', 'in', '(released,transferred)')
            .order('created_at', { ascending: true });

        if (error) {
            console.warn("Could not load inmate roster (showing archived copy):", error);
            fillInmateSelects([]);
            return;
        }

        data.forEach((i) => { liveInmates[i.id] = i; });

        const grid = document.getElementById('inmatesContainer');
        if (grid) {
            grid.innerHTML = data.length
                ? data.map(inmateCard).join('')
                : `<p class="text-sm text-gray-400 md:col-span-2 lg:col-span-4">No inmates are currently in federal custody.</p>`;
            grid.querySelectorAll('[data-inmate-id]').forEach((btn) => {
                btn.addEventListener('click', () => window.viewInmateDossier(btn.dataset.inmateId));
            });
        }

        fillInmateSelects(data.filter((i) => i.custody_status !== 'escaped'));
    }

    function fillInmateSelects(inmates) {
        document.querySelectorAll('[data-inmate-select]').forEach((sel) => {
            sel.innerHTML = inmates.length
                ? inmates.map((i) => `<option value="${esc(i.id)}">${esc(i.name)} (#${esc(i.inmate_number)}) - ${esc(FACILITY_SHORT[i.facility] || '')}</option>`).join('')
                : `<option value="">Roster unavailable</option>`;
        });
    }

    const staticViewInmate = window.viewInmateDossier;
    window.viewInmateDossier = function (key) {
        const i = liveInmates[key];
        if (!i) return staticViewInmate(key);

        const lvl = LEVEL[i.security_level] || LEVEL.medium;
        document.getElementById('dossierTitle').textContent = `${i.name}${i.alias ? ` "${i.alias}"` : ''} — #${i.inmate_number}`;
        document.getElementById('dossierContent').innerHTML = `
            <div class="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-3">
                ${row('Custodial Status', CUSTODY[i.custody_status] || i.custody_status, 'text-red-400 font-mono')}
                ${row('Classification', lvl.label, 'text-white')}
                ${row('Facility Assignment', FACILITY[i.facility] || i.facility, 'text-gray-300')}
                ${i.intake_date ? row('Intake Date', i.intake_date, 'text-gray-400') : ''}
            </div>
            ${block('Convicted Offenses', i.offense, 'text-red-400', 'text-gray-300')}
            ${i.sentence ? block('Active Sentence & Fines', i.sentence, 'text-gray-400', 'text-gray-300') : ''}
            ${i.behavior_log ? block('Guard Behavioral Log', i.behavior_log, 'text-gray-400', 'text-gray-400 italic') : ''}
            ${i.parole_status ? `
                <div class="flex justify-between items-center gap-4 p-3 rounded bg-amber-950/30 border border-amber-800/40 text-xs">
                    <span class="text-amber-300 font-semibold">Parole / Release Hearing:</span>
                    <span class="text-white font-mono text-right">${esc(i.parole_status)}</span>
                </div>` : ''}
        `;
        openModal('dossierModal');
    };

    function row(label, value, cls) {
        return `
            <div class="flex justify-between items-center gap-4 pb-2 border-b border-slate-800">
                <span class="text-xs text-gray-500 uppercase">${esc(label)}</span>
                <span class="text-xs font-bold ${cls} text-right">${esc(value)}</span>
            </div>`;
    }

    function block(title, body, titleCls, bodyCls) {
        return `
            <div>
                <h5 class="text-xs font-bold uppercase ${titleCls} mb-1">${esc(title)}</h5>
                <p class="text-xs bg-slate-900 p-3 rounded border border-slate-800 ${bodyCls} leading-relaxed whitespace-pre-line">${esc(body)}</p>
            </div>`;
    }

    function renderAuthNotices() {
        const signedIn = CPB.state.ready && !!CPB.state.user;
        document.querySelectorAll('[data-fboc-auth]').forEach((el) => {
            if (!CPB.state.ready) {
                el.textContent = 'Checking sign-in…';
            } else if (!CPB.state.user) {
                el.innerHTML = `You need to sign in first. <button type="button" class="text-red-400 font-bold underline" data-cpb-signin-inline>Sign in with Google</button>`;
                el.querySelector('[data-cpb-signin-inline]').addEventListener('click', CPB.signIn);
            } else {
                const who = CPB.state.profile?.minecraft_username || CPB.state.user.email;
                el.innerHTML = `Submitting as <strong class="text-white">${esc(who)}</strong>.`;
            }
        });
        document.querySelectorAll('[data-fboc-submit]').forEach((btn) => { btn.disabled = !signedIn; });
    }

    async function callRpc(fn, params, modalId, successText) {
        if (!CPB.state.user) {
            CPB.signIn();
            return false;
        }
        const buttons = document.querySelectorAll(`#${modalId} [data-fboc-submit]`);
        buttons.forEach((b) => { b.disabled = true; });
        try {
            const { data, error } = await CPB.client.rpc(fn, params);
            if (error) throw error;
            alert(`${successText} Your reference number is ${data.reference_number}.`);
            closeModal(modalId);
            return true;
        } catch (err) {
            alert("Your submission could not be sent: " + (err.message || err));
            return false;
        } finally {
            renderAuthNotices();
        }
    }

    window.handleReportSubmit = async function (e) {
        e.preventDefault();
        const ok = await callRpc('submit_fboc_incident', {
            p_category: document.getElementById('incidentCategory').value,
            p_subject_name: document.getElementById('incidentSubject').value,
            p_location: document.getElementById('incidentLocation').value,
            p_details: document.getElementById('incidentDetails').value
        }, 'tipModal', 'Incident report dispatched to FBOC Duty Wardens.');
        if (ok) e.target.reset();
    };

    window.submitFbocRequest = async function (type) {
        const ids = {
            visitation: { modal: 'visitationModal', inmate: 'visitInmate' },
            commissary: { modal: 'commissaryModal', inmate: 'commInmate' },
            parole: { modal: 'paroleModal', inmate: 'paroleInmate' }
        }[type];

        const inmateId = document.getElementById(ids.inmate).value || null;
        if (!inmateId) {
            alert("Please choose an inmate from the roster.");
            return;
        }

        const params = {
            p_request_type: type,
            p_inmate_id: inmateId,
            p_inmate_label: null,
            p_timeslot: null,
            p_amount: null,
            p_details: null
        };

        if (type === 'visitation') {
            params.p_timeslot = document.getElementById('visitTimeslot').value;
        } else if (type === 'commissary') {
            params.p_amount = parseInt(document.getElementById('commAmount').value, 10) || null;
            if (!params.p_amount) {
                alert("Please enter how many Brass Ingots to transfer.");
                return;
            }
        } else if (type === 'parole') {
            const work = document.getElementById('paroleWork').value.trim();
            const statement = document.getElementById('paroleStatement').value.trim();
            if (!statement) {
                alert("Please write a statement of good conduct.");
                return;
            }
            params.p_details = (work ? `Restitution completed: ${work}\n\n` : '') + statement;
        }

        const labels = {
            visitation: 'Visitation request sent to the FBOC Sector Warden.',
            commissary: 'Commissary deposit request sent to FBOC.',
            parole: 'Parole petition filed with FBOC for review.'
        };
        await callRpc('submit_fboc_request', params, ids.modal, labels[type]);
    };

    CPB.onChange(() => {
        CPB.renderAuthChip(document.getElementById('cpbAuthChip'));
        renderAuthNotices();
    });

    CPB.renderAuthChip(document.getElementById('cpbAuthChip'));
    renderAuthNotices();
    loadInmates();
})();
