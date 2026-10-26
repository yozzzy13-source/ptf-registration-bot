// Сторис с таблицей дивизиона: одна картинка 1080×1920 на каждую группу.
//
// Рисуем сами, а не снимаем скриншот: скриншот зависит от браузера, размера
// окна и вёрстки сайта, а здесь картинка всегда одна и та же и собирается за
// сотню миллисекунд. Макет и палитра — те же, что у карточки матча и постера,
// чтобы всё в ленте выглядело одной серией.
//
// Движение по местам считаем не «на глазок», а от прошлой публикации: каждый
// выпуск кладёт снимок мест в лист Standings Snapshots нашей собственной
// таблицы (боевые таблицы дивизионов не трогаем вовсе). Первый выпуск выходит
// без стрелок — сравнивать не с чем, он и становится точкой отсчёта.
//
// Расписание. До конца сезона выпуск выходит по вторникам в 19:00, начиная с
// WEEKLY_FROM. Всё, что раньше, — разовая ручная выгрузка командой /tables:
// начало сезона догоняем руками, а дальше бот идёт понедельно сам. После
// SEASON_END автоматика молчит, пока в Settings не появится новый сезон.
import sharp from 'sharp';
import { TIMEZONE } from './config.js';
import { sendMessage, sendDocumentBuffer } from './telegram.js';
import { ensureExtraSheet, appendObjects, getRows, getSetting, setSetting, publishedAvatars, getMasterPhotos, sameName } from './sheets.js';
import { availableDivisions, divisionGroups, divisionDisplayName, getDivisionTable, latestSeason } from './division.js';
import { playerPhotoForPoster } from './matchcard.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POSTER_FONT as FONT, POSTER_COLORS as C } from './matchposter.js';
import { sponsorStrip } from './sponsors.js';
import { instagramEnabled, publishStory } from './instagram.js';
import { nowISO } from './util.js';

const WIDTH = 1080, HEIGHT = 1920;
const txt = v => String(v ?? '').trim();
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Границы автоматического режима. Даты сезона живут здесь, а не в Settings:
// это разовые ориентиры одного сезона, а не настройка, которую крутят.
export const WEEKLY_FROM = '2026-10-06';   // первый автоматический вторник
export const SEASON_END = '2026-11-08';    // после этой даты автоматика молчит
const SNAPSHOT_SHEET = 'Standings Snapshots';
const SNAPSHOT_HEADERS = ['taken_at', 'issue', 'season', 'division', 'group', 'player', 'place', 'matches', 'wins', 'points'];

// ------------------------------------------------------------- снимки мест
const dayIn = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA',
  { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
export const groupKey = (season, letter, group) => `${season || '-'}:${txt(letter).toUpperCase()}:${txt(group) || '-'}`;
const nameKey = (v = '') => txt(v).toLowerCase().replace(/\s+/g, ' ');

export async function readSnapshots() {
  await ensureExtraSheet(SNAPSHOT_SHEET, SNAPSHOT_HEADERS).catch(() => {});
  const { rows } = await getRows(SNAPSHOT_SHEET).catch(() => ({ rows: [] }));
  return rows || [];
}

// Последний снимок по группе: имя → место. Берём самый свежий выпуск, а не
// все строки подряд — иначе стрелка считалась бы от начала сезона.
// before — день выпуска, который сейчас собирается. «Неделя» — это неделя:
// берём последний снимок, сделанный не позже чем за WEEK_GAP_DAYS дней до него.
// Повторный прогон в среду после вторничного выпуска (или ручной внеплановый
// выпуск) сравнивает с прошлым вторником, а не со вчерашним днём.
export const WEEK_GAP_DAYS = 6;
const issueOf = r => (txt(r.issue) || txt(r.taken_at)).slice(0, 10);
const daysBefore = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
export async function lastSnapshot(season, letter, group, rows = null, before = '') {
  const all = rows || await readSnapshots();
  const day = txt(before).slice(0, 10);
  const groupRows = all.filter(r => groupKey(r.season, r.division, r.group) === groupKey(season, letter, group));
  let mine = groupRows;
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const cutoff = daysBefore(day, WEEK_GAP_DAYS);
    mine = groupRows.filter(r => issueOf(r) <= cutoff);
    if (!mine.length) mine = groupRows.filter(r => issueOf(r) < day);   // самый первый выпуск сезона
  }
  if (!mine.length) return { issue: '', places: new Map(), stats: new Map() };
  const issue = mine.map(issueOf).sort().pop();
  const places = new Map(), stats = new Map();
  const num = v => (txt(v) === '' ? null : Number(v));
  for (const r of mine) {
    if (issueOf(r) !== issue) continue;
    const place = Number(r.place);
    if (!nameKey(r.player) || !Number.isFinite(place)) continue;
    places.set(nameKey(r.player), place);
    const st = { matches: num(r.matches), wins: num(r.wins), points: num(r.points) };
    if ([st.matches, st.wins, st.points].every(Number.isFinite)) stats.set(nameKey(r.player), st);
  }
  return { issue, places, stats };
}

export async function saveSnapshot(issue, season, letter, group, table = []) {
  if (!table.length) return { ok: false };
  await ensureExtraSheet(SNAPSHOT_SHEET, SNAPSHOT_HEADERS).catch(() => {});
  await appendObjects(SNAPSHOT_SHEET, table.map(row => ({
    taken_at: nowISO(), issue, season: txt(season), division: txt(letter).toUpperCase(), group: txt(group),
    player: txt(row.name), place: row.place, matches: row.matches, wins: row.wins, points: row.points
  })));
  return { ok: true, count: table.length };
}

