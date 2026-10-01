// Поиск (SEO): чтобы сайт лиги находился в Google и красиво выглядел в выдаче
// и в превью мессенджеров.
//
// Что здесь делается:
//  • у каждой страницы свой адрес, заголовок и описание (на английском и русском);
//  • canonical и hreflang — Google понимает, какой адрес главный и что есть
//    русская версия (тот же адрес с ?lang=ru);
//  • структурированные данные (schema.org): организация, сайт, вопросы-ответы,
//    события, профиль игрока — из них Google строит «богатые» сниппеты;
//  • серверный текст страницы (#ssr): короткое содержание и ссылки на игроков
//    и дивизионы прямо в HTML. Робот видит их сразу, не дожидаясь скриптов;
//    у человека этот блок исчезает, как только загрузился интерфейс;
//  • robots.txt и sitemap.xml — список всех страниц для поисковиков.
//
// Модуль ничего не читает сам: данные ему отдаёт index.js. Так его легко
// проверять и нечему падать.
export const SEO_PAGES = {
  home: { path: '/',
    en: ['Phuket Tennis Family — Amateur Tennis League in Phuket', 'Amateur tennis league in Phuket: 2-month seasons, level-based divisions, live standings, playoffs, a Yearly Race and tennis events. Join with Telegram.'],
    ru: ['Phuket Tennis Family — любительская теннисная лига на Пхукете', 'Любительская теннисная лига на Пхукете: сезоны по 2 месяца, дивизионы по уровню, живые таблицы, плей-офф, годовая гонка и теннисные события. Вступайте через Telegram.'] },
  about: { path: '/about',
    en: ['About the league — Phuket Tennis Family', 'How the Phuket Tennis Family amateur tennis league works: seasons, divisions by level, playoffs, live finals and awards dinner, Yearly Race and Grand Final. How to join.'],
    ru: ['О лиге — Phuket Tennis Family', 'Как устроена любительская теннисная лига Phuket Tennis Family: сезоны, дивизионы по уровню, плей-офф, живые финалы и ужин с награждением, годовая гонка и Grand Final. Как вступить.'] },
  div: { path: '/divisions',
    en: ['Division standings — Phuket Tennis Family', 'Live standings of every division of the Phuket tennis league: points, wins, sets and games, playoff bracket and champions.'],
    ru: ['Таблицы дивизионов — Phuket Tennis Family', 'Живые таблицы всех дивизионов теннисной лиги Пхукета: очки, победы, сеты и геймы, сетка плей-офф и чемпионы.'] },
  race: { path: '/race',
    en: ['Yearly Race — Phuket Tennis Family', 'The annual ranking of Phuket Tennis Family players: Year Ranking Points from every season and qualification for the Grand Final.'],
    ru: ['Годовая гонка — Phuket Tennis Family', 'Годовой рейтинг игроков Phuket Tennis Family: очки YRP за каждый сезон и отбор на Grand Final.'] },
  players: { path: '/players',
    en: ['Players — Phuket Tennis Family', 'All players of the Phuket amateur tennis league: divisions, level, matches, wins and results.'],
    ru: ['Игроки — Phuket Tennis Family', 'Все игроки любительской теннисной лиги Пхукета: дивизионы, уровень, матчи, победы и результаты.'] },
  matches: { path: '/matches',
    en: ['Matches and results — Phuket Tennis Family', 'Upcoming league matches and the latest results of the Phuket tennis league.'],
    ru: ['Матчи и результаты — Phuket Tennis Family', 'Ближайшие матчи лиги и свежие результаты теннисной лиги Пхукета.'] },
  events: { path: '/events',
    en: ['Tennis events in Phuket — Phuket Tennis Family', 'Tennis events, meet-ups and tournaments of Phuket Tennis Family: dates, venues and registration.'],
    ru: ['Теннисные события на Пхукете — Phuket Tennis Family', 'Теннисные события, встречи и турниры Phuket Tennis Family: даты, площадки и запись.'] },
  tournaments: { path: '/tournaments',
    en: ['Seasons and tournaments — Phuket Tennis Family', 'League seasons of Phuket Tennis Family: the current season, the next-season waitlist and past champions.'],
    ru: ['Сезоны и турниры — Phuket Tennis Family', 'Сезоны лиги Phuket Tennis Family: идущий сезон, лист ожидания следующего и чемпионы прошлых сезонов.'] },
  partners: { path: '/partners',
    en: ['League partners — Phuket Tennis Family', 'Partners of the Phuket Tennis Family league: courts, recovery, hotels and places we love in Phuket.'],
    ru: ['Партнёры лиги — Phuket Tennis Family', 'Партнёры лиги Phuket Tennis Family: корты, восстановление, отели и любимые места на Пхукете.'] }
};

