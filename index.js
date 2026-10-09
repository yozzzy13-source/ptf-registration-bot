import express from 'express';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { SITE_URL } from './config.js';
import { PORT, PUBLIC_URL, BOT_TOKEN, SPREADSHEET_ID, DEFAULT_USDT_AMOUNT, SHEETS, MATCH_DURATION_MIN, ADMIN_IDS, COURT_BOOKING_OPEN, TIMEZONE } from './config.js';
import { setWebhook, setCommands, sendMessage, getMe, sendPhotoBuffer, getFileBuffer, markChatAlive, deadChatsCount } from './telegram.js';
import { queueMatchAttention, handleMessage, handleCallback, sendPaymentStart, prepareAnnouncementForAdmin, rememberLang } from './bot.js';
import { onLeagueCacheInvalidated, warmSheetCache, getPartners, getPartnersPageTexts, getLeagueProfiles, getLeagueMatchHistory, getLeagueEvents, getLeagueAchievements, invalidateLeagueCache, getSetting, setSetting, getAllActiveLeaguePlayers, getPlayerLeagueInfo, getDivisionOpponents, getActiveEvents, getAllEvents, upsertApplicant, createApplication, createOrUpdateApplication, getPaymentMethods, getRows, findApplicantByTelegramIdentity, findApplicantByTelegramId, updateApplicantByTelegramId, setUserLanguage, updateObjectByRow, isProfileCompleted, enrichEventsWithStats, getEventPlayers, getManualParticipants, ensureAvatarColumns, ensureInstagramColumn, publishedAvatars, getMasterPhotos, withRatingSourceTag, ratingSourceOf, playerGroup, PLAYER_GROUPS, getGroupTabs, MINIAPP_TABS, healApplicantId } from './sheets.js';
import { parseInitData, verifyTelegramInitData, verifyWebAppToken, uid, nowISO, safe, escapeHtml } from './util.js';
import { reverseScore as reverseScoreSafe } from './tennis.js';
import { notifyNewApplication, notifyAvatarVariant, paymentAutoOn, notifyAdmin, getAdminChatId } from './admin.js';
import { registerAdminRoutes } from './adminPanel.js';
import { registerFantasyRoutes, fantasyAccessFor, getFantasyBootstrap } from './fantasy.js';
import { registerTournamentRoutes } from './tournamentsapi.js';
import { setPairBotUsername } from './pairflow.js';
import { takeMedia, refreshToken, instagramEnabled, IG_PROFILE_URL } from './instagram.js';
import { runWeeklyCarousel, runWeeklyPhotos } from './publicity.js';
import { sendBookingHelper, matchContact, publishOpenSlot, sendDirectChallenge, notifyMatchAgreed, setBotUsername,
  notifyProposal, notifyResultPrompt, notifyResultForVerification, notifyResultHalfConfirmed, notifyResultConfirmed, notifyCrossDivision, broadcastResult, notifyMatchUnfinished, sendCourtRequests,
  notifyMatchCancelled, notifyTimeChange, notifyMatchReminder, notifyDeadline,
  notifyStuckNegotiation, notifyNegotiationExpired, notifyStuckTimeChange, notifyTimeChangeExpired,
  notifyStuckResult, notifyResultStalled, notifyStuckCourt, notifyStuckScore, notifyScoreStalled, notifyCourtConfirmed, scheduleSlotCards } from './matches.js';
import { allSlots, pendingActionsFor, setMatchChangeHandler, setWindowChangeHandler, findSameResult, createSlot, findSlot, claimSlot, counterSlot, listOpenSlots, listMySlots, isSlotPast, listToCell, cellToList, getCourts,
  listResultTasks, listMatchesNeedingResultPrompt, markResultPromptSent, submitResult, submitResultByAdmin, confirmResult, confirmResultByAdmin, deleteMatchByAdmin, markMatchUnfinished, createManualMatch,
  proposeTimeChange, listMatchesNeedingReminder, markReminderSent, expireStaleSlots, findTimeConflict,
  listStuck, isStuckCurrent, markStuckNudge, closeStuckSlot, cancelMatchmaking, dropStuckTimeChange, agreedSchedule, courtUsage,
  courtsByPlayedMatch, courtKey, pendingAction, nightWindow, isNightHold, resultPromptDelayMin, confirmCourt, courtCloseAt } from './matchesdb.js';
import { validateMatchScore, formatScore, detectSet3Mode } from './tennis.js';
import { getUnplayedOpponents, writeConfirmedResult, describeWrite } from './results.js';
import { getDivisionTable, availableDivisions, getSeasons, invalidateDivisionCache, divisionTitles, divisionGroups } from './division.js';
import { enqueueAvatar, setAvatarHandler, AVATAR_STATUS, MAX_ATTEMPTS, avatarReady, queueLength } from './avatars.js';

import { uiError } from './ui-errors.js';
import { resumeBroadcasts, flushBroadcasts } from './broadcast.js';
import { startLogCleanup } from './retention.js';
import { webSessionMiddleware, registerWebAuthRoutes, setWebBotName, webBotName } from './webauth.js';
import { syncWaitlistEntry, syncAllWaitlists } from './waitlistsync.js';
import { withPriority, sheetsQueueStats } from './google.js';
import { SEO_PAGES, seoLang, slugOf as seoSlug, divLabel as seoDivLabel, organizationLd, websiteLd, faqLd, personLd, eventsLd, ssrHtml, applySeo, robotsTxt, sitemapXml, webManifest, aboutSsr } from './seo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Служебные коды: интерфейс показывает по ним свой экран, поэтому наружу они
// уходят как есть, без перевода в человеческий текст.
// Остальные коды по-прежнему переводятся; сам код всегда едет отдельным полем code.
const UI_CODES = new Set(['profile_required']);

const app = express();
// Сжатие: страница лиги ≈300 КБ превращается примерно в 60 КБ — на мобильном
// интернете это разница в секунды.
app.use(compression({ threshold: 1024 }));
// Сайт живёт на одном адресе — без www. Для Telegram phukettennis.com и
// www.phukettennis.com — два разных домена, а вход через Telegram привязан
// к одному. Поэтому www сразу перекидываем на основной адрес с тем же путём.
app.use((req, res, next) => {
  const host = String(req.headers?.host || '');
  if (!/^www\./i.test(host) || !['GET','HEAD'].includes(req.method)) return next();
  res.redirect(301, `https://${host.replace(/^www\./i, '')}${req.originalUrl || req.url || '/'}`);
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
// Сайт лиги: вошедший через Telegram в браузере получает те же права, что и в
// мини-приложении. Прослойка стоит до всех /api — дальше вход с сайта ничем не
// отличается от входа из Telegram.
app.use(webSessionMiddleware);
// Очередь к Google Таблицам (google.js): действие человека — POST в /api и
// кнопки/сообщения бота (/webhook) — идёт первым; открытие экранов — обычным
// порядком; фон (таймеры, рассылки, пересборка витрины) — последним.
app.use((req, res, next) => withPriority(req.method === 'POST' && (req.path.startsWith('/api/') || req.path === '/webhook') ? 'high' : 'normal', next));
// Картинки меняются редко — неделю из памяти телефона. Скрипты и стили — с
// проверкой «не изменилось?» (304), чтобы после выкладки сразу шли новые.
app.use('/public', express.static(path.join(__dirname, 'public'), { setHeaders: (res, file) => res.set('Cache-Control', /\.(png|jpe?g|webp|gif|svg|ico|woff2?)$/i.test(file) ? 'public, max-age=604800, stale-while-revalidate=2592000' : 'no-cache') }));
// Resolve the saved language before responding, including validation failures.
app.use('/api', async (req,res,next) => {
  let lang = 'en', source = 'default';
  try {
    const who = webAppUser(req.body?.initData || req.query.initData || '', req.body?.t || req.query.t || '');
    if (who.ok) {
      const profile = await findApplicantByTelegramIdentity(who.user);
      // Откуда взят язык — экрану важно: выбор из анкеты главнее выбора на
      // устройстве, а язык Telegram — только подсказка по умолчанию.
      if (['ru','en'].includes(profile?.language)) { lang = profile.language; source = 'profile'; }
      else { lang = String(who.user.language_code || '').startsWith('ru') ? 'ru' : 'en'; source = 'telegram'; }
    }
  } catch (e) { console.error('UI language:',e.message); }
  req.uiLang = lang;
  req.uiLangSource = source;
  const json = res.json.bind(res);
  res.json = body => {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      body = { ...body, lang:body.lang || lang, lang_source:body.lang_source || (body.lang && body.lang !== lang ? 'server' : source) };
      if (body.error) {
        console.error('API error:',req.path,body.error);
        // Коды, на которые интерфейс отвечает своим экраном, а не текстом ошибки,
        // переводить нельзя: перевод превращал их в общее «не удалось выполнить»,
        // и новый игрок вместо приглашения заполнить анкету упирался в тупик.
        body.code = body.error;
        if (!UI_CODES.has(body.error)) body.error = uiError(body.error,lang);
      }
      if (body.warning) body.warning = uiError(body.warning,lang);
    }
    return json(body);
  };
  next();
});
app.get('/api/ui-language', (req,res) => res.json({ok:true,lang:req.uiLang}));
// Переключатель RU/EN в мини-приложениях. Пишем язык в анкету, только если она
// уже есть: новую строку-лид из-за нажатия на кнопку создавать нельзя. У кого
// анкеты нет, выбор живёт на устройстве.
app.post('/api/ui-language', async (req,res) => {
  try {
    const lang = req.body?.lang === 'ru' ? 'ru' : (req.body?.lang === 'en' ? 'en' : '');
    if (!lang) return res.status(400).json({ ok:false, error:'lang_required' });
    const who = webAppUser(req.body?.initData || '', req.body?.t || '');
    if (!who.ok) return res.json({ ok:true, lang, saved:false });
    const profile = await findApplicantByTelegramIdentity(who.user);
    if (!profile) return res.json({ ok:true, lang, saved:false });
    if (profile.language !== lang) await setUserLanguage(who.user, lang);
    rememberLang(who.user.id, lang);
    res.json({ ok:true, lang, lang_source:'profile', saved:true });
  } catch (e) { console.error('ui-language save failed:', e.message); res.status(500).json({ ok:false, error:e.message }); }
});

// Страницы: телефон хранит копию, но каждый раз коротко спрашивает сервер
// «не изменилось?». Не изменилось — ответ 304 без тела, страница открывается
// из памяти телефона. Изменилось (новая выкладка) — приходит новая. Раньше
// стояло no-store, и каждый заход заново качал страницу целиком (≈300 КБ).
function noCache(res) { res.set('Cache-Control','no-cache'); }
// Главная сайта — тот же интерфейс лиги, что и в мини-приложении. Страница сама
// понимает, где её открыли: в Telegram или в обычном браузере.
app.get('/health', (req, res) => res.send('PTF Registration Bot is running'));
// Живая часть сайта: галерея из папки «PTF Gallery» и лента Instagram.
app.get('/api/public/gallery', async (req, res) => {
  try {
    const { getGallery } = await import('./gallery.js');
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ ok:true, ...(await getGallery()) });
  } catch (e) { res.json({ ok:true, albums:[] }); }
});
app.get('/gallery/:id.jpg', async (req, res) => {
  try {
    const { galleryImage } = await import('./gallery.js');
    const buf = await galleryImage(req.params.id, Number(req.query.w || 500));
    if (!buf) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=86400').type('image/jpeg').send(buf);
  } catch (e) { console.error('gallery image:', e.message); res.status(404).end(); }
});
app.get('/api/public/instagram', async (req, res) => {
  try {
    const { recentPosts, IG_PROFILE_URL, IG_ACCOUNT } = await import('./instagram.js');
    res.set('Cache-Control', 'public, max-age=600');
    res.json({ ok:true, account:IG_ACCOUNT, profile_url:IG_PROFILE_URL, posts: await recentPosts(6) });
  } catch (e) { res.json({ ok:true, posts:[] }); }
});
// ------------------------------------------------------------------ SEO
// Каждая публичная страница сайта отдаётся с заголовком, описанием, превью,
// структурированными данными и серверным текстом для поисковиков (см. seo.js).
// Адреса: / /about /divisions /race /players /matches /events /tournaments
// /partners, игрок /p/<имя>, дивизион /d/<буква>. Русская версия — ?lang=ru.
const pageCache = new Map();
async function pageHtml(file) {
  if (!pageCache.has(file)) pageCache.set(file, await fs.promises.readFile(path.join(__dirname, 'public', file), 'utf8'));
  return pageCache.get(file);
}
export const slugOf = seoSlug;
async function snapshotSoon(ms = 3500) {
  return Promise.race([getLeagueSnapshot(), new Promise(r => setTimeout(() => r(null), ms))]).catch(() => null);
}
function divisionLabelFor(d = '') { return seoDivLabel(d) || 'Division'; }
const siteHost = () => { try { return new URL(SITE_URL).host; } catch { return ''; } };
const socialLinks = () => ({ instagram: 'https://www.instagram.com/phukettennisfamily/', telegram: webBotName() ? `https://t.me/${webBotName()}` : '' });
const absImage = (src = '') => /^https?:/.test(src) ? src : (src ? `${PUBLIC_URL}${src.startsWith('/') ? '' : '/'}${src}` : '');
async function seoEvents(lang) {
  const out = [];
  try {
    for (const e of await getAllEvents().catch(() => [])) {
      const name = lang === 'ru' ? (e.event_name_ru || e.event_name_en) : (e.event_name_en || e.event_name_ru);
      if (!name) continue;
      const start = String(e.start_date || '').trim(), end = String(e.end_date || '').trim();
      out.push({ name, start: start && start !== 'None' ? start : '', end: end && end !== 'None' ? end : '', path:'/tournaments',
        when: [start, end].filter(x => x && x !== 'None').map(x => String(x).slice(0, 10)).join(' — ') });
    }
  } catch (e) {}
  try {
    const { eventsForViewer } = await import('./eventflow.js');
    for (const e of await eventsForViewer('', false, false).catch(() => [])) {
      if (e.past) continue;
      const name = lang === 'ru' ? (e.title_ru || e.title_en) : (e.title_en || e.title_ru);
      out.push({ name, start: e.starts_at ? new Date(e.starts_at).toISOString() : '', place: e.place || '', path:'/events',
        when: [e.date, e.time].filter(Boolean).join(' '), description: lang === 'ru' ? (e.description_ru || e.description_en) : (e.description_en || e.description_ru) });
    }
  } catch (e) {}
  return out;
}
async function sendSeoPage(req, res, page, { player = null, division = '' } = {}) {
  noCache(res);
  const lang = seoLang(req);
  const site = SITE_URL;
  const P = SEO_PAGES[page] || SEO_PAGES.home;
  let [title, description] = lang === 'ru' ? P.ru : P.en;
  let pathName = P.path, image = `${site}/public/img/og.png`, noindex = false;
  const ld = [organizationLd(site, socialLinks())];
  const snap = await snapshotSoon();
  const players = (snap?.players || []).filter(x => String(x.name || '').trim());
  const data = { players, divisions: snap?.divisions || [] };
  if (page === 'home') ld.push(websiteLd(site));
  if (['home', 'events', 'tournaments'].includes(page)) {
    data.events = await seoEvents(lang);
    ld.push(...eventsLd(site, data.events));
  }
  if (req.params?.slug !== undefined) {
    pathName = `/p/${String(req.params.slug || '').toLowerCase()}`;
    if (!player) noindex = true;
    else {
      const div = divisionLabelFor(player.division);
      const stats = [div, Number(player.matches) ? (lang === 'ru' ? `${player.matches} матчей · ${player.wins || 0} побед` : `${player.matches} matches · ${player.wins || 0} wins`) : ''].filter(Boolean).join(' · ');
      title = `${player.name} — Phuket Tennis Family`;
      description = lang === 'ru' ? `${stats ? stats + '. ' : ''}Профиль игрока любительской теннисной лиги на Пхукете.` : `${stats ? stats + '. ' : ''}Player profile in the Phuket amateur tennis league.`;
      pathName = `/p/${seoSlug(player.name)}`;
      if (player.photo) image = absImage(player.photo);
      data.player = player;
      ld.push(personLd(site, { name: player.name, image: player.photo ? absImage(player.photo) : '', description: stats }));
    }
  }
  if (division) {
    pathName = `/d/${division}`;
    title = `${divisionLabelFor(division)} — ${lang === 'ru' ? 'таблица' : 'standings'} · Phuket Tennis Family`;
    description = lang === 'ru' ? `Таблица, результаты и плей-офф: ${divisionLabelFor(division)}, теннисная лига Пхукета.` : `Standings, results and playoffs of ${divisionLabelFor(division)} in the Phuket tennis league.`;
    data.division = division;
    try {
      const season = snap?.current?.number || '';
      const groups = await divisionGroups(division, season).catch(() => []);
      const tables = [];
      for (const g of (groups.length ? groups.map(x => x.group) : [''])) {
        const t = await getDivisionTable(division, season, g).catch(() => null);
        if (t?.ok) tables.push(...(t.players || []));
      }
      data.table = tables;
    } catch (e) {}
  }
  const file = page === 'about' ? 'about.html' : 'league.html';
  if (page === 'about') ld.push(faqLd(lang === 'ru' ? ABOUT_FAQ.ru : ABOUT_FAQ.en));
  const html = await pageHtml(file);
  res.type('html').send(applySeo(html, {
    site, path: pathName, lang, title, description, image, ld, noindex,
    ssr: file === 'league.html' ? ssrHtml({ page, lang, site, data }) : aboutSsr(lang, lang === 'ru' ? ABOUT_FAQ.ru : ABOUT_FAQ.en)
  }));
}
// Вопросы-ответы с лендинга — ещё и для Google (FAQ в выдаче).
const ABOUT_FAQ = {
  en: [['What level do I need?', 'Any. Phuket Tennis Family is an amateur league: divisions are built by level, so you play people of your strength.'],
       ['Do I need to be in Phuket for the full 2 months?', 'No. Just play your 7 matches before the final stage; you agree the time of each match with your opponent.'],
       ['Who books and pays for the court?', 'For regular matches the players do; courts for semifinals and finals are included.'],
       ['How do I join?', 'Log in with Telegram on phukettennis.com, fill in a short profile in our bot and choose a season or join the waitlist.']],
  ru: [['Какой нужен уровень?', 'Любой. Phuket Tennis Family — любительская лига: дивизионы собираются по уровню, и вы играете с соперниками своей силы.'],
       ['Нужно ли быть на Пхукете все 2 месяца?', 'Нет. Главное — сыграть свои 7 матчей до финальной стадии; время каждого матча вы согласуете с соперником сами.'],
       ['Кто бронирует и оплачивает корт?', 'На матчи регулярки — игроки; корты на полуфиналы и финалы входят в участие.'],
       ['Как вступить?', 'Войдите через Telegram на phukettennis.com, заполните короткую анкету в нашем боте и выберите сезон или лист ожидания.']]
};
app.get('/', (req, res) => sendSeoPage(req, res, 'home').catch(e => { console.error('seo home:', e.message); res.sendFile(path.join(__dirname, 'public', 'league.html')); }));
app.get('/about', (req, res) => sendSeoPage(req, res, 'about').catch(e => { console.error('seo about:', e.message); res.sendFile(path.join(__dirname, 'public', 'about.html')); }));
for (const [key, route] of [['div','/divisions'],['race','/race'],['players','/players'],['matches','/matches'],['events','/events'],['tournaments','/tournaments'],['partners','/partners']]) {
  app.get(route, (req, res) => sendSeoPage(req, res, key).catch(e => { console.error('seo page:', e.message); res.sendFile(path.join(__dirname, 'public', 'league.html')); }));
}
app.get('/p/:slug', async (req, res) => {
  try {
    const snap = await snapshotSoon();
    const p = (snap?.players || []).find(x => seoSlug(x.name) === String(req.params.slug || '').toLowerCase());
    await sendSeoPage(req, res, 'players', { player: p || null });
  } catch (e) { console.error('share player page:', e.message); res.type('html').send(await pageHtml('league.html')); }
});
app.get('/d/:letter', async (req, res) => {
  const letter = String(req.params.letter || '').toUpperCase().replace(/[^A-Z]/g, '');
  try { await sendSeoPage(req, res, 'div', { division: letter }); }
  catch (e) { console.error('share division page:', e.message); res.type('html').send(await pageHtml('league.html')); }
});
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(robotsTxt(SITE_URL, String(req.headers?.host || '') === siteHost()));
});
app.get('/sitemap.xml', async (req, res) => {
  try {
    const snap = await snapshotSoon(6000);
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('application/xml').send(sitemapXml(SITE_URL, { players: snap?.players || [], divisions: snap?.divisions || [] }));
  } catch (e) { res.type('application/xml').send(sitemapXml(SITE_URL, {})); }
});
app.get('/site.webmanifest', (req, res) => { res.set('Cache-Control', 'public, max-age=86400'); res.type('application/manifest+json').send(JSON.stringify(webManifest())); });