// ------------------------------------------------------------- сбор таблицы
// Все группы сезона: дивизион без групп — одна строка с пустой группой.
export async function standingsGroups(season = '') {
  const out = [];
  for (const letter of await availableDivisions(season).catch(() => [])) {
    const groups = await divisionGroups(letter, season).catch(() => []);
    if (groups.length) for (const g of groups) out.push({ letter, group: g.group, title: txt(g.title_en) || txt(g.title) || '' });
    else out.push({ letter, group: '', title: '' });
  }
  return out;
}

// Заголовок картинки: «DIVISION B · GROUP 2» — по-английски, как и всё
// остальное, что уходит в публикацию.
export function groupTitle(letter, group, title = '') {
  const base = divisionDisplayName(letter).toUpperCase();
  if (txt(title)) return `${base} · ${txt(title).toUpperCase()}`;
  return txt(group) ? `${base} · GROUP ${txt(group).toUpperCase()}` : base;
}

export async function buildStandings(season, letter, group = '', snapshots = null, issue = '') {
  const table = await getDivisionTable(letter, season, group).catch(() => null);
  if (!table?.ok || !table.players?.length) return null;
  const before = await lastSnapshot(season, letter, group, snapshots, issue);
  const rows = table.players.map(p => {
    const was = before.places.get(nameKey(p.name));
    const move = Number.isFinite(was) ? was - p.place : null;   // + вверх, − вниз
    // Что игрок сделал за неделю: разница с прошлым снимком.
    const prev = before.stats.get(nameKey(p.name));
    const week = prev ? {
      played: Math.max(0, (Number(p.matches) || 0) - prev.matches),
      wins: Math.max(0, (Number(p.wins) || 0) - prev.wins),
      points: Math.max(0, (Number(p.points) || 0) - prev.points),
      winsBefore: prev.wins
    } : null;
    return { ...p, was: Number.isFinite(was) ? was : null, move, week };
  });
  return { season, letter, group, rows, playoff: table.playoff || null, baseline: !before.places.size, since: before.issue };
}

// ------------------------------------------------------------- рисование
const MAX_ROWS = Math.max(4, Math.min(14, Number(process.env.STANDINGS_MAX_ROWS || 12)));
const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
// Интерфейс сторис съедает заметно больше, чем 5%: сверху лежит имя аккаунта
// с полосой просмотра, снизу — поле ответа и кнопки. Поэтому вся наша вёрстка
// живёт между 230 и 1660: шапка ниже, лента партнёров выше.
const L = {
  title: 236, logoTop: 268, logoBox: { w: 200, h: 112 }, name: 442, sub: 482,
  row: 104,
  colPlace: 74, colAvatar: 150, colName: 232,
  colP: 690, colW: 790, colPts: 910, colMove: 1006
};

function initials(name = '') {
  const parts = txt(name).split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}
function fit(name = '', max = 20) {
  const s = txt(name);
  if (s.length <= max) return s;
  const parts = s.split(/\s+/);
  if (parts.length > 1) {
    const short = `${parts[0]} ${parts[parts.length - 1][0]}.`;
    if (short.length <= max) return short;
  }
  return s.slice(0, max - 1) + '…';
}

