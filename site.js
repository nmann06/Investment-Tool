(() => {
  const path = location.pathname.replace(/\/$/, '') || '/';
  const page = path === '/about' ? 'about' : path === '/portfolio' ? 'portfolio' : 'home';
  for (const name of ['home', 'about', 'portfolio']) {
    document.getElementById(`${name}-page`).hidden = name !== page;
  }
  document.querySelectorAll('[data-nav]').forEach((link) => {
    const active = link.dataset.nav === page;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
  });
  document.getElementById('footer-year').textContent = new Date().getFullYear();
  const titles = { home: 'Nathaniel Mann — Electrical engineering student', about: 'About Me — Nathaniel Mann', portfolio: 'Projects — Nathaniel Mann' };
  document.title = titles[page];
})();