// Вход на сайт через Telegram. Новый человек сразу появляется в Players list
// лидом с пометкой «сайт», а в админ-чат приходит карточка — как при /start в боте.
registerWebAuthRoutes(app, {
  onLogin: async (user) => {
    const { ensureApplicantLead } = await import('./sheets.js');
    const { notifyNewLead } = await import('./admin.js');
    const profile = await ensureApplicantLead({ ...user, source:'website' }).catch(e => { console.error('web lead:', e.message); return null; });
    await notifyNewLead({ ...(profile || {}), ...user, telegram_id:user.id }, { reason:'website' });
  }
});
app.get('/participants', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'public', 'participants.html')); });
app.get('/match', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'public', 'match.html')); });
app.get('/league', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'public', 'league.html')); });
app.get('/fantasy', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'public', 'fantasy.html')); });
// Турнирная админка — отдельное приложение, а не вкладка внутри админки.
// Турнирная админка. Адрес /tournaments теперь у публичной вкладки «Турниры»
// сайта, поэтому админка переехала на /tournament-admin.
app.get('/tournament-admin', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'public', 'tournament.html')); });

// --- Календарь -------------------------------------------------------------
// /ics отдаёт сам файл события, /cal — страница мини-приложения с кнопкой:
// системе нужен переход по https-ссылке, поэтому открываем её через openLink.
function icsEscape(v = '') { return String(v).replace(/[\\;,]/g, m => '\\' + m).replace(/\r?\n/g, '\\n'); }
function toIcsStamp(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
app.get('/ics', (req, res) => {
  const title = String(req.query.t || 'PTF match');
  const start = toIcsStamp(req.query.s);
  const end = toIcsStamp(req.query.e);
  if (!start || !end) return res.status(400).send('Bad event dates');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PTF//Match//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:ptf-${Date.now()}@phukettennis`,
    `DTSTAMP:${toIcsStamp(new Date().toISOString())}`,
    `DTSTART:${start}`, `DTEND:${end}`,
    `SUMMARY:${icsEscape(title)}`,
    req.query.l ? `LOCATION:${icsEscape(req.query.l)}` : '',
    'END:VEVENT', 'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="ptf-match.ics"');
  res.send(ics);
});
app.get('/cal', async (req, res) => {
  const params = {...req.query};
  const lang = String(params.lang || (['ru','en'].includes(params.l) ? params.l : '') || 'en');
  if (params.e && !params.s) {
    try {
      const {findEvent,eventStartMs} = await import('./events.js');
      const event = await findEvent(String(params.e));
      if (!event) return res.status(404).send(uiError('Событие не найдено',lang));
      const start = eventStartMs(event);
      params.t = (lang==='ru'?event.title_ru:event.title_en) || event.title_ru;
      params.s = new Date(start).toISOString();params.e = new Date(start+2*60*60*1000).toISOString();params.l = event.place || '';
    } catch(e) { return res.status(400).send(uiError(e.message,lang)); }
  }
  const ru = lang==='ru';
  noCache(res);
  const q = new URLSearchParams({ t: params.t || 'PTF match', s: params.s || '', e: params.e || '', l: params.l || '' });
  const icsUrl = `${PUBLIC_URL}/ics?${q.toString()}`;
  // Тот же матч для Google Календаря: событие открывается уже заполненным.
  const gStamp = v => { const d = new Date(v || ''); return Number.isNaN(d.getTime()) ? '' : d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); };
  const gUrl = gStamp(params.s) ? 'https://calendar.google.com/calendar/render?' + new URLSearchParams({ action:'TEMPLATE', text:String(params.t || 'PTF match'), dates:`${gStamp(params.s)}/${gStamp(params.e) || gStamp(params.s)}`, location:String(params.l || '') }).toString() : '';
  const title = String(params.t || 'PTF match').replace(/[&<>]/g, '');
  const place = String(params.l || '').replace(/[&<>]/g, '');
  const when = (() => {
    const s = new Date(params.s || ''), e = new Date(params.e || '');
    if (Number.isNaN(s.getTime())) return '';
    const opts = { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', weekday: 'short' };
    const hm = (d) => d.toLocaleTimeString(ru?'ru-RU':'en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
    return `${s.toLocaleDateString(ru?'ru-RU':'en-GB', opts)}, ${hm(s)}${Number.isNaN(e.getTime()) ? '' : '–' + hm(e)}`;
  })();
  res.send(`<!doctype html><html lang="${ru?'ru':'en'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>PTF — ${ru?'календарь':'calendar'}</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Arial,sans-serif;background:linear-gradient(180deg,#0f0f0f,#1b1b1b);color:#f6f4ef;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center}
.card{max-width:420px;width:100%;background:#202020;border:1px solid #3a3a3a;border-radius:20px;padding:26px}
h1{font-size:20px;margin:0 0 10px}p{color:#a9a49b;font-size:14px;line-height:1.5;margin:0 0 6px}
b{color:#f6f4ef}button{width:100%;border:0;border-radius:16px;padding:16px;font-size:16px;font-weight:900;margin-top:18px;cursor:pointer;background:linear-gradient(135deg,#ef5f00,#ff8a2a);color:#111}
.hint{font-size:12px;margin-top:14px}</style></head><body>
<div class="card"><h1>📅 ${ru?'Добавить в календарь':'Add to calendar'}</h1>
<p><b>${title}</b></p><p>${when}</p>${place ? `<p>📍 ${place}</p>` : ''}
<button id="go">🍎 ${ru?'Apple Календарь (iPhone)':'Apple Calendar (iPhone)'}</button>
${gUrl ? `<button id="g" style="background:#2b2b2b;color:#f6f4ef;border:1px solid #3a3a3a">📅 ${ru?'Google Календарь':'Google Calendar'}</button>` : ''}
<p class="hint">${ru?'Откроется системное окно календаря — подтвердите добавление.':'Your calendar will open — confirm adding the event.'}</p></div>
<script>
var tg=window.Telegram&&window.Telegram.WebApp; if(tg){tg.ready();tg.expand();}
var ICS=${JSON.stringify(icsUrl)};
var G=${JSON.stringify(gUrl)};
var gb=document.getElementById('g');if(gb)gb.onclick=function(){try{if(tg&&tg.openLink){tg.openLink(G);return}}catch(e){}window.location.href=G;};
document.getElementById('go').onclick=function(){
  try{ if(tg&&tg.openLink){tg.openLink(ICS,{try_instant_view:false});return} }catch(e){}
  window.location.href=ICS;
};
</script></body></html>`);
});
app.get('/apply', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'public', 'apply.html')); });
registerAdminRoutes(app);

const seen = new Set();
app.post('/webhook', async (req, res) => {
  res.status(200).send('ok');
  try {
    const update = req.body;
    if (update.update_id !== undefined) {
      if (seen.has(update.update_id)) return;
      seen.add(update.update_id);
      if (seen.size > 2000) seen.clear();
    }
    // Человек сам написал боту или нажал кнопку — значит, бот снова может ему писать.
    const fromId = update.message?.from?.id || update.callback_query?.from?.id;
    if (fromId) markChatAlive(fromId);
    // Замер — чтобы «кажется, тормозит» превратилось в цифры. В лог пишем
    // только то, что человек успевает заметить: всё, что дольше секунды.
    const started = Date.now();
    let kind = '';
    if (update.message) { kind = 'сообщение ' + String(update.message.text || '').slice(0, 24); await handleMessage(update.message); }
    else if (update.callback_query) { kind = 'кнопка ' + String(update.callback_query.data || '').slice(0, 24); await handleCallback(update.callback_query); }
    const spent = Date.now() - started;
    if (kind && spent > 1000) console.log(`медленно: ${kind} — ${spent} мс`);
  } catch (e) {
    console.error('webhook error', e);
  }
});

