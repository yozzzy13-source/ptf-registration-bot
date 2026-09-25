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
import { sendMessage, sendPhotoBuffer } from './telegram.js';
import { ensureExtraSheet, appendObjects, getRows, getSetting, setSetting } from './sheets.js';
import { availableDivisions, divisionGroups, divisionDisplayName, getDivisionTable, latestSeason } from './division.js';
import { playerPhotoForPoster } from './matchcard.js';
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
export async function lastSnapshot(season, letter, group, rows = null) {
  const all = rows || await readSnapshots();
  const mine = all.filter(r => groupKey(r.season, r.division, r.group) === groupKey(season, letter, group));
  if (!mine.length) return { issue: '', places: new Map() };
  const issue = mine.map(r => txt(r.issue) || txt(r.taken_at)).sort().pop();
  const places = new Map();
  for (const r of mine) {
    if ((txt(r.issue) || txt(r.taken_at)) !== issue) continue;
    const place = Number(r.place);
    if (nameKey(r.player) && Number.isFinite(place)) places.set(nameKey(r.player), place);
  }
  return { issue, places };
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

export async function buildStandings(season, letter, group = '', snapshots = null) {
  const table = await getDivisionTable(letter, season, group).catch(() => null);
  if (!table?.ok || !table.players?.length) return null;
  const before = await lastSnapshot(season, letter, group, snapshots);
  const rows = table.players.map(p => {
    const was = before.places.get(nameKey(p.name));
    const move = Number.isFinite(was) ? was - p.place : null;   // + вверх, − вниз
    return { ...p, was: Number.isFinite(was) ? was : null, move };
  });
  return { season, letter, group, rows, baseline: !before.places.size, since: before.issue };
}

// ------------------------------------------------------------- рисование
const MAX_ROWS = Math.max(4, Math.min(14, Number(process.env.STANDINGS_MAX_ROWS || 12)));
const L = {
  title: 148, name: 206, sub: 250,
  head: 322, first: 366, row: 104,
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

async function avatarCircle(row, size) {
  const buffer = await playerPhotoForPoster({ name: row.name }).catch(() => null);
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
  const SPONSOR = { top: 1556, bottom: 1818 };
  const sponsor = await sponsorStrip(SPONSOR);
  // Блок строк центрируем в полосе между шапкой и плашкой партнёров: группы
  // разной длины, и прибитая к верху таблица оставляла бы внизу пустоту.
  const bandTop = 340, bandBottom = SPONSOR.top - 28;
  const first = Math.round(bandTop + Math.max(0, (bandBottom - bandTop - rows.length * L.row) / 2));
  const head = first - 26;
  const bodyBottom = first + rows.length * L.row + 18;
  const zone = i => (data.group ? (i < 4 ? C.win : '') : (i < 4 ? C.win : i < 6 ? C.amber : C.loss));

  let body = '';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], y = first + i * L.row, mid = y + L.row / 2;
    const accent = zone(i);
    body += `<rect x="40" y="${y}" width="1000" height="${L.row - 12}" rx="24" fill="${C.plate}" stroke="${C.plateLine}"/>`;
    if (accent) body += `<rect x="40" y="${y}" width="7" height="${L.row - 12}" rx="3.5" fill="${accent}" opacity=".85"/>`;
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
    font-weight="800" letter-spacing="2" fill="${C.mute}">P</text>
  <text x="${L.colW}" y="${head}" text-anchor="middle" font-family="${FONT}" font-size="15"
    font-weight="800" letter-spacing="2" fill="${C.mute}">W</text>
  <text x="${L.colPts}" y="${head}" text-anchor="middle" font-family="${FONT}" font-size="15"
    font-weight="800" letter-spacing="2" fill="${C.mute}">PTS</text>
  ${data.baseline ? '' : `<text x="${L.colMove}" y="${head}" text-anchor="middle" font-family="${FONT}" font-size="15"
    font-weight="800" letter-spacing="2" fill="${C.mute}">+/-</text>`}
  ${body}
  ${data.baseline ? `<text x="${WIDTH / 2}" y="${Math.min(bodyBottom + 40, 1500)}" text-anchor="middle" font-family="${FONT}"
    font-size="18" font-weight="700" letter-spacing="2" fill="${C.mute}">FIRST ISSUE — MOVEMENT STARTS NEXT WEEK</text>` : ''}
</svg>`);

  const layers = [{ input: svg, left: 0, top: 0 }];
  const size = 62;
  for (let i = 0; i < rows.length; i++) {
    const circle = await avatarCircle(rows[i], size).catch(() => null);
    if (circle) layers.push({ input: circle, left: L.colAvatar - size / 2, top: first + i * L.row + Math.round((L.row - 12 - size) / 2) });
  }
  if (sponsor?.layer) layers.push(sponsor.layer);
  return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: { r: 12, g: 11, b: 11, alpha: 1 } } })
    .composite(layers).png({ compressionLevel: 6 }).toBuffer();
}

// ------------------------------------------------------------- подпись
export const STANDINGS_HASHTAGS = ['#phuket', '#tennis', '#phukettennis', '#phukettennisfamily'];
const TEXT_MODEL = process.env.STANDINGS_TEXT_MODEL || 'gpt-4o-mini';
const OPENAI_KEY = String(process.env.OPENAI_API_KEY || '').trim();

// Одно предложение по группе. Просим модель, но никогда на неё не полагаемся:
// если ключа нет или запрос не прошёл, собираем фразу сами из тех же фактов.
function fallbackSentence(data, title) {
  const rows = data.rows || [];
  const top = rows[0];
  const climber = rows.filter(r => Number.isFinite(r.move) && r.move > 0).sort((a, b) => b.move - a.move)[0];
  const parts = [];
  if (top) parts.push(`${top.name} leads ${title.replace(/^DIVISION\s+/i, 'Division ')} with ${top.points} points from ${top.matches} matches`);
  if (climber) parts.push(`${climber.name} is the week's biggest mover, up ${climber.move}`);
  return (parts.join(', ') || `${title} standings updated`) + '.';
}
async function askForSentence(prompt) {
  if (!OPENAI_KEY) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await globalThis.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TEXT_MODEL, temperature: 0.7, max_tokens: 90,
        messages: [
          { role: 'system', content: 'You write one short English sentence for an amateur tennis league Instagram story. No emoji, no hashtags, no quotes, max 25 words.' },
          { role: 'user', content: prompt }
        ]
      }),
      signal: controller.signal
    });
    const json = await res.json().catch(() => ({}));
    return txt(json?.choices?.[0]?.message?.content).replace(/^["']|["']$/g, '');
  } catch (e) { console.error('standings sentence failed:', e.message); return ''; }
  finally { clearTimeout(timer); }
}

