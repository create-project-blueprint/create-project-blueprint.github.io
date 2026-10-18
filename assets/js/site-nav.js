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

    const theme = document.createElement('link');
    theme.rel = 'stylesheet';
    theme.href = new URL('assets/css/site-theme.css', root).href;
    document.head.append(theme);

    const nav = document.createElement('nav');
    nav.className = 'cpb-site-nav';
    nav.dataset.cpbSiteNav = '';
    nav.setAttribute('aria-label', 'Website pages');
    const inner = document.createElement('div');
    inner.className = 'cpb-site-nav__inner';
    const brand = document.createElement('a');
    brand.className = 'cpb-site-nav__brand';
    brand.href = new URL('index.html', root).href;
    brand.innerHTML = 'Create: Project Blueprint<small>Community • Seasons • Services</small>';
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

    const legacyHeader = document.querySelector('body > header.bg-white, body > header.header');
    if (legacyHeader) legacyHeader.remove();

    const header = document.querySelector('body > header');
    if (header) header.insertAdjacentElement('afterend', nav);
    else document.body.prepend(nav);

    const footer = document.createElement('footer');
    footer.className = 'cpb-footer';
    footer.innerHTML = `
        <div class="cpb-footer__inner">
            <div class="cpb-footer__grid">
                <div>
                    <a class="cpb-footer__brand" href="${new URL('index.html', root).href}">Create: Project Blueprint</a>
                    <p class="cpb-footer__copy">A community built around Create, shared worlds, and the people who bring them to life. Explore the project, its history, and the services that keep it moving.</p>
                </div>
                <div><h2 class="cpb-footer__heading">Explore</h2><div class="cpb-footer__links">
                    <a href="${new URL('history.html', root).href}">Project history</a>
                    <a href="${new URL('whens3.1.html', root).href}">Season 3.1</a>
                    <a href="${new URL('mainland.html', root).href}">The Mainland</a>
                </div></div>
                <div><h2 class="cpb-footer__heading">Community</h2><div class="cpb-footer__links">
                    <a href="${new URL('co/', root).href}">Companies</a>
                    <a href="${new URL('partners/', root).href}">Partners</a>
                    <a href="${new URL('support/#contact', root).href}">Get support</a>
                </div></div>
                <div><h2 class="cpb-footer__heading">Project</h2><div class="cpb-footer__links">
                    <a href="${new URL('government.html', root).href}">Governance</a>
                    <a href="${new URL('server-security/', root).href}">Security &amp; Justice</a>
                    <a href="${new URL('server-security/portal/', root).href}">Staff portal · sign-in required</a>
                </div></div>
            </div>
            <div class="cpb-footer__bottom">
                <span>© ${new Date().getFullYear()} Create: Project Blueprint · A community project with roots in CTBE.</span>
                <span><a href="${new URL('LEGAL.md', root).href}">Legal</a> · <a href="${new URL('SECURITY.md', root).href}">Security</a> · <a href="${new URL('LICENSE.md', root).href}">License</a> · <a href="${new URL('status.json', root).href}">Status</a></span>
            </div>
        </div>`;
    const oldFooter = document.querySelector('body > footer');
    if (oldFooter) oldFooter.replaceWith(footer);
    else document.body.append(footer);
})();
