// Карточка матча: одна картинка со счётом и двумя портретами.
//
// Это НЕ генерация: аватарки игроков берутся как есть, режутся в круг и
// кладутся на фон. Лица настоящие, ничего не выдумывается, денег не стоит,
// собирается примерно за сотню миллисекунд.
//
// Фото ищем по той же цепочке, что и везде в приложении:
//   1) своя аватарка игрока (avatar_file_id, лежит в Telegram);
//   2) фото из Players_Master;
//   3) инициалы в кружке — если фото нет вовсе.
//
// Подписи на карточке английские: одна картинка уходит всем сразу, а имена у
// нас латиницей. Кириллицу выбранный шрифт тянет плохо, поэтому не смешиваем.
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getFileBuffer } from './telegram.js';
import { findApplicantByTelegramId, getMasterPhotos, sameName } from './sheets.js';
import { sponsorsAvailable, sponsorStrip } from './sponsors.js';

const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
const CARD_LOGOS_DIR = path.join(ASSETS_DIR, 'match-card-logos');

// Любые прозрачные PNG/WebP/SVG из этой папки автоматически появляются в
// нижней части следующей карточки. Список перечитывается на каждую генерацию:
// чтобы сменить партнёров, достаточно заменить файлы и перезапустить не нужно.
// Свободная полоса под колонками статистики: рамки и подписи там нет, просто
// пустое место, куда ложится общая лента партнёров во всю ширину карточки.
const CARD_SPONSOR_BAND = { top: 900, bottom: 1140 };
async function cardLogoComposites(canvasWidth = 1080, canvasHeight = 1148) {
  // Один общий файл партнёров главнее папки с отдельными логотипами: он
  // одинаково выглядит на карточке, постере матча и постере таблицы.
  if (sponsorsAvailable()) {
    const layers = [];
    try {
      const org = await sharp(path.join(CARD_LOGOS_DIR, 'ptf.png'))
        .resize({ width: 230, height: 120, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
      const meta = await sharp(org).metadata();
      layers.push({ input: org, left: Math.round((canvasWidth - (meta.width || 230)) / 2), top: 160 });
    } catch (e) { if (e && e.code !== 'ENOENT') console.error('match card org logo failed:', e.message); }
    const band = Math.min(CARD_SPONSOR_BAND.bottom, canvasHeight - 20);
    const strip = await sponsorStrip({ top: CARD_SPONSOR_BAND.top, bottom: band, canvas: canvasWidth });
    if (strip?.layer) layers.push(strip.layer);
    return layers;
  }
  let files = [];
  try {
    files = fs.readdirSync(CARD_LOGOS_DIR)
      .filter(name => /\.(png|webp|svg)$/i.test(name))
      .sort((a,b) => a.localeCompare(b))
      .slice(0, 4);
  } catch (e) {
    if (e && e.code !== 'ENOENT') console.error('match card logos read failed:', e.message);
    return [];
  }
  if (!files.length) return [];
  const gap = 34, available = 880;
  const boxWidth = Math.min(230, Math.floor((available - gap * (files.length - 1)) / files.length));
  const rendered = [];
  for (const name of files) {
    try {
      const input = path.join(CARD_LOGOS_DIR, name);
      const buffer = await sharp(input).resize({
        width:boxWidth, height:120, fit:'inside', withoutEnlargement:true
      }).png().toBuffer();
      const meta = await sharp(buffer).metadata();
      rendered.push({ name, input:buffer, width:meta.width || boxWidth, height:meta.height || 120 });
    } catch (e) { console.error('match card logo failed:', name, e.message); }
  }
  const organization = rendered.find(item => /^ptf\./i.test(item.name));
  const sponsors = rendered.filter(item => item !== organization);
  const layers = [];
  if (organization) layers.push({ input:organization.input, left:Math.round((canvasWidth - organization.width) / 2), top:160 });
  const total = sponsors.reduce((sum,item) => sum + item.width, 0) + gap * Math.max(0, sponsors.length - 1);
  let left = Math.round((canvasWidth - total) / 2);
  for (const item of sponsors) { layers.push({ input:item.input, left, top:canvasHeight - 160 + Math.round((120 - item.height) / 2) }); left += item.width + gap; }
  return layers;
}
// Берём любые шрифты, положенные в assets: .ttf и .otf, сколько угодно
// начертаний. Имя семейства читаем из файла, поэтому замена шрифта — это
// просто замена файлов, без единой правки кода.
function cardFontFiles() {
  try {
    return fs.readdirSync(ASSETS_DIR)
      .filter(f => /\.(ttf|otf)$/i.test(f))
      .sort((a, b) => {
        // Обычное начертание вперёд: именно из него берём имя семейства.
        const score = f => (/regular/i.test(f) ? 0 : /medium|book/i.test(f) ? 1 : /italic/i.test(f) ? 3 : 2);
        return score(a) - score(b) || a.localeCompare(b);
      })
      .map(f => path.join(ASSETS_DIR, f));
  } catch (e) { console.error('card fonts read failed:', e.message); return []; }
}
const CARD_FONT_FILE = cardFontFiles()[0] || '';

// Шрифт для картинки. Раньше он лежал в SVG как base64 внутри @font-face, и
// казалось, что этого достаточно. Но librsvg внутри sharp встроенные шрифты НЕ
// читает — он спрашивает их у fontconfig. На машине разработчика шрифты есть, и
// всё рисовалось; на сервере их нет, и вся подпись превращалась в квадратики.
//
// Поэтому показываем fontconfig папку с нашим шрифтом и зовём его настоящим
// именем семейства — оно берётся из самого файла, а не выдумывается. Тогда
// подмена файла на другой шрифт продолжит работать без правок кода.
function fontFamilyOf(file) {
  try {
    const b = fs.readFileSync(file);
    const tables = {};
    const count = b.readUInt16BE(4);
    for (let i = 0; i < count; i++) {
      const rec = 12 + i * 16;
      tables[b.toString('latin1', rec, rec + 4)] = b.readUInt32BE(rec + 8);
    }
    const nameOff = tables.name;
    if (!nameOff) return '';
    const recs = b.readUInt16BE(nameOff + 2), strOff = nameOff + b.readUInt16BE(nameOff + 4);
    let fallback = '';
    for (let i = 0; i < recs; i++) {
      const r = nameOff + 6 + i * 12;
      const platform = b.readUInt16BE(r), nameId = b.readUInt16BE(r + 6);
      const len = b.readUInt16BE(r + 8), off = b.readUInt16BE(r + 10);
      if (nameId !== 1) continue;
      const raw = b.subarray(strOff + off, strOff + off + len);
      const wide = platform === 3 || platform === 0;
      const value = wide ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1');
      if (value && !fallback) fallback = value;
      if (platform === 3) return value;
    }
    return fallback;
  } catch (e) { console.error('card font name read failed:', e.message); return ''; }
}
const CARD_FONT_FAMILY = (CARD_FONT_FILE && fontFamilyOf(CARD_FONT_FILE)) || 'DejaVu Sans';
// Экранировать не нужно: имя семейства берём из файла шрифта, кавычек там не бывает.
const FONT = `'${CARD_FONT_FAMILY}', 'DejaVu Sans', 'Liberation Sans', sans-serif`;

// Конфиг fontconfig собираем сами: так папка со шрифтом видна всегда, даже если
// на сервере своего конфига нет вовсе. Системные папки оставляем — вдруг там
// есть что-то ещё полезное.
(function ensureCardFont() {
  if (process.env.FONTCONFIG_FILE) return;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptf-fonts-'));
    const conf = path.join(dir, 'fonts.conf');
    fs.writeFileSync(conf, `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${ASSETS_DIR}</dir>
  <dir>/usr/share/fonts</dir>
  <dir>/usr/local/share/fonts</dir>
  <dir prefix="xdg">fonts</dir>
  <cachedir>${path.join(dir, 'cache')}</cachedir>
</fontconfig>
`);
    process.env.FONTCONFIG_FILE = conf;
    console.log(`card font: ${CARD_FONT_FAMILY} (${cardFontFiles().length} file(s) in assets)`);
  } catch (e) { console.error('card font setup failed:', e.message); }
})();
const W = 1200, H = 650, R = 200;
// Центры портретов. По краям карточки — колонки со статистикой (место в
// дивизионе и очки Fantasy), между портретами — счёт.
const CENTER = [{ x: 330, y: 288 }, { x: 870, y: 288 }];
const SCORE_ROOM = 340;

// Палитра Noir — та же, что в мини-приложении, чтобы картинка не выглядела
// чужой рядом с интерфейсом. Золото — то же самое кольцо чемпиона, что и на
// главной странице лиги (--goldRing/--goldGlow), только глянец собран из
// пары полупрозрачных обводок вместо box-shadow — librsvg blur ненадёжен.
const C = {
  bg1: '#0C0B0B', bg2: '#17130F', text: '#EFEBE4', dim: '#B9B1A5', mute: '#8A7F6F',
  amber: '#E8A45C', win: '#8FBF9A', line: 'rgba(255,255,255,.10)', ring2: '#4A423A',
  chipBg: 'rgba(143,191,154,.15)', chipLine: 'rgba(143,191,154,.34)', avBg: '#1C1A18',
  champ: '#D9C7A3', loss: '#C2695E', lossBg: 'rgba(194,105,94,.15)', lossLine: 'rgba(194,105,94,.36)',
  upBg: 'rgba(143,191,154,.16)', upLine: 'rgba(143,191,154,.38)',
  plate: 'rgba(255,255,255,.035)', plateLine: 'rgba(255,255,255,.10)',
  // Кольцо чемпиона — ровно как на главной странице лиги:
  // box-shadow: 0 0 0 3px var(--goldRing), 0 0 0 5px var(--goldGlow).
  // Это не размытое свечение, а два плотных кольца, поэтому и рисуем их
  // обводками в тех же пропорциях (3px и 2px от 96px аватарки).
  gold: '#C9A76A', goldGlow: 'rgba(201,167,106,.24)', goldSoft: 'rgba(201,167,106,.10)',
  // Проигравший — серебро финалиста из той же карточки чемпиона (.chru, 2px).
  silver: '#9A948B', silverSoft: 'rgba(154,148,139,.18)'
};

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const txt = (v) => String(v ?? '').trim();

// Длинные имена ужимаем, иначе они уезжают за край карточки.
function fit(name = '', max = 22) {
  const s = txt(name);
  if (s.length <= max) return s;
  const parts = s.split(/\s+/);
  if (parts.length > 1) {
    const short = `${parts[0]} ${parts[parts.length - 1][0]}.`;
    if (short.length <= max) return short;
  }
  return s.slice(0, max - 1) + '…';
}
// Счёт кладём по сетам, каждый сет своей строкой: между кружками всего ~330
// пикселей, и «7:6 (7:4) 3:6 10:8» одной строкой уезжает прямо на портреты.
// Столбиком это ещё и читается как табло.
function scoreLines(score = '') {
  const raw = txt(score).toUpperCase();
  if (/^(W\/L|L\/W|L\/L)$/.test(raw)) return [raw];
  const s = txt(score).replace(/\s*\/\s*/g, ' ');
  const out = [];
  for (const tok of s.split(/\s+/).filter(Boolean)) {
    // Тай-брейк в скобках и пометки вроде RET относятся к предыдущему сету.
    if (out.length && (/^\(/.test(tok) || /^(RET|W\.?O\.?|DEF|WO)$/i.test(tok))) {
      out[out.length - 1] += ` ${tok}`;
      continue;
    }
    out.push(tok);
  }
  return out.length ? out.slice(0, 4) : ['—'];
}
// Подбираем кегль так, чтобы самая длинная строка влезла в просвет.
function scoreSize(lines, room = 330) {
  const longest = lines.reduce((n, l) => Math.max(n, l.replace(/\s*\([^)]*\)/g, '').length), 1);
  const byRows = [92, 92, 76, 64, 54][lines.length] || 54;
  return Math.max(34, Math.min(byRows, Math.floor(room / (longest * 0.62))));
}

function initials(name = '') {
  const parts = txt(name).split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

// --------------------------------------------------------------- портреты
// Кадрируем по «интересной» области, а не по центру: на селфи лицо редко
// стоит ровно посередине, и центральная обрезка режет его пополам.
//
// Квадрат фотографии касается круга в четырёх точках, и туда попадает самый край
// исходника: у круглых аватарок это белая кайма, у скриншотов — полоска
// интерфейса. Боремся в два приёма, и оба щадящие — сильный «зум внутрь» резал
// бы макушки на нормальных портретах.
//   1) отрезаем однотонную рамку по периметру, если она там есть;
//   2) берём кадр на 6% крупнее круга и режем центр — этого хватает на
//      сглаженные края и тонкие каёмки, а кольцо перекрывает остаток.
const ZOOM = 1.06;

// Однотонная рамка по всему периметру — это рамка, а не часть кадра. Если срез
// вышел слишком большим, значит однотонным был сам фон снимка: откатываемся.
async function trimEdges(buffer) {
  try {
    const upright = await sharp(buffer).rotate().toBuffer();
    const { width, height } = await sharp(upright).metadata();
    const cut = await sharp(upright).trim({ threshold: 12 }).toBuffer({ resolveWithObject: true });
    if (cut.info.width < width * 0.75 || cut.info.height < height * 0.75) return upright;
    return cut.data;
  } catch { return buffer; }
}

// Рамки ровно те же, что и в карточке чемпиона на главной: победителю —
// золотое кольцо 3px плюс плотный полупрозрачный ободок 2px, проигравшему —
// серебро финалиста 2px. Пропорции считаем от 96px аватарки интерфейса, чтобы
// на большой картинке кольцо выглядело так же, а не толстым обручем.
const FRAME = {
  winner: { ring: C.gold, glow: C.goldGlow, soft: C.goldSoft, ringScale: 0.031, glowScale: 0.021 },
  loser: { ring: C.silver, glow: C.silverSoft, soft: '', ringScale: 0.021, glowScale: 0.014 }
};

async function toCircle(buffer, size, frame) {
  const big = Math.round(size * ZOOM);
  const off = Math.round((big - size) / 2);
  const photo = await sharp(await trimEdges(buffer))
    .resize(big, big, { fit: 'cover', position: sharp.strategy.attention })
    .extract({ left: off, top: off, width: size, height: size })
    .toBuffer();
  const mask = Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`);
  const round = await sharp(photo).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  return withFrame(round, size, frame);
}
// Кольца рисуются СНАРУЖИ фотографии, поэтому буфер выходит крупнее исходного:
// композит на карточке центрируется по фактическому размеру, а не по R.
async function withFrame(buffer, size, frame = FRAME.loser) {
  const rw = Math.max(3, Math.round(size * frame.ringScale));
  const gw = Math.max(2, Math.round(size * frame.glowScale));
  const sw = frame.soft ? Math.round(gw * 0.9) : 0;
  const pad = rw + gw + sw + 2, canvas = size + pad * 2, c = canvas / 2, r0 = size / 2;
  const rings = [
    `<circle cx="${c}" cy="${c}" r="${r0 + rw / 2}" fill="none" stroke="${frame.ring}" stroke-width="${rw}"/>`,
    `<circle cx="${c}" cy="${c}" r="${r0 + rw + gw / 2}" fill="none" stroke="${frame.glow}" stroke-width="${gw}"/>`
  ];
  if (frame.soft) rings.push(`<circle cx="${c}" cy="${c}" r="${r0 + rw + gw + sw / 2}" fill="none" stroke="${frame.soft}" stroke-width="${sw}"/>`);
  const svg = Buffer.from(`<svg width="${canvas}" height="${canvas}" xmlns="http://www.w3.org/2000/svg">${rings.join('')}</svg>`);
  return sharp({ create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: buffer, left: pad, top: pad }, { input: svg, left: 0, top: 0 }])
    .png().toBuffer();
}
// Заглушка вместо фото: инициалы, как в приложении.
async function initialsCircle(name, size, frame) {
  const svg = Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${C.avBg}"/>
    <text x="${size / 2}" y="${size / 2 + size * 0.13}" text-anchor="middle" font-family="${FONT}"
      font-size="${Math.round(size * 0.34)}" font-weight="800" fill="${C.mute}">${esc(initials(name))}</text>
  </svg>`);
  return withFrame(await sharp(svg).png().toBuffer(), size, frame);
}

// Контекст карточки (место в дивизионе «до», форма «до», очки Fantasy за этот
// матч) — снимается в results.js прямо перед записью счёта, пока прошлое
// состояние ещё не перезаписано. Карточка собирается уже после записи, когда
// это «до» не восстановить простым чтением таблицы, поэтому оно передаётся
// через этот короткоживущий кэш по challenge_id матча.
const cardContextStore = new Map();
const CARD_CONTEXT_TTL = 2 * 60 * 60 * 1000;
const CARD_CONTEXT_MAX = 500;
export function rememberCardContext(id, data) {
  if (!id) return;
  cardContextStore.set(String(id), { ...data, at: Date.now() });
  if (cardContextStore.size > CARD_CONTEXT_MAX) cardContextStore.delete(cardContextStore.keys().next().value);
}
function takeCardContext(id) {
  if (!id) return null;
  const hit = cardContextStore.get(String(id));
  if (!hit) return null;
  if (Date.now() - hit.at > CARD_CONTEXT_TTL) { cardContextStore.delete(String(id)); return null; }
  return hit;
}
// Для отчёта тестового прогона: показать, что именно бот снял перед записью.
export function peekCardContext(id) { return takeCardContext(id); }
export function forgetCardContext(id) { if (id) cardContextStore.delete(String(id)); }

const photoCache = new Map();      // ключ → буфер фотографии
const PHOTO_CACHE_MAX = 200;
function remember(key, buffer) {
  if (!key || !buffer) return buffer;
  photoCache.set(key, buffer);
  if (photoCache.size > PHOTO_CACHE_MAX) photoCache.delete(photoCache.keys().next().value);
  return buffer;
}

// Фото в Players_Master лежат на postimg.cc (за Cloudflare): запрос без
// браузерного User-Agent оттуда чаще обрывается, поэтому представляемся браузером.
const PHOTO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
};
async function fromUrl(url) {
  const res = await globalThis.fetch(url, { redirect: 'follow', headers: PHOTO_HEADERS });
  if (!res.ok) throw new Error(`фото не скачалось: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Ищем фото игрока по цепочке. Ошибки не роняют карточку: не нашли — рисуем
// инициалы, это лучше, чем не отправить ничего.
// Какой файл аватарки у игрока — запоминаем, чтобы при сбое чтения таблицы
// (лимит Google во время рассылки) всё равно найти фото.
const knownAvatar = new Map();
async function playerPhoto({ telegramId = '', name = '', fresh = false, report = null } = {}) {
  const key = `p:${telegramId || name.toLowerCase()}`;
  const fail = why => { if (report) report.errors.push(why); };

  if (telegramId) {
    const row = await findApplicantByTelegramId(telegramId).catch(e => { fail(`анкета: ${e.message}`); return undefined; });
    if (row) knownAvatar.set(String(telegramId), txt(row.avatar_file_id));
    const fileId = row !== undefined ? txt(row?.avatar_file_id) : (knownAvatar.get(String(telegramId)) || '');
    if (fileId) {
      if (!fresh && photoCache.has(fileId)) return photoCache.get(fileId);
      const hit = await getFileBuffer(fileId).then(f => f.buffer).catch(e => { fail(`файл аватарки: ${e.message}`); console.error(`card avatar for ${telegramId} failed:`, e.message); return null; });
      if (hit) return remember(fileId, hit);
    }
  }
  const wanted = txt(name);
  if (wanted) {
    // Имена сверяем терпимо — так же, как таблица дивизиона: «Yana D.» и
    // «Yana D», лишний пробел или регистр не должны оставлять карточку без фото.
    const master = await getMasterPhotos().catch(e => { fail(`Players_Master: ${e.message}`); return new Map(); });
    for (const [n, url] of master) {
      if (!url || !sameName(n, wanted)) continue;
      if (!fresh && photoCache.has(url)) return photoCache.get(url);
      const hit = await fromUrl(url).catch(e => { fail(`фото по ссылке: ${e.message}`); console.error(`card photo for ${wanted} failed:`, e.message); return null; });
      if (hit) return remember(url, hit);
      break;
    }
  }
  return remember(key, null);
}

// Фото для карточки результата. Если найти не удалось из-за сбоя (а не потому,
// что фото у игрока просто нет) — ещё одна попытка через пару секунд: лимит
// Google минутный, и за это время он часто уже отпускает. Причину неудачи
// возвращаем, чтобы админ узнал, что карточка ушла с инициалами.
const PHOTO_RETRY_MS = 2500;
async function cardPhoto(player) {
  const report = { errors: [] };
  const first = await playerPhoto({ ...player, report }).catch(e => { report.errors.push(e.message); return null; });
  if (first || !report.errors.length) return { buffer: first, error: '' };
  await new Promise(r => setTimeout(r, PHOTO_RETRY_MS));
  const again = { errors: [] };
  const second = await playerPhoto({ ...player, fresh: true, report: again }).catch(e => { again.errors.push(e.message); return null; });
  if (second) return { buffer: second, error: '' };
  return { buffer: null, error: again.errors[0] || report.errors[0] || 'неизвестно' };
}

export async function playerPhotoForPoster(player = {}) {
  return playerPhoto({ ...player, fresh:true });
}

// Сколько позиций и куда. Без «было #3»: стрелка с числом и так читается.
function rankPill(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === after) return null;
  return after < before
    ? { w: 66, text: `▲ ${before - after}`, bg: C.upBg, line: C.upLine, fg: C.win }
    : { w: 66, text: `▼ ${after - before}`, bg: C.lossBg, line: C.lossLine, fg: C.loss };
}
// Форма — последние до 5 матчей строго до этого, W/L кружками, как в
// приложении. Подписи нет намеренно: у части игроков истории меньше пяти
// матчей, и подпись «last 5» там врала бы.
function formChipsSvg(form, cx, y, { gap=44, r=17 }={}) {
  // Данные хранятся хронологически, а рисуем свежим слева: слева самый
  // последний матч, дальше вправо всё старее.
  const items = (form || []).slice(-5).reverse();
  if (!items.length) return '';
  let x = cx - (items.length * gap) / 2 + gap / 2;
  let out = '';
  for (const f of items) {
    const win = f === 'W';
    const bg = win ? C.chipBg : C.lossBg, line = win ? C.chipLine : C.lossLine, fg = win ? C.win : C.loss;
    out += `<circle cx="${x}" cy="${y}" r="${r}" fill="${bg}" stroke="${line}" stroke-width="1.5"/>`
      + `<text x="${x}" y="${y + Math.round(r * 0.38)}" text-anchor="middle" font-family="${FONT}"
        font-size="${Math.round(r * 1.15)}" font-weight="800" fill="${fg}">${f}</text>`;
    x += gap;
  }
  return out;
}

// ------------------------------------------------------------------ карточка
// match: { winner, loser, score, division, season, date, court, winnerMeta, loserMeta }
// winnerMeta/loserMeta: { position:{before,after}, fp, form } — необязательны.
// Единый публичный макет: та же карточка 1080×1350 используется и в Telegram,
// и для Instagram, и для архива на Google Drive.
export async function renderMatchCard(match = {}) {
  return renderInstagramMatchCard(match);
}
// Стадия плей-офф для карточки: из «SF», «Semifinal», «Semifinal S2» и т.п.
export function cardStage(v = '') {
  const x = txt(v).toLowerCase().replace(/\bs\d+\b/g, '').replace(/[^a-z0-9]+/g, '');
  if (/^(qf|quarterfinals?)$/.test(x)) return { key:'QF', title:'QUARTER-FINAL', places:false };
  if (/^(sf|semifinals?)$/.test(x)) return { key:'SF', title:'SEMI-FINAL', places:false };
  if (/^(3rd|third|thirdplace|bronze|3rdplace)$/.test(x)) return { key:'3rd', title:'3RD PLACE MATCH', places:true, win:'3RD PLACE', lose:'4TH PLACE' };
  if (/^(f|final|finals)$/.test(x)) return { key:'Final', title:'FINAL', places:true, win:'CHAMPION', lose:'RUNNER-UP' };
  return null;
}
// Кубок — простой контур, без шрифтов и картинок: librsvg рисует его везде одинаково.
function trophySvg(cx, cy, s = 1, color = C.gold) {
  const k = n => Math.round(n * s * 10) / 10;
  return `<g transform="translate(${cx - k(24)},${cy - k(26)})" fill="none" stroke="${color}" stroke-width="${k(3.2)}" stroke-linejoin="round" stroke-linecap="round">
    <path d="M${k(10)} ${k(4)}H${k(38)}V${k(16)}C${k(38)} ${k(26)} ${k(32)} ${k(32)} ${k(24)} ${k(32)}C${k(16)} ${k(32)} ${k(10)} ${k(26)} ${k(10)} ${k(16)}Z" fill="${color}" fill-opacity=".18"/>
    <path d="M${k(10)} ${k(8)}H${k(3)}C${k(3)} ${k(16)} ${k(6)} ${k(20)} ${k(11)} ${k(21)}"/>
    <path d="M${k(38)} ${k(8)}H${k(45)}C${k(45)} ${k(16)} ${k(42)} ${k(20)} ${k(37)} ${k(21)}"/>
    <path d="M${k(24)} ${k(32)}V${k(41)}M${k(15)} ${k(48)}H${k(33)}M${k(18)} ${k(48)}L${k(19)} ${k(41)}H${k(29)}L${k(30)} ${k(48)}"/>
  </g>`;
}
export async function renderInstagramMatchCard(match = {}) {
  const stage = cardStage(match.stage);
  if (stage) return renderPlayoffMatchCard(match, stage);
  const IW = 1080, IH = 1148, IR = 390;
  // Верхние 70% заняты результатом; нижние 30% намеренно остаются чистыми
  // для будущей композиции прозрачных логотипов.
  const centers = [{ x:225, y:420 }, { x:855, y:420 }];
  const m = {
    winner:txt(match.winner), loser:txt(match.loser), score:txt(match.score),
    division:txt(match.division), season:txt(match.season), label:txt(match.label),
    winnerMeta:match.winnerMeta || null, loserMeta:match.loserMeta || null
  };
  const division = m.division && !/^Division\b/i.test(m.division) ? `Division ${m.division}` : m.division;
  const chip = [division, m.season ? `Season ${m.season}` : ''].filter(Boolean).join(' · ');
  const chipW = Math.min(920, Math.max(240, chip.length * 12 + 56));
  const lines = scoreLines(m.score);
  const fs = Math.min(68, Math.max(38, scoreSize(lines, 300)));
  const step = Math.round(fs * 1.16), scoreCenter = centers[0].y;
  const first = Math.round(scoreCenter + fs * 0.34 - (lines.length - 1) * step / 2);
  // Тайбрейк — маленькой строкой под счётом сета, по центру: справа от счёта
  // ему не хватает места, длинный «(10:8)» уезжал под портрет.
  const scoreSvg = (() => {
    const tbGap = Math.round(fs * 0.5); // лишняя высота под строку тайбрейка
    const extra = lines.filter(l => /\(\d+:\d+\)$/.test(l)).length * tbGap;
    let y = Math.round(scoreCenter + fs * 0.34 - ((lines.length - 1) * step + extra) / 2);
    return lines.map(line => {
      const tie = line.match(/^(\d+:\d+)\s*\((\d+:\d+)\)$/);
      const main = tie ? tie[1] : line;
      const out = `<text x="${IW / 2}" y="${y}" text-anchor="middle" font-family="${FONT}"
        font-size="${fs}" font-weight="800" fill="${C.amber}" letter-spacing="1">${esc(main)}</text>`
        + (tie ? `<text x="${IW / 2}" y="${y + Math.round(fs * 0.42)}" text-anchor="middle"
        font-family="${FONT}" font-size="${Math.max(22, Math.round(fs * 0.38))}" font-weight="800"
        fill="${C.amber}" fill-opacity="0.85" letter-spacing="1">(${esc(tie[2])})</text>` : '');
      y += step + (tie ? tbGap : 0);
      return out;
    }).join('');
  })();
  const rank = (meta, cx) => {
    if (!meta) return '';
    const pos = meta.position || {};
    const value = Number.isFinite(pos.after) ? pos.after : (Number.isFinite(pos.before) ? pos.before : null);
    if (value === null) return '';
    const unchanged = Number.isFinite(pos.before) && Number.isFinite(pos.after) && pos.before === pos.after;
    const pill = rankPill(pos.before, pos.after) || (unchanged
      ? { text:'—', bg:'rgba(232,164,92,.13)', line:'rgba(232,164,92,.32)', fg:C.amber }
      : null);
    const w = 178, h = pill ? 118 : 90, x = cx - w / 2, y = 755;
    return `<g>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="15" fill="${C.plate}" stroke="${C.plateLine}"/>
      <text x="${cx}" y="${y + 27}" text-anchor="middle" font-family="${FONT}" font-size="14" font-weight="800"
        letter-spacing="1" fill="${C.mute}">DIVISION RANK</text>
      <text x="${cx}" y="${y + 72}" text-anchor="middle" font-family="${FONT}" font-size="40" font-weight="900"
        fill="${C.text}">#${value}</text>
      ${pill ? `<rect x="${cx - 37}" y="${y + 80}" width="74" height="30" rx="15" fill="${pill.bg}" stroke="${pill.line}"/>
      <text x="${cx}" y="${y + 101}" text-anchor="middle" font-family="${FONT}" font-size="17" font-weight="800"
        fill="${pill.fg}">${esc(pill.text)}</text>` : ''}
    </g>`;
  };
  const svg = `<svg width="${IW}" height="${IH}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.bg1}"/><stop offset="1" stop-color="${C.bg2}"/></linearGradient></defs>
    <rect width="${IW}" height="${IH}" fill="url(#g)"/>
    <rect width="${IW}" height="5" fill="${C.amber}" opacity=".9"/>
    <text x="${IW / 2}" y="66" text-anchor="middle" font-family="${FONT}" font-size="24" font-weight="700"
      letter-spacing="6" fill="${C.mute}">PHUKET TENNIS FAMILY</text>
    ${chip ? `<rect x="${IW / 2 - chipW / 2}" y="94" width="${chipW}" height="48" rx="24"
      fill="${C.chipBg}" stroke="${C.chipLine}"/>
    <text x="${IW / 2}" y="126" text-anchor="middle" font-family="${FONT}" font-size="21" font-weight="700"
      fill="${C.win}">${esc(chip)}</text>` : ''}
    ${scoreSvg}
    <text x="${centers[0].x}" y="660" text-anchor="middle" font-family="${FONT}" font-size="42" font-weight="800"
      fill="${C.text}">${esc(fit(m.winner, 18))}</text>
    <text x="${centers[1].x}" y="660" text-anchor="middle" font-family="${FONT}" font-size="42" font-weight="700"
      fill="${C.dim}">${esc(fit(m.loser, 18))}</text>
    ${formChipsSvg(m.winnerMeta && m.winnerMeta.form, centers[0].x, 713, { gap:42, r:17 })}
    ${formChipsSvg(m.loserMeta && m.loserMeta.form, centers[1].x, 713, { gap:42, r:17 })}
    ${rank(m.winnerMeta, centers[0].x)}
    ${rank(m.loserMeta, centers[1].x)}
    ${m.label ? `<text x="${centers[0].x}" y="908" text-anchor="middle" font-family="${FONT}" font-size="16"
      font-weight="700" fill="${C.champ}" letter-spacing="3">${esc(m.label)}</text>` : ''}
  </svg>`;

  const [wr, lr] = await Promise.all([
    cardPhoto({ telegramId:match.winnerId, name:m.winner }),
    cardPhoto({ telegramId:match.loserId, name:m.loser })
  ]);
  const wp = wr.buffer, lp = lr.buffer;
  const missingPhotos = [[m.winner, wr], [m.loser, lr]]
    .filter(([, r]) => r.error).map(([name, r]) => ({ name, reason: r.error }));
  const [a, b] = await Promise.all([
    wp ? toCircle(wp, IR, FRAME.winner).catch(() => initialsCircle(m.winner, IR, FRAME.winner))
       : initialsCircle(m.winner, IR, FRAME.winner),
    lp ? toCircle(lp, IR, FRAME.loser).catch(() => initialsCircle(m.loser, IR, FRAME.loser))
       : initialsCircle(m.loser, IR, FRAME.loser)
  ]);
  const [am, bm, logos] = await Promise.all([
    sharp(a).metadata(), sharp(b).metadata(), cardLogoComposites(IW, IH)
  ]);
  return sharp(Buffer.from(svg)).composite([
    { input:a, left:Math.round(centers[0].x - am.width / 2), top:Math.round(centers[0].y - am.height / 2) },
    { input:b, left:Math.round(centers[1].x - bm.width / 2), top:Math.round(centers[1].y - bm.height / 2) },
    ...logos
  ]).png({ compressionLevel:6 }).toBuffer().then(buf => {
    // Кто остался без фото из-за сбоя — пометка для рассылки (см. matches.js).
    if (missingPhotos.length) buf.missingPhotos = missingPhotos;
    return buf;
  });
}
// Место «после» матча читаем прямо сейчас (это просто текущая таблица
// дивизиона — она не протухает), а место «до», форму и очки Fantasy — из
// контекста, снятого results.js перед записью счёта. Если контекста нет
// (карточка перевыпущена спустя долгое время, или сервер перезапускался
// между записью и рассылкой) — просто не показываем эти блоки.
// Контекста нет — постер собирают по старому матчу, или сервер перезапускался
// между записью счёта и рассылкой. Тогда берём ровно ту же логику, что и
// карточка результата, только считаем её сейчас:
//
//  • форма — из витрины профилей (Frontend_Profile_All.recent_form), то есть
//    по всей истории игрока, а не по одному журналу текущего дивизиона;
//    витрина не заполнена — падаем на Match_Log, как и карточка;
//  • место — из живой таблицы дивизиона, теми же терпимыми сравнениями имён.
//
// Стрелку движения задним числом не рисуем: место «до» карточка снимает в
// момент записи счёта, когда строка матча ещё пуста, и восстановить его из
// сегодняшних данных нельзя. Плашка выходит с номером места, но без пилюли.
async function metasFromSheets(slot, winnerIsFrom, seasonHint = '') {
  const division = txt(slot.division), season = txt(seasonHint) || txt(slot.season), group = txt(slot.group);
  if (!division) return [null, null];
  const p1 = txt(slot.from_name), p2 = txt(slot.to_name);
  try {
    const { getDivisionTable, playerFormAcrossSeasons } = await import('./division.js');
    const { sameName, getLeagueProfiles } = await import('./sheets.js');
    const [table, profiles] = await Promise.all([
      getDivisionTable(division, season, group).catch(() => null),
      getLeagueProfiles().catch(() => [])
    ]);
    // Та же цепочка, что в results.js: сначала журналы дивизионов сквозь
    // сезоны, витрина профилей — запасной вариант.
    const formOf = async name => {
      // Главный источник — общий журнал лиги: там все матчи по порядку,
      // включая межгрупповые. Форма — по этот матч включительно.
      const { leagueFormBefore } = await import('./results.js');
      const central = await leagueFormBefore(name, { throughPair: [p1, p2], limit: 5 }).catch(() => null);
      if (central && central.length) return central;
      const live = await playerFormAcrossSeasons(name, { season, limit: 5 }).catch(() => []);
      if (live.length) return live;
      const shown = profiles.find(x => sameName(x.name, name))?.form;
      return Array.isArray(shown) && shown.length ? shown.slice(-5) : [];
    };
    const [form1, form2] = await Promise.all([formOf(p1), formOf(p2)]);
    const place = name => table?.ok ? table.players.find(x => sameName(x.name, name))?.place : undefined;
    const fromMeta = { form: form1, position: { after: place(p1) } };
    const toMeta = { form: form2, position: { after: place(p2) } };
    return winnerIsFrom ? [fromMeta, toMeta] : [toMeta, fromMeta];
  } catch (e) { console.error('card meta rebuild failed:', e.message); return [null, null]; }
}
async function buildPlayerMetas(slot, winnerIsFrom, seasonHint = '') {
  const ctx = takeCardContext(slot.challenge_id);
  if (!ctx) return metasFromSheets(slot, winnerIsFrom, seasonHint);
  const fromMeta = { form: ctx.p1?.form || [], position: { before: ctx.p1?.place } };
  const toMeta = { form: ctx.p2?.form || [], position: { before: ctx.p2?.place } };
  try {
    if (ctx.division && ctx.season) {
      const { getDivisionTable } = await import('./division.js');
      const { sameName } = await import('./sheets.js');
      const find = (table,name) => table?.ok
        ? (table.players || []).find(p => sameName(p.name,name))
        : null;
      if (ctx.cross_group || ctx.group === 'cross') {
        const [p1Table,p2Table]=await Promise.all([
          getDivisionTable(ctx.division,ctx.season,ctx.p1?.group || '').catch(()=>null),
          getDivisionTable(ctx.division,ctx.season,ctx.p2?.group || '').catch(()=>null)
        ]);
        const p1row=find(p1Table,ctx.p1?.name),p2row=find(p2Table,ctx.p2?.name);
        if (p1row) fromMeta.position.after=p1row.place;
        if (p2row) toMeta.position.after=p2row.place;
      } else {
        const table=await getDivisionTable(ctx.division,ctx.season,ctx.group || '');
        const p1row=find(table,ctx.p1?.name),p2row=find(table,ctx.p2?.name);
        if (p1row) fromMeta.position.after=p1row.place;
        if (p2row) toMeta.position.after=p2row.place;
      }
    }
  } catch (e) { console.error('card position lookup failed:', e.message); }
  return winnerIsFrom ? [fromMeta, toMeta] : [toMeta, fromMeta];
}
// Данные карточки и постера собираются одной функцией: имена, порядок игроков,
// счёт, форма и движение по дивизиону не могут разойтись между форматами.
export async function matchDataForSlot(slot = {}, { winnerFirstScore, season = '' } = {}) {
  const bothTechnical=String(slot.result_kind||'')==='technical'&&!slot.result_winner;
  const winnerIsFrom = bothTechnical || String(slot.result_winner) === String(slot.from_telegram_id);
  const score = typeof winnerFirstScore === 'function' ? winnerFirstScore(slot) : txt(slot.result_score);
  const [winnerMeta, loserMeta] = await buildPlayerMetas(slot, winnerIsFrom, season).catch(() => [null, null]);
  return {
    winner: winnerIsFrom ? slot.from_name : slot.to_name,
    loser: winnerIsFrom ? slot.to_name : slot.from_name,
    winnerId: winnerIsFrom ? slot.from_telegram_id : slot.to_telegram_id,
    loserId: winnerIsFrom ? slot.to_telegram_id : slot.from_telegram_id,
    label:bothTechnical?'TECHNICAL RESULT':'', round:slot.round||'',
    // Матч плей-офф получает свою карточку (золото, стадия вместо места).
    stage: cardStage(slot.stage) ? slot.stage : (/^\d*$/.test(txt(slot.round)) ? '' : (cardStage(slot.round) ? slot.round : '')),
    score, division: [slot.division, slot.group ? `Group ${slot.group}` : ''].filter(Boolean).join(' · '), season,
    date: slot.agreed_date ? fmtDate(slot.agreed_date) : '',
    court: slot.agreed_court || '',
    winnerMeta, loserMeta
  };
}

// Карточка по слоту матча из таблицы матчей. Победитель всегда первым, счёт
// развёрнут в его сторону — так же, как в тексте ленты.
export async function cardForSlot(slot = {}, options = {}) {
  return renderMatchCard(await matchDataForSlot(slot, options));
}
function fmtDate(iso = '') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso).trim();
}

export function forgetPhotoCache() { photoCache.clear(); }


// ------------------------------------------------------------ плей-офф
// Карточка матча плей-офф. Та же сетка, что у обычной (портреты, счёт по сетам,
// форма, лента партнёров), но:
//  • золотые ленты сверху и снизу, тёплое золотое свечение за счётом;
//  • вместо «места в дивизионе» — итог стадии: «TO THE FINAL» / «SEMIFINALIST»;
//  • в финале — кубок и «CHAMPION», победитель подсвечен сильнее.
function scoreBlockSvg(score, cx, cy, color = C.amber) {
  const lines = scoreLines(score);
  const fs = Math.min(68, Math.max(38, scoreSize(lines, 300)));
  const step = Math.round(fs * 1.16), tbGap = Math.round(fs * 0.5);
  const extra = lines.filter(l => /\(\d+:\d+\)$/.test(l)).length * tbGap;
  let y = Math.round(cy + fs * 0.34 - ((lines.length - 1) * step + extra) / 2);
  return lines.map(line => {
    const tie = line.match(/^(\d+:\d+)\s*\((\d+:\d+)\)$/);
    const out = `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${FONT}" font-size="${fs}"
      font-weight="800" fill="${color}" letter-spacing="1">${esc(tie ? tie[1] : line)}</text>`
      + (tie ? `<text x="${cx}" y="${y + Math.round(fs * 0.42)}" text-anchor="middle" font-family="${FONT}"
      font-size="${Math.max(22, Math.round(fs * 0.38))}" font-weight="800" fill="${color}" fill-opacity="0.85">(${esc(tie[2])})</text>` : '');
    y += step + (tie ? tbGap : 0);
    return out;
  }).join('');
}
// Оформление стадий: у каждой свой металл и свой декор.
//   QF   — сталь и холодный синий: прожекторы вечернего корта;
//   SF   — золото: лучи за счётом;
//   3rd  — бронза: медаль «3» у победителя;
//   Final— насыщенное золото, двойные уголки, искры, кубок и «CHAMPION».
export const STAGE_THEMES = {
  QF:    { metal: '#A9BCD6', light: '#DCE6F3', deep: '#53647C', glow: '#7FA6D9', bg2: '#0F151D', text: '#E6EDF6' },
  SF:    { metal: '#C9A76A', light: '#E9D29E', deep: '#8C6E3C', glow: '#C9A76A', bg2: '#1B160F', text: '#EFE4CC' },
  '3rd': { metal: '#C08457', light: '#E3B48C', deep: '#7A4A2A', glow: '#C08457', bg2: '#1C130D', text: '#F0DCCB' },
  Final: { metal: '#D8B45F', light: '#F6E3A4', deep: '#8E6A2A', glow: '#E8C46A', bg2: '#21180A', text: '#F7EBCB' }
};
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const frameFor = th => ({ ring: th.metal, glow: hexA(th.metal, .3), soft: hexA(th.metal, .1), ringScale: 0.031, glowScale: 0.021 });
const championFrame = th => ({ ring: th.metal, glow: hexA(th.light, .45), soft: hexA(th.metal, .18), ringScale: 0.042, glowScale: 0.03 });
// Уголки рамки: только в углах кадра, чтобы не заходить на портреты.
function cornersSvg(W, H, th, double) {
  const L = 92, o = 22, w = 3;
  const c = (x, y, dx, dy, off) => `<path d="M${x + dx * off} ${y + dy * (off + L)} V${y + dy * off} H${x + dx * (off + L)}" fill="none" stroke="${th.metal}" stroke-width="${w}" stroke-linecap="round" opacity="${off > o ? .5 : .95}"/>`;
  const set = off => c(0, 0, 1, 1, off) + c(W, 0, -1, 1, off) + c(0, H, 1, -1, off) + c(W, H, -1, -1, off);
  return set(o) + (double ? set(o + 12) : '');
}
// Искры финала: россыпь мелких ромбов в верхней части, детерминированно.
function sparklesSvg(W, th) {
  let out = '', seed = 7;
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  for (let i = 0; i < 34; i++) {
    const x = 40 + rnd() * (W - 80), y = 30 + rnd() * 230, r = 2 + rnd() * 4.5, op = .25 + rnd() * .55;
    if (Math.abs(x - W / 2) < 150 && y > 150) continue;     // не на логотипе
    out += `<path d="M${x} ${y - r} L${x + r * .6} ${y} L${x} ${y + r} L${x - r * .6} ${y} Z" fill="${i % 3 ? th.light : th.metal}" opacity="${op.toFixed(2)}"/>`;
  }
  return out;
}
// Лучи за счётом полуфинала.
function raysSvg(cx, cy, th) {
  let out = '';
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2, a2 = a + 0.08;
    out += `<path d="M${cx} ${cy} L${cx + Math.cos(a) * 520} ${cy + Math.sin(a) * 520} L${cx + Math.cos(a2) * 520} ${cy + Math.sin(a2) * 520} Z" fill="${th.light}" opacity=".035"/>`;
  }
  return out;
}
// Прожекторы четвертьфинала: два мягких конуса света сверху.
function floodlightsSvg(W, th) {
  return `<path d="M120 0 L330 0 L520 520 L-60 520 Z" fill="url(#beam)" opacity=".55"/>
    <path d="M${W - 330} 0 L${W - 120} 0 L${W + 60} 520 L${W - 520} 520 Z" fill="url(#beam)" opacity=".55"/>`;
}
// Медаль с числом — у победителя матча за 3-е место.
function medalSvg(cx, cy, th, label) {
  return `<circle cx="${cx}" cy="${cy}" r="17" fill="${hexA(th.metal, .25)}" stroke="${th.metal}" stroke-width="2.5"/>
    <text x="${cx}" y="${cy + 6}" text-anchor="middle" font-family="${FONT}" font-size="17" font-weight="900" fill="${th.light}">${label}</text>`;
}

export async function renderPlayoffMatchCard(match = {}, stage = cardStage(match.stage)) {
  const IW = 1080, IH = 1148, IR = 390;
  const centers = [{ x:225, y:420 }, { x:855, y:420 }];
  const th = STAGE_THEMES[stage.key] || STAGE_THEMES.SF;
  const final = stage.key === 'Final', third = stage.key === '3rd';
  const winner = txt(match.winner), loser = txt(match.loser);
  // «W · Group cross» → «W»: группа в плей-офф ни при чём.
  const divRaw = txt(match.division).split('·')[0].trim();
  const division = divRaw && !/^Division\b/i.test(divRaw) ? `Division ${divRaw}` : divRaw;
  // Сверху — дивизион и сезон, стадия — под счётом, между именами.
  const chip = [division, match.season ? `Season ${txt(match.season)}` : ''].filter(Boolean).join(' · ');
  const chipW = Math.min(960, Math.max(260, chip.length * 12.5 + 64));
  // «3RD PLACE MATCH» в узкий просвет между именами не помещается — в две строки.
  const stageLines = /\sMATCH$/.test(stage.title) ? [stage.title.replace(/\s+MATCH$/, ''), 'MATCH'] : [stage.title];
  const stageSvg = (() => {
    const y0 = 606 - (stageLines.length - 1) * 15;
    const line = `<line x1="${IW / 2 - 70}" y1="${y0 - 34}" x2="${IW / 2 + 70}" y2="${y0 - 34}" stroke="${hexA(th.metal, .6)}" stroke-width="2"/>`;
    return line + stageLines.map((t, i) => `<text x="${IW / 2}" y="${y0 + i * 30}" text-anchor="middle" font-family="${FONT}" font-size="${final ? 34 : stageLines.length > 1 ? 24 : 27}"
      font-weight="900" letter-spacing="${final ? 7 : 5}" fill="${th.light}">${esc(t)}</text>`).join('');
  })();
  const plate = (cx, text, win) => {
    const w = 300, h = 70, x = cx - w / 2, y = 770;
    if (!stage.places) return '';   // четвертьфинал, полуфинал: стадия говорит сама за себя
    const fill = win ? hexA(th.metal, final ? .2 : .14) : 'rgba(154,148,139,.10)';
    const line = win ? hexA(th.metal, .6) : 'rgba(154,148,139,.35)';
    const fg = win ? th.light : C.silver;
    // Значок места: кубок чемпиону, серебро «2» финалисту, бронза «3», «4» — без металла.
    const silver = { metal: '#B8B8BC', light: '#E4E4E8' }, plain = { metal: '#8A7F6F', light: '#B9B1A5' };
    const icon = final ? (win ? trophySvg(x + 46, y + h / 2 + 2, 0.72, th.light) : medalSvg(x + 42, y + h / 2, silver, '2'))
      : third ? (win ? medalSvg(x + 42, y + h / 2, th, '3') : medalSvg(x + 42, y + h / 2, plain, '4')) : '';
    const tx = icon ? cx + 22 : cx;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="35" fill="${fill}" stroke="${line}" stroke-width="2"/>
      ${icon}<text x="${tx}" y="${y + 44}" text-anchor="middle" font-family="${FONT}" font-size="${text.length > 14 ? 21 : 24}"
      font-weight="900" letter-spacing="3" fill="${fg}">${esc(text)}</text>`;
  };
  const decor = stage.key === 'QF' ? floodlightsSvg(IW, th) : stage.key === 'SF' ? raysSvg(IW / 2, centers[0].y, th) : final ? sparklesSvg(IW, th) : '';
  const svg = `<svg width="${IW}" height="${IH}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${C.bg1}"/><stop offset="1" stop-color="${th.bg2}"/></linearGradient>
      <radialGradient id="glow" cx="50%" cy="38%" r="58%">
        <stop offset="0" stop-color="${th.glow}" stop-opacity="${final ? '.22' : '.11'}"/>
        <stop offset="1" stop-color="${th.glow}" stop-opacity="0"/></radialGradient>
      <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${th.light}" stop-opacity=".22"/><stop offset="1" stop-color="${th.light}" stop-opacity="0"/></linearGradient>
      <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="${th.deep}"/><stop offset=".5" stop-color="${th.light}"/><stop offset="1" stop-color="${th.deep}"/></linearGradient>
    </defs>
    <rect width="${IW}" height="${IH}" fill="url(#g)"/>
    <rect width="${IW}" height="${IH}" fill="url(#glow)"/>
    ${decor}
    ${cornersSvg(IW, IH, th, final)}
    <rect width="${IW}" height="7" fill="url(#bar)"/>
    <rect y="${IH - 7}" width="${IW}" height="7" fill="url(#bar)"/>
    <text x="${IW / 2}" y="68" text-anchor="middle" font-family="${FONT}" font-size="24" font-weight="700"
      letter-spacing="6" fill="${th.metal}">PHUKET TENNIS FAMILY</text>
    <rect x="${IW / 2 - chipW / 2}" y="94" width="${chipW}" height="50" rx="25" fill="${hexA(th.metal, .14)}" stroke="${hexA(th.metal, .55)}"/>
    <text x="${IW / 2}" y="127" text-anchor="middle" font-family="${FONT}" font-size="21" font-weight="800"
      letter-spacing="2" fill="${th.text}">${esc(chip)}</text>
    ${scoreBlockSvg(match.score, IW / 2, centers[0].y + (scoreLines(match.score).length >= 3 ? 8 : -20), stage.key === 'SF' ? C.amber : th.light)}
    ${stageSvg}
    <text x="${centers[0].x}" y="660" text-anchor="middle" font-family="${FONT}" font-size="42" font-weight="800"
      fill="${final ? th.light : C.text}">${esc(fit(winner, 18))}</text>
    <text x="${centers[1].x}" y="660" text-anchor="middle" font-family="${FONT}" font-size="42" font-weight="700"
      fill="${C.dim}">${esc(fit(loser, 18))}</text>
    ${formChipsSvg(match.winnerMeta && match.winnerMeta.form, centers[0].x, 713, { gap:42, r:17 })}
    ${formChipsSvg(match.loserMeta && match.loserMeta.form, centers[1].x, 713, { gap:42, r:17 })}
    ${plate(centers[0].x, stage.win, true)}
    ${plate(centers[1].x, stage.lose, false)}
  </svg>`;
  const [wr, lr] = await Promise.all([
    match.winnerPhoto ? { buffer: match.winnerPhoto } : cardPhoto({ telegramId:match.winnerId, name:winner }),
    match.loserPhoto ? { buffer: match.loserPhoto } : cardPhoto({ telegramId:match.loserId, name:loser })
  ]);
  const wf = final ? championFrame(th) : frameFor(th);
  const [a, b] = await Promise.all([
    wr.buffer ? toCircle(wr.buffer, IR, wf).catch(() => initialsCircle(winner, IR, wf)) : initialsCircle(winner, IR, wf),
    lr.buffer ? toCircle(lr.buffer, IR, FRAME.loser).catch(() => initialsCircle(loser, IR, FRAME.loser)) : initialsCircle(loser, IR, FRAME.loser)
  ]);
  const [am, bm, logos] = await Promise.all([sharp(a).metadata(), sharp(b).metadata(), cardLogoComposites(IW, IH)]);
  return sharp(Buffer.from(svg)).composite([
    { input:a, left:Math.round(centers[0].x - am.width / 2), top:Math.round(centers[0].y - am.height / 2) },
    { input:b, left:Math.round(centers[1].x - bm.width / 2), top:Math.round(centers[1].y - bm.height / 2) },
    ...logos
  ]).png({ compressionLevel:6 }).toBuffer();
}