export async function groupCaption(data, title, subtitle) {
  const rows = (data.rows || []).slice(0, MAX_ROWS);
  const facts = rows.map(r => `${r.place}. ${r.name} — ${r.points} pts, ${r.matches} played, ${r.wins} won`
    + (Number.isFinite(r.move) && r.move !== 0 ? `, ${r.move > 0 ? 'up' : 'down'} ${Math.abs(r.move)}` : '')).join('\n');
  const sentence = await askForSentence(`League: Phuket Tennis Family. ${title}. Standings after this week:\n${facts}\n\nWrite one sentence about what happened in this group.`)
    || fallbackSentence(data, title);
  return [`🎾 ${title}`, '', sentence, '', subtitle, '', STANDINGS_HASHTAGS.join(' ')].join('\n');
}

// ------------------------------------------------------------- выпуск
export function issueLabel(now = Date.now()) { return dayIn(now); }
function spanLabel(data, now) {
  const day = ms => new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, day: '2-digit', month: 'short' }).format(new Date(ms));
  const from = data.since ? Date.parse(`${data.since}T12:00:00+07:00`) : null;
  return Number.isFinite(from) ? `${day(from)} — ${day(now)}` : `AS OF ${day(now)}`;
}

// Собирает по картинке и подписи на каждую группу сезона.
export async function buildStandingsStories(season = '', { now = Date.now(), only = '' } = {}) {
  const useSeason = txt(season) || txt(await latestSeason().catch(() => '')) || '';
  const wanted = txt(only).toUpperCase().replace(/\s+/g, '');
  const snapshots = await readSnapshots();
  const items = [];
  for (const g of await standingsGroups(useSeason)) {
    const label = `${txt(g.letter).toUpperCase()}${txt(g.group).toUpperCase()}`;
    if (wanted && label !== wanted && txt(g.letter).toUpperCase() !== wanted) continue;
    const data = await buildStandings(useSeason, g.letter, g.group, snapshots);
    if (!data) continue;
    const title = groupTitle(g.letter, g.group, g.title);
    const subtitle = `SEASON ${useSeason} · ${spanLabel(data, now)}`;
    const buffer = await renderStandingsPoster(data, { title, subtitle });
    items.push({ key: label, letter: g.letter, group: g.group, title, subtitle, data, buffer, caption: await groupCaption(data, title, subtitle) });
  }
  return { season: useSeason, items };
}