app.get('/api/bootstrap', async (req, res) => {
  try {
    const initData = req.query.initData || '';
    // Раздел мог открыться из постоянной клавиатуры — там Telegram не отдаёт
    // initData, и человека опознаёт подписанный токен в адресе.
    const who = webAppUser(initData, req.query.t || '');
    const user = who.ok ? who.user : null;
    const existingProfile = user ? await findApplicantByTelegramIdentity(user) : null;
    const lang = ['ru','en'].includes(String(existingProfile?.language || '').toLowerCase()) ? String(existingProfile.language).toLowerCase() : 'en';
    // Витрина новичка: показываем и то, что идёт, и то, что прошло — иначе
    // экран выглядит пустым и непонятно, живая ли лига вообще. Заявку по-прежнему
    // можно оставить только туда, где набор открыт.
    const allEvents = await getAllEvents();
    const enrichedAll = await enrichEventsWithStats(allEvents);
    const enrichedEvents = enrichedAll.filter(e => e.joinable);
    res.json({ ok: true, user, lang, language_required: !existingProfile?.language, events: enrichedEvents, all_events: enrichedAll, usdtAmount: DEFAULT_USDT_AMOUNT, existingProfile, profileCompleted: isProfileCompleted(existingProfile) });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

async function participantsPayload(user=null, season='') {
  let lang = '';
  if (user?.id) {
    const profile = await findApplicantByTelegramId(user.id).catch(() => null);
    lang = ['ru','en'].includes(String(profile?.language || '').toLowerCase()) ? String(profile.language).toLowerCase() : '';
  }
  if (!lang) lang = String(user?.language_code || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
  const data = await getManualParticipants(season);
  // telegram_id игроков в браузер не отдаём: он нужен только серверу.
  const clean = ({ telegram_id, ...p }) => p;
  const players = (data.players || []).map((p, idx) => ({ n: idx + 1, ...clean(p) }));
  const groups = (data.groups || []).map(g => ({ ...g, players: (g.players || []).map(clean) }));
  return { ok:true, lang, season: data.season || '', sheet: data.sheet || '', total: players.length, totals: data.totals, note: data.note, divisions: data.divisions, groups, players };
}

app.get('/api/participants', async (req, res) => {
  try {
    // Кнопка «Состав» есть в постоянной клавиатуре, а оттуда приходит токен
    // вместо initData. Раньше здесь проверялась только initData, и раздел
    // отвечал «Invalid Telegram initData».
    const who = webAppUser(req.query.initData || '', req.query.t || '');
    if (!who.ok) return res.status(who.code).json({ ok:false, error:who.error });
    res.json(await participantsPayload(who.user, String(req.query.season || '')));
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

function requireRacketRating(profile = {}) {
  const rating = safe(profile.racket_rating || profile.ntrp);
  if (!rating || ["unknown","не знаю","dont know","don\'t know","n/a","na","-"].includes(String(rating).trim().toLowerCase())) {
    throw new Error('Racket Rating is required. If the player does not know it, complete the level test.');
  }
  return rating;
}

// Откуда пришла цифра рейтинга. Фронт присылает 'test', если человек прошёл
// короткий тест, и 'player', если вписал руками. Всё, что пришло не из анкеты,
// считаем поставленным организатором.
function ratingSource(value, fallback = 'player') {
  const v = String(value || '').trim().toLowerCase();
  return ['test', 'player', 'admin'].includes(v) ? v : fallback;
}

app.post('/api/update-rating', async (req, res) => {
  try {
    const { initData = '', t = '', rating = '', ntrp_source = '' } = req.body || {};
    const who = webAppUser(initData, t);
    if (!who.ok) return res.status(who.code).json({ ok:false, error:who.error });
    const user = who.user;
    const existing = await findApplicantByTelegramIdentity(user) || await findApplicantByTelegramId(user.id);
    if (!existing) return res.status(404).json({ ok:false, error:'Player profile not found. Please complete the profile first.' });
    const racketRating = requireRacketRating({ ntrp: rating, racket_rating: rating });
    const src = ratingSource(ntrp_source);
    const tags = withRatingSourceTag(existing.crm_tags, src);
    let updated = await updateApplicantByTelegramId(user.id, { ntrp: racketRating, crm_tags: tags, telegram_id: user.id, telegram_username: user.username || existing.telegram_username || '', telegram: user.username ? `t.me/${user.username}` : existing.telegram || '', profile_completed: 'yes', source: existing.source || 'telegram_webapp' });
    if (!updated && existing?._rowNumber) {
      const patch = { ntrp: racketRating, crm_tags: tags, telegram_id: user.id, telegram_username: user.username || existing.telegram_username || '', telegram: user.username ? `t.me/${user.username}` : existing.telegram || '', profile_completed: 'yes', updated_at: nowISO() };
      await updateObjectByRow(SHEETS.applicants, existing._rowNumber, patch);
      updated = { ...existing, ...patch };
    }
    import('./admin.js')
      .then(({ notifyRatingChanged }) => notifyRatingChanged({ ...(updated || existing), telegram_id: user.id }, { from: existing?.ntrp, to: racketRating }))
      .catch(e => console.error('notifyRatingChanged failed:', e.message));
    res.json({ ok:true, applicant: updated, rating: racketRating });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.post('/api/save-profile'
, async (req, res) => {
  try {
    const { initData = '', t = '', profile = {} } = req.body || {};
    const who = webAppUser(initData, t);
    if (!who.ok) return res.status(who.code).json({ ok:false, error:who.error });
    const user = who.user;
    const existingProfile = await findApplicantByTelegramIdentity(user);
    const lang = ['ru','en'].includes(String(existingProfile?.language || '').toLowerCase()) ? String(existingProfile.language).toLowerCase() : 'en'; const username = user.username || '';
    const racketRating = requireRacketRating(profile);
    await ensureInstagramColumn().catch(() => {});
    const applicant = await upsertApplicant({ name:safe(profile.name)||[user.first_name,user.last_name].filter(Boolean).join(' '), ntrp:racketRating, status:'waitlist', experience:safe(profile.experience), gender:safe(profile.gender), age:safe(profile.age), country_of_origin:safe(profile.country_of_origin), telegram:username?`t.me/${username}`:'', whatsapp:safe(profile.whatsapp), instagram:normalizeInstagram(profile.instagram), photo_publication_consent:consentFromForm(profile), notes:safe(profile.notes), telegram_id:user.id, telegram_username:username, language:lang, source:'telegram_webapp', last_application_event:'PTF Player Profile / Waitlist', selfie_status:'optional_missing', crm_tags:withRatingSourceTag('ptf_waitlist,profile_completed', ratingSource(profile.ntrp_source)), increment_application_count:false });
    // Анкета без события раньше не приходила никуда: человек заполнял всё,
    // попадал в лист ожидания и пропадал из виду. Теперь это событие в его теме.
    const wasCompleted = isProfileCompleted(existingProfile);
    import('./admin.js')
      .then(({ notifyProfileFilled }) => notifyProfileFilled({ ...applicant, telegram_id: user.id }, {
        headline: wasCompleted ? '✏️ <b>Анкета обновлена</b>' : '📝 <b>Анкета заполнена</b> — лист ожидания'
      }))
      .catch(e => console.error('notifyProfileFilled failed:', e.message));
    res.json({ok:true,applicant,profileCompleted:true});
  } catch(e){ console.error(e); res.status(500).json({ok:false,error:e.message}); }
});


function noFlag(value) { return ['no','false','0','off','disabled','inactive','нет'].includes(String(value || '').trim().toLowerCase()); }
function isPaymentEnabledForEvent(event) {
  if (!event) return false;
  const priceThb = Number(event.price_thb || 0);
  if (!(priceThb > 0)) return false;
  if (noFlag(event.payment_enabled)) return false;
  return true;
}
function eventPriceThb(event) { return Number(event?.price_thb || 0); }
function eventPriceUsdt(event) { return Number(event?.price_usdt || event?.usdt_amount || DEFAULT_USDT_AMOUNT || 0); }

app.get('/api/payment-methods', async (req, res) => {
  try {
    const methods = await getPaymentMethods();
    res.json({ ok:true, methods });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/submit-application', async (req, res) => {
  try {
    const { initData = '', t = '', profile = {}, event_id, mode = 'profile' } = req.body || {};
    const who = webAppUser(initData, t);
    if (!who.ok) return res.status(who.code).json({ ok:false, error:who.error });
    const user = who.user;

    await ensureInstagramColumn().catch(() => {});
    const events = await getActiveEvents();
    const event = event_id ? events.find(e => e.event_id === event_id) : null;

    const username = user.username || '';
    const existingProfile = await findApplicantByTelegramIdentity(user);
    const lang = ['ru','en'].includes(String(existingProfile?.language || '').toLowerCase()) ? String(existingProfile.language).toLowerCase() : 'en';
    // Лист ожидания с готовой анкетой — та же заявка на событие: анкету не трогаем.
    const eventOnlyWithProfile = (mode === 'event' || mode === 'waitlist') && isProfileCompleted(existingProfile);
    const isWaitEvent = String(event?.status_code || event?.status || '').toLowerCase() === 'waitlist';
    const effectiveProfile = eventOnlyWithProfile ? {
      name: existingProfile.name,
      ntrp: existingProfile.ntrp,
      ntrp_unknown: existingProfile.ntrp === 'unknown',
      experience: existingProfile.experience,
      gender: existingProfile.gender,
      age: existingProfile.age,
      country_of_origin: existingProfile.country_of_origin,
      whatsapp: existingProfile.whatsapp,
      notes: existingProfile.notes
    } : profile;
    const racketRating = requireRacketRating(effectiveProfile);
    const fullName = safe(effectiveProfile.name) || [user.first_name, user.last_name].filter(Boolean).join(' ');
    const isEventApplication = Boolean(event);
    const eventName = event
      ? (lang === 'ru' ? (event.event_name_ru || event.event_name_en) : (event.event_name_en || event.event_name_ru))
      : 'PTF Player Profile / Waitlist';
    const finalEventId = event?.event_id || 'ptf_waitlist';
    const applicationId = uid('app');
    const priceThb = eventPriceThb(event);
    const priceUsdt = eventPriceUsdt(event);
    const paymentRequired = isPaymentEnabledForEvent(event);
    const applicationStatus = event ? (paymentRequired ? 'waiting_payment' : 'application_received') : 'waitlist';
    const paymentStatus = paymentRequired ? 'payment_required' : 'not_required';

    // Игрок идущего сезона встаёт в лист следующего — его статус «active» не
    // понижаем до «waitlist»: он всё ещё играет.
    const keepStatus = isWaitEvent && /^(active|confirmed|approved|paid|payment|waiting_payment)$/i.test(String(existingProfile?.status || '').trim());
    const applicant = await upsertApplicant({
      name: fullName,
      ntrp: racketRating,
      status: keepStatus ? existingProfile.status : applicationStatus,
      experience: safe(effectiveProfile.experience),
      gender: safe(effectiveProfile.gender),
      age: safe(effectiveProfile.age),
      country_of_origin: safe(effectiveProfile.country_of_origin),
      telegram: username ? `t.me/${username}` : '',
      whatsapp: safe(effectiveProfile.whatsapp),
      instagram: normalizeInstagram(effectiveProfile.instagram),
      photo_publication_consent: consentFromForm(effectiveProfile),
      notes: safe(effectiveProfile.notes),
      telegram_id: user.id,
      telegram_username: username,
      language: lang,
      source: 'telegram_webapp',
      last_application_event: eventName,
      selfie_status: 'optional_missing',
      // Метку источника рейтинга подмешиваем сюда же: отдельной колонки нет
      // намеренно — вставка колонки сдвигает лист и ломает формулы витрины.
      crm_tags: withRatingSourceTag(
        isEventApplication ? `event_application,${finalEventId}` : 'ptf_waitlist,profile_completed',
        ratingSource(effectiveProfile.ntrp_source, eventOnlyWithProfile ? (ratingSourceOf(existingProfile) || 'player') : 'player')
      ),
      increment_application_count: true
    });

    const appRow = {
      application_id: applicationId,
      telegram_id: user.id,
      telegram_username: username,
      player_name: fullName,
      event_id: finalEventId,
      event_name: eventName,
      application_status: applicationStatus,
      submitted_at: nowISO(),
      payment_status: paymentStatus,
      selfie_required: 'no',
      selfie_status: 'optional_missing',
      source: 'telegram_webapp',
      notes: safe(effectiveProfile.notes),
      payment_amount: paymentRequired ? priceThb : '',
      payment_currency: paymentRequired ? 'THB' : '',
      payment_amount_usdt: paymentRequired ? priceUsdt : '',
      payment_amount_thb: paymentRequired ? priceThb : '',
      price_thb: paymentRequired ? priceThb : '',
      price_usdt: paymentRequired ? priceUsdt : ''
    };
    const savedApplication = await createOrUpdateApplication(appRow);
    appRow.application_id = savedApplication.application_id || applicationId;
    res.json({ ok:true, application_id:appRow.application_id, event:eventName, price_thb:priceThb, price_usdt:priceUsdt, payment_required:paymentRequired, application_status: applicationStatus, payment_status: paymentStatus });
    // Ответ экрану — сразу, как только заявка записана. Сообщения в бот,
    // карточка админу, счёт и строка в списке участников уходят следом в фоне:
    // раньше экран ждал их все и «Отправить» висело по полминуты.
    setImmediate(() => withPriority('low', async () => {
      // Do not spam admin topics when the same player presses submit again for the same event.
      // The row in Applications is updated, but the admin application card is sent only for a fresh application.
      if (!savedApplication.isUpdated) {
        try {
          await notifyNewApplication(appRow, applicant);
        } catch (notifyError) {
          // Do not block player registration/payment if the admin chat is misconfigured or migrated.
          console.error('notifyNewApplication failed:', notifyError.message);
        }
      }
      // Рубильник автосчёта: когда он выключен, игрок не получает реквизиты сразу —
      // сначала организатор смотрит, есть ли место, и жмёт «Выставить счёт» в топике.
      // Саму ветку оплаты не трогаем: она запускается тем же sendPaymentStart, просто позже.
      const autoInvoice = await paymentAutoOn().catch(() => true);
      if (isEventApplication && paymentRequired && !autoInvoice) {
        await sendMessage(user.id, lang === 'ru'
          ? `✅ Заявка на «${eventName}» принята.\n\nОплата пока не открыта: проверяем свободные места в дивизионе. Как только место подтвердится, пришлю счёт сюда же — обычно в течение дня.\n\nМесто закрепляется только после оплаты.`
          : `✅ Your application for “${eventName}” has been received.\n\nPayment is not open yet: we are checking free spots in the division. As soon as a spot is confirmed, I will send the invoice right here — usually within a day.\n\nThe spot is secured only after payment.`);
      } else if (isEventApplication && paymentRequired) {
        await sendMessage(user.id, lang === 'ru' ? `✅ Заявка на событие сохранена: ${eventName}.

<b>Следующий шаг — оплата участия.</b>

⚠️ Неоплаченная заявка не является активным участием в сезоне. Заявки с подтверждённой оплатой будут рассматриваться в первую очередь.

Выберите удобный способ оплаты ниже.` : `✅ Your event application has been saved: ${eventName}.

<b>Next step — participation payment.</b>

⚠️ An unpaid application is not an active season entry. Applications with confirmed payment will be processed first.

Please choose a payment method below.`);
        await sendPaymentStart(user.id, lang, appRow.application_id);
      } else if (isEventApplication && isWaitEvent) {
        await sendMessage(user.id, lang === 'ru'
          ? `📝 Вы в листе ожидания: <b>${escapeHtml(eventName)}</b>.\n\nКогда откроется набор, мы напишем вам здесь раньше остальных. Порядок в листе: сначала игроки, которые уже играли в лиге, дальше — по дате заявки. Места ограничены: 8 в каждом дивизионе.`
          : `📝 You are on the waitlist: <b>${escapeHtml(eventName)}</b>.\n\nWhen registration opens, we will message you here before everyone else. Order on the list: players who have already played in the league first, then by application date. Places are limited: 8 per division.`);
      } else if (isEventApplication) {
        await sendMessage(user.id, lang === 'ru' ? `✅ Заявка на событие сохранена: ${eventName}. Детали подтверждения участия будут отправлены через Telegram-бота.` : `✅ Your event application has been saved: ${eventName}. Participation confirmation details will be sent through the Telegram bot.`);
      } else await sendMessage(user.id, lang === 'ru' ? `✅ Анкета сохранена в системе PTF.

Теперь вы можете подать заявку в открытое событие.

📸 Постеры матчей и результаты выкладываем в <a href="${IG_PROFILE_URL}">Instagram</a> — подпишитесь, чтобы видеть свои матчи.` : `✅ Your profile has been saved in the PTF system.

You can now join an open event.

📸 Match posters and results go to our <a href="${IG_PROFILE_URL}">Instagram</a> — follow us to see your own matches there.`, { reply_markup:{ inline_keyboard:[[ { text: lang === 'ru' ? '🏆 Участвовать в событии' : '🏆 Join Event', web_app:{ url:`${PUBLIC_URL}/apply?mode=event` } } ],[ { text: lang === 'ru' ? '🏠 Главное меню' : '🏠 Main menu', callback_data:'main' } ]] } });
      if (isWaitEvent) await syncWaitlistEntry(event).catch(e => console.error('waitlist sync:', e.message));
    }).catch(e => console.error('application follow-up failed:', e.message)));
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:e.message });
  }
});


// ---------------------------------------------------------------------------
// МАТЧИ. Заявка формируется ровно как бронь в боте тренировок: дата, интервал,
// длительность, площадка — и уходит либо в топик дивизиона (открытое окно),
// либо лично сопернику (адресный вызов).
// ---------------------------------------------------------------------------
// Instagram пишем в одном виде — @nick: люди присылают и ссылку, и с собачкой,
// и без. Пустое значение остаётся пустым, поле необязательное.
// В анкете спрашиваем прямо: публиковать в Instagram или нет. Пустой ответ
// оставляем пустым — это не согласие и не отказ, спросим позже опросом.
function consentFromForm(profile = {}) {
  const v = String(profile.photo_publication_consent || '').trim().toUpperCase();
  return v === 'YES' || v === 'NO' ? v : '';
}
function normalizeInstagram(value = '') {
  let v = String(value || '').trim();
  if (!v) return '';
  v = v.replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/[?/].*$/, '').replace(/^@+/, '').trim();
  return v ? '@' + v : '';
}
function hhmmToMin(v) { const [h, m] = String(v || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); }

// Кто открыл мини-приложение. Обычный путь — подписанный Telegram initData.
// Запасной — токен ?t= из адреса: его вшивает бот в кнопки постоянной
// клавиатуры, потому что там initData не приходит вовсе.
function webAppUser(initData, token = '') {
  const verified = verifyTelegramInitData(initData);
  const { user } = parseInitData(initData);
  if (user?.id) {
    if (BOT_TOKEN && !verified && process.env.NODE_ENV === 'production') return { ok:false, code:403, error:'Invalid Telegram initData' };
    return { ok:true, user };
  }
  const id = verifyWebAppToken(token);
  if (id) return { ok:true, user: { id: Number(id) || id } };
  return { ok:false, code:400, error:'Telegram WebApp user not found' };
}

// Гость: открытая часть лиги без входа (сайт) или без анкеты. Видит витрину,
// таблицы, гонку, события и расписание; Fantasy и личное — нет. Такой вид
// отдают только читающие ручки, которые явно разрешили гостя.
function guestViewer(user = null, profile = {}, lang = '') {
  const l = ['ru','en'].includes(profile?.language) ? profile.language
    : ['ru','en'].includes(lang) ? lang
    : (String(user?.language_code || '').startsWith('ru') ? 'ru' : 'en');
  return { ok:true, guest:true, anonymous:!user?.id, needsProfile:true,
    user: user?.id ? user : { id:'' }, profile: profile || {}, lang:l, division:'', season:'', matchGroup:'',
    canMatch:false, isAdmin:false, isLeagueMember:false, isPlayersMasterMember:false, profileCompleted:false };
}
async function leagueViewer(initData, token = '', { allowGuest = false, lang: langHint = '' } = {}) {
  const who = webAppUser(initData, token);
  if (!who.ok) return allowGuest && who.code === 400 ? guestViewer(null, {}, langHint) : who;
  const user = who.user;
  const profile = await findApplicantByTelegramIdentity(user) || await findApplicantByTelegramId(user.id) || {};
  if (profile._rowNumber && user.id) await healApplicantId(profile, user.id);
  const lang = ['ru','en'].includes(profile.language) ? profile.language : (String(user.language_code || '').startsWith('ru') ? 'ru' : 'en');
  const league = await getPlayerLeagueInfo({ ...profile, telegram_id:user.id });
  const profileCompleted = isProfileCompleted(profile);
  if (!league.member && !league.admin && !profileCompleted) {
    return allowGuest ? guestViewer(user, profile, langHint || lang) : { ok:false, code:403, lang, error:'profile_required' };
  }
  // Снялся с сезона — матчи ему больше не открываем (таблицы и история видны как раньше).
  const withdrawn = league.found ? await (await import('./withdraw.js')).isWithdrawn(league.name || profile.name || '', league.season || '').catch(() => false) : false;
  return { ok:true, user, profile, lang, division:league.division || '', season:league.season || '',
    matchGroup:league.group || '', canMatch:(league.found && !withdrawn) || league.admin, isAdmin:league.admin, withdrawn,
    isLeagueMember:Boolean(league.member || league.admin), isPlayersMasterMember:Boolean(league.member), profileCompleted };
}
async function matchViewer(initData, token = '') { return leagueViewer(initData, token); }

registerFantasyRoutes(app,{ viewer: leagueViewer });
registerTournamentRoutes(app,{ viewer: leagueViewer });

// История матчей лиги для экрана матчей: плоская лента, по строке на матч.
// В витрине она хранится по игрокам — один матч лежит в двух карточках, поэтому
// схлопываем по номеру матча и паре имён.
app.get('/api/match/history', async (req, res) => {
  try {
    const v = await matchViewer(req.query.initData || '', String(req.query.t || ''));
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    const [history, players] = await Promise.all([
      getLeagueMatchHistory().catch(() => new Map()),
      getLeagueProfiles().catch(() => [])
    ]);
    const nameById = new Map(players.map(p => [String(p.id), p.name]));
    const seen = new Set();
    const out = [];
    for (const [pid, list] of history.entries()) {
      for (const m of (list || [])) {
        const key = `${m.match_no || ''}-${[String(pid), String(m.opponent_id || m.opponent)].sort().join('-')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const me = nameById.get(String(pid)) || '';
        const win = m.result === 'WIN';
        out.push({
          no: m.match_no || '', date: m.date || '', season: m.season || '',
          division: (m.division || m.opponent_division || '').toString().toUpperCase(),
          winner: win ? me : m.opponent, loser: win ? m.opponent : me,
          score: m.score || '', court: m.court || ''
        });
      }
    }
    // История должна следовать реальному дню матча, а не техническому номеру
    // строки, который может появиться позже при ручной корректировке.
    out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(b.no || 0) - Number(a.no || 0));
    res.json({ ok:true, division: v.division || '', matches: out.slice(0, 300) });
  } catch (e) {
    console.error('match history failed:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get('/api/match/attention',async(req,res)=>{try{const v=await matchViewer(req.query.initData||'',String(req.query.t||''));if(!v.ok)return res.status(v.code).json({ok:false,error:v.error});res.json({ok:true,attention:pendingActionsFor(v.user.id,await allSlots())});}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.get('/api/match/admin-active', async (req, res) => {
  try {
    const v=await matchViewer(req.query.initData||'',String(req.query.t||''));
    if(!v.ok)return res.status(v.code).json({ok:false,error:v.error});
    if(!v.isAdmin)return res.status(403).json({ok:false,error:'admin_required'});
    const rows=(await allSlots()).filter(function(slot){
      const status=String(slot.status||'').trim().toLowerCase();
      const resultStatus=String(slot.result_status||'').trim().toLowerCase();
      const resultConfirmed=resultStatus==='confirmed'||Boolean(String(slot.result_confirmed_at||'').trim());
      return ['open','pending','accepted'].includes(status)&&!resultConfirmed
        && (status==='accepted'||!isSlotPast(slot));
    });
    const ids=[...new Set(rows.flatMap(function(slot){return [slot.from_telegram_id,slot.to_telegram_id]}).filter(Boolean).map(String))];
    const people=new Map(await Promise.all(ids.map(async function(id){
      const p=await findApplicantByTelegramId(id).catch(function(){return null});
      const username=String(p?.telegram_username||p?.username||'').replace(/^@/,'');
      return [id,{telegram_id:id,name:p?.name||p?.full_name||'',username:username,url:username?'https://t.me/'+username:'tg://user?id='+encodeURIComponent(id)}];
    })));
    const items=rows.map(function(slot){
      const from=people.get(String(slot.from_telegram_id))||{};const to=people.get(String(slot.to_telegram_id))||{};
      return {...slot,dates:cellToList(slot.dates),courts:cellToList(slot.courts),from_contact:{...from,name:slot.from_name||from.name,username:slot.from_username||from.username,url:slot.from_username?'https://t.me/'+String(slot.from_username).replace(/^@/,''):from.url},to_contact:slot.to_telegram_id?{...to,name:slot.to_name||to.name,username:slot.to_username||to.username,url:slot.to_username?'https://t.me/'+String(slot.to_username).replace(/^@/,''):to.url}:null};
    }).sort(function(a,b){
      // Админ видит матчи в календарном порядке; записи без выбранной даты
      // оставляем внизу, а одинаковую дату упорядочиваем по времени.
      var ad=String(a.agreed_date||a.dates[0]||''),bd=String(b.agreed_date||b.dates[0]||'');
      if(!ad&&!bd)return String(a.created_at||'').localeCompare(String(b.created_at||''));
      if(!ad)return 1;if(!bd)return -1;
      return ad.localeCompare(bd)||String(a.agreed_time||a.time_from||'').localeCompare(String(b.agreed_time||b.time_from||''))||String(a.created_at||'').localeCompare(String(b.created_at||''));
    });
    res.json({ok:true,items:items});
  } catch(e){res.status(500).json({ok:false,error:e.message})}
});

// Афиша-анонс: пара игроков + комментарий из мини-приложения (админская
// вкладка), запуск генерации — сюда; сама картинка и кнопка «В сторис»
// по-прежнему приходят в чат админов, как и у постера результата.
app.post('/api/match/announce-poster', async (req, res) => {
  try {
    const b=req.body||{},v=await matchViewer(b.initData||'',String(b.t||''));
    if(!v.ok)return res.status(v.code).json({ok:false,error:v.error});
    if(!v.isAdmin)return res.status(403).json({ok:false,error:'admin_required'});
    const id1=String(b.player1_id||'').trim(),id2=String(b.player2_id||'').trim();
    if(!id1||!id2||id1===id2)return res.status(400).json({ok:false,error:'players_required'});
    const [p1,p2]=await Promise.all([findApplicantByTelegramId(id1),findApplicantByTelegramId(id2)]);
    if(!p1||!p2)return res.status(404).json({ok:false,error:'player_not_found'});
    const player1={telegram_id:id1,name:String(p1.name||'').trim()};
    const player2={telegram_id:id2,name:String(p2.name||'').trim()};
    let division=String(b.division||'').trim();
    // Дивизион не указали — берём из состава, если оба игрока из одного.
    if(!division){
      const roster=await getAllActiveLeaguePlayers().catch(()=>[]);
      const d1=roster.find(p=>String(p.telegram_id)===id1)?.division||'',d2=roster.find(p=>String(p.telegram_id)===id2)?.division||'';
      if(d1&&d1===d2)division=d1;
    }
    const comment=String(b.comment||'').trim();
    const season=String(await getSetting('season_number').catch(()=>'')||'').trim();
    const chatId=await getAdminChatId().catch(()=>'');
    if(!chatId)return res.status(500).json({ok:false,error:'admin_chat_not_set'});
    res.json({ok:true});
    prepareAnnouncementForAdmin({chatId,player1,player2,division,season,comment})
      .catch(e=>console.error('announce-poster failed:',e.message));
  } catch(e){res.status(500).json({ok:false,error:e.message})}
});

app.get('/api/match/bootstrap', async (req, res) => {
  try {
    const v = await matchViewer(req.query.initData || '', String(req.query.t || ''));
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    const counterId = String(req.query.counter || '');
    const [courts, opponents, openSlots, mySlots, resultTasks] = await Promise.all([
      getCourts(),
      getDivisionOpponents(v.division, v.user.id, v.season, v.matchGroup),
      listOpenSlots(v.division, v.user.id, v.season, v.matchGroup),
      listMySlots(v.user.id),
      v.isAdmin ? allSlots().then(rows => rows.filter(r => String(r.status || '').toLowerCase() === 'accepted' && String(r.result_status || '').trim().toLowerCase() !== 'confirmed' && !String(r.result_confirmed_at || '').trim()).slice(-300)) : listResultTasks(v.user.id)
    ]);
    const contacts=new Map(await Promise.all(mySlots.map(async s=>[s.challenge_id,await matchContact(s,v.user.id)])));
    const byId = new Map(opponents.map(o => [String(o.telegram_id), o]));
    const shape = (s) => ({
      ...s,
      broadcast_msgs: undefined,   // кому разослано окно — служебное, в браузер не отдаём
      dates: cellToList(s.dates),
      courts: cellToList(s.courts),
      from: byId.get(String(s.from_telegram_id)) || null,
      contact:contacts.get(s.challenge_id)||null,
      // Когда матч снимется, если автор так и не подтвердит корт (0 — не грозит).
      court_close_at: courtCloseAt(s) || 0
    });
    res.json({
      ok:true, lang:v.lang, user:{ id:v.user.id, name:v.profile.name }, division:v.division,
      can_match:v.canMatch, match_group:v.matchGroup, season:v.season,
      attention:pendingActionsFor(v.user.id,await allSlots()),
      courts, opponents, duration_min: MATCH_DURATION_MIN, is_admin: v.isAdmin,
      result_after_min: await resultPromptDelayMin().catch(() => 90),
      can_book_court: COURT_BOOKING_OPEN || v.isAdmin,
      unplayed: await getUnplayedOpponents(v.division, v.profile.name, v.season, v.matchGroup).catch(() => ({ known:false, names:[] })),
      open_slots: openSlots.map(shape),
      my_matches: mySlots.map(shape),
      result_tasks: resultTasks.map(shape),
      admin_players: v.isAdmin ? await getAllActiveLeaguePlayers().catch(() => []) : [],
      result_slot: String(req.query.result || ''),
      focus_slot: String(req.query.slot || ''),
      counter_slot: String(req.query.counter || '')
    });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/match/create', async (req, res) => {
  try {
    const b = req.body || {};
    const v = await matchViewer(b.initData || '', String(b.t || ''));
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    if (!v.division) return res.status(400).json({ ok:false, error:'You are not assigned to a division yet.' });
    const dates = (Array.isArray(b.dates) ? b.dates : []).map(d => String(d).trim()).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (!dates.length) return res.status(400).json({ ok:false, error:'Pick at least one date' });
    const timeFrom = String(b.time_from || '').trim();
    const timeTo = String(b.time_to || timeFrom).trim();
    if (!/^\d{2}:\d{2}$/.test(timeFrom)) return res.status(400).json({ ok:false, error:'Time is required' });
    // Длительность матча всегда одна — игрок её не выбирает.
    const duration = MATCH_DURATION_MIN;
    if (hhmmToMin(timeTo) - hhmmToMin(timeFrom) < duration) {
      return res.status(400).json({ ok:false, error:`Time window must be at least ${duration / 60}h long` });
    }
    const courts = (Array.isArray(b.courts) ? b.courts : []).map(c => String(c).trim()).filter(Boolean);
    const isDirect = String(b.match_type || 'open') === 'direct';
    let opponent = null;
    if (isDirect) {
      const list = await getDivisionOpponents(v.division, v.user.id, v.season, v.matchGroup);
      opponent = list.find(o => String(o.telegram_id) === String(b.to_telegram_id));
      if (!opponent) return res.status(400).json({ ok:false, error:'Opponent not found in your division' });
    }
    const slot = {
      challenge_id: uid('match'),
      match_type: isDirect ? 'direct' : 'open',
      status: 'open',
      division: v.division, season:v.season, group:v.matchGroup,
      from_telegram_id: String(v.user.id),
      from_name: v.profile.name || [v.user.first_name, v.user.last_name].filter(Boolean).join(' '),
      from_username: v.user.username || v.profile.telegram_username || '',
      to_telegram_id: isDirect ? String(opponent.telegram_id) : '',
      to_name: isDirect ? opponent.name : '',
      to_username: isDirect ? opponent.username : '',
      dates: listToCell(dates), time_from: timeFrom, time_to: timeTo,
      duration_min: duration, courts: listToCell(courts), comment: safe(b.comment),
      agreed_date:'', agreed_time:'', agreed_court:'',
      created_at: nowISO()
    };
    await createSlot(slot);
    if (isDirect) await sendDirectChallenge(slot).catch(e => console.error('sendDirectChallenge failed:', e.message));
    else await publishOpenSlot(slot).catch(e => console.error('publishOpenSlot failed:', e.message));
    res.json({ ok:true, challenge_id: slot.challenge_id });
  } catch (e) { console.error(e); res.status(500).json({ ok:false, error:e.message }); }
});

// Отвечающий обязан выбрать конкретную дату (и корт, если автор предложил несколько).
app.post('/api/match/take', async (req, res) => {
  try {
    const v = await matchViewer(req.body?.initData || '', String(req.body?.t || ''));
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    if (!v.canMatch && !v.isAdmin) return res.status(403).json({ok:false,error:'division_required'});
    // Два корта на одно время — самая обидная накладка, ловим до согласования.
    const clash = await findTimeConflict(v.user.id, req.body.date, req.body.time, MATCH_DURATION_MIN, req.body.challenge_id)
      .catch(() => null);
    if (clash) {
      return res.status(409).json({ ok:false,
        error: `У вас уже назначен матч на это время (${clash.agreed_date} ${clash.agreed_time}). Выберите другой слот.` });
    }
    const result = await claimSlot(req.body.challenge_id, {
      telegram_id: v.user.id, name: v.profile.name, username: v.user.username || v.profile.telegram_username || ''
    }, { date: req.body.date, court: req.body.court, time: req.body.time }, { allowSelf: v.isAdmin });
    if (!result.ok) {
      const messages = {
        taken:'This slot has just been taken.', own:'This is your own slot.', closed:'This slot is closed.',
        not_for_you:'This challenge is addressed to another player.', not_found:'Slot not found.',
        already_yours:'You have already taken this slot.', bad_date:'Pick one of the offered dates.',
        bad_court:'Pick one of the offered courts.', bad_time:'Pick a time inside the offered window.'
      };
      return res.status(409).json({ ok:false, error: messages[result.reason] || 'Slot unavailable' });
    }
    // Матч ещё не назначен: автор окна должен подтвердить предложенные дату и корт.
    await notifyProposal(result.slot).catch(e => console.error('notifyProposal failed:', e.message));
    res.json({ ok:true, status:'pending' });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

// Встречное предложение: сторона, которая сейчас отвечает, называет свои дату/время/корт.
app.post('/api/match/counter', async (req, res) => {
  try {
    const v = await matchViewer(req.body?.initData || '', String(req.body?.t || ''));
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    if (!v.canMatch && !v.isAdmin) return res.status(403).json({ok:false,error:'division_required'});
    const result = await counterSlot(req.body.challenge_id, { telegram_id: v.user.id, name: v.profile.name },
      { date: req.body.date, time: req.body.time, court: req.body.court });
    if (!result.ok) {
      const messages = { not_found:'Slot not found.', not_pending:'This slot is not awaiting an answer.',
        not_your_turn:'It is the other player\'s turn to answer.', too_many_rounds:'Too many rounds — agree in chat instead.' };
      return res.status(409).json({ ok:false, error: messages[result.reason] || 'Cannot counter' });
    }
    await notifyProposal(result.slot, { isCounter:true }).catch(e => console.error('notifyProposal failed:', e.message));
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});


// ---------------------------------------------------------------------------
// Результаты матчей. Счёт вносит любой из двоих, засчитывается после подтверждения
// соперником. Счёт всегда приводим к порядку «от from_telegram_id».
// ---------------------------------------------------------------------------
function scoreFromBody(sets = []) {
  const out = { s1p1:'', s1p2:'', s1tb1:'', s1tb2:'', s2p1:'', s2p2:'', s2tb1:'', s2tb2:'', s3p1:'', s3p2:'', s3tb1:'', s3tb2:'' };
  sets.slice(0, 3).forEach((set, i) => {
    const n = i + 1;
    const num = (v) => (v === '' || v === null || v === undefined ? '' : String(Number(v)));
    out[`s${n}p1`] = num(set?.a); out[`s${n}p2`] = num(set?.b);
    out[`s${n}tb1`] = num(set?.tba); out[`s${n}tb2`] = num(set?.tbb);
  });
  return out;
}

// Фото приходит из мини-приложения как data URL; отдаём его Telegram и храним file_id.
// Фото уходит в личку игроку, чтобы получить постоянный file_id — дальше карточки
// и лента используют уже его. Сбой загрузки НЕ должен терять внесённый счёт:
// сохраняем результат без фото и предупреждаем игрока.
async function uploadResultPhoto(chatId, dataUrl, caption = '📸 Фото матча', lang = 'ru', statusMode = false) {
  if (!dataUrl || typeof dataUrl !== 'string') return { fileId: '', warning: '' };
  const ru=lang==='ru',savedRu=statusMode?'статус сохранён':'счёт сохранён';
  const m = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!m) return { fileId: '', warning: ru?'Фото не распознано — '+savedRu+' без него.':'The photo was not recognised; the status was saved without it.' };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) throw new Error(ru?'Фото больше 8 МБ — уменьшите размер':'The photo is over 8 MB; please reduce its size');
  try {
    const sent = await sendPhotoBuffer(chatId, buf, m[1], { caption });
    const sizes = sent?.photo || [];
    return { fileId: sizes.length ? sizes[sizes.length - 1].file_id : '', warning: '' };
  } catch (e) {
    console.error('result photo upload failed:', e.message);
    return { fileId: '', warning: ru?'Фото не загрузилось — '+savedRu+' без него.':'The photo could not be uploaded; the status was saved without it.' };
  }
}

app.post('/api/match/unfinished', async (req,res) => {
  try {
    const b=req.body||{},v=await matchViewer(b.initData||'',String(b.t||''));
    if(!v.ok)return res.status(v.code).json({ok:false,error:v.error});
    if(!v.canMatch&&!v.isAdmin)return res.status(403).json({ok:false,error:'division_required'});
    const slot=await findSlot(b.challenge_id);
    if(!slot)return res.status(404).json({ok:false,error:v.lang==='ru'?'Матч не найден.':'Match not found.'});
    const participant=[String(slot.from_telegram_id),String(slot.to_telegram_id)].includes(String(v.user.id));
    if(!participant)return res.status(403).json({ok:false,error:v.lang==='ru'?'Это не ваш матч.':'This is not your match.'});
    let photo={fileId:'',warning:''};
    try {
      photo=await uploadResultPhoto(v.user.id,b.photo,v.lang==='ru'?'📸 Подтверждение: матч не доигран':'📸 Evidence: match unfinished',v.lang,true);
    } catch(e) { return res.status(400).json({ok:false,error:e.message}); }
    const saved=await markMatchUnfinished(b.challenge_id,{telegram_id:v.user.id,name:v.profile.name},{
      note:safe(b.note),photoFileId:photo.fileId
    });
    if(!saved.ok) {
      const ru=v.lang==='ru';
      const errors={
        not_found:ru?'Матч не найден.':'Match not found.',
        not_accepted:ru?'Матч больше не активен.':'The match is no longer active.',
        already_confirmed:ru?'Результат уже подтверждён.':'The result is already confirmed.',
        result_started:ru?'По матчу уже внесён результат.':'A result has already been submitted.',
        match_not_ended:ru?'Матч ещё не должен был завершиться.':'The match is not due to finish yet.',
        not_a_player:ru?'Это не ваш матч.':'This is not your match.'
      };
      return res.status(409).json({ok:false,error:errors[saved.reason]||(ru?'Не удалось изменить статус матча.':'Could not update the match.')});
    }
    const delivered=await notifyMatchUnfinished(saved.slot,{actorId:v.user.id}).catch(e=>{
      console.error('notifyMatchUnfinished failed:',e.message);return null;
    });
    res.json({ok:true,organizer_notified:Boolean(delivered),warning:photo.warning||''});
  } catch(e) { console.error('unfinished match failed:',e);res.status(500).json({ok:false,error:e.message}); }
});

async function finishConfirmedWebResult(slot) {
  const write = await writeConfirmedResult(slot).catch(e => ({ status:'error', reason:e.message }));
  if (write.status === 'error' || (write.division && write.division.status !== 'saved')) {
    await notifyAdmin('Не удалось записать результат '+slot.challenge_id+': '+describeWrite(write)).catch(() => {});
    return { review:true, write:describeWrite(write) };
  }
  if (write.status === 'cross_division_blocked') {
    await notifyCrossDivision(slot, write).catch(e => console.error('notifyCrossDivision failed:',e.message));
    return { review:true, cross_division:true, write:describeWrite(write) };
  }
  invalidateLeagueCache();
  invalidateDivisionCache();
  await notifyResultConfirmed(slot, describeWrite(write)).catch(e => console.error('notifyResultConfirmed failed:',e.message));
  broadcastResult(slot).catch(e => console.error('broadcastResult failed:',e.message));
  return { review:false, write:describeWrite(write) };
}

app.post('/api/match/result/remind', async (req,res) => {
  try {
    const b=req.body||{},v=await matchViewer(b.initData||'',String(b.t||''));
    if(!v.ok)return res.status(v.code).json({ok:false,error:v.error});
    const slot=await findSlot(b.challenge_id);
    if(!slot)return res.status(404).json({ok:false,error:v.lang==='ru'?'Матч не найден.':'Match not found.'});
    if(String(slot.result_status||'').toLowerCase()!=='pending')return res.status(409).json({ok:false,error:v.lang==='ru'?'Результат уже обработан.':'The result has already been processed.'});
    const participant=[String(slot.from_telegram_id),String(slot.to_telegram_id)].includes(String(v.user.id));
    const submitter=String(slot.result_by)===String(v.user.id);
    if(!v.isAdmin&&(!participant||!submitter))return res.status(403).json({ok:false,error:v.lang==='ru'?'Повторно отправить может автор счёта.':'Only the score submitter can resend this request.'});
    const delivered=Boolean(await notifyResultForVerification(slot));
    if(!delivered)return res.status(502).json({ok:false,error:v.lang==='ru'?'Telegram не принял сообщение. Используйте подтверждение в «Моих матчах».':'Telegram did not accept the message. Use confirmation in My matches.'});
    res.json({ok:true});
  } catch(e) { console.error('result confirmation resend failed:',e);res.status(502).json({ok:false,error:e.message}); }
});
// Ручное напоминание: один игрок подталкивает другого, когда тот не нажал
// кнопку. Отправляется ровно то же сообщение, что ушло бы автоматически, —
// чтобы у человека были те же кнопки и он не искал, куда нажимать.
//
// Кого ждём, решает не интерфейс, а сервер: тот же pendingAction, что питает
// автоматические напоминания. Иначе кнопка со временем начала бы будить не того.
const manualNudges = new Map();
const MANUAL_NUDGE_MS = 60 * 60 * 1000;
app.post('/api/match/nudge', async (req,res) => {
  try {
    const b=req.body||{},v=await matchViewer(b.initData||'',String(b.t||''));
    if(!v.ok)return res.status(v.code).json({ok:false,error:v.error});
    const ru=v.lang==='ru';
    const slot=await findSlot(b.challenge_id);
    if(!slot)return res.status(404).json({ok:false,error:ru?'Матч не найден.':'Match not found.'});
    const sides=[String(slot.from_telegram_id),String(slot.to_telegram_id)];
    if(!v.isAdmin&&!sides.includes(String(v.user.id)))return res.status(403).json({ok:false,error:ru?'Это не ваш матч.':'This is not your match.'});
    // self=1 — человек сам открыл экран подтверждения и просит прислать то же
    // сообщение ещё раз: он мог не заметить первое. Тихие часы и лесенку
    // напоминаний это не трогает, повтор ограничен изнутри уведомления.
    if(String(b.self||'')==='1'){
      if(String(slot.result_status||'').toLowerCase()!=='pending')return res.json({ok:true,skipped:true});
      if(String(slot.result_by||'')===String(v.user.id))return res.json({ok:true,skipped:true});
      await notifyResultForVerification(slot,{only:String(v.user.id)}).catch(()=>{});
      return res.json({ok:true,self:true});
    }
    const item=pendingAction(slot);
    if(!item)return res.status(409).json({ok:false,error:ru?'Сейчас никто ничего не ждёт — напоминать не о чем.':'Nothing is pending on this match right now.'});
    const waiting=(item.waitingIds||[]).map(String).filter(Boolean);
    if(!waiting.length)return res.status(409).json({ok:false,error:ru?'Некому напоминать.':'There is nobody to remind.'});
    // Себе не напоминают: если ход за тобой, кнопка бессмысленна.
    if(!v.isAdmin&&waiting.length===1&&waiting[0]===String(v.user.id)) {
      return res.status(409).json({ok:false,error:ru?'Сейчас ход за вами — напоминать нужно не сопернику.':'It is your turn — there is nothing to remind about.'});
    }
    // Ночью повторные напоминания молчат. Ручное — такое же повторное, и будить
    // человека кнопкой было бы обходом того же правила.
    const win=await nightWindow();
    if(isNightHold(Date.now(),TIMEZONE,win)) {
      return res.status(409).json({ok:false,error:ru?'Сейчас тихие часы — напоминания не уходят. Попробуйте утром.':'Quiet hours — reminders are not delivered now. Try in the morning.'});
    }
    const key=`${slot.challenge_id}:${item.scope}`;
    const last=manualNudges.get(key)||0;
    if(Date.now()-last<MANUAL_NUDGE_MS) {
      const left=Math.ceil((MANUAL_NUDGE_MS-(Date.now()-last))/60000);
      return res.status(429).json({ok:false,error:ru?`Напоминание уже отправлено. Следующее можно через ${left} мин.`:`A reminder was already sent. You can send the next one in ${left} min.`});
    }
    const payload={...item,stage:'manual'};
    if(item.scope==='invite'||item.scope==='negotiation')await notifyStuckNegotiation(payload);
    else if(item.scope==='time')await notifyStuckTimeChange(payload);
    else if(item.scope==='court')await notifyStuckCourt(payload);
    else if(item.scope==='score')await notifyStuckScore(payload);
    else if(item.scope==='result')await notifyResultForVerification(slot);
    manualNudges.set(key,Date.now());
    for(const [k,t] of manualNudges) if(Date.now()-t>MANUAL_NUDGE_MS)manualNudges.delete(k);
    res.json({ok:true,scope:item.scope});
  } catch(e) { console.error('manual nudge failed:',e);res.status(502).json({ok:false,error:e.message}); }
});
// «Не согласен» из мини-приложения. Раньше это жило только кнопкой в чате, и
// человек, открывший приложение по старой ссылке, не мог возразить — только
// подтвердить или уйти.
app.post('/api/match/result/dispute', async (req,res) => {
  try {
    const b=req.body||{},v=await matchViewer(b.initData||'',String(b.t||''));
    if(!v.ok)return res.status(v.code).json({ok:false,error:v.error});
    const { disputeResult }=await import('./matchesdb.js');
    const action=await disputeResult(b.challenge_id,{telegram_id:v.user.id,name:v.profile.name});
    if(!action.ok){
      const ru=v.lang==='ru';
      const errors={
        not_found:ru?'Матч не найден.':'Match not found.',
        not_pending:ru?'Результат уже обработан.':'The result has already been processed.',
        own_result:ru?'Свой же счёт оспорить нельзя.':'You cannot dispute your own score.',
        not_a_player:ru?'Это не ваш матч.':'This is not your match.'
      };
      return res.status(409).json({ok:false,error:errors[action.reason]||(ru?'Не удалось отклонить счёт.':'Could not reject the score.')});
    }
    const { notifyResultDisputed }=await import('./matches.js');
    await notifyResultDisputed(action.previous).catch(e=>console.error('notifyResultDisputed failed:',e.message));
    res.json({ok:true});
  } catch(e) { console.error('result dispute failed:',e);res.status(500).json({ok:false,error:e.message}); }
});
app.post('/api/match/result/confirm', async (req,res) => {
  try {
    const b=req.body||{},v=await matchViewer(b.initData||'',String(b.t||''));
    if(!v.ok)return res.status(v.code).json({ok:false,error:v.error});
    const action=v.isAdmin
      ?await confirmResultByAdmin(b.challenge_id,{telegram_id:v.user.id,name:v.profile.name})
      :await confirmResult(b.challenge_id,{telegram_id:v.user.id,name:v.profile.name});
    if(!action.ok){
      const ru=v.lang==='ru';
      const errors={
        not_found:ru?'Матч не найден.':'Match not found.',
        not_pending:ru?'Результат уже обработан.':'The result has already been processed.',
        own_result:ru?'Счёт подтверждает соперник.':'The opponent must confirm the score.',
        not_a_player:ru?'Это не ваш матч.':'This is not your match.'
      };
      return res.status(409).json({ok:false,error:errors[action.reason]||(ru?'Не удалось подтвердить результат.':'Could not confirm the result.')});
    }
    // Счёт от организатора ждёт подписи обоих: первая подпись ничего не пишет
    // в таблицы, только отмечается и уведомляет второго.
    if(action.waiting){
      await notifyResultHalfConfirmed(action.slot,String(v.user.id)).catch(e=>console.error('half confirm notice:',e.message));
      return res.json({ok:true,waiting:true});
    }
    const final=await finishConfirmedWebResult(action.slot);
    res.json({ok:true,review:final.review,cross_division:final.cross_division||false});
  } catch(e) { console.error('web result confirmation failed:',e);res.status(500).json({ok:false,error:e.message}); }
});

app.post('/api/match/delete', async (req,res) => {
  try {
    const b=req.body||{},v=await matchViewer(b.initData||'',String(b.t||''));
    if(!v.ok)return res.status(v.code).json({ok:false,error:v.error});
    if(!v.isAdmin)return res.status(403).json({ok:false,error:'admin_required'});
    const removed=await deleteMatchByAdmin(b.challenge_id,{telegram_id:v.user.id,name:v.profile.name});
    if(!removed.ok){
      const errors={not_found:'Матч не найден.',already_confirmed:'Подтверждённый матч сначала нужно откатить из таблиц.'};
      return res.status(409).json({ok:false,error:errors[removed.reason]||'Не удалось удалить матч.'});
    }
    res.json({ok:true});
  } catch(e) { console.error('admin match deletion failed:',e);res.status(500).json({ok:false,error:e.message}); }
});
app.post('/api/match/result', async (req, res) => {
  try {
    const b=req.body||{},v=await matchViewer(b.initData||'',String(b.t||''));
    if(!v.ok)return res.status(v.code).json({ok:false,error:v.error});
    if(!v.canMatch&&!v.isAdmin)return res.status(403).json({ok:false,error:'division_required'});
    const slot=await findSlot(b.challenge_id);
    if(!slot)return res.status(404).json({ok:false,error:'Match not found'});
    const sides=[String(slot.from_telegram_id),String(slot.to_telegram_id)],participant=sides.includes(String(v.user.id));
    if(!participant&&!v.isAdmin)return res.status(403).json({ok:false,error:'Not your match'});
    // Счёт уже внесён и ждёт подтверждения: второй игрок не переписывает его
    // заново, а подтверждает или жмёт «Не согласен». Иначе result_by менялся
    // местами, и просьба подтвердить прилетала тому, кто счёт и внёс.
    // Организатору править не мешаем: это его инструмент исправления.
    if(String(slot.result_status||'').toLowerCase()==='pending'&&!v.isAdmin
      &&String(slot.result_by||'')!==String(v.user.id)){
      // Человек мог не увидеть уведомление — присылаем его заново.
      notifyResultForVerification(slot,{only:String(v.user.id)}).catch(()=>{});
      return res.status(409).json({ok:false,error:'result_pending_confirm',
        detail:v.lang==='ru'
          ?'Соперник уже внёс счёт — подтвердите его или нажмите «Не согласен».'
          :'Your opponent already submitted the score — confirm it or tap “Disagree”.'});
    }
    const kind=['retired','technical'].includes(String(b.kind||'').toLowerCase())?String(b.kind).toLowerCase():'played';
    if(kind==='technical'&&!v.isAdmin)return res.status(403).json({ok:false,error:'Only the organiser can record W/L'});
    const requestedWinner=String(b.winner||'');
    let winnerId='',storedScore='',set3Mode='';
    if(kind==='technical'){
      if(requestedWinner!=='both'&&!sides.includes(requestedWinner))return res.status(400).json({ok:false,error:'Выберите победителя или результат для обоих'});
      winnerId=requestedWinner==='both'?'':requestedWinner;
      storedScore=requestedWinner==='both'?'L/L':requestedWinner===String(slot.from_telegram_id)?'W/L':'L/W';
    }else{
      let score=scoreFromBody(b.sets);
      if(!sides.includes(requestedWinner))return res.status(400).json({ok:false,error:'Выберите победителя'});
      if(String(b.perspective)==='winner'){
        if(requestedWinner!==String(slot.from_telegram_id))score=reverseScoreSafe(score);
      }else if(participant&&String(v.user.id)!==String(slot.from_telegram_id))score=reverseScoreSafe(score);
      if(kind==='played'){
        const check=validateMatchScore(score);
        if(!check.ok)return res.status(400).json({ok:false,error:check.message});
        winnerId=check.winner==='p1'?String(slot.from_telegram_id):String(slot.to_telegram_id);
        if(requestedWinner!==winnerId)return res.status(400).json({ok:false,error:'Указанный победитель не совпадает со счётом'});
      }else{
        if(!Array.isArray(b.sets)||!b.sets.length)return res.status(400).json({ok:false,error:'Для RET укажите сыгранный счёт'});
        winnerId=requestedWinner;
      }
      storedScore=formatScore(score)+(kind==='retired'?' RET':'');
      set3Mode=detectSet3Mode(score);
    }
    const validPoint=x=>['0','1','3'].includes(String(x));
    const fromWon=winnerId===String(slot.from_telegram_id),both=!winnerId&&kind==='technical';
    const pointsFrom=v.isAdmin&&kind!=='played'&&validPoint(b.points_from)?Number(b.points_from):(both?0:fromWon?3:kind==='played'?'':kind==='retired'?1:0);
    const pointsTo=v.isAdmin&&kind!=='played'&&validPoint(b.points_to)?Number(b.points_to):(both?0:fromWon?(kind==='played'?'':kind==='retired'?1:0):3);
    let photo={fileId:'',warning:''};
    try{photo=await uploadResultPhoto(v.user.id,b.photo)}catch(e){return res.status(400).json({ok:false,error:e.message})}
    const enteredByOrganiser=v.isAdmin&&!participant;
    const payload={winner:winnerId,score:storedScore,set3Mode,kind,pointsFrom,pointsTo,photoFileId:photo.fileId,note:safe(b.note),
      submitter:enteredByOrganiser?String(v.user.id):String(slot.from_telegram_id)};
    const saved=v.isAdmin
      ?await submitResultByAdmin(b.challenge_id,{telegram_id:v.user.id,name:v.profile.name},payload)
      :await submitResult(b.challenge_id,{telegram_id:v.user.id,name:v.profile.name},payload);
    if(!saved.ok){const messages={not_found:'Match not found.',not_accepted:'Match is not agreed.',already_confirmed:'Result already confirmed.',not_a_player:'Not your match.',different_group:'different_group',league_access_denied:'league_access_denied',division_required:'division_required'};console.warn(`result not saved: ${b.challenge_id} — ${saved.reason}`);return res.status(409).json({ok:false,error:messages[saved.reason]||'Cannot save result'})}
    let confirmationDelivered=false;
    try { confirmationDelivered=Boolean(await notifyResultForVerification(saved.slot)); }
    catch(e) { console.error('notifyResultForVerification failed:',e.message); }
    const deliveryWarning=confirmationDelivered?'':(v.lang==='ru'
      ?'Счёт сохранён, но сообщение сопернику не доставлено. Он всё равно увидит подтверждение в «Моих матчах».'
      :'The score was saved, but the message was not delivered. Your opponent can still confirm it in My matches.');
    res.json({ok:true,score:saved.slot.result_score,confirmation_delivered:confirmationDelivered,
      warning:[photo.warning,deliveryWarning].filter(Boolean).join(' ')});
  }catch(e){
    console.error('match result failed:',e.message);
    // Счёт не сохранился даже после ожидания — организатор узнаёт сразу, а не
    // из жалобы игрока: можно внести вручную.
    const b=req.body||{};
    notifyAdmin(`<b>⚠️ Счёт не сохранился</b>\n\nМатч: <code>${escapeHtml(String(b.challenge_id||''))}</code>\nСчёт: ${escapeHtml(JSON.stringify(b.sets||[]).slice(0,200))}\nПричина: ${escapeHtml(String(e.message||'').slice(0,200))}\n\nИгрок видит просьбу повторить через минуту.`).catch(()=>{});
    res.status(500).json({ok:false,error:e.message});
  }
});

// Матч, сыгранный вне бота. Игрок выбирает соперника своей группы; организатор
// может выбрать любую пару одного дивизиона. В обоих случаях второй игрок
// подтверждает результат до записи в таблицы.
app.post('/api/match/manual', async (req,res)=>{
  try{
    const b=req.body||{},v=await matchViewer(b.initData||'',String(b.t||''));
    if(!v.ok)return res.status(v.code).json({ok:false,error:v.error});
    let from,to,division,season,group;
    if(v.isAdmin&&b.from_telegram_id){
      const all=await getAllActiveLeaguePlayers(),byId=new Map(all.map(p=>[String(p.telegram_id),p]));
      from=byId.get(String(b.from_telegram_id));to=byId.get(String(b.to_telegram_id));
      if(!from||!to||String(from.telegram_id)===String(to.telegram_id))return res.status(400).json({ok:false,error:'Выберите двух разных игроков'});
      if(String(from.division).toUpperCase()!==String(to.division).toUpperCase())return res.status(400).json({ok:false,error:'Игроки должны быть из одного дивизиона'});
      division=from.division;season=from.season||to.season;group=String(from.group||'')===String(to.group||'')?from.group:'cross';
    }else{
      if(!v.division)return res.status(400).json({ok:false,error:'You are not assigned to a division yet.'});
      const opponents=await getDivisionOpponents(v.division,v.user.id,v.season,v.matchGroup);
      to=opponents.find(o=>String(o.telegram_id)===String(b.to_telegram_id));
      if(!to)return res.status(400).json({ok:false,error:'Opponent not found in your division'});
      from={telegram_id:String(v.user.id),name:v.profile.name,username:v.user.username||v.profile.telegram_username||''};
      division=v.division;season=v.season;group=v.matchGroup;
    }
    const date=String(b.date||'').trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return res.status(400).json({ok:false,error:'Date is required'});
    const sides=[String(from.telegram_id),String(to.telegram_id)],kind=['retired','technical'].includes(String(b.kind||'').toLowerCase())?String(b.kind).toLowerCase():'played';
    if(kind==='technical'&&!v.isAdmin)return res.status(403).json({ok:false,error:'Only the organiser can record W/L'});
    const requestedWinner=String(b.winner||'');
    let winnerId='',storedScore='',set3Mode='';
    if(kind==='technical'){
      if(requestedWinner!=='both'&&!sides.includes(requestedWinner))return res.status(400).json({ok:false,error:'Выберите победителя или результат для обоих'});
      winnerId=requestedWinner==='both'?'':requestedWinner;
      storedScore=requestedWinner==='both'?'L/L':requestedWinner===sides[0]?'W/L':'L/W';
    }else{
      let score=scoreFromBody(b.sets);
      if(!sides.includes(requestedWinner))return res.status(400).json({ok:false,error:'Выберите победителя'});
      if(requestedWinner!==sides[0])score=reverseScoreSafe(score);
      if(kind==='played'){
        const check=validateMatchScore(score);if(!check.ok)return res.status(400).json({ok:false,error:check.message});
        winnerId=check.winner==='p1'?sides[0]:sides[1];
        if(winnerId!==requestedWinner)return res.status(400).json({ok:false,error:'Указанный победитель не совпадает со счётом'});
      }else{
        if(!Array.isArray(b.sets)||!b.sets.length)return res.status(400).json({ok:false,error:'Для RET укажите сыгранный счёт'});
        winnerId=requestedWinner;
      }
      storedScore=formatScore(score)+(kind==='retired'?' RET':'');set3Mode=detectSet3Mode(score);
    }
    const validPoint=x=>['0','1','3'].includes(String(x)),fromWon=winnerId===sides[0],both=!winnerId&&kind==='technical';
    const pointsFrom=v.isAdmin&&kind!=='played'&&validPoint(b.points_from)?Number(b.points_from):(both?0:fromWon?3:kind==='played'?'':kind==='retired'?1:0);
    const pointsTo=v.isAdmin&&kind!=='played'&&validPoint(b.points_to)?Number(b.points_to):(both?0:fromWon?(kind==='played'?'':kind==='retired'?1:0):3);
    let photo={fileId:'',warning:''};try{photo=await uploadResultPhoto(v.user.id,b.photo)}catch(e){return res.status(400).json({ok:false,error:e.message})}
    const row={challenge_id:uid('match'),match_type:'manual',status:'accepted',division,season,group,
      from_telegram_id:sides[0],from_name:from.name,from_username:from.username||'',
      to_telegram_id:sides[1],to_name:to.name,to_username:to.username||'',
      dates:date,time_from:'',time_to:'',duration_min:MATCH_DURATION_MIN,courts:safe(b.court).slice(0,60),comment:'',
      agreed_date:date,agreed_time:safe(b.time),agreed_court:safe(b.court).slice(0,60),pending_by:'',round:v.isAdmin?safe(b.round):'',
      result_status:'pending',result_by:(v.isAdmin&&!sides.includes(String(v.user.id)))?String(v.user.id):sides[0],
      result_winner:winnerId,result_score:storedScore,result_set3_mode:set3Mode,
      result_kind:kind,result_points_from:pointsFrom,result_points_to:pointsTo,
      result_photo_file_id:photo.fileId,result_note:safe(b.note),result_submitted_at:nowISO(),created_at:nowISO(),responded_at:nowISO()};
    // Тот же матч (пара + дата) уже внесён — второй раз не принимаем.
    const same=await findSameResult(row.from_telegram_id,row.to_telegram_id,row.agreed_date).catch(()=>null);
    if(same)return res.status(409).json({ok:false,error:v.lang==='ru'?'Результат этого матча уже внесён ('+same.agreed_date+'). Если он неверный — исправьте или удалите его, а не вносите заново.':'This match result is already recorded ('+same.agreed_date+'). Edit or delete it instead of entering it again.'});
    await createManualMatch(row);
    let confirmationDelivered=false;
    try { confirmationDelivered=Boolean(await notifyResultForVerification(row)); }
    catch(e) { console.error('notifyResultForVerification failed:',e.message); }
    const deliveryWarning=confirmationDelivered?'':(v.lang==='ru'
      ?'Матч сохранён, но сообщение сопернику не доставлено. Он всё равно увидит подтверждение в «Моих матчах».'
      :'The match was saved, but the message was not delivered. Your opponent can still confirm it in My matches.');
    res.json({ok:true,challenge_id:row.challenge_id,confirmation_delivered:confirmationDelivered,
      warning:[photo.warning,deliveryWarning].filter(Boolean).join(' ')});
  }catch(e){console.error(e);res.status(500).json({ok:false,error:e.message})}
});


// Витрина лиги: годовая гонка, список игроков, карточка игрока.
// Пока открыта только админу — включим всем, когда утвердим вид.
// События лиги для витрины: список карточек со свободными местами и статусом
// самого игрока. Записываться и платить он будет в боте — там кнопки и оплата.
app.get('/api/league/events', async (req, res) => {
  try {
    const v = await leagueViewer(String(req.query.initData || ''), String(req.query.t || ''), { allowGuest:true, lang:String(req.query.lang || '') });
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    const { eventsForViewer } = await import('./eventflow.js');
    const { getBalance } = await import('./events.js');
    const tg = v.user?.id || '';
    const applicant = tg ? await findApplicantByTelegramId(tg).catch(() => null) : null;
    const isActive = Boolean(v.isLeagueMember);
    const [events, balance] = await Promise.all([
      eventsForViewer(tg, isActive, !!v.isAdmin).catch(() => []),
      tg ? getBalance(tg).catch(() => 0) : 0
    ]);
    res.json({ ok:true, events, balance, is_admin: !!v.isAdmin });
  } catch (e) {
    console.error('league events failed:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Запись и отмена прямо из мини-приложения. Сама логика — та же, что по кнопке
// в боте: счёт, лист ожидания, возврат по правилу отмены. Меняется только точка
// входа, поэтому ветку в боте не трогаем.
app.post('/api/league/event-join', async (req, res) => {
  try {
    const v = await leagueViewer(String(req.body.initData || ''), String(req.body.t || ''));
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    const { joinEvent, invoiceText, invoiceKeyboard } = await import('./eventflow.js');
    const { getBalance } = await import('./events.js');
    const { getAdminChatId } = await import('./admin.js');
    const { sendMessage } = await import('./telegram.js');
    const lang = v.lang === 'ru' ? 'ru' : 'en';
    const applicant = await findApplicantByTelegramId(v.user.id).catch(() => null);
    const name = applicant?.name || v.profile?.name || String(v.user.id);
    const adminChatId = await getAdminChatId().catch(() => '');
    const group = await playerGroup(v.user.id, applicant).catch(() => 'guest');
    const r = await joinEvent({ telegramId: v.user.id, name, lang,
      eventId: String(req.body.event_id || ''), adminChatId, group });
    // Отказ с кнопкой («Подать заявку») уходит в бот: web_app-кнопку в мини-апп
    // не отдать, а в чате она откроет форму в один тап.
    if (!r.ok) {
      if (r.markup) await sendMessage(v.user.id, r.message, { reply_markup: r.markup }).catch(() => {});
      return res.json({ ok:false, error: r.error || r.message });
    }
    // Счёт и подтверждение уходят в бот — там оплата и скриншоты.
    if (r.message) await sendMessage(v.user.id, r.message, r.markup ? { reply_markup: r.markup } : {}).catch(() => {});
    else {
      const balance = await getBalance(v.user.id).catch(() => 0);
      await sendMessage(v.user.id, await invoiceText(r.event, r.signup, lang, balance),
        { reply_markup: invoiceKeyboard(r.event, r.signup, lang, balance) }).catch(() => {});
    }
    res.json({ ok:true, status: r.signup?.status || '' });
  } catch (e) {
    console.error('event join failed:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.post('/api/league/event-cancel', async (req, res) => {
  try {
    const v = await leagueViewer(String(req.body.initData || ''), String(req.body.t || ''));
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    const { cancelSignup } = await import('./eventflow.js');
    const { getAdminChatId } = await import('./admin.js');
    const { sendMessage } = await import('./telegram.js');
    const lang = v.lang === 'ru' ? 'ru' : 'en';
    const applicant = await findApplicantByTelegramId(v.user.id).catch(() => null);
    const adminChatId = await getAdminChatId().catch(() => '');
    const r = await cancelSignup({ signupId: String(req.body.signup_id || ''),
      telegramId: v.user.id, name: applicant?.name || String(v.user.id),
      lang, keepGuests: false, adminChatId });
    if (r?.message) await sendMessage(v.user.id, r.message).catch(() => {});
    res.json({ ok: r?.ok !== false, error: r?.ok === false ? r.message : '' });
  } catch (e) {
    console.error('event cancel failed:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Организатор правит состав из карточки события. Сам бот спрашивает, что делать
// с оплатой или возвратом, — здесь только отправляем ему вопрос.
app.post('/api/league/event-roster', async (req, res) => {
  try {
    const v = await leagueViewer(String(req.body.initData || ''), String(req.body.t || ''));
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    if (!v.isAdmin) return res.status(403).json({ ok:false, error:'Только для организатора' });
    const { askAddToEvent, askRemoveFromEvent } = await import('./admin.js');
    const action = String(req.body.action || '');
    const chatId = v.user.id;
    if (action === 'add') {
      // В витрине телеграм-id нет, поэтому из карточки приходит имя — ищем его
      // среди игроков, у кого есть анкета.
      let telegramId = String(req.body.telegram_id || '').trim();
      if (!telegramId) {
        const name = String(req.body.player_name || '').trim().toLowerCase();
        const { rows } = await getRows(SHEETS.applicants, { useCache: false });
        const hit = rows.find(r => String(r.name || '').trim().toLowerCase() === name);
        if (!hit) return res.status(404).json({ ok:false, error:'Игрок не найден в анкетах' });
        telegramId = String(hit.telegram_id || '');
      }
      await askAddToEvent(chatId, String(req.body.event_id || ''), telegramId);
    }
    else if (action === 'remove') await askRemoveFromEvent(chatId, String(req.body.signup_id || ''));
    else return res.status(400).json({ ok:false, error:'Неизвестное действие' });
    res.json({ ok:true });
  } catch (e) {
    console.error('event roster failed:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Касса игрока: баланс и история операций. Показывается, только когда деньги
// на депозите уже появились — обычно после первого возврата.
// Страница для Apple Calendar: отдаёт .ics и сама его открывает. Telegram не
// умеет прикреплять файл к кнопке, поэтому идём через маленькую web_app-страницу —
// ровно как в тренерском боте.


app.get('/api/league/wallet', async (req, res) => {
  try {
    const v = await leagueViewer(String(req.query.initData || ''), String(req.query.t || ''));
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    const { getBalance, transactionsOf } = await import('./events.js');
    const { TOPUP_MIN, TOPUP_PRESETS } = await import('./eventflow.js');
    const [balance, history] = await Promise.all([
      getBalance(v.user.id).catch(() => 0),
      transactionsOf(v.user.id).catch(() => [])
    ]);
    res.json({ ok:true, balance, history, min: TOPUP_MIN, presets: TOPUP_PRESETS });
  } catch (e) {
    console.error('wallet failed:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Запрос на пополнение: счёт с реквизитами уходит в бот, там же игрок шлёт чек.
app.post('/api/league/wallet-topup', async (req, res) => {
  try {
    const v = await leagueViewer(String(req.body.initData || ''), String(req.body.t || ''));
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    const { startTopup, TOPUP_MIN } = await import('./eventflow.js');
    const amount = Math.round(Number(req.body.amount) || 0);
    if (amount < TOPUP_MIN) return res.status(400).json({ ok:false, error:`Минимум ${TOPUP_MIN} ฿` });
    const applicant = await findApplicantByTelegramId(v.user.id).catch(() => null);
    await startTopup({ telegramId: v.user.id, name: applicant?.name || '', amount,
      lang: v.lang === 'ru' ? 'ru' : 'en', chatId: v.user.id });
    res.json({ ok:true });
  } catch (e) {
    console.error('wallet topup failed:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Общая часть витрины лиги одинакова для всех, кто её открывает: игроки, фото,
// история матчей, события, сезоны, дивизионы и живые места. Собирается она
// тяжело — десятки чтений таблиц, — поэтому считается один раз и живёт в памяти.
// Устаревшее отдаётся сразу, а пересчёт идёт в фоне; после подтверждённого
// результата снимок сбрасывается принудительно, чтобы там, где свежесть реально
// нужна, она была мгновенной.
const LEAGUE_SNAPSHOT_MS = 10 * 60 * 1000;
const leagueSnapshot = { t: 0, v: null, building: null };
// После результата снимок не выбрасываем: пока собирается новый (5–7 секунд
// чтения таблиц), все видят прежний, а не ждут. Новый собирается сразу,
// одним заходом, даже если сбросов пришло несколько подряд.
let snapshotGen = 0, snapshotKick = null;
export function invalidateLeagueSnapshot() {
  leagueSnapshot.t = 0;
  snapshotGen++;
  if (snapshotKick) return;
  snapshotKick = setTimeout(() => { snapshotKick = null; withPriority('normal', () => getLeagueSnapshot()).catch(() => {}); }, 3000);
  snapshotKick.unref?.();
}
async function buildLeagueSnapshot() {
  const started = Date.now();
    const [rawPlayers, history, events, seasonList] = await Promise.all([
      getLeagueProfiles(),
      getLeagueMatchHistory().catch(() => new Map()),
      getLeagueEvents().catch(() => []),
      getSeasons().catch(() => [])
    ]);
    // У каждого сезона свой набор дивизионов: у прошедших таблицы есть,
    // у будущего пока пусто — фронт покажет заглушку вместо таблицы.
    const seasons = [];
    for (const s of seasonList) {
      seasons.push({ ...s, divisions: await availableDivisions(s.number).catch(() => []) });
    }
    // Аватарку, утверждённую организатором, подставляем поверх того, что стоит в
    // таблице витрины: так мы не трогаем чужие формулы, а замена мгновенно
    // откатывается сменой статуса в анкете.
    const avatarOwners = await publishedAvatars().catch(() => new Map());
    const masterPortraits = await getMasterPhotos();
    const portraitKey = name => String(name || '').trim().toLowerCase();
    const portrait = name => [...masterPortraits].find(([n]) => portraitKey(n) === portraitKey(name))?.[1] || '';
    const players = rawPlayers.map(pl => {
      const tg = avatarOwners.get(String(pl.name || '').trim().toLowerCase());
      return { ...pl, photo:tg ? `${PUBLIC_URL}/avatar/${tg}.png` : portrait(pl.name) };
    });
    // Фото по имени для тех, кого нет в витрине: таблицы дивизионов собираются
    // в начале сезона и новых игроков не знают. Основа — Players_Master, поверх —
    // аватарка, которую игрок сделал сам и которую утвердил организатор.
    const masterPhotos = await getMasterPhotos().catch(() => new Map());
    const photoByName = {};
    const nameKey = (v) => String(v || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    for (const [name, url] of masterPhotos.entries()) {
      const key = nameKey(name);
      if (key) photoByName[key] = url;
    }
    for (const pl of players) {
      const key = nameKey(pl.name);
      if (key && pl.photo) photoByName[key] = pl.photo;
    }
    const current = seasons.filter(s => s.divisions.length).pop() || seasons[seasons.length - 1] || null;
    const divisions = current ? current.divisions : [];
    // Место в дивизионе и счёт сезона — из живых таблиц дивизионов, а не из
    // витрины: после матча они меняются сразу, витрина же ждёт импорт.
    // Витрина остаётся запасным вариантом для тех, кого в таблице нет.
    try {
      const { livePlaces, placeKey } = await import('./division.js');
      const places = await livePlaces(current ? current.number : '');
      const key = placeKey;
      let matched = 0;
      for (const pl of players) {
        const live = places.get(key(pl.name));
        if (!live) continue;
        pl.division_position = live.place;
        // Плитки под аватаркой — статистика за всю историю лиги, её не трогаем.
        // Счёт текущего сезона кладём отдельными полями: он нужен только строке
        // идущего сезона в истории дивизионов.
        pl.season_matches = live.matches;
        pl.season_wins = live.wins;
        pl.season_losses = live.losses;
        pl.live_stats = true;
        matched++;
      }
      console.log(`live places: season=${current ? current.number : '-'} rows=${places.size} matched=${matched}/${players.length}`);
      if (places.size && !matched) {
        console.warn('live places: имена витрины не совпали с таблицами дивизионов; примеры ' +
          JSON.stringify({ table: [...places.keys()].slice(0, 5), showcase: players.slice(0, 5).map(p => key(p.name)) }));
      }
    } catch (e) { console.error('live places failed:', e.message); }
    // История матчей отдаётся отдельным словарём id → матчи: так карточка любого
    // игрока открывается мгновенно, без второго запроса на сервер.
    // Корт в журнал результатов не пишется, поэтому история его не знает.
    // Достаём его из листа матчей и подставляем по «дата + пара имён»; если
    // даты записаны по-разному, спасает запасной ключ по одной только паре —
    // дважды с одним соперником в один сезон играют редко.
    const courtMap = await courtsByPlayedMatch().catch(() => new Map());
    const byPair = new Map();
    for (const [key, court] of courtMap.entries()) {
      const pair = key.split('|').slice(1).join('|');
      if (byPair.has(pair) && byPair.get(pair) !== court) byPair.set(pair, '');
      else if (!byPair.has(pair)) byPair.set(pair, court);
    }
    const nameById = new Map(players.map(pl => [String(pl.id), pl.name]));
    // Фотография соперника в истории приходит из таблицы и остаётся старой даже
    // после того, как человек сделал новую аватарку. Подменяем её тем же
    // адресом, что и в списке игроков, — иначе аватарка обновляется не везде.
    const avatarUrlFor = (name) => {
      const tg = avatarOwners.get(String(name || '').trim().toLowerCase());
      return tg ? `${PUBLIC_URL}/avatar/${tg}.png` : '';
    };
    const matches = {};
    for (const [pid, list] of history.entries()) {
      const me = nameById.get(String(pid)) || '';
      matches[pid] = list.map(m => {
        const patch = {};
        if (me) {
          const exact = courtMap.get(courtKey(m.date, me, m.opponent));
          const loose = exact ? '' : byPair.get(courtKey('', me, m.opponent).slice(1));
          const court = exact || loose || '';
          if (court) patch.court = court;
        }
        const photo = avatarUrlFor(m.opponent);
        patch.opponent_photo = photo || portrait(m.opponent);
        return Object.keys(patch).length ? { ...m, ...patch } : m;
      });
    }
  console.log(`league snapshot: собран за ${Date.now() - started} мс, игроков ${players.length}`);
  return { seasons, players, photoByName, matches, events, divisions, current };
}
async function getLeagueSnapshot() {
  const stale = !leagueSnapshot.v || Date.now() - leagueSnapshot.t >= LEAGUE_SNAPSHOT_MS;
  if (stale && !leagueSnapshot.building) {
    // Есть прошлый снимок — пересборка фоновая и не отнимает лимит у людей.
    const gen = snapshotGen;
    leagueSnapshot.building = withPriority(leagueSnapshot.v && leagueSnapshot.t ? 'low' : 'normal', buildLeagueSnapshot)
      // Пока собирали, пришёл новый результат — снимок годится, но сразу устарел.
      .then(v => { leagueSnapshot.v = v; leagueSnapshot.t = gen === snapshotGen ? Date.now() : 0; return v; })
      .finally(() => { leagueSnapshot.building = null; });
    leagueSnapshot.building.catch(e => console.error('league snapshot failed:', e.message));
  }
  // Есть хоть что-то — отдаём немедленно, даже если оно устарело.
  return leagueSnapshot.v || leagueSnapshot.building;
}

// Меню для страниц, которые живут отдельно от витрины лиги («Мои матчи»):
// те же вкладки, что видит этот человек в лиге, одним лёгким запросом.
app.get('/api/league/nav', async (req, res) => {
  try {
    const v = await leagueViewer(String(req.query.initData || ''), String(req.query.t || ''), { allowGuest:true, lang:String(req.query.lang || '') });
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    const group = v.anonymous ? 'guest' : await playerGroup(v.user.id, v.profile).catch(() => 'guest');
    const tabs = v.isAdmin ? MINIAPP_TABS.slice() : await getGroupTabs(group).catch(() => MINIAPP_TABS.slice());
    const fantasy = v.guest ? { allowed:false } : await fantasyAccessFor({ telegramId:v.user.id, name:v.profile.name || '', username:v.profile.telegram_username || v.user.username || '', isAdmin:v.isAdmin, isLeagueMember:v.isPlayersMasterMember }).catch(() => ({ allowed:false }));
    res.json({ ok:true, lang:v.lang, tabs: fantasy.allowed ? tabs : tabs.filter(t => t !== 'fantasy'),
      can_match: Boolean(v.canMatch), is_admin: Boolean(v.isAdmin), guest: Boolean(v.guest), anonymous: Boolean(v.anonymous) });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.get('/api/league/bootstrap', async (req, res) => {
  const startedAt = Date.now();
  try {
    const v = await leagueViewer(String(req.query.initData || ''), String(req.query.t || ''), { allowGuest:true, lang:String(req.query.lang || '') });
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    const { seasons, players, photoByName, matches, events, divisions, current } = await getLeagueSnapshot();
    // Партнёров держим отдельно от общего снимка: лист правится руками, и ждать
    // общего пересчёта ради новой строки незачем — свой кэш у них короче.
    // Подписи страницы приходят оттуда же, чтобы текст правился без деплоя.
    const [partners, partnerTexts] = await Promise.all([
      getPartners().catch(() => []),
      getPartnersPageTexts().catch(() => ({}))
    ]);
    // Нижнее меню зависит от того, кто смотрит: у гостя нет смысла в матчах и
    // расписании, у активного игрока — есть. Организатор видит всё.
    const group = v.anonymous ? 'guest' : await playerGroup(v.user.id, v.profile).catch(() => 'guest');
    // Организатору отдаём всё, иначе он сам себе отрежет доступ. Но с ?as=<группа>
    // он может посмотреть приложение ровно так, как его видит эта группа.
    const asGroup = String(req.query.as || '').trim();
    const viewAs = v.isAdmin && PLAYER_GROUPS.includes(asGroup) ? asGroup : '';
    const tabs = (v.isAdmin && !viewAs)
      ? MINIAPP_TABS.slice()
      : await getGroupTabs(viewAs || group).catch(() => MINIAPP_TABS.slice());
    const fantasyAccess = v.guest ? { allowed:false } : await fantasyAccessFor({ telegramId:v.user.id, name:v.profile.name || '', username:v.profile.telegram_username || v.user.username || '', isAdmin:v.isAdmin, isLeagueMember:v.isPlayersMasterMember }).catch(() => ({ allowed:false }));
    // Fantasy — самая тяжёлая часть ответа: составы, цены, очки по всем игрокам
    // и чтение листа команд мимо кэша. Держать из-за неё закрытым весь интерфейс
    // незачем: по умолчанию не считаем, приложение рисуется сразу, а очки
    // догружаются вторым запросом и подставляются на месте.
    // Apply the Players_Master + TEST gate to every Fantasy surface.
    const wantFantasy = String(req.query.with_fantasy || '') === '1';
    const fantasy = fantasyAccess.allowed && wantFantasy
      ? await getFantasyBootstrap(v.user.id, v.profile.name || '', v.lang, fantasyAccess.mode)
        .catch(e => { console.error('league fantasy:', e.message); return null; }) : null;
    console.log(`league bootstrap: ${Date.now() - startedAt} мс${wantFantasy ? ', с Fantasy' : ''}`);
    res.json({
      ok: true,
      lang: v.lang,
      user: v.anonymous ? null : { id: v.user.id, name: v.profile.name || [v.user.first_name, v.user.last_name].filter(Boolean).join(' ') },
      // Гость видит интерфейс целиком, но без Fantasy и личного; кнопка анкеты
      // висит сверху. anonymous — зашёл на сайт без входа через Telegram.
      guest: Boolean(v.guest), anonymous: Boolean(v.anonymous), needs_profile: Boolean(v.needsProfile),
      bot_username: webBotName(),
      season: current ? current.number : (await getSetting('season_number').catch(() => '')),
      seasons,
      me_division: v.division || '',
      me_group:v.matchGroup, can_match:v.canMatch,
      group,
      view_as: viewAs,
      // Организатору приложение показывает свои служебные вкладки (тестовая
      // главная). В режиме «глазами группы» их нет — там всё как у игроков.
      is_admin: Boolean(v.isAdmin && !viewAs),
      tabs: fantasyAccess.allowed ? tabs : tabs.filter(t => t !== 'fantasy'),
      fantasy_allowed: Boolean(fantasyAccess.allowed),
      // Приложение по этому флагу знает, что очки сейчас подтянутся отдельно.
      fantasy_deferred: Boolean(fantasyAccess.allowed && !wantFantasy),
      players,
      photos: photoByName,
      matches,
      events,
      divisions,
      partners,
      partner_texts: partnerTexts,
      fantasy
    });
  } catch (e) {
    console.error('league bootstrap failed:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Готовый вариант очередь показывает самому игроку — он и выбирает.
setAvatarHandler(notifyAvatarVariant);

// ------------------------------------------------------------------ аватарки
// Селфи приходит из мини-приложения картинкой в base64 — тем же способом, что
// и фото результата матча. Отдаём его Telegram, а file_id кладём в анкету:
// Telegram и есть наше хранилище картинок.
const AVATAR_MAX_BYTES = 8 * 1024 * 1024;
function decodeDataUrl(value = '') {
  const m = String(value).match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!m) throw new Error('Ожидается изображение');
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length) throw new Error('Пустой файл');
  if (buffer.length > AVATAR_MAX_BYTES) throw new Error('Фото больше 8 МБ — сожми его или сними заново');
  return { buffer, mime: m[1] };
}

// Что показывать игроку на экране аватарки.
function avatarView(profile = {}) {
  const status = String(profile.avatar_status || '').toLowerCase();
  const attempts = Number(profile.avatar_attempts || 0);
  return {
    status,
    attempts,
    attempts_left: Math.max(0, MAX_ATTEMPTS - attempts),
    stub: String(profile.avatar_stub || '') === 'yes',
    error: profile.avatar_error || '',
    has_selfie: Boolean(profile.selfie_file_id),
    url: profile.avatar_file_id ? `${PUBLIC_URL}/avatar/${encodeURIComponent(profile.telegram_id)}.png` : '',
    generator_ready: avatarReady(),
    queue: queueLength()
  };
}

app.get('/api/avatar/status', async (req, res) => {
  try {
    const v = await leagueViewer(String(req.query.initData || ''), String(req.query.t || ''));
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    res.json({ ok:true, ...avatarView({ ...v.profile, telegram_id: v.profile.telegram_id || v.user.id }) });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/avatar/upload', async (req, res) => {
  try {
    const b = req.body || {};
    const v = await leagueViewer(b.initData || '', String(b.t || ''));
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    if (!v.profile?.telegram_id && !v.user?.id) return res.status(404).json({ ok:false, error:'Профиль не найден' });
    const telegramId = String(v.profile.telegram_id || v.user.id);
    const attempts = Number(v.profile.avatar_attempts || 0);
    // Лимит попыток считаем ДО генерации: иначе один человек может крутить
    // платный генератор сколько угодно.
    if (attempts >= MAX_ATTEMPTS && !v.isAdmin) {
      return res.status(429).json({ ok:false, error:`Попытки закончились (${MAX_ATTEMPTS}). Напиши организатору, он откроет ещё.` });
    }
    const { buffer, mime } = decodeDataUrl(b.photo);
    await ensureAvatarColumns().catch(() => {});
    const sent = await sendPhotoBuffer(telegramId, buffer, mime, { caption: '📸 Селфи принято. Пришлю аватарку, как будет готова.' });
    const fileId = (sent?.photo || []).slice(-1)[0]?.file_id || '';
    if (!fileId) throw new Error('Telegram не принял фото');
    await updateApplicantByTelegramId(telegramId, {
      selfie_status: 'received', selfie_file_id: fileId, selfie_received_at: nowISO(),
      avatar_status: AVATAR_STATUS.queued, avatar_error: '', avatar_updated_at: nowISO()
    });
    const job = await enqueueAvatar(telegramId);
    res.json({ ok:true, queued:true, position: job.position || 1 });
  } catch (e) { console.error('avatar upload failed:', e.message); res.status(400).json({ ok:false, error:e.message }); }
});

// Картинка для витрины. Постоянный адрес: при перегенерации меняется
// содержимое, а ссылка остаётся прежней.
const avatarCache = new Map();
const avatarFileOf = new Map();   // telegram id → file_id последней известной аватарки
// Instagram не принимает файл — он скачивает картинку по ссылке. Держим её в
// памяти полчаса и отдаём здесь; после публикации ссылка умирает сама.
app.get('/ig/:id.jpg', (req, res) => {
  const item = takeMedia(String(req.params.id || ''));
  if (!item) return res.status(404).send('expired');
  res.set('Content-Type', item.mime || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=600');
  return res.send(item.buffer);
});

app.get('/avatar/:id.png', async (req, res) => {
  try {
    const id = String(req.params.id || '').replace(/\.png$/, '');
    // Витрина запрашивает аватарки пачкой. Если таблица сейчас не читается
    // (лимит Google), берём файл, который уже знали для этого игрока.
    let fileId = '';
    try {
      const profile = await findApplicantByTelegramId(id);
      fileId = profile?.avatar_file_id || '';
      avatarFileOf.set(id, fileId);
    } catch (e) {
      fileId = avatarFileOf.get(id) || '';
      if (!fileId) throw e;
    }
    if (!fileId) return res.status(404).send('no avatar');
    let hit = avatarCache.get(fileId);
    if (!hit) {
      const file = await getFileBuffer(fileId);
      hit = { buffer: file.buffer, mime: file.mime };
      avatarCache.set(fileId, hit);
      if (avatarCache.size > 200) avatarCache.delete(avatarCache.keys().next().value);
    }
    res.set('Content-Type', hit.mime);
    res.set('Cache-Control', 'public, max-age=300');
    res.send(hit.buffer);
  } catch (e) { console.error('avatar serve failed:', e.message); res.status(404).send('no avatar'); }
});

// Расписание согласованных матчей. Открыто всем, кто видит лигу: игроки
// смотрят, кто с кем и когда играет, и приходят поболеть. Метрика по кортам —
// вещь операционная, поэтому уезжает только организатору.
app.get('/api/league/schedule', async (req, res) => {
  try {
    const v = await leagueViewer(String(req.query.initData || ''), String(req.query.t || ''), { allowGuest:true, lang:String(req.query.lang || '') });
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    // Гостю сайта Telegram ID игроков ни к чему: имени и матча ему достаточно.
    const items = (await agreedSchedule()).map(i => v.anonymous
      ? { ...i, p1:{ ...i.p1, id:'' }, p2:{ ...i.p2, id:'' } } : i);
    const payload = {
      ok: true,
      now: Date.now(),
      me: String(v.user.id),
      me_division: v.division || '',
      divisions: [...new Set(items.map(i => i.division).filter(Boolean))].sort(),
      courts: [...new Set(items.map(i => i.court).filter(Boolean))].sort(),
      players: [...new Map(items.flatMap(i => [i.p1, i.p2]).filter(p => p.name).map(p => [p.id || p.name, p])).values()]
        .sort((a, b) => a.name.localeCompare(b.name)),
      items
    };
    // Накладки по кортам больше не считаем: в поле «корт» стоит название клуба,
    // а кортов там несколько — два матча в один час это норма, а не конфликт.
    if (v.isAdmin) {
      payload.admin = true;
      payload.court_usage = await courtUsage().catch(() => []);
    }
    res.json(payload);
  } catch (e) {
    console.error('schedule api failed:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Сводка по сезонам: кто выиграл дивизион, кто был вторым и как игрок прошёл
// свой дивизион. Один запрос вместо десятка — витрина берёт отсюда и чемпионов
// на главной, и цифры в карточке игрока. Таблицы дивизионов кэшируются, поэтому
// повторные обращения дешёвые.
let seasonsSummaryCache = { t: 0, v: null };
const SEASONS_SUMMARY_MS = 5 * 60 * 1000;

// Лестница дивизионов. Женский дивизион (W) идёт отдельной веткой и в подъёмах
// и вылетах не участвует — у него своя история.
const DIVISION_LADDER = ['PRIME', 'A', 'B', 'C', 'D'];
// Сколько мест поднимается из дивизиона. Из A наверх идёт только победитель,
// потому что Prime один; из остальных — первые два места регулярки.
function promoCount(letter) { return letter === 'A' ? 1 : 2; }
// Вылетают 7–8 места. Из D падать некуда, Prime тоже никого не отпускает.
function relegates(letter) { return letter !== 'D' && letter !== 'PRIME'; }
// Wildcard — ачивка, в названии которой встречается это слово. Считаем только
// ачивку того сезона, который сейчас разбираем; если сезон в строке не указан,
// принимаем как есть — руками его заполняют не всегда.
function hasWildcard(list = [], season = '') {
  return list.some(a => {
    if (!/wildcard|wild\s*card/i.test(String(a.title || a.type || ''))) return false;
    const s = String(a.season || '').trim();
    return !s || !season || s === String(season);
  });
}

async function buildSeasonsSummary() {
  const seasonList = await getSeasons().catch(() => []);
  const achievements = await getLeagueAchievements().catch(() => new Map());
  const out = [];
  for (const season of seasonList) {
    const letters = await availableDivisions(season.number).catch(() => []);
    const titles = await divisionTitles(season.number).catch(() => ({}));
    const divisions = [];
    for (const letter of letters) {
      const groupDefs = await divisionGroups(letter,season.number);
      if (groupDefs.length > 1) {
        const groups = [];
        for (const g of groupDefs) {
          const data = await getDivisionTable(letter,season.number,g.group);
          if (!data?.ok) continue;
          groups.push({group:g.group,title:g.title,title_en:g.title_en,table:(data.players || []).map(p=>({...p,group:g.group}))});
        }
        divisions.push({letter,title:titles[letter]?.title || letter,groups,table:groups.flatMap(g=>g.table),
          champion:null,runner_up:null,final:null,final_score:'',promoted:[],relegated:[]});
        continue;
      }
      const data = await getDivisionTable(letter, season.number).catch(() => null);
      if (!data?.ok) continue;
      const table = (data.players || []).map(pl => ({
        id: String(pl.id || ''), name: pl.name || '', photo: pl.photo || '',
        place: pl.place || 0, matches: pl.matches || 0, wins: pl.wins || 0,
        points: pl.points || 0, zone: pl.zone || ''
      }));
      // Второе место — проигравший финал, а не второй в регулярке: в плей-офф
      // порядок может перевернуться, и это как раз то, что стоит показать.
      const final = data.playoff?.final || null;
      const champion = data.playoff?.champion || null;
      let runnerUp = null;
      if (final && champion) {
        const other = String(final.first?.id) === String(champion.id) ? final.second : final.first;
        if (other?.id) runnerUp = { id: String(other.id), name: other.name, photo: other.photo || '' };
      }
      // Кто поднимается и кто падает. Считаем по регулярке, а не по плей-офф:
      // именно место в таблице решает судьбу дивизиона.
      const idx = DIVISION_LADDER.indexOf(letter);
      const upTo = idx > 0 ? DIVISION_LADDER[idx - 1] : '';
      const downTo = idx >= 0 && idx < DIVISION_LADDER.length - 1 ? DIVISION_LADDER[idx + 1] : '';
      const promoted = [];
      const relegated = [];
      if (upTo) {
        const limit = promoCount(letter);
        for (const pl of table) {
          const wild = hasWildcard(achievements.get(String(pl.id)) || [], season.number);
          if ((pl.place && pl.place <= limit) || wild) {
            promoted.push({ ...pl, from: letter, to: upTo, wildcard: wild && pl.place > limit });
          }
        }
      }
      if (downTo && relegates(letter)) {
        for (const pl of table) {
          if (pl.place && pl.place >= 7) relegated.push({ ...pl, from: letter, to: downTo });
        }
      }
      divisions.push({ letter, title: titles[letter] || '', champion, runner_up: runnerUp,
        final_score: final?.score || '', final: final || null, table, promoted, relegated });
    }
    out.push({ number: season.number, label: season.label, status: season.status, divisions });
  }
  return out;
}

app.get('/api/league/seasons-summary', async (req, res) => {
  try {
    const v = await leagueViewer(String(req.query.initData || ''), String(req.query.t || ''), { allowGuest:true, lang:String(req.query.lang || '') });
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    if (seasonsSummaryCache.v && Date.now() - seasonsSummaryCache.t < SEASONS_SUMMARY_MS) {
      return res.json({ ok:true, seasons: seasonsSummaryCache.v });
    }
    const seasons = await buildSeasonsSummary();
    seasonsSummaryCache = { t: Date.now(), v: seasons };
    res.json({ ok:true, seasons });
  } catch (e) {
    console.error('seasons summary failed:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Витрина сезонов для тех, кто ещё не в лиге: сколько было дивизионов и
// игроков, когда сезон шёл и кто стал чемпионом. Анкета для этого не нужна —
// это и есть то, ради чего человек анкету заполняет. Считаем из тех же данных,
// что и сама лига, и держим ответ в кеше: экран открывают часто, а меняется он
// раз в сезон.
// События лиги для сайта (вкладка «Турниры», главная) — без входа. Только то,
// что и так видно всем: названия, даты, статус, описание. Держим в кеше пару
// минут: страницу открывают часто, а лист Events меняется редко.
let publicEventsCache = { t: 0, v: null };
const PUBLIC_EVENT_FIELDS = ['event_id','event_type','event_name','event_name_en','event_name_ru','status','status_code','joinable',
  'start_date','end_date','description_en','description_ru','sort_order'];
app.get('/api/public/events', async (req, res) => {
  try {
    if (!publicEventsCache.v || Date.now() - publicEventsCache.t > 2 * 60 * 1000) {
      const all = await getAllEvents();
      publicEventsCache = { t: Date.now(), v: all.map(e => Object.fromEntries(PUBLIC_EVENT_FIELDS.map(k => [k, e[k] ?? '']))) };
    }
    res.set('Cache-Control', 'no-store');
    res.json({ ok:true, events: publicEventsCache.v });
  } catch (e) {
    console.error('public events failed:', e.message);
    if (publicEventsCache.v) return res.json({ ok:true, events: publicEventsCache.v, stale:true });
    res.json({ ok:false, events: [] });
  }
});
let publicSeasonsCache = { t: 0, v: null };
const PUBLIC_SEASONS_MS = 10 * 60 * 1000;
app.get('/api/public/seasons', async (req, res) => {
  try {
    if (publicSeasonsCache.v && Date.now() - publicSeasonsCache.t < PUBLIC_SEASONS_MS) {
      return res.json({ ok:true, seasons: publicSeasonsCache.v });
    }
    const [seasonList, profiles, achievements] = await Promise.all([
      getSeasons().catch(() => []),
      getLeagueProfiles().catch(() => []),
      getLeagueAchievements().catch(() => new Map())
    ]);
    const byId = new Map(profiles.map(p => [String(p.id), p]));
    const byName = new Map(profiles.map(p => [String(p.name || '').trim().toLowerCase(), p]));
    const { seasonRoster } = await import('./division.js');
    const isChampion = (a) => /champion|чемпион|winner|победител/i.test(`${a.type} ${a.title}`);
    // Сколько недель сезон реально шёл: по датам сыгранных матчей, а не по тому,
    // что стоит в строке события — там даты часто плановые.
    const history = await getLeagueMatchHistory().catch(() => new Map());
    const span = new Map();
    // Сколько матчей сыграно и сколько игроков реально играло в сезоне — для
    // счётчика на сайте. Один матч лежит в истории у обоих игроков, поэтому
    // считаем по паре участников и дате, а не по строкам.
    const playedMatches = new Map(), playedPlayers = new Map();
    for (const [pid, list] of history.entries()) {
      for (const m of list) {
        const n = String(m.season || '').replace(/\D+/g, '');
        if (!n) continue;
        const me = String(byId.get(String(pid))?.name || pid).trim().toLowerCase();
        const pair = [me, String(m.opponent || m.opponent_id || '').trim().toLowerCase()].sort().join('~');
        if (!playedMatches.has(n)) playedMatches.set(n, new Set());
        playedMatches.get(n).add(`${pair}|${String(m.date || '').slice(0, 10)}`);
        if (!playedPlayers.has(n)) playedPlayers.set(n, new Set());
        playedPlayers.get(n).add(String(pid));
      }
    }
    for (const list of history.values()) {
      for (const m of list) {
        const n = String(m.season || '').replace(/\D+/g, '');
        const d = new Date(m.date);
        if (!n || Number.isNaN(d.getTime())) continue;
        const cur = span.get(n) || { from: d, to: d };
        if (d < cur.from) cur.from = d;
        if (d > cur.to) cur.to = d;
        span.set(n, cur);
      }
    }
    const out = [];
    for (const s of seasonList) {
      const letters = await availableDivisions(s.number).catch(() => []);
      const roster = await seasonRoster(s.number).catch(() => null);
      const champions = [];
      for (const [pid, list] of achievements.entries()) {
        for (const a of list) {
          if (!isChampion(a)) continue;
          if (String(a.season || '').replace(/\D+/g, '') !== String(s.number)) continue;
          const p = byId.get(String(pid));
          champions.push({ id: String(pid), name: p?.name || '', photo: p?.photo || '', title: a.title, division: p?.division || '' });
        }
      }
      // Финалы дивизионов: тот же плей-офф, что лига показывает у себя на
      // главной. Для новичка это самая наглядная картинка сезона.
      const finals = [];
      const titles = await divisionTitles(s.number).catch(() => ({}));
      for (const letter of letters) {
        const data = await getDivisionTable(letter, s.number).catch(() => null);
        const champ = data?.playoff?.champion || null;
        if (!champ?.name) continue;
        const final = data?.playoff?.final || null;
        let runner = null;
        if (final) {
          const other = String(final.first?.id) === String(champ.id) ? final.second : final.first;
          if (other?.name) runner = { name: other.name, photo: other.photo || '' };
        }
        finals.push({
          letter,
          title: titles[letter]?.title || titles[letter] || '',
          champion: { name: champ.name, photo: champ.photo || '' },
          runner_up: runner,
          score: String(final?.score || final?.display || '')
        });
      }
      // Длительность по сыгранным матчам — только у завершённого сезона. У
      // идущего это «сколько недель уже прошло» (выходило 2–3 недели вместо 8);
      // для него экраны считают длительность по датам события.
      const sp = String(s.status || '').toLowerCase() === 'finished' ? span.get(String(s.number)) : null;
      const weeks = sp ? Math.max(1, Math.round((sp.to - sp.from) / 6048e5)) : 0;
      const players = (roster?.players || []).map(p => {
        const hit = byName.get(String(p.name || '').trim().toLowerCase());
        return { name: p.name, division: p.division || '', photo: hit?.photo || '' };
      });
      out.push({
        number: String(s.number), label: s.label, status: s.status,
        divisions: letters.length,
        players: players.length,
        matches_played: playedMatches.get(String(s.number))?.size || 0,
        players_played: playedPlayers.get(String(s.number))?.size || 0,
        players_list: players,
        weeks,
        finals,
        champions: champions.filter(c => c.name).slice(0, 8)
      });
    }
    publicSeasonsCache = { t: Date.now(), v: out };
    res.json({ ok:true, seasons: out });
  } catch (e) {
    console.error('public seasons failed:', e.message);
    res.json({ ok:true, seasons: [] });
  }
});

// Таблица дивизиона: состав, перекрёстная сетка и плей-офф. Отдельным запросом,
// чтобы стартовый экран не ждал чтения ещё четырёх таблиц.
app.get('/api/league/division', async (req, res) => {
  try {
    const v = await leagueViewer(String(req.query.initData || ''), String(req.query.t || ''), { allowGuest:true, lang:String(req.query.lang || '') });
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    const letter = String(req.query.letter || '');
    const season = String(req.query.season || '');
    const messages = { not_configured:'Для этого дивизиона не задана таблица.', no_access:'Нет доступа к таблице дивизиона.' };
    // Дивизион может идти двумя группами — тогда отдаём обе таблицы одним ответом,
    // и витрина показывает их одну под другой.
    const groups = await divisionGroups(letter, season).catch(() => []);
    if (groups.length > 1) {
      const parts = [];
      for (const g of groups) {
        const t = await getDivisionTable(letter, season, g.group).catch(() => null);
        if (!t?.ok) return res.status(503).json({ok:false,error:messages.no_access});
        parts.push({ group: g.group, group_title: g.title, group_title_en:g.title_en, ...t });
      }
      if (!parts.length) return res.status(404).json({ ok:false, error: messages.not_configured });
      return res.json({ ok:true, ...parts[0], groups: parts });
    }
    const data = await getDivisionTable(letter, season);
    if (!data.ok) {
      return res.status(404).json({ ok:false, error: messages[data.reason] || 'Дивизион недоступен' });
    }
    res.json({ ok:true, ...data });
  } catch (e) {
    console.error('division api failed:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Свободная бронь корта: не привязана к матчу. Пока доступна админам —
// COURT_BOOKING_OPEN=true открывает её всем активным игрокам.
app.post('/api/court/request', async (req, res) => {
  try {
    const b = req.body || {};
    const v = await matchViewer(b.initData || '', String(b.t || ''));
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    if (!COURT_BOOKING_OPEN && !v.isAdmin) return res.status(403).json({ ok:false, error:'Court booking is not open yet.' });

    const date = String(b.date || '').trim();
    const time = String(b.time || '').trim();
    const durationMin = Number(b.duration_min || 120);
    const chosen = (Array.isArray(b.courts) ? b.courts : []).map(c => String(c).trim()).filter(Boolean);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok:false, error:'Date is required' });
    if (!/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ ok:false, error:'Time is required' });
    if (!chosen.length) return res.status(400).json({ ok:false, error:'Pick at least one court' });

    const courts = await getCourts();
    const result = await sendCourtRequests(v.user.id, v.lang, { date, time, durationMin, courts: chosen }, courts);
    res.json({ ok:true, sent: result.sent });
  } catch (e) { console.error(e); res.status(500).json({ ok:false, error:e.message }); }
});

// Снять своё окно (пока никто не откликнулся) ИЛИ отменить уже согласованный матч.
// Согласованный может отменить любая из сторон — но тогда обе получают уведомление,
// и это конец: заново договариваются новым окном.
app.post('/api/match/cancel', async (req, res) => {
  try {
    const v = await matchViewer(req.body?.initData || '', String(req.body?.t || ''));
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    if (!v.canMatch && !v.isAdmin) return res.status(403).json({ok:false,error:'division_required'});
    const result = await cancelMatchmaking(req.body.challenge_id, { telegram_id:v.user.id, name:v.profile.name });
    if (!result.ok) {
      const code = result.reason === 'not_found' ? 404 : result.reason === 'not_a_player' ? 403 : 409;
      return res.status(code).json({ok:false,error:result.reason});
    }
    await notifyMatchCancelled(result.previous, {telegram_id:v.user.id,name:v.profile.name}, {backToOpen:result.backToOpen})
      .catch(e => console.error('notifyMatchCancelled failed:',e.message));
    res.json({ok:true,cancelled:result.backToOpen?'reopened':'request'});
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

// Перенос времени согласованного матча из карточки в мини-приложении.
// Дальше всё то же, что и по кнопке в чате: соперник подтверждает или отказывается.
app.post('/api/match/booking',async(req,res)=>{try{
 const b=req.body||{},v=await matchViewer(b.initData||'',String(b.t||''));if(!v.ok)return res.status(v.code).json({ok:false,error:v.error});
 const slot=await findSlot(b.challenge_id);if(!slot||slot.status!=='accepted'||String(slot.from_telegram_id)!==String(v.user.id))return res.status(403).json({ok:false,error:'not_booker'});
 await sendBookingHelper(v.user.id,slot);res.json({ok:true});
}catch(e){res.status(500).json({ok:false,error:e.message});}});
// «Корт подтвердил» прямо из карточки матча — то же, что кнопка в чате.
app.post('/api/match/court-confirm',async(req,res)=>{try{
 const b=req.body||{},v=await matchViewer(b.initData||'',String(b.t||''));if(!v.ok)return res.status(v.code).json({ok:false,error:v.error});
 const r=await confirmCourt(String(b.challenge_id||''),{telegram_id:v.user.id,name:v.profile?.name||''});
 if(!r.ok){
  const ru=v.lang==='ru';
  const texts={not_booker:ru?'Бронь подтверждает автор вызова.':'Only the challenge creator confirms the booking.',already_confirmed:ru?'Корт уже подтверждён.':'Already confirmed.',
   not_accepted:ru?'Матч ещё не согласован.':'Match is not agreed yet.',not_a_player:ru?'Вы не участник этого матча.':'Not your match.',not_found:ru?'Матч не найден.':'Not found.'};
  // message — готовый текст: общий переводчик ошибок эти коды не знает.
  return res.status(400).json({ok:false,error:r.reason,message:texts[r.reason]||''});
 }
 await notifyCourtConfirmed(r.slot).catch(e=>console.error('notifyCourtConfirmed failed:',e.message));
 res.json({ok:true});
}catch(e){res.status(500).json({ok:false,error:e.message});}});
app.post('/api/match/retime', async (req, res) => {
  try {
    const b = req.body || {};
    const v = await matchViewer(b.initData || '', String(b.t || ''));
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    if (!v.canMatch && !v.isAdmin) return res.status(403).json({ok:false,error:'division_required'});
    const r = await proposeTimeChange(b.challenge_id, { telegram_id: v.user.id, name: v.profile.name }, String(b.time || ''));
    if (!r.ok) {
      const messages = {
        not_found: 'Матч не найден.',
        not_accepted: 'Матч ещё не согласован.',
        not_a_player: 'Это не ваш матч.',
        not_booker: 'Время меняет тот, кто бронировал корт.',
        same_time: 'Это и есть текущее время.',
        bad_time: 'Некорректное время.'
      };
      return res.status(409).json({ ok:false, error: messages[r.reason] || 'Не удалось перенести' });
    }
    await notifyTimeChange(r.slot, r.newTime, v.user.id).catch(e => console.error('notifyTimeChange failed:', e.message));
    res.json({ ok:true, time: r.newTime });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

// Заявки, где кто-то молчит: два напоминания и закрытие.
// Счёт исключение — его не закрываем, а отдаём организатору.
export async function runStuckNudges(now=Date.now()) {
  const stuck = await listStuck(now).catch(e => { console.error('listStuck failed:', e.message); return []; });
  for (const item of stuck) {
    try {
      if (!await isStuckCurrent(item)) continue;
      if (item.stage === 'close') {
        if (item.scope === 'negotiation' || item.scope === 'invite' || item.scope === 'court') {
          const r = await closeStuckSlot(item.slot.challenge_id,{scope:item.scope,expected:item,now});
          if (r.ok) await notifyNegotiationExpired(r.previous, { backToOpen: r.backToOpen, scope:item.scope });
        } else if (item.scope === 'time') {
          const r = await dropStuckTimeChange(item.slot.challenge_id,item);
          if (r.ok) await notifyTimeChangeExpired(r.slot, r.proposal);
        } else {
          if(item.scope==='score') await notifyScoreStalled(item.slot);
          else await notifyResultStalled(item.slot);
          await markStuckNudge(item.slot.challenge_id,item.scope,'close',item);
        }
        continue;
      }
      if (item.scope === 'negotiation' || item.scope === 'invite') await notifyStuckNegotiation(item);
      else if (item.scope === 'time') await notifyStuckTimeChange(item);
      else if(item.scope==='court') await notifyStuckCourt(item);
      else if(item.scope==='score') await notifyStuckScore(item);
      else await notifyStuckResult(item);
      await markStuckNudge(item.slot.challenge_id, item.scope, item.stage,item);
      // Напоминание из цепочки — тут и обновляем цифру на кнопке «Мои матчи»
      // (сразу после самого уведомления её не трогаем, чтобы не дублировать).
      queueMatchAttention([item.slot.from_telegram_id,item.slot.to_telegram_id].filter(Boolean).map(String),{},{force:true});
    } catch (e) {
      console.error(`stuck nudge ${item.scope}/${item.stage} failed:`, e.message);
    }
  }
}

// Напоминание о незакрытых матчах — раз в неделю, по понедельникам утром.
// Дата окончания сезона берётся из Settings (season_deadline, формат ГГГГ-ММ-ДД);
// без неё письмо всё равно уходит, просто без обратного отсчёта.
async function runDeadlineNudge() {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }));
  if (local.getDay() !== 1) return;                 // только понедельник
  if (local.getHours() !== 10) return;              // одно окно в сутки
  const stamp = `${local.getFullYear()}-${local.getMonth() + 1}-${local.getDate()}`;
  if (await getSetting('deadline_nudge_last') === stamp) return;
  await setSetting('deadline_nudge_last', stamp, 'Дата последней рассылки о незакрытых матчах');

  const deadline = String(await getSetting('season_deadline') || '').trim();
  const daysLeft = /^\d{4}-\d{2}-\d{2}$/.test(deadline)
    ? Math.round((Date.parse(`${deadline}T23:59:00+07:00`) - Date.now()) / 86400000)
    : null;

  const players = await getAllActiveLeaguePlayers().catch(() => []);
  let sent = 0;
  for (const p of players) {
    try {
      const left = await getUnplayedOpponents(p.division, p.name, p.season, p.group);
      if (!left.known || !left.names.length) continue;
      await notifyDeadline(p.telegram_id, { names: left.names, daysLeft, division: p.division });
      sent++;
      await new Promise(r => setTimeout(r, 60));
    } catch (e) { console.error('deadline nudge for player failed:', e.message); }
  }
  if (sent) console.log(`deadline nudge sent to ${sent} players`);
}

// Деплой останавливает сервис сигналом SIGTERM. Успеваем записать прогресс
// рассылки, чтобы после запуска она продолжилась с того же места, без повторов.
let shuttingDown = false;
process.on?.('SIGTERM', async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const force = setTimeout(() => process.exit(0), 8000);
  try { await flushBroadcasts(); } catch (e) { console.error('shutdown flush failed:', e.message); }
  clearTimeout(force);
  process.exit(0);
});

// Всё, что запускается здесь (таймеры, прогрев, рассылки), — фон: в очереди
// к Google оно уступает действиям людей.
app.listen(PORT, () => withPriority('low', async () => {
  setMatchChangeHandler(queueMatchAttention);
  // Окно поменялось (разобрали день, закрыли) — правим разосланные сообщения.
  setWindowChangeHandler(id => scheduleSlotCards(id));
  // Снимок витрины лиги сбрасывается вместе с остальными кэшами — то есть сразу
  // после подтверждённого результата, а не по таймеру.
  onLeagueCacheInvalidated(invalidateLeagueSnapshot);
  // Прогрев: собираем тяжёлое заранее и подновляем по таймеру, чтобы первый
  // живой заход после простоя не платил за всех. Ошибки прогрева не важны —
  // просто прогреется в следующий раз.
  const warm = () => Promise.allSettled([
    warmSheetCache([SHEETS.settings, SHEETS.botTexts, SHEETS.applicants, SHEETS.events]),
    getLeagueSnapshot()
  ]).catch(() => {});
  warm();
  setInterval(warm, 8 * 60 * 1000).unref();
  // Токен Instagram живёт 60 дней. Продлеваем раз в сутки: продлить раньше
  // срока ничего не стоит, а пропущенное окно останавливает публикации молча.
  if (instagramEnabled()) {
    const renew = async () => {
      const out = await refreshToken().catch(e => ({ ok:false, reason:e.message }));
      if (out.ok) console.log(`instagram token продлён на ${Math.round((out.expires_in||0)/86400)} дн.`);
      else console.error('instagram token не продлился:', out.reason);
    };
    renew();
    setInterval(renew, 24 * 60 * 60 * 1000).unref?.();
  }
  // Time can create a result task without a player pressing a button.
  setInterval(async()=>{try{const rows=await allSlots();queueMatchAttention([...new Set(rows.filter(s=>s.status==='accepted').flatMap(s=>[s.from_telegram_id,s.to_telegram_id]).filter(Boolean))]);}catch(e){console.error('attention sweep:',e.message);}},5*60*1000).unref();
  // Незаконченные рассылки продолжаются сами. Ждём минуту после старта: при
  // деплое старая копия сервиса ещё какое-то время дописывает свой прогресс, и
  // раньше подхватывать очередь нельзя — получатели получили бы сообщение дважды.
  setTimeout(() => { resumeBroadcasts().catch(e => console.error('broadcast resume failed:', e.message)); }, 60 * 1000).unref?.();
  startLogCleanup();
  // Лист ожидания → таблица участников: при запуске сверяем целиком (так
  // переносятся и заявки, поданные до этой функции). Через 2 минуты, когда
  // схлынет стартовая волна чтений таблиц.
  setTimeout(() => {
    syncAllWaitlists().then(r => r.forEach(x => console.log(`waitlist sync s${x.season}:`, x.ok ? `${x.waitlist} в листе → «${x.tab}»` : x.reason)))
      .catch(e => console.error('waitlist sync:', e.message));
  }, 2 * 60 * 1000).unref?.();
  // Межгрупповые матчи W ↔ таблица дивизиона: заменённого игрока в
  // несыгранных матчах меняем на заменившего (раз в 30 минут и при запуске).
  const syncWCross = async () => {
    try {
      const { latestSeason, seasonRoster } = await import('./division.js');
      const season = await latestSeason();
      const w = ((await seasonRoster(season))?.players || []).filter(p => String(p.letter).toUpperCase() === 'W');
      if (!w.some(p => String(p.group) === '1') || !w.some(p => String(p.group) === '2')) return;
      const { seedWomenCrossGroupSchedule } = await import('./results.js');
      const r = await seedWomenCrossGroupSchedule(season);
      if (r?.renamed || r?.added) console.log(`W cross: заменено строк ${r.renamed}, добавлено ${r.added}`, (r.subs || []).map(x => `${x.from} → ${x.to}`).join(', '));
    } catch (e) { console.error('W cross sync:', e.message); }
  };
  setTimeout(syncWCross, 3 * 60 * 1000).unref?.();
  setInterval(syncWCross, 30 * 60 * 1000).unref?.();
  import('./sheets.js').then(m => m.addNewTabOnce('tournaments')).then(done => { if (done) console.log('tabs: «Турниры» добавлены группам'); }).catch(e => console.error('tabs add:', e.message));
  import('./sheets.js').then(m => m.addTabToGroupOnce('partners', 'guest')).then(done => { if (done) console.log('tabs: «Партнёры» добавлены гостям'); }).catch(e => console.error('tabs add partners:', e.message));
  console.log(`PTF Registration Bot listening on ${PORT}`);
  console.log(`Spreadsheet: ${SPREADSHEET_ID}`);
  if (!BOT_TOKEN) console.warn('BOT_TOKEN is empty. Set it in Railway Variables.');
  if (!PUBLIC_URL) console.warn('PUBLIC_URL is empty. Set it in Railway Variables.');
  // Раз в 15 минут: напоминания о матчах, просьба внести счёт, закрытие протухших окон.
  // Всё в одном проходе — таблица одна, лишний раз её дёргать незачем.
  // Five-minute checks keep the 20-minute reminder within 20–25 minutes.
  // Other scans retain their existing 15-minute schedule.
  let stuckSweepBusy = false;
  setInterval(async()=>{
    if(stuckSweepBusy)return;
    stuckSweepBusy=true;
    try { await runStuckNudges(); }
    catch(e) { console.error('stuck nudges failed:',e.message); }
    finally { stuckSweepBusy=false; }
  },5*60*1000).unref?.();
  let resultSweepBusy = false;
  setInterval(async () => {
    if (resultSweepBusy) return;
    resultSweepBusy = true;
    try {
      const reminders = await listMatchesNeedingReminder().catch(e => { console.error('reminder scan failed:', e.message); return []; });
      for (const { slot, kind } of reminders) {
        await notifyMatchReminder(slot, kind).catch(e => console.error('match reminder failed:', e.message));
        await markReminderSent(slot.challenge_id, kind).catch(e => console.error('mark reminder failed:', e.message));
      }
      const due = await listMatchesNeedingResultPrompt();
      for (const slot of due) {
        const current=await findSlot(slot.challenge_id).catch(()=>null);
        if(!current||current.result_status)continue;
        await notifyResultPrompt(current).catch(e => console.error('result prompt failed:', e.message));
        await markResultPromptSent(current.challenge_id).catch(e => console.error('mark result prompt failed:', e.message));
      }
      await expireStaleSlots().catch(e => console.error('expire slots failed:', e.message));
      await runDeadlineNudge().catch(e => console.error('deadline nudge failed:', e.message));
      // Напоминания по событиям идут тем же проходом: за сутки, за два часа и
      // про неоплаченный счёт.
      const { runEventReminders, runWaitlistOffers, runSignupNudges } = await import('./eventflow.js');
      await runEventReminders().catch(e => console.error('event reminders failed:', e.message));
      // И напоминание тем, кто карточку получил, но так и не записался.
      await runSignupNudges().catch(e => console.error('signup nudges failed:', e.message));
      // Лист ожидания: снимаем протухшие удержания и раздаём освободившиеся места.
      const { getAdminChatId } = await import('./admin.js');
      const evAdmin = await getAdminChatId().catch(() => '');
      await runWaitlistOffers(Date.now(), evAdmin).catch(e => console.error('waitlist offers failed:', e.message));
      // Воскресенье, 19:00 — собираем подборку недели и складываем её туда,
      // куда привязана тема командой /instagram_here. Публикация в ленту без
      // человека не происходит: кнопка появляется только когда Instagram
      // подключён.
      try {
        const { setWeeklyBatch } = await import('./bot.js');
        const weekly = await runWeeklyCarousel(Date.now(), evAdmin);
        if (weekly.ok && weekly.prepared?.images?.length) setWeeklyBatch('cards', weekly.prepared);
        // Четверг, 19:00 — фотографии с корта. Отдельный день от карточек:
        // две подборки в один вечер читаются как спам.
        const photos = await runWeeklyPhotos(Date.now(), evAdmin);
        if (photos.ok && photos.prepared?.images?.length) setWeeklyBatch('photos', photos.prepared);
        // Вторник, 19:00 — таблицы дивизионов, по картинке на группу. Первый
        // автоматический выпуск 6 октября, после 8 ноября сезон закончился и
        // выпуски прекращаются сами.
        const { runWeeklyStandings } = await import('./standings.js');
        const { setTableBatch } = await import('./bot.js');
        const tables = await runWeeklyStandings(Date.now(), evAdmin);
        if (tables.ok && tables.prepared?.items?.length) setTableBatch(tables.prepared);
      } catch (e) { console.error('weekly carousel failed:', e.message); }
    } catch (e) {
      console.error('match sweep failed:', e.message);
    } finally { resultSweepBusy = false; }
  }, 15 * 60 * 1000).unref?.();

  try {
    if (BOT_TOKEN && PUBLIC_URL) {
      await setWebhook();
      await setCommands();
      try { const me = await getMe(); setBotUsername(me?.username); setPairBotUsername(me?.username); setWebBotName(me?.username); } catch (e) { console.error('getMe failed:', e.message); }
      console.log('Webhook and commands installed');
    }
  } catch (e) {
    console.error('Startup Telegram setup failed:', e.message);
  }
}));