// Афиша дня плей-офф: одна картинка на день со всем расписанием.
// day: { date:'2026-11-07', venue:'The Peak Racquet Park',
//        matches:[{ time:'09:00', division:'A', stage:'SF', p1:'…', p2:'…' }] }
// Подписи английские, как на всех наших картинках; текст рассылки — на языке игрока.
export async function renderPlayoffSchedule(day = {}) {
  const IW = 1080, IH = 1350;
  const rows = (day.matches || []).slice().sort((a, b) => txt(a.time).localeCompare(txt(b.time)));
  const d = new Date(`${txt(day.date)}T12:00:00+07:00`);
  const dateLine = Number.isFinite(d.getTime())
    ? d.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', timeZone:'Asia/Bangkok' }).toUpperCase()
    : txt(day.date).toUpperCase();
  const area = [330, 1090], gap = rows.length > 5 ? 12 : 22;
  const rh = Math.min(130, Math.floor((area[1] - area[0] - gap * Math.max(0, rows.length - 1)) / Math.max(1, rows.length)));
  // Матчей мало (финальный день) — блок встаёт по центру, а не жмётся к шапке.
  const used = rows.length * rh + gap * Math.max(0, rows.length - 1);
  const top = area[0] + Math.max(0, Math.floor((area[1] - area[0] - used) / 2));
  const AV = Math.min(64, rh - 34);
  const photos = await Promise.all(rows.flatMap(r => [r.p1, r.p2]).map(async name => {
    const res = await cardPhoto({ name }).catch(() => ({}));
    const fr = { ring:C.gold, glow:'rgba(201,167,106,.18)', soft:'', ringScale:0.04, glowScale:0.03 };
    const buf = res?.buffer ? await toCircle(res.buffer, AV, fr).catch(() => initialsCircle(name, AV, fr)) : await initialsCircle(name, AV, fr);
    return { buf, meta: await sharp(buf).metadata() };
  }));
  const layers = [];
  let body = '';
  rows.forEach((r, i) => {
    const y = top + i * (rh + gap), cy = y + rh / 2, st = cardStage(r.stage);
    const div = txt(r.division) ? `DIVISION ${txt(r.division).replace(/^division\s*/i, '').toUpperCase()}` : '';
    const label = [div, st ? st.title : ''].filter(Boolean).join(' · ');
    const isFinal = st?.key === 'Final';
    body += `<rect x="60" y="${y}" width="${IW - 120}" height="${rh}" rx="22" fill="${isFinal ? 'rgba(201,167,106,.12)' : C.plate}"
        stroke="${isFinal ? 'rgba(201,167,106,.55)' : C.plateLine}" stroke-width="${isFinal ? 2 : 1}"/>
      <text x="150" y="${cy + 15}" text-anchor="middle" font-family="${FONT}" font-size="40" font-weight="900" fill="${C.gold}">${esc(txt(r.time) || 'TBA')}</text>
      <line x1="240" y1="${y + 18}" x2="240" y2="${y + rh - 18}" stroke="${C.line}"/>
      <text x="${(270 + IW - 80) / 2}" y="${y + 30}" text-anchor="middle" font-family="${FONT}" font-size="16" font-weight="800"
        letter-spacing="3" fill="${isFinal ? C.gold : C.mute}">${esc(label)}</text>
      <text x="${(270 + IW - 80) / 2}" y="${cy + 24}" text-anchor="middle" font-family="${FONT}" font-size="22" font-weight="800" fill="${C.mute}">vs</text>
      <text x="${(270 + IW - 80) / 2 - 40}" y="${cy + 24}" text-anchor="end" font-family="${FONT}" font-size="28" font-weight="800" fill="${C.text}">${esc(fit(r.p1 || 'TBD', 15))}</text>
      <text x="${(270 + IW - 80) / 2 + 40}" y="${cy + 24}" text-anchor="start" font-family="${FONT}" font-size="28" font-weight="800" fill="${C.text}">${esc(fit(r.p2 || 'TBD', 15))}</text>`;
  });
  const svg = `<svg width="${IW}" height="${IH}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.bg1}"/><stop offset="1" stop-color="#1B160F"/></linearGradient>
      <radialGradient id="glow" cx="50%" cy="10%" r="70%"><stop offset="0" stop-color="${C.gold}" stop-opacity=".14"/><stop offset="1" stop-color="${C.gold}" stop-opacity="0"/></radialGradient>
      <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8C6E3C"/><stop offset=".5" stop-color="#E9D29E"/><stop offset="1" stop-color="#8C6E3C"/></linearGradient>
    </defs>
    <rect width="${IW}" height="${IH}" fill="url(#g)"/><rect width="${IW}" height="${IH}" fill="url(#glow)"/>
    <rect x="14" y="14" width="${IW - 28}" height="${IH - 28}" rx="28" fill="none" stroke="${C.gold}" stroke-opacity=".55" stroke-width="2"/>
    <rect width="${IW}" height="7" fill="url(#bar)"/>
    <text x="${IW / 2}" y="78" text-anchor="middle" font-family="${FONT}" font-size="24" font-weight="700" letter-spacing="6" fill="${C.mute}">PHUKET TENNIS FAMILY</text>
    ${trophySvg(IW / 2, 140, 1.25)}
    <text x="${IW / 2}" y="232" text-anchor="middle" font-family="${FONT}" font-size="64" font-weight="900" letter-spacing="4" fill="#E9D29E">PLAYOFF DAY</text>
    <text x="${IW / 2}" y="282" text-anchor="middle" font-family="${FONT}" font-size="26" font-weight="800" letter-spacing="4" fill="${C.text}">${esc(dateLine)}${day.venue ? '  ·  ' + esc(txt(day.venue).toUpperCase()) : ''}</text>
    ${body}
  </svg>`;
  rows.forEach((r, i) => {
    // Аватарки — в фиксированных колонках по краям строки, имена прижаты к «vs».
    const y = top + i * (rh + gap), cy = y + rh / 2;
    const [a, b] = [photos[i * 2], photos[i * 2 + 1]];
    layers.push({ input:a.buf, left:Math.round(300 - a.meta.width / 2), top:Math.round(cy + 14 - a.meta.height / 2) });
    layers.push({ input:b.buf, left:Math.round(IW - 110 - b.meta.width / 2), top:Math.round(cy + 14 - b.meta.height / 2) });
  });
  const strip = await sponsorStrip({ top: 1110, bottom: IH - 30, canvas: IW });
  if (strip?.layer) layers.push(strip.layer);
  return sharp(Buffer.from(svg)).composite(layers).png({ compressionLevel:6 }).toBuffer();
}