const esc = (v = '') => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const txt = v => String(v ?? '').trim();
export const seoLang = (req) => (String(req?.query?.lang || '').toLowerCase() === 'ru' ? 'ru' : 'en');
export const slugOf = (name = '') => String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
export const divLabel = (d = '') => {
  const k = String(d).replace(/^(division|дивизион)\s*/i, '').trim().toUpperCase();
  if (k === 'PRIME' || k === 'P') return 'Prime';
  if (['W', 'WOMAN', 'WOMEN'].includes(k)) return 'Division W';
  return k ? `Division ${k}` : '';
};
const divLetter = (d = '') => {
  const k = String(d).replace(/^(division|дивизион)\s*/i, '').trim().toUpperCase();
  return k === 'P' ? 'PRIME' : (['WOMAN', 'WOMEN'].includes(k) ? 'W' : k);
};

// Организация — на каждой странице: так Google связывает сайт, логотип,
// Instagram и бота в одну «карточку» лиги.
export function organizationLd(site, { instagram = '', telegram = '' } = {}) {
  return {
    '@context': 'https://schema.org', '@type': 'SportsOrganization',
    '@id': `${site}/#org`, name: 'Phuket Tennis Family', alternateName: 'PTF',
    url: `${site}/`, logo: `${site}/public/img/icon-512.png`, image: `${site}/public/img/og.png`,
    sport: 'Tennis', description: SEO_PAGES.home.en[1],
    areaServed: { '@type': 'City', name: 'Phuket' },
    address: { '@type': 'PostalAddress', addressLocality: 'Phuket', addressCountry: 'TH' },
    sameAs: [instagram, telegram].filter(Boolean)
  };
}
export function websiteLd(site) {
  return { '@context': 'https://schema.org', '@type': 'WebSite', '@id': `${site}/#site`, url: `${site}/`,
    name: 'Phuket Tennis Family', inLanguage: ['en', 'ru'], publisher: { '@id': `${site}/#org` } };
}
export function faqLd(list = []) {
  return { '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: list.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) };
}
export function personLd(site, p) {
  return { '@context': 'https://schema.org', '@type': 'ProfilePage',
    mainEntity: { '@type': 'Person', name: p.name, url: `${site}/p/${slugOf(p.name)}`,
      image: p.image || undefined, memberOf: { '@id': `${site}/#org` },
      description: p.description || undefined } };
}
// События с настоящей датой — SportsEvent. Без даты (например, «ноябрь—декабрь»)
// в разметку не идут: Google такие отбрасывает с ошибкой.
export function eventsLd(site, events = []) {
  return events.filter(e => e.start && !Number.isNaN(new Date(e.start).getTime())).map(e => ({
    '@context': 'https://schema.org', '@type': 'SportsEvent', name: e.name, sport: 'Tennis',
    startDate: new Date(e.start).toISOString(), endDate: e.end && !Number.isNaN(new Date(e.end).getTime()) ? new Date(e.end).toISOString() : undefined,
    eventStatus: 'https://schema.org/EventScheduled', eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: { '@type': 'Place', name: e.place || 'Phuket', address: { '@type': 'PostalAddress', addressLocality: 'Phuket', addressCountry: 'TH' } },
    organizer: { '@id': `${site}/#org` }, url: `${site}${e.path || '/events'}`, description: e.description || undefined
  }));
}

// Серверный текст страницы: заголовок, пара предложений и ссылки. Для робота
// это полноценная страница, человеку он виден секунду до загрузки интерфейса.
export function ssrHtml({ page, lang = 'en', site, data = {} }) {
  const ru = lang === 'ru';
  const P = SEO_PAGES[page] || SEO_PAGES.home;
  const [title, desc] = ru ? P.ru : P.en;
  const q = ru ? '?lang=ru' : '';
  const nav = ['home', 'div', 'race', 'players', 'matches', 'events', 'tournaments', 'partners', 'about'].map(k => {
    const t = (ru ? SEO_PAGES[k].ru : SEO_PAGES[k].en)[0].split(' — ')[0];
    return `<a href="${SEO_PAGES[k].path}${q}">${esc(k === 'home' ? (ru ? 'Главная' : 'Home') : t)}</a>`;
  }).join(' · ');
  let body = '';
  const players = data.players || [];
  if (data.player) {
    const p = data.player;
    body += `<h1>${esc(p.name)}</h1><p>${esc([divLabel(p.division), p.matches ? `${p.matches} ${ru ? 'матчей' : 'matches'}` : '', p.wins ? `${p.wins} ${ru ? 'побед' : 'wins'}` : ''].filter(Boolean).join(' · '))}</p>`
      + `<p>${esc(ru ? 'Игрок любительской теннисной лиги Phuket Tennis Family на Пхукете.' : 'Player of the Phuket Tennis Family amateur tennis league in Phuket.')}</p>`;
  } else if (data.division) {
    body += `<h1>${esc(divLabel(data.division))} — Phuket Tennis Family</h1><p>${esc(desc)}</p>`;
    const rows = data.table || [];
    if (rows.length) body += `<ol class="ssr-table">${rows.map(r => `<li><a href="/p/${esc(slugOf(r.name))}${q}">${esc(r.name)}</a> — ${esc(r.points ?? 0)} ${ru ? 'очк.' : 'pts'}, ${esc(r.wins ?? 0)}/${esc(r.matches ?? 0)}</li>`).join('')}</ol>`;
  } else {
    body += `<h1>${esc(title)}</h1><p>${esc(desc)}</p>`;
  }
  if ((page === 'home' || page === 'div') && (data.divisions || []).length) {
    body += `<details><summary>${ru ? 'Дивизионы' : 'Divisions'}</summary><ul>${data.divisions.map(d => `<li><a href="/d/${esc(divLetter(d))}${q}">${esc(divLabel(d))}</a></li>`).join('')}</ul></details>`;
  }
  if (page === 'race' && players.length) {
    const top = players.slice().sort((a, b) => Number(b.points || 0) - Number(a.points || 0)).slice(0, 30);
    body += `<details><summary>${ru ? 'Лидеры гонки' : 'Race leaders'}</summary><ol>${top.map(p => `<li><a href="/p/${esc(slugOf(p.name))}${q}">${esc(p.name)}</a> — ${esc(p.points || 0)} YRP</li>`).join('')}</ol></details>`;
  }
  if ((page === 'home' || page === 'players') && players.length) {
    body += `<details><summary>${ru ? 'Игроки лиги' : 'League players'} · ${players.length}</summary><ul>${players.map(p => `<li><a href="/p/${esc(slugOf(p.name))}${q}">${esc(p.name)}</a>${p.division ? ` — ${esc(divLabel(p.division))}` : ''}</li>`).join('')}</ul></details>`;
  }
  if ((page === 'events' || page === 'tournaments' || page === 'home') && (data.events || []).length) {
    body += `<details><summary>${ru ? 'События и сезоны' : 'Events and seasons'}</summary><ul>${data.events.map(e => `<li>${esc(e.name)}${e.when ? ` — ${esc(e.when)}` : ''}${e.place ? `, ${esc(e.place)}` : ''}</li>`).join('')}</ul></details>`;
  }
  return `<div id="ssr" class="ssr"><nav>${nav}</nav>${body}</div>`;
}

// Вставка всего нужного в готовую HTML-страницу.
export function applySeo(html, { site, path = '/', lang = 'en', title, description, image, ld = [], ssr = '', noindex = false, ruAvailable = true }) {
  const url = `${site}${path}`;
  const canonical = lang === 'ru' ? `${url}${url.includes('?') ? '&' : '?'}lang=ru` : url;
  const head = [
    `<link rel="canonical" href="${esc(canonical)}" />`,
    ruAvailable ? `<link rel="alternate" hreflang="en" href="${esc(url)}" />` : '',
    ruAvailable ? `<link rel="alternate" hreflang="ru" href="${esc(url)}${url.includes('?') ? '&amp;' : '?'}lang=ru" />` : '',
    ruAvailable ? `<link rel="alternate" hreflang="x-default" href="${esc(url)}" />` : '',
    `<meta property="og:site_name" content="Phuket Tennis Family" />`,
    `<meta property="og:locale" content="${lang === 'ru' ? 'ru_RU' : 'en_US'}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    `<meta name="twitter:image" content="${esc(image)}" />`,
    `<link rel="apple-touch-icon" href="/public/img/apple-touch-icon.png" />`,
    `<link rel="manifest" href="/site.webmanifest" />`,
    process.env.GOOGLE_SITE_VERIFICATION ? `<meta name="google-site-verification" content="${esc(process.env.GOOGLE_SITE_VERIFICATION)}" />` : '',
    process.env.BING_SITE_VERIFICATION ? `<meta name="msvalidate.01" content="${esc(process.env.BING_SITE_VERIFICATION)}" />` : '',
    noindex ? '<meta name="robots" content="noindex" />' : '<meta name="robots" content="index,follow,max-image-preview:large" />',
    ...ld.filter(Boolean).map(x => `<script type="application/ld+json">${JSON.stringify(x).replace(/</g, '\\u003c')}</script>`)
  ].filter(Boolean).join('\n');
  let out = html;
  const set = (re, tag) => { out = re.test(out) ? out.replace(re, tag) : out.replace('</head>', `${tag}\n</head>`); };
  set(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);
  set(/<meta name="description"[^>]*>/, `<meta name="description" content="${esc(description)}" />`);
  set(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${esc(title)}" />`);
  set(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${esc(description)}" />`);
  set(/<meta property="og:image"[^>]*>/, `<meta property="og:image" content="${esc(image)}" />`);
  set(/<meta property="og:url"[^>]*>/, `<meta property="og:url" content="${esc(canonical)}" />`);
  set(/<meta property="og:type"[^>]*>/, `<meta property="og:type" content="${path.startsWith('/p/') ? 'profile' : 'website'}" />`);
  out = out.replace(/<html lang="[^"]*"/, `<html lang="${lang}"`);
  out = out.replace('</head>', `${head}\n</head>`);
  if (ssr) out = out.includes('<!--SSR-->') ? out.replace('<!--SSR-->', ssr) : out;
  return out;
}

export function robotsTxt(site, isSite) {
  if (!isSite) return 'User-agent: *\nDisallow: /\n';
  return ['User-agent: *', 'Allow: /',
    'Disallow: /api/', 'Disallow: /auth/', 'Disallow: /admin', 'Disallow: /tournament-admin',
    'Disallow: /apply', 'Disallow: /fantasy', 'Disallow: /match$', 'Disallow: /match?', 'Disallow: /participants', 'Disallow: /cal',
    '', `Sitemap: ${site}/sitemap.xml`, ''].join('\n');
}
export function sitemapXml(site, { players = [], divisions = [], today = new Date().toISOString().slice(0, 10) } = {}) {
  const paths = [
    ...Object.values(SEO_PAGES).map(p => [p.path, p.path === '/' ? '1.0' : '0.8', 'daily']),
    ...divisions.map(d => [`/d/${divLetter(d)}`, '0.7', 'daily']),
    ...players.filter(p => txt(p.name)).map(p => [`/p/${slugOf(p.name)}`, '0.5', 'weekly'])
  ];
  const seen = new Set();
  const urls = paths.filter(([p]) => !seen.has(p) && seen.add(p)).map(([p, prio, freq]) => {
    const loc = `${site}${p}`;
    const ru = `${loc}${p.includes('?') ? '&amp;' : '?'}lang=ru`;
    return `<url><loc>${esc(loc)}</loc><lastmod>${today}</lastmod><changefreq>${freq}</changefreq><priority>${prio}</priority>`
      + `<xhtml:link rel="alternate" hreflang="en" href="${esc(loc)}"/><xhtml:link rel="alternate" hreflang="ru" href="${ru}"/></url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`;
}
export function webManifest() {
  return {
    name: 'Phuket Tennis Family', short_name: 'PTF League', start_url: '/', display: 'standalone',
    background_color: '#0A0A0B', theme_color: '#0A0A0B', lang: 'en',
    description: SEO_PAGES.home.en[1],
    icons: [{ src: '/public/img/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/public/img/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }]
  };
}

// Текст лендинга для поисковика: то же, что видит человек, но прямо в HTML.
export function aboutSsr(lang = 'en', faq = []) {
  const ru = lang === 'ru';
  const P = ru ? {
    h1: 'Phuket Tennis Family — любительская теннисная лига на Пхукете',
    p: ['Играйте регулярно с соперниками своего уровня: сезоны по 2 месяца, 7 матчей, дивизионы по 8 игроков, собранные по уровню.',
        'Места 1–4 выходят в плей-офф; полуфиналы и финалы проходят вживую, после них — торжественный ужин и награждение. Очки сезона идут в годовую гонку и отбор на Grand Final.',
        'Кроме лиги — турниры, встречи и теннисные события. Вход и анкета — через Telegram, туда приходят анонсы и набор. Места в дивизионах ограничены.']
  } : {
    h1: 'Phuket Tennis Family — amateur tennis league in Phuket',
    p: ['Play regularly against opponents of your level: 2-month seasons, 7 matches, divisions of 8 players built by level.',
        'Places 1–4 reach the playoffs; semifinals and finals are played live, followed by an awards dinner. Season points count toward the Yearly Race and the Grand Final.',
        'Beyond the league — tournaments, meet-ups and tennis events. You join and fill in the profile through Telegram, where announcements and registration arrive. Places in divisions are limited.']
  };
  return `<div class="ssr"><h1>${esc(P.h1)}</h1>${P.p.map(x => `<p>${esc(x)}</p>`).join('')}`
    + `<h2>${ru ? 'Частые вопросы' : 'FAQ'}</h2>${faq.map(([q, a]) => `<h3>${esc(q)}</h3><p>${esc(a)}</p>`).join('')}`
    + `<p><a href="/${ru ? '?lang=ru' : ''}">${ru ? 'Открыть лигу' : 'Open the league'}</a> · <a href="/?join=1">${ru ? 'Вступить в лигу' : 'Join the league'}</a></p></div>`;
}
