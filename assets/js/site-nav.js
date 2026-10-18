(function () {
    'use strict';

    const script = document.currentScript;
    if (!script || document.querySelector('[data-cpb-site-nav]')) return;

    const root = new URL('../../', script.src);
    const routes = [
        ['Home', 'index.html'],
        ['Government', 'government.html'],
        ['History', 'history.html'],
        ['Season 3.1', 'whens3.1.html'],
        ['Mainland', 'mainland.html'],
        ['Companies', 'co/'],
        ['Partners', 'partners/'],
        ['Security & Justice', 'server-security/'],
        ['Support', 'support/'],
        ['Staff portal · sign-in required', 'server-security/portal/']
    ];

    const style = document.createElement('style');
    style.textContent = `
        .cpb-site-nav{position:relative;z-index:30;width:100%;align-self:stretch;background:#111827;color:#e5e7eb;border-bottom:1px solid #374151;font:500 13px/1.4 Inter,system-ui,sans-serif}
        .cpb-site-nav__inner{max-width:1280px;margin:auto;padding:9px 16px;display:flex;align-items:center;gap:12px}
        .cpb-site-nav__brand{color:#fff;font-weight:800;white-space:nowrap;text-decoration:none;letter-spacing:.02em}
        .cpb-site-nav__links{display:flex;align-items:center;gap:4px;overflow-x:auto;scrollbar-width:thin;flex:1}
        .cpb-site-nav a{color:#d1d5db;text-decoration:none;white-space:nowrap;padding:6px 9px;border-radius:6px}
        .cpb-site-nav a:hover,.cpb-site-nav a:focus-visible{background:#1f2937;color:#fff;outline:none}
        .cpb-site-nav a[aria-current=page]{color:#bfdbfe;background:#1e3a8a}
        .cpb-site-nav__staff{border:1px solid #92400e;color:#fde68a!important}
        @media(max-width:640px){.cpb-site-nav__inner{align-items:flex-start;flex-direction:column;gap:5px}.cpb-site-nav__links{width:100%}}
    `;
    document.head.append(style);

    const nav = document.createElement('nav');
    nav.className = 'cpb-site-nav';
    nav.dataset.cpbSiteNav = '';
    nav.setAttribute('aria-label', 'Website pages');
    const inner = document.createElement('div');
    inner.className = 'cpb-site-nav__inner';
    const brand = document.createElement('a');
    brand.className = 'cpb-site-nav__brand';
    brand.href = new URL('index.html', root).href;
    brand.textContent = 'CTBE · CPB';
    inner.append(brand);

    const links = document.createElement('div');
    links.className = 'cpb-site-nav__links';
    const currentPath = window.location.pathname.replace(/\/+$/, '') || '/';
    for (const [label, path] of routes) {
        const link = document.createElement('a');
        link.href = new URL(path, root).href;
        link.textContent = label;
        if (path.includes('portal')) link.classList.add('cpb-site-nav__staff');
        if (new URL(link.href).pathname.replace(/\/+$/, '') === currentPath) {
            link.setAttribute('aria-current', 'page');
        }
        links.append(link);
    }
    inner.append(links);
    nav.append(inner);

    const header = document.querySelector('body > header');
    if (header) header.insertAdjacentElement('afterend', nav);
    else document.body.prepend(nav);
})();