// ------------------------------------------------------ сетка плей-офф картинкой
// Сторис 1080×1920 в духе сетки на сайте: колонки раундов, в каждой паре —
// аватарка, имя, посев; у сыгранной пары победитель золотом и счёт с его
// стороны. Пустые места подписаны «Winner QF1». Сверху бренд и «PLAYOFFS»,
// внизу лента партнёров.
// data: { division, season, grouped, matches:[{ slot, stage, p1, p2, seed1, seed2,
//          label1, label2, winner, score, played }] }
export async function renderBracketImage(data = {}) {
  const IW = 1080, IH = 1920;
  const th = STAGE_THEMES.Final;
  const grouped = Boolean(data.grouped);
  const by = slot => (data.matches || []).find(m => m.slot === slot) || { slot };
  const cols = grouped
    ? [{ x: 36, w: 318, slots: ['QF1', 'QF2', 'QF3', 'QF4'], label: 'QUARTER-FINALS' }, { x: 381, w: 318, slots: ['SF1', 'SF2'], label: 'SEMI-FINALS' }, { x: 726, w: 318, slots: ['Final'], label: 'FINAL' }]
    : [{ x: 60, w: 440, slots: ['SF1', 'SF2'], label: 'SEMI-FINALS' }, { x: 580, w: 440, slots: ['Final'], label: 'FINAL' }];
  const top = 620, bottom = 1380, BH = 150;
  // Вертикальные центры пар: первый раунд — равномерно, дальше — между своими парами.
  const centers = [];
  const n0 = cols[0].slots.length, step0 = (bottom - top) / n0;
  centers.push(cols[0].slots.map((_, i) => top + step0 * (i + 0.5)));
  for (let c = 1; c < cols.length; c++) centers.push(cols[c].slots.map((_, i) => (centers[c - 1][i * 2] + centers[c - 1][i * 2 + 1]) / 2));
  const avatars = [];
  const AV = 52;
  let body = '';
  const side = (m, k, x, y, w) => {
    const name = txt(m['p' + k]), label = txt(m['label' + k]), seed = txt(m['seed' + k]);
    const win = m.played && name && sameName(name, m.winner);
    const lose = m.played && name && !win;
    // Справа от имени — счёт или посев: имя ужимаем, чтобы не наехать на них.
    const tail = (win && txt(m.score)) || (!m.played && seed);
    const shown = name ? fit(name, w > 400 ? (tail ? 15 : 20) : (tail ? 10 : 13)) : (label || 'TBD');
    if (name) avatars.push({ name, x: x + 16, y: y - AV / 2, win });
    const tx = x + (name ? 16 + AV + 14 : 22);
    const score = win ? txt(m.score).replace(/\s+/g, ' ') : '';
    return `<text x="${tx}" y="${y + 9}" font-family="${FONT}" font-size="${name ? (w > 400 ? 27 : 23) : 19}" font-weight="${win ? 900 : 700}"
        fill="${win ? th.light : lose ? C.mute : name ? C.text : C.mute}" ${name ? '' : 'font-style="italic"'}>${esc(shown)}</text>`
      + (seed && !m.played ? `<text x="${x + w - 16}" y="${y + 9}" text-anchor="end" font-family="${FONT}" font-size="17" font-weight="800" fill="${C.mute}">${esc(seed.replace('·', ' · G'))}</text>` : '')
      + (score ? `<text x="${x + w - 16}" y="${y + 9}" text-anchor="end" font-family="${FONT}" font-size="${w > 400 ? 22 : 18}" font-weight="900" fill="${th.light}">${esc(score)}</text>` : '');
  };
  cols.forEach((col, c) => {
    body += `<text x="${col.x + col.w / 2}" y="${top - 40}" text-anchor="middle" font-family="${FONT}" font-size="20" font-weight="900" letter-spacing="4" fill="${th.metal}">${col.label}</text>`;
    col.slots.forEach((slot, i) => {
      const m = by(slot), cy = centers[c][i], y = cy - BH / 2, fin = slot === 'Final';
      body += `<rect x="${col.x}" y="${y}" width="${col.w}" height="${BH}" rx="20" fill="${fin ? hexA(th.metal, .13) : 'rgba(255,255,255,.045)'}" stroke="${fin ? hexA(th.metal, .7) : 'rgba(255,255,255,.12)'}" stroke-width="${fin ? 2.5 : 1.2}"/>
        <line x1="${col.x + 16}" y1="${cy}" x2="${col.x + col.w - 16}" y2="${cy}" stroke="rgba(255,255,255,.08)"/>`
        + side(m, 1, col.x, y + BH * 0.27, col.w) + side(m, 2, col.x, y + BH * 0.73, col.w);
      // Линии к следующему раунду.
      if (c < cols.length - 1) {
        const nx = cols[c + 1].x, ny = centers[c + 1][Math.floor(i / 2)], mx = col.x + col.w + (nx - col.x - col.w) / 2;
        body += `<path d="M${col.x + col.w} ${cy} H${mx} V${ny} H${nx}" fill="none" stroke="${hexA(th.metal, .45)}" stroke-width="2"/>`;
      }
    });
  });
  // Матч за 3-е место — под финалом.
  const third = by('3rd'), fc = cols[cols.length - 1], ty = bottom + 40;
  body += `<text x="${fc.x + fc.w / 2}" y="${ty}" text-anchor="middle" font-family="${FONT}" font-size="18" font-weight="900" letter-spacing="4" fill="${STAGE_THEMES['3rd'].metal}">3RD PLACE</text>
    <rect x="${fc.x}" y="${ty + 18}" width="${fc.w}" height="${BH}" rx="20" fill="rgba(255,255,255,.045)" stroke="${hexA(STAGE_THEMES['3rd'].metal, .5)}" stroke-width="1.2"/>
    <line x1="${fc.x + 16}" y1="${ty + 18 + BH / 2}" x2="${fc.x + fc.w - 16}" y2="${ty + 18 + BH / 2}" stroke="rgba(255,255,255,.08)"/>`
    + side(third, 1, fc.x, ty + 18 + BH * 0.27, fc.w) + side(third, 2, fc.x, ty + 18 + BH * 0.73, fc.w);
  // Чемпион, если финал сыгран.
  const fin = by('Final');
  const champ = fin.played ? txt(fin.winner) : '';
  const div = txt(data.division);
  const chip = [div ? (/^division/i.test(div) || /^prime$/i.test(div) ? div.toUpperCase() : `DIVISION ${div.toUpperCase()}`) : '', data.season ? `SEASON ${data.season}` : ''].filter(Boolean).join(' · ');
  const svg = `<svg width="${IW}" height="${IH}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.bg1}"/><stop offset="1" stop-color="${th.bg2}"/></linearGradient>
      <radialGradient id="glow" cx="50%" cy="18%" r="60%"><stop offset="0" stop-color="${th.glow}" stop-opacity=".18"/><stop offset="1" stop-color="${th.glow}" stop-opacity="0"/></radialGradient>
      <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${th.deep}"/><stop offset=".5" stop-color="${th.light}"/><stop offset="1" stop-color="${th.deep}"/></linearGradient>
      <linearGradient id="metal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${th.light}"/><stop offset=".55" stop-color="${th.metal}"/><stop offset="1" stop-color="${th.deep}"/></linearGradient></defs>
    <rect width="${IW}" height="${IH}" fill="url(#g)"/><rect width="${IW}" height="${IH}" fill="url(#glow)"/>
    ${cornersSvg(IW, IH, th, true)}
    <rect width="${IW}" height="8" fill="url(#bar)"/><rect y="${IH - 8}" width="${IW}" height="8" fill="url(#bar)"/>
    <text x="${IW / 2}" y="140" text-anchor="middle" font-family="${FONT}" font-size="28" font-weight="700" letter-spacing="9" fill="${th.light}">PHUKET TENNIS FAMILY</text>
    <text x="${IW / 2}" y="430" text-anchor="middle" font-family="${FONT}" font-size="118" font-weight="900" letter-spacing="8" fill="url(#metal)">PLAYOFFS</text>
    ${chip ? `<text x="${IW / 2}" y="488" text-anchor="middle" font-family="${FONT}" font-size="24" font-weight="800" letter-spacing="5" fill="${C.dim}">${esc(chip)}</text>` : ''}
    ${body}
    ${champ ? `${trophySvg(IW / 2 - 200, 1665, 1.05, th.light)}<text x="${IW / 2 + 20}" y="1652" text-anchor="middle" font-family="${FONT}" font-size="20" font-weight="900" letter-spacing="5" fill="${th.metal}">CHAMPION</text>
      <text x="${IW / 2 + 20}" y="1700" text-anchor="middle" font-family="${FONT}" font-size="40" font-weight="900" fill="${th.light}">${esc(fit(champ, 22))}</text>` : ''}
  </svg>`;
  const layers = [];
  for (const a of avatars) {
    const res = await cardPhoto({ name: a.name }).catch(() => ({}));
    const fr = a.win ? { ring: th.metal, glow: hexA(th.metal, .25), soft: '', ringScale: 0.05, glowScale: 0.04 } : { ring: '#4A423A', glow: 'rgba(0,0,0,0)', soft: '', ringScale: 0.04, glowScale: 0.02 };
    const buf = res?.buffer ? await toCircle(res.buffer, AV, fr).catch(() => initialsCircle(a.name, AV, fr)) : await initialsCircle(a.name, AV, fr);
    const meta = await sharp(buf).metadata();
    layers.push({ input: buf, left: Math.round(a.x + AV / 2 - meta.width / 2), top: Math.round(a.y + AV / 2 - meta.height / 2) });
  }
  try {
    const org = await sharp(path.join(CARD_LOGOS_DIR, 'ptf.png')).resize({ width: 220, height: 140, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    const meta = await sharp(org).metadata();
    layers.push({ input: org, left: Math.round((IW - (meta.width || 220)) / 2), top: 172 });
  } catch (e) { if (e?.code !== 'ENOENT') console.error('bracket logo failed:', e.message); }
  const strip = await sponsorStrip({ top: champ ? 1740 : 1600, bottom: IH - 50, canvas: IW });
  if (strip?.layer) layers.push(strip.layer);
  return sharp(Buffer.from(svg)).composite(layers).png({ compressionLevel: 6 }).toBuffer();
}