// Фотографии игроков ищем по той же цепочке, что и везде в приложении:
// своя аватарка игрока (avatar_file_id, лежит в Telegram), затем фото из
// Players_Master, затем инициалы. Имена сверяем терпимо — «Yana D.» в одной
// таблице и «Yana D» в другой это один человек, и строгое сравнение оставляло
// половину таблицы без лиц. Карты читаем один раз на всю картинку.
async function photoSources() {
  const [avatars, master] = await Promise.all([
    publishedAvatars().catch(() => new Map()),   // имя → telegram_id владельца аватарки
    getMasterPhotos().catch(() => new Map())     // имя → ссылка на фото
  ]);
  return { avatars: [...avatars], master: [...master] };
}
async function playerPhotoBuffer(name, sources) {
  // Сначала штатная цепочка карточки: своя аватарка игрока, потом
  // Players_Master. Telegram-id берём из витрины аватарок по имени.
  const telegramId = sources?.avatars.find(([n]) => sameName(n, name))?.[1] || '';
  const own = await playerPhotoForPoster({ telegramId, name }).catch(() => null);
  if (own?.length) return own;
  // Карточка сверяет имена в Players_Master строго, поэтому «Yana D.» и
  // «Yana D» для неё разные люди. Здесь добираем терпимым сравнением — иначе
  // половина таблицы остаётся с инициалами вместо лиц.
  const url = sources?.master.find(([n]) => sameName(n, name))?.[1];
  if (!url) return null;
  return globalThis.fetch(url, { redirect: 'follow', headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' } })
    .then(r => r.ok ? r.arrayBuffer() : null).then(b => b && Buffer.from(b)).catch(() => null);
}
async function avatarCircle(row, size, sources) {
  const buffer = await playerPhotoBuffer(row.name, sources);
  const mask = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`);
  if (buffer?.length) {
    try {
      const photo = await sharp(buffer).rotate().resize(size, size, { fit: 'cover', position: sharp.strategy.attention }).toBuffer();
      return sharp(photo).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
    } catch (e) { console.error('standings avatar failed:', e.message); }
  }
  const svg = Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#1C1A18"/>
    <text x="${size / 2}" y="${size / 2 + size * 0.13}" text-anchor="middle" font-family="${FONT}"
      font-size="${Math.round(size * 0.36)}" font-weight="800" fill="${C.mute}">${esc(initials(row.name))}</text>
  </svg>`);
  return sharp(svg).png().toBuffer();
}

// Логотип лиги в шапке — тот же файл, что на постере матча.
async function orgLogoLayer() {
  try {
    const buffer = await sharp(path.join(ASSETS_DIR, 'match-card-logos', 'ptf.png'))
      .resize({ width: L.logoBox.w, height: L.logoBox.h, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    const meta = await sharp(buffer).metadata();
    return { input: buffer, left: Math.round((WIDTH - (meta.width || L.logoBox.w)) / 2), top: L.logoTop };
  } catch (e) {
    if (e?.code !== 'ENOENT') console.error('standings logo failed:', e.message);
    return null;
  }
}

// Ярлычок движения — тот же, что в карточке матча: стрелка и число позиций.
// Первый выпуск идёт без ярлычков вовсе: двигаться было неоткуда.
function moveChip(move, x, y) {
  if (!Number.isFinite(move) || move === 0) {
    return `<text x="${x}" y="${y + 8}" text-anchor="middle" font-family="${FONT}" font-size="22" font-weight="700" fill="${C.mute}">–</text>`;
  }
  const up = move > 0;
  const w = 74, h = 38;
  return `<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${h / 2}"
      fill="${up ? C.upBg : C.lossBg}" stroke="${up ? C.upLine : C.lossLine}"/>
    <text x="${x}" y="${y + 7}" text-anchor="middle" font-family="${FONT}" font-size="20" font-weight="800"
      fill="${up ? C.win : C.loss}">${up ? '▲' : '▼'} ${Math.abs(move)}</text>`;
}

export async function renderStandingsPoster(data = {}, { title = '', subtitle = '' } = {}) {
  const rows = (data.rows || []).slice(0, MAX_ROWS);
  // Партнёры: та же лента, что на постере матча, в той же свободной полосе —
  // без рамки и подписи, просто снизу кадра.
  const SPONSOR = { top: 1398, bottom: 1660 };
  const sponsor = await sponsorStrip(SPONSOR);
  // Блок строк центрируем в полосе между шапкой и плашкой партнёров: группы
  // разной длины, и прибитая к верху таблица оставляла бы внизу пустоту.
  const bandTop = 566, bandBottom = SPONSOR.top - 28;
  // Строка ужимается, если группа длинная: лучше чуть плотнее, чем вылезти
  // за безопасную зону сторис.
  const rowH = rows.length ? Math.min(L.row, Math.floor((bandBottom - bandTop) / rows.length)) : L.row;
  const first = Math.round(bandTop + Math.max(0, (bandBottom - bandTop - rows.length * rowH) / 2));
  const head = first - 26;
  const bodyBottom = first + rows.length * rowH + 18;
  const zone = i => (data.group ? (i < 4 ? C.win : '') : (i < 4 ? C.win : i < 6 ? C.amber : C.loss));

  let body = '';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], y = first + i * rowH, mid = y + rowH / 2;
    const accent = zone(i);
    body += `<rect x="40" y="${y}" width="1000" height="${rowH - 12}" rx="24" fill="${C.plate}" stroke="${C.plateLine}"/>`;
    if (accent) body += `<rect x="40" y="${y}" width="7" height="${rowH - 12}" rx="3.5" fill="${accent}" opacity=".85"/>`;
    body += `<text x="${L.colPlace}" y="${mid + 4}" text-anchor="middle" font-family="${FONT}" font-size="34"
        font-weight="900" fill="${i < 4 ? C.gold : C.text}">${r.place}</text>`;
    body += `<text x="${L.colName}" y="${mid + 4}" font-family="${FONT}" font-size="34" font-weight="800"
        fill="${C.text}">${esc(fit(r.name))}</text>`;
    body += `<text x="${L.colP}" y="${mid + 4}" text-anchor="middle" font-family="${FONT}" font-size="30"
        font-weight="700" fill="${C.dim}">${r.matches}</text>`;
    body += `<text x="${L.colW}" y="${mid + 4}" text-anchor="middle" font-family="${FONT}" font-size="30"
        font-weight="700" fill="${C.dim}">${r.wins}</text>`;
    body += `<text x="${L.colPts}" y="${mid + 4}" text-anchor="middle" font-family="${FONT}" font-size="34"
        font-weight="900" fill="${C.amber}">${r.points}</text>`;
    if (!data.baseline) body += moveChip(r.move, L.colMove, mid - 4);
  }

  const svg = Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${C.bg2}"/><stop offset=".45" stop-color="${C.bg1}"/>
    <stop offset="1" stop-color="${C.bg2}"/></linearGradient></defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <text x="${WIDTH / 2}" y="${L.title}" text-anchor="middle" font-family="${FONT}" font-size="26"
    font-weight="700" letter-spacing="9" fill="${C.text}" opacity=".9">PHUKET TENNIS FAMILY</text>
  <text x="${WIDTH / 2}" y="${L.name}" text-anchor="middle" font-family="${FONT}" font-size="46"
    font-weight="900" letter-spacing="3" fill="${C.amber}">${esc(title)}</text>
  <text x="${WIDTH / 2}" y="${L.sub}" text-anchor="middle" font-family="${FONT}" font-size="20"
    font-weight="700" letter-spacing="4" fill="${C.mute}">${esc(subtitle)}</text>
  <text x="${L.colPlace}" y="${head}" text-anchor="middle" font-family="${FONT}" font-size="15"
    font-weight="800" letter-spacing="2" fill="${C.mute}">#</text>
  <text x="${L.colName}" y="${head}" font-family="${FONT}" font-size="15"
    font-weight="800" letter-spacing="2" fill="${C.mute}">PLAYER</text>
  <text x="${L.colP}" y="${head}" text-anchor="middle" font-family="${FONT}" font-size="15"
    font-weight="800" letter-spacing="2" fill="${C.mute}">G</text>
  <text x="${L.colW}" y="${head}" text-anchor="middle" font-family="${FONT}" font-size="15"
    font-weight="800" letter-spacing="2" fill="${C.mute}">W</text>
  <text x="${L.colPts}" y="${head}" text-anchor="middle" font-family="${FONT}" font-size="15"
    font-weight="800" letter-spacing="2" fill="${C.mute}">PTS</text>
  ${data.baseline ? '' : `<text x="${L.colMove}" y="${head}" text-anchor="middle" font-family="${FONT}" font-size="15"
    font-weight="800" letter-spacing="2" fill="${C.mute}">+/-</text>`}
  ${body}
  ${data.baseline ? `<text x="${WIDTH / 2}" y="${Math.min(bodyBottom + 40, SPONSOR.top - 40)}" text-anchor="middle" font-family="${FONT}"
    font-size="18" font-weight="700" letter-spacing="2" fill="${C.mute}">FIRST ISSUE — MOVEMENT STARTS NEXT WEEK</text>` : ''}
</svg>`);

  const layers = [{ input: svg, left: 0, top: 0 }];
  const logo = await orgLogoLayer();
  if (logo) layers.push(logo);
  const sources = await photoSources();
  const size = 62;
  for (let i = 0; i < rows.length; i++) {
    const circle = await avatarCircle(rows[i], size, sources).catch(() => null);
    if (circle) layers.push({ input: circle, left: L.colAvatar - size / 2, top: first + i * rowH + Math.round((rowH - 12 - size) / 2) });
  }
  if (sponsor?.layer) layers.push(sponsor.layer);
  return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: { r: 12, g: 11, b: 11, alpha: 1 } } })
    .composite(layers).png({ compressionLevel: 6 }).toBuffer();
}

// ------------------------------------------------------------- подпись
// Подпись к сторис — одна-две короткие фразы на английском. Ни хэштегов, ни
// названия дивизиона, ни дат: всё это уже нарисовано на картинке.
//
// Раньше модель получала таблицу и писала «кто лидирует / кто поднялся» — и
// подписи всех групп выходили на одно лицо. Теперь бот сам ищет в таблице
// сюжет недели, а модель только облекает его в слова:
//
//   · где группа сейчас — прежде всего по СЫГРАННЫМ матчам (кто-то проходит
//     дистанцию за две недели, кто-то начинает в последнюю), сроки — поправка;
//   · у кого сколько матчей в запасе, кто уже точно в плей-офф, кому уже не
//     догнать, кто поднялся / упал, кто без поражений, у кого серия;
//   · сюжеты в одном выпуске не повторяются, и в группе не берём тот же, что
//     на прошлой неделе; начало фраз тоже не повторяем.
const TEXT_MODEL = process.env.STANDINGS_TEXT_MODEL || 'gpt-4o-mini';
const OPENAI_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const CAPTIONS_SETTING = 'standings_last_captions';
const WIN_POINTS = 3;

// Где сезон по календарю: окончание регулярки — Settings → season_deadline.
async function seasonClock(now = Date.now()) {
  const deadline = txt(await getSetting('season_deadline').catch(() => ''));
  const end = /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? Date.parse(`${deadline}T23:59:00+07:00`) : null;
  const daysLeft = Number.isFinite(end) ? Math.ceil((end - now) / 86400000) : null;
  return { daysLeft, regularOver: daysLeft !== null && daysLeft < 0 };
}

const looseKey = (v = '') => txt(v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const ord = n => { const v = Number(n) || 0, t = v % 100; return v + (t >= 11 && t <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th')); };
const streakOf = form => { let n = 0; for (let i = (form || []).length - 1; i >= 0 && form[i] === 'W'; i--) n++; return n; };

// Разбор таблицы: прогресс, расчёт шансов и список возможных сюжетов с весом.
export function storyFacts(data = {}, { daysLeft = null, regularOver = false, forms = new Map(), crossCount = new Map() } = {}) {
  const rows = (data.rows || []).filter(r => txt(r.name));
  const n = rows.length;
  // Матчей у игрока по регламенту: круг в группе плюс межгрупповые пары (W).
  const due = r => Math.max(n - 1 + (crossCount.get(looseKey(r.name)) || 0), Number(r.matches) || 0);
  const perPlayer = Math.max(1, ...rows.map(due));
  const played = rows.reduce((s, r) => s + (Number(r.matches) || 0), 0);
  const totalDue = rows.reduce((s, r) => s + due(r), 0);
  const progress = totalDue ? Math.min(1, played / totalDue) : 0;
  const left = r => Math.max(0, due(r) - (Number(r.matches) || 0));
  const maxPts = r => (Number(r.points) || 0) + left(r) * WIN_POINTS;
  const cut = Math.min(4, n - 1);                      // зона плей-офф: места 1–4
  const allDone = rows.every(r => left(r) === 0);
  let stage = progress < 0.3 ? 'early' : progress < 0.7 ? 'middle' : 'late';
  if (daysLeft !== null && daysLeft <= 14 && stage !== 'late' && progress >= 0.4) stage = 'late';
  if (allDone || regularOver) stage = 'final';
  const hasPlayoff = Boolean(data.playoff && [data.playoff.sf1, data.playoff.sf2, data.playoff.final, ...(data.playoff.qf || []), ...(data.playoff.sf || [])]
    .some(m => m && (m.first || m.second)));
  if (hasPlayoff && (allDone || regularOver)) stage = 'playoff';

  // Кто уже точно в четвёрке: обогнать его могут меньше четырёх человек.
  const clinched = cut > 0 ? rows.filter(r => r.place <= cut && rows.filter(o => o !== r && maxPts(o) >= r.points).length < cut) : [];

  // Только успехи: никого не называем за падение, за то, что ещё не играл,
  // или за то, что четвёрку уже не догнать. Сюжеты недели — по разнице с
  // прошлым выпуском (сколько сыграл, выиграл, набрал за эти дни).
  const stories = [];
  const add = (type, weight, text, names = []) => stories.push({ type, weight, text, names });
  const top = rows[0], second = rows[1];
  const hasWeek = rows.some(r => r.week);
  const wk = rows.filter(r => r.week && r.week.played > 0);
  const playedThisWeek = name => !hasWeek || wk.some(r => r.name === name);
  // События недели — главный приоритет; табличные «состояния» (лидер, без
  // поражений, отрыв) повторяются из недели в неделю и идут ниже.
  const perfect = wk.filter(r => r.week.played >= 2 && r.week.wins === r.week.played).sort((a, b) => b.week.wins - a.week.wins)[0];
  if (perfect) add('perfect_week', 12 + perfect.week.wins / 2, `${perfect.name} won all ${perfect.week.wins} matches this week.`, [perfect.name]);
  const bestWeek = wk.filter(r => r.week.wins >= 2 && r !== perfect).sort((a, b) => b.week.wins - a.week.wins || b.week.points - a.week.points)[0];
  if (bestWeek) add('week_wins', 10 + bestWeek.week.wins / 2, `${bestWeek.name} won ${bestWeek.week.wins} matches this week.`, [bestWeek.name]);
  const firstWin = wk.filter(r => r.week.winsBefore === 0 && r.week.wins >= 1 && r.matches > r.week.played)[0];
  if (firstWin) add('first_win', 9, `${firstWin.name} got a first win of the season this week.`, [firstWin.name]);
  if (top && Number.isFinite(top.was) && top.was !== 1 && top.matches > 0 && (!hasWeek || top.week?.wins > 0))
    add('new_leader', 9, `${top.name} takes over first place.`, [top.name]);
  const climber = rows.filter(r => r.move >= 2 && r.matches > 0).sort((a, b) => b.move - a.move)[0];
  if (climber) add('climber', 7 + climber.move, `${climber.name} climbs ${climber.move} places to ${ord(climber.place)}.`, [climber.name]);
  const busy = wk.filter(r => r.week.played >= 3).sort((a, b) => b.week.played - a.week.played)[0];
  if (busy) add('busy_week', 6, `${busy.name} played ${busy.week.played} matches this week.`, [busy.name]);
  const weekTotal = wk.reduce((sum, r) => sum + r.week.played, 0) / 2;
  if (weekTotal >= 3) add('busy_group', 4, `${Math.round(weekTotal)} matches played in the group this week.`, []);
  const unbeaten = rows.filter(r => r.matches >= 3 && r.wins === r.matches);
  if (unbeaten.length) add('unbeaten', 6 + unbeaten[0].matches / 2, `${unbeaten[0].name} is unbeaten: ${unbeaten[0].wins} from ${unbeaten[0].matches}.`, [unbeaten[0].name]);
  // Форма игрока общая за все сезоны: серию считаем только в пределах побед
  // этого сезона и только если на этой неделе она продолжилась.
  const streaker = rows.map(r => ({ r, s: Math.min(streakOf(forms.get(looseKey(r.name))), Number(r.wins) || 0) }))
    .filter(x => x.s >= 3 && (!hasWeek || x.r.week?.wins > 0)).sort((a, b) => b.s - a.s)[0];
  if (streaker && !unbeaten.some(u => u.name === streaker.r.name)) add('streak', 5 + streaker.s / 2, `${streaker.r.name} has won ${streaker.s} in a row.`, [streaker.r.name]);
  if (clinched.length && stage !== 'early') add('clinched', stage === 'final' ? 6 : 7, `${clinched.map(r => r.name).join(', ')} ${clinched.length > 1 ? 'have' : 'has'} secured a playoff place.`, clinched.map(r => r.name));
  const race = cut > 0 ? rows.filter(r => r.place >= cut - 1 && r.place <= cut + 2) : [];
  if (race.length >= 3 && Math.max(...race.map(r => r.points)) - Math.min(...race.map(r => r.points)) <= 3 && stage !== 'early' && stage !== 'playoff')
    add('race', stage === 'late' ? 8 : 5, `Only ${Math.max(...race.map(r => r.points)) - Math.min(...race.map(r => r.points))} points separate places ${race[0].place} to ${race[race.length - 1].place} around the playoff line.`, []);
  if (top && second && top.points - second.points >= 5 && stage !== 'early') add('runaway', 5, `${top.name} leads by ${top.points - second.points} points.`, [top.name]);
  if (stage === 'final' && top) add('regular_done', 8, `Regular season complete: ${rows.slice(0, cut).map(r => r.name).join(', ')} go through.`, rows.slice(0, cut).map(r => r.name));
  if (stage === 'playoff') {
    const p = data.playoff || {};
    const pairs = [...(p.qf || []), ...(p.sf || []), p.sf1, p.sf2, p.final].filter(m => m && m.first && m.second && !m.played);
    if (pairs.length) add('playoff', 12, `Playoff matches ahead: ${pairs.map(m => `${m.first.name} vs ${m.second.name}`).join('; ')}.`, pairs.flatMap(m => [m.first.name, m.second.name]));
  }
  // Неделя без матчей в группе — нейтральная фраза без имён.
  if (!stories.length) add('quiet', 1, 'A quieter week here — the table is ready for the next round of matches.', []);
  // Никого не называем, если он на этой неделе не играл.
  for (let i = stories.length - 1; i >= 0; i--)
    if (!['regular_done', 'playoff'].includes(stories[i].type) && !stories[i].names.every(playedThisWeek)) stories.splice(i, 1);
  if (!stories.length) add('quiet', 1, 'A quieter week here — the table is ready for the next round of matches.', []);
  return { stage, progress, played: Math.round(played / 2), total: Math.round(totalDue / 2), daysLeft, perPlayer, stories };
}

const STAGE_TEXT = {
  early: 'Early in the season: few matches played, the table is still forming.',
  middle: 'Middle of the season: about half the matches are played.',
  late: 'Final stretch of the regular season: most matches are played, every result matters for the playoff places.',
  final: 'The regular season is complete.',
  playoff: 'Playoff week: the knockout matches are next.'
};

// Сюжет для группы: самый весомый, но не тот, что уже взят в этом выпуске
// другой группой и не тот, что был у этой группы неделю назад.
export function pickStory(facts, { usedTypes = [], lastType = '' } = {}) {
  const ranked = [...facts.stories].sort((a, b) => b.weight - a.weight);
  const fresh = ranked.filter(s => !usedTypes.includes(s.type) && s.type !== lastType);
  const main = fresh[0] || ranked.find(s => s.type !== lastType) || ranked[0] || null;
  const extra = ranked.find(s => s !== main && !(main?.names || []).some(n => s.names.includes(n)) && s.weight >= 5) || null;
  return { main, extra };
}

// Запасные фразы на случай, если модель недоступна: под каждый сюжет
// несколько вариантов, выбор зависит от группы — подписи не совпадают.
const FALLBACK = {
  new_leader: [s => s.text, s => `New name on top: ${s.names[0]}.`],
  climber: [s => s.text, s => `Big week for ${s.names[0]} — up the table.`],
  perfect_week: [s => s.text, s => `A perfect week for ${s.names[0]}.`],
  week_wins: [s => s.text, s => `Strong week for ${s.names[0]}.`],
  first_win: [s => s.text, s => `First win of the season for ${s.names[0]}.`],
  busy_week: [s => s.text, s => `Busiest week in the group: ${s.names[0]}.`],
  busy_group: [s => s.text],
  unbeaten: [s => s.text, s => `Nobody has beaten ${s.names[0]} yet.`],
  streak: [s => s.text, s => `${s.names[0]} keeps on winning.`],
  clinched: [s => s.text, s => `Playoff place confirmed: ${s.names.join(', ')}.`],
  race: [s => s.text, s => 'The fight for the playoff places is wide open.'],
  runaway: [s => s.text, s => `${s.names[0]} is pulling away at the top.`],
  regular_done: [s => s.text, s => 'Regular season complete — the playoff line-up is set.'],
  playoff: [s => s.text, s => 'Playoff week is here.'],
  quiet: [s => s.text, s => 'The table after this week — more matches to come.']
};
// Подпись должна влезать в сторис и в комментарий Instagram: одна фраза.
export const CAPTION_MAX = 100;
function fitCaption(t = '') {
  const s = txt(t).replace(/\s+/g, ' ');
  if (s.length <= CAPTION_MAX) return s;
  const first = (s.match(/^.+?[.!?](?=\s|$)/) || [''])[0];
  return first && first.length <= CAPTION_MAX ? first : '';
}
function fallbackCaption(pick, seed = '') {
  const s = pick.main;
  if (!s) return 'Standings updated.';
  const list = FALLBACK[s.type] || [x => x.text];
  const h = [...String(seed)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  for (let i = 0; i < list.length; i++) {
    const c = fitCaption(list[(h + i) % list.length](s));
    if (c) return c;
  }
  return 'Standings updated — new week, new results.';
}

async function askForCaption(prompt) {
  if (!OPENAI_KEY) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await globalThis.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TEXT_MODEL, temperature: 0.9, max_tokens: 50,
        messages: [
          { role: 'system', content: 'You write the caption for an Instagram story showing an amateur tennis league table. Exactly ONE short English sentence: at most 14 words and 90 characters. Celebrate what happened THIS WEEK, built around the MAIN STORY; add the SECOND STORY only if it still fits the limit. You may name only players listed under THIS WEEK. Say "this week" only about facts listed under THIS WEEK. Do not talk about who leads the table unless that is the MAIN STORY. Positive only: never mention anyone who has not played, who dropped places or who is out of the race, and never mention losses. Use only the facts given — never invent results, streaks or numbers. Lively but not cheesy, no clichés like "heats up" or "every match counts". No emoji, no hashtags, no quotes. Never name the division, the group or the season — the image already shows them. Do not start the way the listed other captions start.' },
          { role: 'user', content: prompt }
        ]
      }),
      signal: controller.signal
    });
    const json = await res.json().catch(() => ({}));
    return txt(json?.choices?.[0]?.message?.content).replace(/^["']|["']$/g, '');
  } catch (e) { console.error('standings caption failed:', e.message); return ''; }
  finally { clearTimeout(timer); }
}

const firstWords = (t = '', k = 3) => txt(t).split(/\s+/).slice(0, k).join(' ');
// Подпись группы. ctx — общий на весь выпуск: какие сюжеты и начала фраз уже
// заняты, что было у этой группы неделю назад, где сезон по календарю.
export async function groupCaption(data, ctx = {}) {
  const facts = storyFacts(data, ctx);
  const key = groupKey(data.season, data.letter, data.group);
  // Подписи этого же выпуска (повторный прогон в тот же день) прошлой неделей не считаем.
  const stored = ctx.lastCaptions?.[key] || {};
  const last = stored.issue && stored.issue === ctx.issue ? {} : stored;
  const pick = pickStory(facts, { usedTypes: ctx.usedTypes || [], lastType: last.type || '' });
  const avoid = [...(ctx.usedCaptions || []), last.caption].filter(Boolean).map(c => firstWords(c));
  const rows = (data.rows || []).slice(0, MAX_ROWS);
  // Модель видит только тех, кто играл на этой неделе, и только движение вверх.
  const weekRows = rows.filter(r => r.week?.played > 0);
  const table = weekRows.map(r => `${r.name} — now ${ord(r.place)}${r.move > 0 ? ` (up ${r.move})` : ''}; this week ${r.week.played} played, ${r.week.wins} won; season ${r.matches} played, ${r.wins} won`).join('\n');
  const prompt = [
    `SEASON STAGE: ${STAGE_TEXT[facts.stage]} ${facts.played} of ${facts.total} group matches played${facts.daysLeft !== null && facts.daysLeft >= 0 ? `, ${facts.daysLeft} days left in the regular season` : ''}.`,
    `MAIN STORY: ${pick.main?.text || 'The table after this week.'}`,
    pick.extra ? `SECOND STORY (optional): ${pick.extra.text}` : '',
    avoid.length ? `Other captions start with: ${avoid.map(a => `"${a}"`).join(', ')}` : '',
    `THIS WEEK:\n${table || '(nobody played this week — do not name anyone)'}`
  ].filter(Boolean).join('\n');
  let caption = fitCaption(await askForCaption(prompt));
  if (!caption || avoid.includes(firstWords(caption))) caption = fallbackCaption(pick, key + (ctx.issue || ''));
  if (ctx.usedTypes && pick.main) ctx.usedTypes.push(pick.main.type);
  if (ctx.usedCaptions) ctx.usedCaptions.push(caption);
  if (ctx.thisIssue) ctx.thisIssue[key] = { type: pick.main?.type || '', caption, issue: ctx.issue || '' };
  return caption;
}

// Контекст выпуска: календарь сезона, форма игроков (для серий) и подписи
// прошлой недели — чтобы не повторяться.
async function captionContext(now = Date.now(), issue = '') {
  const clock = await seasonClock(now);
  const forms = new Map();
  try {
    const { getLeagueProfiles } = await import('./sheets.js');
    for (const p of await getLeagueProfiles()) if (p?.name && Array.isArray(p.form)) forms.set(looseKey(p.name), p.form);
  } catch {}
  // Межгрупповые пары W: у этих игроков по регламенту на матчи больше.
  const crossCount = new Map();
  try {
    const { currentWCrossPairs, resolveWCrossPairs } = await import('./access.js');
    const pairs = (await resolveWCrossPairs().catch(() => null))?.pairs || currentWCrossPairs();
    for (const pair of pairs || []) for (const name of pair) crossCount.set(looseKey(name), (crossCount.get(looseKey(name)) || 0) + 1);
  } catch {}
  let lastCaptions = {};
  try { lastCaptions = JSON.parse(await getSetting(CAPTIONS_SETTING).catch(() => '') || '{}') || {}; } catch {}
  return { ...clock, forms, crossCount, lastCaptions, usedTypes: [], usedCaptions: [], thisIssue: {}, issue };
}
async function rememberCaptions(ctx) {
  if (!ctx?.thisIssue || !Object.keys(ctx.thisIssue).length) return;
  await setSetting(CAPTIONS_SETTING, JSON.stringify({ ...(ctx.lastCaptions || {}), ...ctx.thisIssue }), 'Подписи прошлого выпуска таблиц — чтобы не повторяться').catch(() => {});
}

// ------------------------------------------------------------- выпуск
export function issueLabel(now = Date.now()) { return dayIn(now); }
function spanLabel(data, now) {
  const day = ms => new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, day: '2-digit', month: 'short' }).format(new Date(ms));
  const from = data.since ? Date.parse(`${data.since}T12:00:00+07:00`) : null;
  return Number.isFinite(from) ? `${day(from)} — ${day(now)}` : `AS OF ${day(now)}`;
}

// Собирает по картинке и подписи на каждую группу сезона.
export async function buildStandingsStories(season = '', { now = Date.now(), only = '', captionsOnly = false } = {}) {
  const useSeason = txt(season) || txt(await latestSeason().catch(() => '')) || '';
  const wanted = txt(only).toUpperCase().replace(/\s+/g, '');
  const snapshots = await readSnapshots();
  const captionCtx = await captionContext(now, issueLabel(now));
  const items = [];
  for (const g of await standingsGroups(useSeason)) {
    const label = `${txt(g.letter).toUpperCase()}${txt(g.group).toUpperCase()}`;
    if (wanted && label !== wanted && txt(g.letter).toUpperCase() !== wanted) continue;
    const data = await buildStandings(useSeason, g.letter, g.group, snapshots, issueLabel(now));
    if (!data) continue;
    const title = groupTitle(g.letter, g.group, g.title);
    const subtitle = `SEASON ${useSeason} · ${spanLabel(data, now)}`;
    const buffer = captionsOnly ? null : await renderStandingsPoster(data, { title, subtitle });
    items.push({ key: label, letter: g.letter, group: g.group, title, subtitle, data, buffer, caption: await groupCaption(data, captionCtx) });
  }
  return { season: useSeason, items, captionCtx };
}

// Отправка в тему: картинка группы, следом её подпись отдельным сообщением —
// одним касанием копируется целиком. Кнопка публикации в сторис появляется
// только когда Instagram подключён.
const tableFileName = (item = {}) => `table-${String(item.key || 'group').toLowerCase()}-${dayIn()}.png`;
export async function deliverStandings(prepared, { chatId, threadId = '', canPublish = false, captionsOnly = false } = {}) {
  if (!chatId) return { ok: false, reason: 'no_chat' };
  const opts = threadId ? { message_thread_id: threadId } : {};
  if (!prepared?.items?.length) {
    await sendMessage(chatId, '📊 <b>Таблицы дивизионов</b>\n\nНет ни одной группы с данными.', opts).catch(() => {});
    return { ok: true, empty: true };
  }
  if (captionsOnly) {
    // Только подписи: картинки уже есть, нужны новые тексты.
    await sendMessage(chatId, `✍️ <b>Подписи к таблицам</b> · ${esc(spanLabel(prepared.items[0].data, Date.now()))}\nКартинки не пересобирались.`, opts).catch(() => {});
    for (const item of prepared.items)
      await sendMessage(chatId, `📊 <b>${esc(item.title)}</b>\n<code>${esc(item.caption)}</code>`, opts)
        .catch(e => console.error('standings caption failed:', e.message));
    return { ok: true, count: prepared.items.length, captionsOnly: true };
  }
  for (const item of prepared.items) {
    // Файлом, а не фотографией: sendPhoto ужимает картинку до 1280 px, и
    // сохранённая из чата таблица теряет качество ещё до Instagram.
    await sendDocumentBuffer(chatId, item.buffer, tableFileName(item), opts)
      .catch(e => console.error('standings file failed:', e.message));
    await sendMessage(chatId,
      `📊 <b>${esc(item.title)}</b>\n\n<b>Подпись</b> — нажмите, чтобы скопировать:\n<code>${esc(item.caption)}</code>`,
      { ...opts, ...(canPublish ? { reply_markup: { inline_keyboard: [[{ text: '📤 В сторис', callback_data: `igtable:${item.key}` }]] } } : {}) }
    ).catch(e => console.error('standings caption failed:', e.message));
  }
  return { ok: true, count: prepared.items.length };
}

export async function publishStandingsStory(item) {
  if (!instagramEnabled()) throw new Error('Instagram не подключён: задайте IG_USER_ID и IG_ACCESS_TOKEN');
  if (!item?.buffer?.length) throw new Error('Картинка уже не в памяти — соберите таблицы заново командой /tables');
  return publishStory(item.buffer, { handles: [] });
}

// Вторник, 19:00, но только внутри сезона и только начиная с WEEKLY_FROM:
// раньше этой даты выпуски делаются руками, позже SEASON_END не делаются вовсе.
// Окно — с 19:00 вторника до 12:00 среды (если сервер был занят или лежал).
// Возвращает дату выпуска (вторник) или ''.
export async function standingsIssue(now = Date.now()) {
  const { issueWindow } = await import('./publicity.js');
  const day = issueWindow(now, 'Tue');
  return day && day >= WEEKLY_FROM && day <= SEASON_END ? day : '';
}
export function standingsDue(now = Date.now(), timeZone = TIMEZONE) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(new Date(now));
  const weekday = p.find(x => x.type === 'weekday')?.value || '';
  const hour = Number(p.find(x => x.type === 'hour')?.value || -1);
  const day = dayIn(now), yesterday = dayIn(now - 24 * 3600 * 1000);
  if (weekday === 'Tue' && hour >= 19) return day >= WEEKLY_FROM && day <= SEASON_END;
  if (weekday === 'Wed' && hour < 12) return yesterday >= WEEKLY_FROM && yesterday <= SEASON_END;
  return false;
}

// force — ручной прогон командой: расписание и отметку «уже делали» не смотрим.
// save=false — черновой прогон: картинки будут, но точка отсчёта не сдвинется.
export async function runWeeklyStandings(now = Date.now(), adminChatId = '', { force = false, only = '', save = true, season = '', captionsOnly = false, issue: wanted = '' } = {}) {
  if (captionsOnly) save = false;   // только тексты — снимок мест не трогаем
  if (!force && !standingsDue(now)) return { ok: false, reason: 'not_due' };
  const day = wanted || (force ? issueLabel(now) : await standingsIssue(now));
  if (!force && !day) return { ok: false, reason: 'not_due' };
  // Отметка «сделано» — только после доставки; сбой — строка организатору и повтор.
  const { runIssue, instagramTarget } = await import('./publicity.js');
  return runIssue('tables', now, adminChatId, async issue => {
  const target = await instagramTarget(adminChatId);
  if (!target.chatId) return { ok: false, reason: 'no_admin_chat' };
  // Выпуск, собираемый утром среды, — на вечер вторника.
  if (!force || wanted) now = Date.parse(`${issue}T19:00:00+07:00`);
  const prepared = await buildStandingsStories(season, { now, only, captionsOnly });
  await deliverStandings(prepared, { ...target, canPublish: instagramEnabled(), captionsOnly });
  // Снимок кладём ПОСЛЕ отправки: если что-то упало по дороге, точка отсчёта
  // не сдвинется и следующий выпуск всё равно покажет верное движение.
  if (save) await rememberCaptions(prepared.captionCtx);
  if (save) for (const item of prepared.items) {
    await saveSnapshot(issue, prepared.season, item.letter, item.group, item.data.rows)
      .catch(e => console.error('standings snapshot failed:', e.message));
  }
  return { ok: true, prepared, issue, target, saved: save };
  }, { force, issue: day });
}