// Отправка в тему: картинка группы, следом её подпись отдельным сообщением —
// одним касанием копируется целиком. Кнопка публикации в сторис появляется
// только когда Instagram подключён.
export async function deliverStandings(prepared, { chatId, threadId = '', canPublish = false } = {}) {
  if (!chatId) return { ok: false, reason: 'no_chat' };
  const opts = threadId ? { message_thread_id: threadId } : {};
  if (!prepared?.items?.length) {
    await sendMessage(chatId, '📊 <b>Таблицы дивизионов</b>\n\nНет ни одной группы с данными.', opts).catch(() => {});
    return { ok: true, empty: true };
  }
  for (const item of prepared.items) {
    await sendPhotoBuffer(chatId, item.buffer, 'image/png', opts).catch(e => console.error('standings photo failed:', e.message));
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
export function standingsDue(now = Date.now(), timeZone = TIMEZONE) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(new Date(now));
  const weekday = p.find(x => x.type === 'weekday')?.value || '';
  const hour = Number(p.find(x => x.type === 'hour')?.value || -1);
  const day = dayIn(now);
  return weekday === 'Tue' && hour === 19 && day >= WEEKLY_FROM && day <= SEASON_END;
}

// force — ручной прогон командой: расписание и отметку «уже делали» не смотрим.
// save=false — черновой прогон: картинки будут, но точка отсчёта не сдвинется.
export async function runWeeklyStandings(now = Date.now(), adminChatId = '', { force = false, only = '', save = true, season = '' } = {}) {
  if (!force && !standingsDue(now)) return { ok: false, reason: 'not_due' };
  const issue = issueLabel(now);
  if (!force) {
    const last = await getSetting('standings_weekly_last').catch(() => '');
    if (txt(last) === issue) return { ok: false, reason: 'already_done' };
    await setSetting('standings_weekly_last', issue, 'Дата последнего выпуска таблиц дивизионов');
  }
  const { instagramTarget } = await import('./publicity.js');
  const target = await instagramTarget(adminChatId);
  if (!target.chatId) return { ok: false, reason: 'no_admin_chat' };
  const prepared = await buildStandingsStories(season, { now, only });
  await deliverStandings(prepared, { ...target, canPublish: instagramEnabled() });
  // Снимок кладём ПОСЛЕ отправки: если что-то упало по дороге, точка отсчёта
  // не сдвинется и следующий выпуск всё равно покажет верное движение.
  if (save) for (const item of prepared.items) {
    await saveSnapshot(issue, prepared.season, item.letter, item.group, item.data.rows)
      .catch(e => console.error('standings snapshot failed:', e.message));
  }
  return { ok: true, prepared, issue, target, saved: save };
}
