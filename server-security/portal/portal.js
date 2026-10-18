// ==============================================================================
// File: server-security/portal/portal.js
// Description: Staff Portal (server-security/portal/) and President's Office
//              (server-security/president/). Each tab only appears for roles
//              that can use it; the database enforces the same rules (RLS), so
//              hiding a tab is a convenience, not the security boundary.
// ==============================================================================

(function () {
    'use strict';

    const CPB = window.CPB;
    const db = CPB.client;
    const esc = CPB.escapeHtml;
    const fmt = CPB.formatDate;
    const MODE = document.body.dataset.portalMode || 'staff'; // 'staff' | 'president'

    // --------------------------------------------------------------------------
    // Labels
    // --------------------------------------------------------------------------
    const TIP_CATEGORY = {
        contraption_ramming: 'Contraption ramming', schematic_theft: 'Schematic theft', duplication: 'Duplication / desync',
        rail_sabotage: 'Rail sabotage', espionage: 'Corporate espionage', other: 'Other'
    };
    const INCIDENT_CATEGORY = {
        escape: 'Escape attempt', custody_breach: 'Facility breach', contraband: 'Contraband',
        weapon: 'Weaponized schematic', griefing: 'Griefing / ramming', other: 'Other'
    };
    const FACILITY = { redoubt: 'Facility 01 - Obsidian Redoubt', kinetic: 'Facility 02 - Kinetic Vault', andesite: 'Facility 03 - Andesite Works' };
    const SECURITY = { maximum: 'Maximum', medium: 'Medium', restitution: 'Restitution' };
    const CUSTODY = {
        incarcerated: 'Incarcerated', solitary: 'Solitary', work_detail: 'Work detail', paroled: 'Paroled',
        released: 'Released', escaped: 'Escaped', transferred: 'Transferred'
    };
    const THREAT = { extreme: 'Extreme', high: 'High', moderate: 'Moderate', low: 'Low' };
    const WANTED_STATUS = { wanted: 'Wanted', captured: 'Captured', cleared: 'Cleared' };
    const TIP_STATUS = { new: 'New', investigating: 'Investigating', actioned: 'Actioned', dismissed: 'Dismissed' };
    const INCIDENT_STATUS = { new: 'New', responding: 'Responding', resolved: 'Resolved', dismissed: 'Dismissed' };
    const REQUEST_STATUS = { pending: 'Pending', approved: 'Approved', denied: 'Denied', completed: 'Completed' };
    const REQUEST_TYPE = { visitation: 'Visitation', commissary: 'Commissary', parole: 'Parole' };
    const FILING_STATUS = { pending_review: 'Pending review', under_investigation: 'Under investigation', docketed: 'Docketed', rejected: 'Rejected', closed: 'Closed' };
    const CASE_STATUS = {
        pending_review: 'Pending review', in_deliberation: 'In deliberation', hearing_scheduled: 'Hearing scheduled',
        verdict_rendered: 'Verdict rendered', appealed: 'Appealed', dismissed: 'Dismissed', closed: 'Closed'
    };

    const STATUS_TONE = {
        new: 'amber', pending: 'amber', pending_review: 'amber', wanted: 'red', escaped: 'red',
        investigating: 'blue', responding: 'blue', under_investigation: 'blue', in_deliberation: 'blue', hearing_scheduled: 'blue',
        actioned: 'green', resolved: 'green', approved: 'green', completed: 'green', docketed: 'green', captured: 'green', verdict_rendered: 'green',
        dismissed: 'gray', denied: 'gray', rejected: 'gray', closed: 'gray', cleared: 'gray', released: 'gray'
    };
    const TONE_CLASS = {
        amber: 'bg-amber-950 text-amber-300 border-amber-800',
        red: 'bg-red-950 text-red-300 border-red-800',
        blue: 'bg-sky-950 text-sky-300 border-sky-800',
        green: 'bg-emerald-950 text-emerald-300 border-emerald-800',
        gray: 'bg-slate-800 text-gray-300 border-slate-700'
    };

    function badge(status, labels) {
        const tone = TONE_CLASS[STATUS_TONE[status] || 'gray'];
        return `<span class="inline-block px-2 py-0.5 rounded border text-[11px] font-semibold whitespace-nowrap ${tone}">${esc((labels && labels[status]) || status)}</span>`;
    }

    function options(map, selected) {
        return Object.entries(map).map(([value, label]) =>
            `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`).join('');
    }

    // --------------------------------------------------------------------------
    // Tabs
    // --------------------------------------------------------------------------
    const TABS = [
        { id: 'overview', label: 'Overview', can: () => true, render: renderOverview },
        { id: 'judiciary', label: 'Judiciary', can: CPB.access.judiciary, render: renderJudiciary },
        { id: 'fbis', label: 'FBIS', can: CPB.access.fbis, render: renderFbis },
        { id: 'fboc', label: 'FBOC', can: CPB.access.fboc, render: renderFboc },
        { id: 'admin', label: 'Administration', can: CPB.access.admin, render: renderAdmin }
    ];

    let activeTab = null;
    const content = () => document.getElementById('portalContent');

    function boot() {
        CPB.renderAuthChip(document.getElementById('cpbAuthChip'));
        const gate = document.getElementById('portalGate');
        const app = document.getElementById('portalApp');

        if (!CPB.state.ready) {
            gate.innerHTML = card('Loading…', 'Checking your sign-in.');
            return;
        }
        if (!CPB.state.user) {
            gate.innerHTML = card('Sign in required', 'This portal is for server staff. Sign in with the Google account linked to your staff role.',
                `<button type="button" data-signin class="mt-4 bg-amber-600 hover:bg-amber-500 text-white px-4 py-2 rounded text-xs font-bold uppercase tracking-wider">Sign in with Google</button>`);
            gate.querySelector('[data-signin]').addEventListener('click', CPB.signIn);
            app.classList.add('hidden');
            return;
        }
        if (!CPB.state.profile) {
            gate.innerHTML = card('Profile unavailable', 'Your CPB profile could not be loaded. Reload the page, or check the browser console for details.');
            app.classList.add('hidden');
            return;
        }

        const allowed = MODE === 'president' ? CPB.access.admin() : CPB.access.anyStaff();
        if (!allowed) {
            const msg = MODE === 'president'
                ? 'The President\'s Office is restricted to the President and server administrators.'
                : 'You don\'t have a staff role yet. Ask the President or an administrator to assign one.';
            gate.innerHTML = card('Access restricted', msg, `<a href="../" class="inline-block mt-4 text-amber-400 hover:text-amber-300 text-sm font-semibold">← Back to Security & Justice</a>`);
            app.classList.add('hidden');
            return;
        }

        gate.innerHTML = '';
        app.classList.remove('hidden');
        document.getElementById('portalWelcome').textContent =
            `Signed in as ${CPB.state.profile.minecraft_username || CPB.state.profile.full_name || CPB.state.user.email} · ${CPB.ROLE_LABELS[CPB.role()] || CPB.role()}`;

        const nav = document.getElementById('portalTabs');
        const visible = TABS.filter((t) => t.can());
        nav.innerHTML = visible.map((t) =>
            `<button type="button" data-tab="${t.id}" class="portal-tab px-4 py-2 rounded-t text-sm font-semibold border-b-2 border-transparent text-gray-400 hover:text-white whitespace-nowrap">${esc(t.label)}</button>`).join('');
        nav.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

        const fromHash = window.location.hash.replace('#', '');
        const initial = visible.find((t) => t.id === fromHash) || visible[0];
        showTab(initial.id);
    }

    function showTab(id) {
        const tab = TABS.find((t) => t.id === id && t.can());
        if (!tab) return;
        activeTab = id;
        history.replaceState(null, '', `#${id}`);
        document.querySelectorAll('#portalTabs [data-tab]').forEach((b) => {
            const on = b.dataset.tab === id;
            b.classList.toggle('border-amber-500', on);
            b.classList.toggle('text-white', on);
            b.classList.toggle('text-gray-400', !on);
        });
        content().innerHTML = `<p class="text-sm text-gray-400">Loading…</p>`;
        Promise.resolve(tab.render()).catch((err) => {
            console.error(err);
            content().innerHTML = errorBox(err);
        });
    }

    function refresh() {
        if (activeTab) showTab(activeTab);
    }

    function card(title, body, extra = '') {
        return `
            <div class="max-w-lg mx-auto mt-16 bg-slate-900 border border-slate-800 rounded-xl p-8 text-center">
                <h2 class="text-xl font-bold text-white heading-font mb-2">${esc(title)}</h2>
                <p class="text-sm text-gray-400">${esc(body)}</p>
                ${extra}
            </div>`;
    }

    function errorBox(err) {
        return `<div class="bg-red-950/50 border border-red-800 text-red-200 rounded-lg p-4 text-sm">Something went wrong: ${esc(err.message || err)}</div>`;
    }

    function sectionHeader(title, subtitle, actionsHtml = '') {
        return `
            <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-4">
                <div>
                    <h2 class="text-lg font-bold text-white heading-font">${esc(title)}</h2>
                    ${subtitle ? `<p class="text-xs text-gray-400 mt-0.5">${esc(subtitle)}</p>` : ''}
                </div>
                <div class="flex flex-wrap gap-2">${actionsHtml}</div>
            </div>`;
    }

    // Responsive table: rows is an array of { cells: [...html], id }
    function table(headers, rows, emptyText, rowAttr = 'data-row') {
        if (!rows.length) {
            return `<div class="bg-slate-900 border border-slate-800 rounded-lg p-6 text-sm text-gray-400 text-center">${esc(emptyText)}</div>`;
        }
        return `
            <div class="overflow-x-auto bg-slate-900 border border-slate-800 rounded-lg">
                <table class="min-w-full text-sm">
                    <thead class="bg-slate-950 text-[11px] uppercase tracking-wider text-gray-400">
                        <tr>${headers.map((h) => `<th class="text-left font-semibold px-3 py-2 whitespace-nowrap">${esc(h)}</th>`).join('')}</tr>
                    </thead>
                    <tbody class="divide-y divide-slate-800">
                        ${rows.map((r) => `
                            <tr ${r.id ? `${rowAttr}="${esc(r.id)}" class="hover:bg-slate-800/60 cursor-pointer"` : ''}>
                                ${r.cells.map((c) => `<td class="px-3 py-2 align-top text-gray-200">${c}</td>`).join('')}
                            </tr>`).join('')}
                    </tbody>
                </table>
            </div>`;
    }

    function subTabs(id, items, active) {
        return `
            <div class="flex gap-2 mb-5 flex-wrap" data-subtabs="${id}">
                ${items.map(([key, label]) => `
                    <button type="button" data-sub="${key}" class="px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider border ${key === active ? 'bg-amber-600 border-amber-500 text-white' : 'bg-slate-900 border-slate-700 text-gray-300 hover:bg-slate-800'}">${esc(label)}</button>`).join('')}
            </div>`;
    }

    function bindSubTabs(id, handler) {
        document.querySelectorAll(`[data-subtabs="${id}"] [data-sub]`).forEach((b) =>
            b.addEventListener('click', () => handler(b.dataset.sub)));
    }

    async function count(tableName, apply) {
        let q = db.from(tableName).select('*', { count: 'exact', head: true });
        if (apply) q = apply(q);
        const { count: n, error } = await q;
        if (error) throw error;
        return n ?? 0;
    }

    function submitter(r) {
        return esc(r.submitter_minecraft_username || r.requester_minecraft_username || r.submitter_email || r.requester_email || '—');
    }

    // --------------------------------------------------------------------------
    // Modal
    // --------------------------------------------------------------------------
    function openModal(title, bodyHtml, footerHtml) {
        document.getElementById('portalModalTitle').textContent = title;
        document.getElementById('portalModalBody').innerHTML = bodyHtml;
        document.getElementById('portalModalFooter').innerHTML = footerHtml ||
            `<button type="button" data-close class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-gray-200 rounded text-xs font-semibold">Close</button>`;
        const modal = document.getElementById('portalModal');
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
    }

    function closeModal() {
        const modal = document.getElementById('portalModal');
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }

    function detailList(pairs) {
        return `
            <dl class="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm bg-slate-950 border border-slate-800 rounded-lg p-4">
                ${pairs.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v, raw]) => `
                    <dt class="text-gray-500 text-xs uppercase tracking-wider sm:pt-0.5">${esc(k)}</dt>
                    <dd class="sm:col-span-2 text-gray-200 whitespace-pre-line break-words">${raw ? v : esc(v)}</dd>`).join('')}
            </dl>`;
    }

    // Field spec: { key, label, type: text|textarea|select|number|checkbox, options, required, maxlength, help }
    function formFields(fields, values = {}) {
        return fields.map((f) => {
            const id = `field_${f.key}`;
            const v = values[f.key] ?? f.default ?? '';
            const base = 'w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500';
            let input;
            if (f.type === 'textarea') {
                input = `<textarea id="${id}" rows="${f.rows || 3}" ${f.maxlength ? `maxlength="${f.maxlength}"` : ''} ${f.required ? 'required' : ''} class="${base}">${esc(v)}</textarea>`;
            } else if (f.type === 'select') {
                input = `<select id="${id}" class="${base}">${options(f.options, v)}</select>`;
            } else if (f.type === 'checkbox') {
                return `
                    <label class="flex items-center gap-2 text-sm text-gray-300">
                        <input id="${id}" type="checkbox" ${v ? 'checked' : ''} class="rounded bg-slate-800 border-slate-700">
                        ${esc(f.label)}
                    </label>`;
            } else {
                input = `<input id="${id}" type="${f.type || 'text'}" value="${esc(v)}" ${f.maxlength ? `maxlength="${f.maxlength}"` : ''} ${f.required ? 'required' : ''} class="${base}">`;
            }
            return `
                <div>
                    <label for="${id}" class="block text-xs font-semibold uppercase text-gray-400 mb-1">${esc(f.label)}${f.required ? ' *' : ''}</label>
                    ${input}
                    ${f.help ? `<p class="text-[11px] text-gray-500 mt-1">${esc(f.help)}</p>` : ''}
                </div>`;
        }).join('');
    }

    function readFields(fields) {
        const out = {};
        for (const f of fields) {
            const el = document.getElementById(`field_${f.key}`);
            if (!el) continue;
            if (f.type === 'checkbox') {
                out[f.key] = el.checked;
            } else {
                const val = el.value.trim();
                if (f.required && !val) throw new Error(`${f.label} is required.`);
                out[f.key] = val === '' ? null : val;
            }
        }
        return out;
    }

    async function saveWithButton(btn, work) {
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = 'Saving…';
        try {
            await work();
            closeModal();
            refresh();
        } catch (err) {
            alert(err.message || String(err));
        } finally {
            btn.disabled = false;
            btn.textContent = original;
        }
    }

    function footer(saveLabel, extra = '') {
        return `
            ${extra}
            <button type="button" data-close class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-gray-200 rounded text-xs font-semibold">Cancel</button>
            <button type="button" data-save class="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded text-xs font-bold uppercase tracking-wider">${esc(saveLabel)}</button>`;
    }

    // --------------------------------------------------------------------------
    // Overview
    // --------------------------------------------------------------------------
    async function renderOverview() {
        const stats = [];
        const jobs = [];

        if (CPB.access.judiciary()) {
            jobs.push(count('filings', (q) => q.eq('status', 'pending_review')).then((n) => stats.push(['Judiciary', 'Filings awaiting review', n, 'judiciary'])));
            jobs.push(count('cases', (q) => q.in('status', ['in_deliberation', 'hearing_scheduled'])).then((n) => stats.push(['Judiciary', 'Open cases', n, 'judiciary'])));
        }
        if (CPB.access.fbis()) {
            jobs.push(count('fbis_tips', (q) => q.eq('status', 'new')).then((n) => stats.push(['FBIS', 'New tips', n, 'fbis'])));
            jobs.push(count('fbis_wanted', (q) => q.eq('status', 'wanted')).then((n) => stats.push(['FBIS', 'Active Most Wanted', n, 'fbis'])));
        }
        if (CPB.access.fboc()) {
            jobs.push(count('fboc_incidents', (q) => q.eq('status', 'new')).then((n) => stats.push(['FBOC', 'New incident reports', n, 'fboc'])));
            jobs.push(count('fboc_inmates', (q) => q.eq('custody_status', 'escaped')).then((n) => stats.push(['FBOC', 'Escaped inmates', n, 'fboc'])));
            jobs.push(count('fboc_inmates', (q) => q.in('custody_status', ['incarcerated', 'solitary', 'work_detail'])).then((n) => stats.push(['FBOC', 'Inmates in custody', n, 'fboc'])));
            jobs.push(count('fboc_requests', (q) => q.eq('status', 'pending')).then((n) => stats.push(['FBOC', 'Pending requests', n, 'fboc'])));
        }
        await Promise.all(jobs);

        const order = ['Judiciary', 'FBIS', 'FBOC'];
        stats.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));

        const recent = await loadRecentActivity();

        content().innerHTML = `
            ${sectionHeader(MODE === 'president' ? 'State of the Department' : 'Overview', 'What needs attention across the divisions you can access.')}
            <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
                ${stats.map(([division, label, n, tab]) => `
                    <button type="button" data-goto="${tab}" class="text-left bg-slate-900 border border-slate-800 hover:border-amber-600 rounded-lg p-4 transition">
                        <div class="text-[11px] uppercase tracking-wider text-gray-500">${esc(division)}</div>
                        <div class="text-3xl font-bold text-white mt-1">${n}</div>
                        <div class="text-xs text-gray-400 mt-1">${esc(label)}</div>
                    </button>`).join('')}
            </div>
            <h3 class="text-sm font-bold text-white uppercase tracking-wider mb-3">Latest submissions</h3>
            ${table(['When', 'Division', 'Type', 'Summary', 'Status'], recent.map((r) => ({ cells: r })), 'Nothing submitted yet.')}
        `;
        content().querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.goto)));
    }

    async function loadRecentActivity() {
        const rows = [];
        const jobs = [];
        const take = (q) => q.order('created_at', { ascending: false }).limit(5);

        if (CPB.access.judiciary()) {
            jobs.push(take(db.from('filings').select('created_at, filing_type, title, status')).then(({ data }) =>
                (data || []).forEach((r) => rows.push([r.created_at, 'Judiciary', r.filing_type, r.title, badge(r.status, FILING_STATUS)]))));
        }
        if (CPB.access.fbis()) {
            jobs.push(take(db.from('fbis_tips').select('created_at, category, suspect_name, status')).then(({ data }) =>
                (data || []).forEach((r) => rows.push([r.created_at, 'FBIS', 'tip', `${TIP_CATEGORY[r.category] || r.category}: ${r.suspect_name}`, badge(r.status, TIP_STATUS)]))));
        }
        if (CPB.access.fboc()) {
            jobs.push(take(db.from('fboc_incidents').select('created_at, category, subject_name, status')).then(({ data }) =>
                (data || []).forEach((r) => rows.push([r.created_at, 'FBOC', 'incident', `${INCIDENT_CATEGORY[r.category] || r.category}${r.subject_name ? `: ${r.subject_name}` : ''}`, badge(r.status, INCIDENT_STATUS)]))));
            jobs.push(take(db.from('fboc_requests').select('created_at, request_type, inmate_label, status')).then(({ data }) =>
                (data || []).forEach((r) => rows.push([r.created_at, 'FBOC', 'request', `${REQUEST_TYPE[r.request_type]}: ${r.inmate_label || ''}`, badge(r.status, REQUEST_STATUS)]))));
        }
        await Promise.all(jobs);

        return rows
            .sort((a, b) => new Date(b[0]) - new Date(a[0]))
            .slice(0, 12)
            .map(([when, division, type, summary, status]) => [esc(fmt(when)), esc(division), esc(type), esc(summary), status]);
    }

    // --------------------------------------------------------------------------
    // Judiciary (read-only here; docketing stays in the judiciary workbench)
    // --------------------------------------------------------------------------
    let judiciarySub = 'filings';

    async function renderJudiciary(sub = judiciarySub) {
        judiciarySub = sub;
        const workbench = `<a href="../judiciary/" class="px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider bg-amber-600 hover:bg-amber-500 text-white">Open Judiciary Workbench</a>`;
        let body;

        if (sub === 'filings') {
            const { data, error } = await db.from('filings')
                .select('id, reference_number, filing_type, title, details, relief_sought, submitter_email, submitter_minecraft_username, submitter_verified, status, review_notes, is_confidential, target_party_name, created_at')
                .order('created_at', { ascending: false }).limit(200);
            if (error) throw error;
            window.__portalFilings = Object.fromEntries(data.map((r) => [r.id, r]));
            body = table(['Reference', 'Type', 'Title', 'Filed by', 'Status', 'Filed'],
                data.map((r) => ({
                    id: r.id,
                    cells: [
                        `<span class="font-mono text-xs">${esc(r.reference_number)}</span>`,
                        esc(r.filing_type) + (r.is_confidential ? ' <span class="text-[10px] text-red-300">(confidential)</span>' : ''),
                        esc(r.title),
                        submitter(r) + (r.submitter_verified ? ' <span class="text-emerald-400 text-xs" title="Verified Minecraft account">✓</span>' : ''),
                        badge(r.status, FILING_STATUS),
                        esc(fmt(r.created_at))
                    ]
                })), 'No filings yet.');
        } else {
            const { data, error } = await db.from('cases')
                .select('id, docket_number, case_type, title, plaintiff_name, defendant_name, status, assigned_judge, current_order, is_published, created_at')
                .order('created_at', { ascending: false }).limit(200);
            if (error) throw error;
            window.__portalCases = Object.fromEntries(data.map((r) => [r.id, r]));
            body = table(['Docket', 'Type', 'Title', 'Judge', 'Status', 'Public'],
                data.map((r) => ({
                    id: r.id,
                    cells: [
                        `<span class="font-mono text-xs">${esc(r.docket_number)}</span>`,
                        esc(r.case_type), esc(r.title), esc(r.assigned_judge || '—'),
                        badge(r.status, CASE_STATUS), r.is_published ? 'Yes' : 'No'
                    ]
                })), 'No cases yet.');
        }

        content().innerHTML = `
            ${sectionHeader('Federal Judiciary', 'Filings and cases. Docket filings, issue orders and render verdicts in the Judiciary Workbench.', workbench)}
            ${subTabs('jud', [['filings', 'Filings'], ['cases', 'Cases']], sub)}
            ${body}`;
        bindSubTabs('jud', renderJudiciary);

        content().querySelectorAll('[data-row]').forEach((tr) => tr.addEventListener('click', () => {
            if (sub === 'filings') {
                const r = window.__portalFilings[tr.dataset.row];
                openModal(`Filing ${r.reference_number}`, detailList([
                    ['Type', r.filing_type], ['Title', r.title], ['Status', FILING_STATUS[r.status] || r.status],
                    ['Filed by', `${r.submitter_minecraft_username || '—'} (${r.submitter_email || 'no email'})`],
                    ['Verified', r.submitter_verified ? 'Yes' : 'No'], ['Against', r.target_party_name],
                    ['Details', r.details], ['Relief sought', r.relief_sought], ['Review notes', r.review_notes], ['Filed', fmt(r.created_at)]
                ]));
            } else {
                const r = window.__portalCases[tr.dataset.row];
                openModal(`Case ${r.docket_number}`, detailList([
                    ['Title', r.title], ['Type', r.case_type], ['Status', CASE_STATUS[r.status] || r.status],
                    ['Plaintiff', r.plaintiff_name], ['Defendant', r.defendant_name], ['Judge', r.assigned_judge],
                    ['Current order', r.current_order], ['Published', r.is_published ? 'Yes' : 'No'], ['Opened', fmt(r.created_at)]
                ]));
            }
        }));
    }

    // --------------------------------------------------------------------------
    // Shared review flow for tips / incidents / requests
    // --------------------------------------------------------------------------
    function reviewModal({ title, details, statusMap, record, notesKey, notesLabel, table: tableName }) {
        const body = `
            ${detailList(details)}
            <div class="grid grid-cols-1 gap-4 mt-4">
                <div>
                    <label for="reviewStatus" class="block text-xs font-semibold uppercase text-gray-400 mb-1">Status</label>
                    <select id="reviewStatus" class="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-white text-sm">${options(statusMap, record.status)}</select>
                </div>
                <div>
                    <label for="reviewNotes" class="block text-xs font-semibold uppercase text-gray-400 mb-1">${esc(notesLabel)}</label>
                    <textarea id="reviewNotes" rows="4" maxlength="5000" class="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-white text-sm">${esc(record[notesKey] || '')}</textarea>
                </div>
            </div>`;
        openModal(title, body, footer('Save'));
        document.querySelector('#portalModal [data-save]').addEventListener('click', (e) => saveWithButton(e.currentTarget, async () => {
            const { error } = await db.from(tableName).update({
                status: document.getElementById('reviewStatus').value,
                [notesKey]: document.getElementById('reviewNotes').value.trim() || null,
                reviewed_by: CPB.state.user.id
            }).eq('id', record.id);
            if (error) throw error;
        }));
    }

    function statusFilter(id, map, current) {
        return `
            <select id="${id}" class="bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs text-gray-200">
                <option value="">All statuses</option>
                ${options(map, current)}
            </select>`;
    }

    // --------------------------------------------------------------------------
    // FBIS
    // --------------------------------------------------------------------------
    let fbisSub = 'tips';
    let tipStatusFilter = 'new';

    async function renderFbis(sub = fbisSub) {
        fbisSub = sub;
        if (sub === 'tips') return renderTips();
        return renderWanted();
    }

    async function renderTips() {
        let q = db.from('fbis_tips').select('*').order('created_at', { ascending: false }).limit(200);
        if (tipStatusFilter) q = q.eq('status', tipStatusFilter);
        const { data, error } = await q;
        if (error) throw error;
        const byId = Object.fromEntries(data.map((r) => [r.id, r]));

        content().innerHTML = `
            ${sectionHeader('FBIS · Intelligence Tips', 'Confidential tips from signed-in citizens. Only FBIS staff and leadership can see these.', statusFilter('tipFilter', TIP_STATUS, tipStatusFilter))}
            ${subTabs('fbis', [['tips', 'Tips'], ['wanted', 'Most Wanted']], 'tips')}
            ${table(['Reference', 'Category', 'Suspect', 'From', 'Status', 'Received'],
                data.map((r) => ({
                    id: r.id,
                    cells: [`<span class="font-mono text-xs">${esc(r.reference_number)}</span>`, esc(TIP_CATEGORY[r.category] || r.category),
                        esc(r.suspect_name), submitter(r), badge(r.status, TIP_STATUS), esc(fmt(r.created_at))]
                })), tipStatusFilter ? 'No tips with this status.' : 'No tips yet.')}`;
        bindSubTabs('fbis', renderFbis);
        document.getElementById('tipFilter').addEventListener('change', (e) => { tipStatusFilter = e.target.value; renderTips(); });

        content().querySelectorAll('[data-row]').forEach((tr) => tr.addEventListener('click', () => {
            const r = byId[tr.dataset.row];
            reviewModal({
                title: `Tip ${r.reference_number}`, record: r, table: 'fbis_tips', statusMap: TIP_STATUS,
                notesKey: 'staff_notes', notesLabel: 'Internal notes (staff only)',
                details: [
                    ['Category', TIP_CATEGORY[r.category] || r.category], ['Suspect', r.suspect_name], ['Location', r.location],
                    ['Details', r.details], ['Evidence', r.evidence_urls],
                    ['From', `${r.submitter_minecraft_username || '—'} (${r.submitter_email || 'no email'})`], ['Received', fmt(r.created_at)]
                ]
            });
        }));
    }

    const WANTED_FIELDS = [
        { key: 'name', label: 'Name / IGN', required: true, maxlength: 100 },
        { key: 'alias', label: 'Known aliases', maxlength: 200 },
        { key: 'offense', label: 'Offense', required: true, maxlength: 500 },
        { key: 'threat_level', label: 'Threat level', type: 'select', options: THREAT, default: 'moderate' },
        { key: 'bounty', label: 'Bounty', maxlength: 100, help: 'e.g. 250 Brass' },
        { key: 'last_seen', label: 'Last seen', maxlength: 200 },
        { key: 'status_note', label: 'Status line', maxlength: 200, help: 'Short line on the public card, e.g. ARMED WITH REINFORCED WRENCH' },
        { key: 'summary', label: 'Investigation summary', type: 'textarea', maxlength: 5000 },
        { key: 'modus_operandi', label: 'Modus operandi', type: 'textarea', maxlength: 5000 },
        { key: 'field_instructions', label: 'Citizen directives', type: 'textarea', maxlength: 5000 },
        { key: 'status', label: 'Status', type: 'select', options: WANTED_STATUS, default: 'wanted' },
        { key: 'is_public', label: 'Show on the public FBIS page', type: 'checkbox', default: true }
    ];

    async function renderWanted() {
        const { data, error } = await db.from('fbis_wanted').select('*').order('created_at', { ascending: false });
        if (error) throw error;
        const byId = Object.fromEntries(data.map((r) => [r.id, r]));

        content().innerHTML = `
            ${sectionHeader('FBIS · Most Wanted', 'Entries marked public appear on the FBIS page while their status is Wanted.',
                `<button type="button" data-add class="px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider bg-amber-600 hover:bg-amber-500 text-white">Add fugitive</button>`)}
            ${subTabs('fbis', [['tips', 'Tips'], ['wanted', 'Most Wanted']], 'wanted')}
            ${table(['Case', 'Name', 'Threat', 'Bounty', 'Status', 'Public'],
                data.map((r) => ({
                    id: r.id,
                    cells: [`<span class="font-mono text-xs">${esc(r.wanted_number)}</span>`, esc(r.name), esc(THREAT[r.threat_level]),
                        esc(r.bounty || '—'), badge(r.status, WANTED_STATUS), r.is_public ? 'Yes' : 'No']
                })), 'No Most Wanted entries.')}`;
        bindSubTabs('fbis', renderFbis);
        content().querySelector('[data-add]').addEventListener('click', () => editRecord('fbis_wanted', 'Add fugitive', WANTED_FIELDS, null));
        content().querySelectorAll('[data-row]').forEach((tr) => tr.addEventListener('click', () => {
            const r = byId[tr.dataset.row];
            editRecord('fbis_wanted', `Edit ${r.wanted_number}`, WANTED_FIELDS, r);
        }));
    }

    function editRecord(tableName, title, fields, record) {
        const del = record
            ? `<button type="button" data-delete class="mr-auto px-4 py-2 bg-red-900 hover:bg-red-800 text-red-100 rounded text-xs font-semibold">Delete</button>`
            : '';
        openModal(title, `<div class="grid grid-cols-1 gap-4">${formFields(fields, record || {})}</div>`, footer(record ? 'Save changes' : 'Create', del));

        document.querySelector('#portalModal [data-save]').addEventListener('click', (e) => saveWithButton(e.currentTarget, async () => {
            const values = readFields(fields);
            const { error } = record
                ? await db.from(tableName).update(values).eq('id', record.id)
                : await db.from(tableName).insert(values);
            if (error) throw error;
        }));

        const delBtn = document.querySelector('#portalModal [data-delete]');
        if (delBtn) {
            delBtn.addEventListener('click', (e) => {
                if (!confirm(`Permanently delete "${record.name}"? This cannot be undone.`)) return;
                saveWithButton(e.currentTarget, async () => {
                    const { error } = await db.from(tableName).delete().eq('id', record.id);
                    if (error) throw error;
                });
            });
        }
    }

    // --------------------------------------------------------------------------
    // FBOC
    // --------------------------------------------------------------------------
    let fbocSub = 'incidents';
    let incidentStatusFilter = 'new';
    let requestStatusFilter = 'pending';

    async function renderFboc(sub = fbocSub) {
        fbocSub = sub;
        if (sub === 'incidents') return renderIncidents();
        if (sub === 'inmates') return renderInmates();
        return renderRequests();
    }

    const FBOC_SUBTABS = [['incidents', 'Incidents'], ['inmates', 'Inmates'], ['requests', 'Requests']];

    async function renderIncidents() {
        let q = db.from('fboc_incidents').select('*').order('created_at', { ascending: false }).limit(200);
        if (incidentStatusFilter) q = q.eq('status', incidentStatusFilter);
        const { data, error } = await q;
        if (error) throw error;
        const byId = Object.fromEntries(data.map((r) => [r.id, r]));

        content().innerHTML = `
            ${sectionHeader('FBOC · Incident Reports', 'Escapes, custody breaches and contraband reported by citizens.', statusFilter('incFilter', INCIDENT_STATUS, incidentStatusFilter))}
            ${subTabs('fboc', FBOC_SUBTABS, 'incidents')}
            ${table(['Reference', 'Category', 'Involved', 'From', 'Status', 'Received'],
                data.map((r) => ({
                    id: r.id,
                    cells: [`<span class="font-mono text-xs">${esc(r.reference_number)}</span>`,
                        r.category === 'escape' ? `<span class="text-red-300 font-semibold">${esc(INCIDENT_CATEGORY.escape)}</span>` : esc(INCIDENT_CATEGORY[r.category] || r.category),
                        esc(r.subject_name || '—'), submitter(r), badge(r.status, INCIDENT_STATUS), esc(fmt(r.created_at))]
                })), incidentStatusFilter ? 'No incidents with this status.' : 'No incident reports yet.')}`;
        bindSubTabs('fboc', renderFboc);
        document.getElementById('incFilter').addEventListener('change', (e) => { incidentStatusFilter = e.target.value; renderIncidents(); });

        content().querySelectorAll('[data-row]').forEach((tr) => tr.addEventListener('click', () => {
            const r = byId[tr.dataset.row];
            reviewModal({
                title: `Incident ${r.reference_number}`, record: r, table: 'fboc_incidents', statusMap: INCIDENT_STATUS,
                notesKey: 'staff_notes', notesLabel: 'Internal notes (staff only)',
                details: [
                    ['Category', INCIDENT_CATEGORY[r.category] || r.category], ['Involved', r.subject_name], ['Location', r.location],
                    ['Details', r.details], ['From', `${r.submitter_minecraft_username || '—'} (${r.submitter_email || 'no email'})`],
                    ['Received', fmt(r.created_at)]
                ]
            });
        }));
    }

    const INMATE_FIELDS = [
        { key: 'name', label: 'Name / IGN', required: true, maxlength: 100 },
        { key: 'alias', label: 'Alias', maxlength: 200 },
        { key: 'minecraft_uuid', label: 'Minecraft UUID', maxlength: 36, help: 'Optional. Format: 069a79f4-44e9-4726-a5be-fca90e38aaf5' },
        { key: 'offense', label: 'Convicted offenses', type: 'textarea', required: true, maxlength: 1000 },
        { key: 'sentence', label: 'Sentence', maxlength: 500 },
        { key: 'facility', label: 'Facility', type: 'select', options: FACILITY, default: 'redoubt' },
        { key: 'security_level', label: 'Security level', type: 'select', options: SECURITY, default: 'medium' },
        { key: 'custody_status', label: 'Custody status', type: 'select', options: CUSTODY, default: 'incarcerated' },
        { key: 'intake_date', label: 'Intake date', maxlength: 100, help: 'e.g. Season 3.1 - Week 2' },
        { key: 'parole_status', label: 'Parole / release hearing', maxlength: 200 },
        { key: 'behavior_log', label: 'Guard behavioral log', type: 'textarea', maxlength: 5000 },
        { key: 'is_public', label: 'Show on the public FBOC roster', type: 'checkbox', default: true }
    ];

    async function renderInmates() {
        const { data, error } = await db.from('fboc_inmates').select('*').order('created_at', { ascending: false });
        if (error) throw error;
        const byId = Object.fromEntries(data.map((r) => [r.id, r]));

        content().innerHTML = `
            ${sectionHeader('FBOC · Inmate Roster', 'Public inmates appear on the FBOC page unless released or transferred. Mark escapes here.',
                `<button type="button" data-add class="px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider bg-amber-600 hover:bg-amber-500 text-white">Book inmate</button>`)}
            ${subTabs('fboc', FBOC_SUBTABS, 'inmates')}
            ${table(['Inmate #', 'Name', 'Facility', 'Security', 'Custody', 'Public'],
                data.map((r) => ({
                    id: r.id,
                    cells: [`<span class="font-mono text-xs">${esc(r.inmate_number)}</span>`, esc(r.name), esc(FACILITY[r.facility] || r.facility),
                        esc(SECURITY[r.security_level]), badge(r.custody_status, CUSTODY), r.is_public ? 'Yes' : 'No']
                })), 'No inmates on record.')}`;
        bindSubTabs('fboc', renderFboc);
        content().querySelector('[data-add]').addEventListener('click', () => editRecord('fboc_inmates', 'Book inmate', INMATE_FIELDS, null));
        content().querySelectorAll('[data-row]').forEach((tr) => tr.addEventListener('click', () => {
            const r = byId[tr.dataset.row];
            editRecord('fboc_inmates', `Edit #${r.inmate_number}`, INMATE_FIELDS, r);
        }));
    }

    async function renderRequests() {
        let q = db.from('fboc_requests').select('*').order('created_at', { ascending: false }).limit(200);
        if (requestStatusFilter) q = q.eq('status', requestStatusFilter);
        const { data, error } = await q;
        if (error) throw error;
        const byId = Object.fromEntries(data.map((r) => [r.id, r]));

        content().innerHTML = `
            ${sectionHeader('FBOC · Requests', 'Visitation, commissary and parole requests. Your response is shown to the requester.', statusFilter('reqFilter', REQUEST_STATUS, requestStatusFilter))}
            ${subTabs('fboc', FBOC_SUBTABS, 'requests')}
            ${table(['Reference', 'Type', 'Inmate', 'Requested by', 'Status', 'Received'],
                data.map((r) => ({
                    id: r.id,
                    cells: [`<span class="font-mono text-xs">${esc(r.reference_number)}</span>`, esc(REQUEST_TYPE[r.request_type]),
                        esc(r.inmate_label || '—'), submitter(r), badge(r.status, REQUEST_STATUS), esc(fmt(r.created_at))]
                })), requestStatusFilter ? 'No requests with this status.' : 'No requests yet.')}`;
        bindSubTabs('fboc', renderFboc);
        document.getElementById('reqFilter').addEventListener('change', (e) => { requestStatusFilter = e.target.value; renderRequests(); });

        content().querySelectorAll('[data-row]').forEach((tr) => tr.addEventListener('click', () => {
            const r = byId[tr.dataset.row];
            reviewModal({
                title: `${REQUEST_TYPE[r.request_type]} request ${r.reference_number}`, record: r, table: 'fboc_requests', statusMap: REQUEST_STATUS,
                notesKey: 'staff_response', notesLabel: 'Response to requester',
                details: [
                    ['Type', REQUEST_TYPE[r.request_type]], ['Inmate', r.inmate_label], ['Timeslot', r.timeslot],
                    ['Amount', r.amount ? `${r.amount} Brass Ingots` : null], ['Details', r.details],
                    ['Requested by', `${r.requester_minecraft_username || '—'} (${r.requester_email || 'no email'})`], ['Received', fmt(r.created_at)]
                ]
            });
        }));
    }

    // --------------------------------------------------------------------------
    // Administration (admin + president)
    // --------------------------------------------------------------------------
    let adminSub = 'users';
    let userSearch = '';
    let userRoleFilter = 'all';
    let userPage = 0;
    const USERS_PAGE_SIZE = 50;

    async function renderAdmin(sub = adminSub) {
        adminSub = sub;
        if (sub === 'users') return renderUsers();
        return renderAudit();
    }

    // Roles an admin can hand out; admin/president changes are President-only
    function assignableRoles(targetRole) {
        const all = Object.keys(CPB.ROLE_LABELS);
        if (CPB.access.president()) return all;
        if (['admin', 'president'].includes(targetRole)) return [];
        return all.filter((r) => !['admin', 'president'].includes(r));
    }

    async function renderUsers() {
        let q = db.from('profiles')
            .select('id, email, full_name, minecraft_username, verification_status, role, created_at', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(userPage * USERS_PAGE_SIZE, (userPage + 1) * USERS_PAGE_SIZE - 1);
        // Strip characters that have meaning in PostgREST filter syntax
        const term = userSearch.replace(/[^\w@.\- ]/g, '').trim();
        if (term) q = q.or(`email.ilike.%${term}%,minecraft_username.ilike.%${term}%,full_name.ilike.%${term}%`);
        if (userRoleFilter !== 'all') q = q.eq('role', userRoleFilter);
        const { data, error, count: total } = await q;
        if (error) throw error;
        const rows = data || [];
        const pageCount = Math.max(1, Math.ceil((total || 0) / USERS_PAGE_SIZE));
        const first = total ? userPage * USERS_PAGE_SIZE + 1 : 0;
        const last = total ? Math.min((userPage + 1) * USERS_PAGE_SIZE, total) : 0;
        const safeRenderUsers = async () => {
            try {
                await renderUsers();
            } catch (err) {
                content().innerHTML = errorBox(err);
            }
        };

        const me = CPB.state.user.id;
        content().innerHTML = `
            ${sectionHeader('Administration · Users & Roles', CPB.access.president()
                ? 'As President you can appoint any role, including administrators.'
                : 'Administrators can assign staff roles. Only the President can appoint or remove administrators.',
                `<input id="userSearch" type="search" value="${esc(userSearch)}" placeholder="Search name, IGN or email" aria-label="Search users" class="bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-xs text-gray-200 w-56">
                 <select id="userRoleFilter" aria-label="Filter users by role" class="bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-xs text-gray-200">
                    <option value="all">All roles</option>${Object.entries(CPB.ROLE_LABELS).map(([value, label]) => `<option value="${esc(value)}" ${value === userRoleFilter ? 'selected' : ''}>${esc(label)}</option>`).join('')}
                 </select>
                 <button type="button" id="userSearchApply" class="px-3 py-1.5 bg-blue-700 hover:bg-blue-600 text-white rounded text-xs font-semibold">Search</button>
                 <button type="button" id="userSearchReset" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-gray-200 rounded text-xs font-semibold">Reset</button>
                 <button type="button" id="userRefresh" class="px-3 py-1.5 border border-slate-700 hover:bg-slate-800 text-gray-200 rounded text-xs font-semibold">Refresh</button>`)}
            ${subTabs('adm', [['users', 'Users & Roles'], ['audit', 'Audit Log']], 'users')}
            <div class="flex flex-wrap items-center justify-between gap-3 mb-3 text-xs text-gray-400">
                <span>Showing ${first}–${last} of ${total || 0} users · Page ${userPage + 1} of ${pageCount}</span>
                <div class="flex gap-2">
                    <button type="button" id="userPrev" ${userPage <= 0 ? 'disabled' : ''} class="px-3 py-1.5 rounded border border-slate-700 enabled:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed">Previous</button>
                    <button type="button" id="userNext" ${userPage + 1 >= pageCount ? 'disabled' : ''} class="px-3 py-1.5 rounded border border-slate-700 enabled:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed">Next</button>
                </div>
            </div>
            ${table(['User', 'Minecraft', 'Role', 'Joined', ''],
                rows.map((u) => {
                    const choices = u.id === me ? [] : assignableRoles(u.role);
                    const control = choices.length
                        ? `<div class="flex gap-2 items-center">
                               <select data-role-for="${esc(u.id)}" class="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white">
                                   ${choices.map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${esc(CPB.ROLE_LABELS[r])}</option>`).join('')}
                               </select>
                               <button type="button" data-set-role="${esc(u.id)}" class="px-2 py-1 bg-amber-600 hover:bg-amber-500 text-white rounded text-[11px] font-bold">Save</button>
                           </div>`
                        : `<span class="text-xs text-gray-500">${u.id === me ? 'You' : 'President only'}</span>`;
                    return {
                        cells: [
                            `<div class="font-semibold">${esc(u.full_name || '—')}</div><div class="text-xs text-gray-400">${esc(u.email || '')}</div>
                             <div class="text-[10px] text-gray-600 font-mono select-all">${esc(u.id)}</div>`,
                            `${esc(u.minecraft_username || '—')} ${u.verification_status === 'verified' ? '<span class="text-emerald-400 text-xs" title="Verified">✓</span>' : ''}`,
                            esc(CPB.ROLE_LABELS[u.role] || u.role),
                            esc(fmt(u.created_at)),
                            control
                        ]
                    };
                }), term || userRoleFilter !== 'all' ? 'No users match these filters.' : 'No users yet.')}`;
        bindSubTabs('adm', renderAdmin);

        const search = document.getElementById('userSearch');
        const applySearch = () => { userSearch = search.value; userPage = 0; safeRenderUsers(); };
        document.getElementById('userSearchApply').addEventListener('click', applySearch);
        search.addEventListener('keydown', (e) => { if (e.key === 'Enter') applySearch(); });
        document.getElementById('userRoleFilter').addEventListener('change', (e) => { userRoleFilter = e.target.value; userPage = 0; safeRenderUsers(); });
        document.getElementById('userSearchReset').addEventListener('click', () => { userSearch = ''; userRoleFilter = 'all'; userPage = 0; safeRenderUsers(); });
        document.getElementById('userRefresh').addEventListener('click', safeRenderUsers);
        document.getElementById('userPrev').addEventListener('click', () => { if (userPage > 0) { userPage--; safeRenderUsers(); } });
        document.getElementById('userNext').addEventListener('click', () => { if (userPage + 1 < pageCount) { userPage++; safeRenderUsers(); } });

        content().querySelectorAll('[data-set-role]').forEach((btn) => btn.addEventListener('click', async () => {
            const userId = btn.dataset.setRole;
            const newRole = content().querySelector(`[data-role-for="${CSS.escape(userId)}"]`).value;
            if (!confirm(`Change this user's role to ${CPB.ROLE_LABELS[newRole]}?`)) return;
            btn.disabled = true;
            btn.textContent = 'Saving…';
            try {
                const { error } = await db.rpc('admin_set_user_role', { p_target_user_id: userId, p_new_role: newRole });
                if (error) throw error;
                await renderUsers();
            } catch (err) {
                btn.disabled = false;
                btn.textContent = 'Save';
                alert(`Could not update the role: ${err.message || err}`);
            }
        }));
    }

    async function renderAudit() {
        const { data, error } = await db.from('audit_log').select('*').order('created_at', { ascending: false }).limit(200);
        if (error) throw error;

        const describe = (r) => {
            const d = r.details || {};
            if (r.action === 'set_role') return `Role changed from ${CPB.ROLE_LABELS[d.from] || d.from} to ${CPB.ROLE_LABELS[d.to] || d.to}`;
            const what = r.target_type === 'fboc_inmates' ? 'Inmate' : r.target_type === 'fbis_wanted' ? 'Most Wanted entry' : r.target_type;
            return `${what} ${d.name ? `"${d.name}"` : ''} ${r.action}d${d.status ? ` (${d.status})` : ''}`;
        };

        content().innerHTML = `
            ${sectionHeader('Administration · Audit Log', 'Role changes and every change to the inmate roster and Most Wanted list.')}
            ${subTabs('adm', [['users', 'Users & Roles'], ['audit', 'Audit Log']], 'audit')}
            ${table(['When', 'By', 'Action', 'Target'],
                data.map((r) => ({
                    cells: [esc(fmt(r.created_at)), esc(r.actor_name || 'System'), esc(describe(r)),
                        `<span class="font-mono text-[10px] text-gray-500 select-all">${esc(r.target_id || '')}</span>`]
                })), 'No administrative actions recorded yet.')}`;
        bindSubTabs('adm', renderAdmin);
    }

    // --------------------------------------------------------------------------
    // Start
    // --------------------------------------------------------------------------
    document.getElementById('portalModal').addEventListener('click', (e) => {
        if (e.target.id === 'portalModal') closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });

    CPB.onChange(boot);
    boot();
})();
