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
import { findApplicantByTelegramId, getMasterPhotos } from './sheets.js';

const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
const CARD_LOGOS_DIR = path.join(ASSETS_DIR, 'match-card-logos');

// Любые прозрачные PNG/WebP/SVG из этой папки автоматически появляются в
// нижней части следующей карточки. Список перечитывается на каждую генерацию:
// чтобы сменить партнёров, достаточно заменить файлы и перезапустить не нужно.
async function cardLogoComposites(canvasWidth = 1080, canvasHeight = 1148) {
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
const PLATE = { w: 196, x: [24, 980], rankY: 168, fpY: 312, fpH: 96 };
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

async function fromUrl(url) {
  const res = await globalThis.fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`фото не скачалось: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Ищем фото игрока по цепочке. Ошибки не роняют карточку: не нашли — рисуем
// инициалы, это лучше, чем не отправить ничего.
async function playerPhoto({ telegramId = '', name = '', fresh = false } = {}) {
  const key = `p:${telegramId || name.toLowerCase()}`;
  

  if (telegramId) {
    const row = await findApplicantByTelegramId(telegramId).catch(() => null);
    const fileId = txt(row?.avatar_file_id);
    if (fileId) {
      if (!fresh && photoCache.has(fileId)) return photoCache.get(fileId);
      const hit = await getFileBuffer(fileId).then(f => f.buffer).catch(() => null);
      if (hit) return remember(fileId, hit);
    }
  }
  const wanted = txt(name).toLowerCase();
  if (wanted) {
    const master = await getMasterPhotos().catch(() => new Map());
    for (const [n, url] of master) {
      if (txt(n).toLowerCase() !== wanted || !url) continue;
      if (!fresh && photoCache.has(url)) return photoCache.get(url);
      const hit = await fromUrl(url).catch(() => null);
      if (hit) return remember(url, hit);
      break;
    }
  }
  return remember(key, null);
}

export async function playerPhotoForPoster(player = {}) {
  return playerPhoto({ ...player, fresh:true });
}

// Плашка статистики в боковой колонке: подпись, крупное число и — только у
// места в дивизионе — пилюля со стрелкой, на сколько позиций игрок сместился.
function plateSvg(x, y, height, label, value, color, pill) {
  const cx = x + PLATE.w / 2;
  const head = `<rect x="${x}" y="${y}" width="${PLATE.w}" height="${height}" rx="18" fill="${C.plate}" stroke="${C.plateLine}"/>
    <text x="${cx}" y="${y + 27}" text-anchor="middle" font-family="${FONT}" font-size="13" font-weight="800"
      letter-spacing="2.2" fill="${C.mute}">${esc(label)}</text>
    <text x="${cx}" y="${y + 74}" text-anchor="middle" font-family="${FONT}" font-size="46" font-weight="900"
      fill="${color}">${esc(value)}</text>`;
  if (!pill) return head;
  return head + `<rect x="${cx - pill.w / 2}" y="${y + 84}" width="${pill.w}" height="30" rx="15"
      fill="${pill.bg}" stroke="${pill.line}"/>
    <text x="${cx}" y="${y + 104}" text-anchor="middle" font-family="${FONT}" font-size="16" font-weight="800"
      fill="${pill.fg}">${esc(pill.text)}</text>`;
}
// Сколько позиций и куда. Без «было #3»: стрелка с числом и так читается.
function rankPill(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === after) return null;
  return after < before
    ? { w: 66, text: `▲ ${before - after}`, bg: C.upBg, line: C.upLine, fg: C.win }
    : { w: 66, text: `▼ ${after - before}`, bg: C.lossBg, line: C.lossLine, fg: C.loss };
}
// Колонка статистики одного игрока. Плашки рисуются только если данные есть:
// нет контекста матча — карточка просто остаётся без колонок.
function statColumn(meta, side) {
  if (!meta) return '';
  const x = PLATE.x[side];
  const pos = meta.position || {};
  let out = '';
  // Место показываем всегда, когда игрок вообще есть в таблице дивизиона —
  // даже если матчей у него ещё не было и двигаться было неоткуда. Стрелка
  // появляется только при реальном изменении.
  const rank = Number.isFinite(pos.after) ? pos.after : (Number.isFinite(pos.before) ? pos.before : null);
  if (rank !== null) {
    const pill = rankPill(pos.before, pos.after);
    out += plateSvg(x, PLATE.rankY, pill ? 122 : 96, 'DIVISION RANK', `#${rank}`, C.text, pill);
  }
  if (Number.isFinite(meta.fp)) {
    out += plateSvg(x, PLATE.fpY, PLATE.fpH, 'FANTASY POINTS', `+${meta.fp}`, C.amber, null);
  }
  return out;
}
// Форма — последние до 5 матчей строго до этого, W/L кружками, как в
// приложении. Подписи нет намеренно: у части игроков истории меньше пяти
// матчей, и подпись «last 5» там врала бы.
function formChipsSvg(form, cx, y, { gap=44, r=17 }={}) {
  const items = (form || []).slice(-5);
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
export async function renderInstagramMatchCard(match = {}) {
  const IW = 1080, IH = 1148, IR = 390;
  // Верхние 70% заняты результатом; нижние 30% намеренно остаются чистыми
  // для будущей композиции прозрачных логотипов.
  const centers = [{ x:225, y:450 }, { x:855, y:450 }];
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
  const scoreSvg = lines.map((line, i) => {
    const tie = line.match(/^(\d+:\d+)\s*\((\d+:\d+)\)$/);
    const main = tie ? tie[1] : line, y = first + i * step;
    return `<text x="${IW / 2}" y="${y}" text-anchor="middle" font-family="${FONT}"
      font-size="${fs}" font-weight="800" fill="${C.amber}" letter-spacing="1">${esc(main)}</text>`
      + (tie ? `<text x="${IW / 2 + 76}" y="${y - Math.round(fs * 0.36)}" text-anchor="start"
        font-family="${FONT}" font-size="${Math.max(18, Math.round(fs * 0.32))}" font-weight="800"
        fill="${C.amber}">(${esc(tie[2])})</text>` : '');
  }).join('');
  const rank = (meta, cx) => {
    if (!meta) return '';
    const pos = meta.position || {};
    const value = Number.isFinite(pos.after) ? pos.after : (Number.isFinite(pos.before) ? pos.before : null);
    if (value === null) return '';
    const pill = rankPill(pos.before, pos.after);
    const w = 178, h = pill ? 118 : 90, x = cx - w / 2, y = 748;
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
    <text x="${centers[0].x}" y="700" text-anchor="middle" font-family="${FONT}" font-size="42" font-weight="800"
      fill="${C.text}">${esc(fit(m.winner, 18))}</text>
    <text x="${centers[1].x}" y="700" text-anchor="middle" font-family="${FONT}" font-size="42" font-weight="700"
      fill="${C.dim}">${esc(fit(m.loser, 18))}</text>
    ${rank(m.winnerMeta, centers[0].x)}
    ${rank(m.loserMeta, centers[1].x)}
    ${formChipsSvg(m.winnerMeta && m.winnerMeta.form, centers[0].x, 903, { gap:42, r:17 })}
    ${formChipsSvg(m.loserMeta && m.loserMeta.form, centers[1].x, 903, { gap:42, r:17 })}
    ${m.label ? `<text x="${centers[0].x}" y="949" text-anchor="middle" font-family="${FONT}" font-size="16"
      font-weight="700" fill="${C.champ}" letter-spacing="3">${esc(m.label)}</text>` : ''}
  </svg>`;

  const [wp, lp] = await Promise.all([
    playerPhoto({ telegramId:match.winnerId, name:m.winner }).catch(() => null),
    playerPhoto({ telegramId:match.loserId, name:m.loser }).catch(() => null)
  ]);
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
  ]).png({ compressionLevel:6 }).toBuffer();
}
// Место «после» матча читаем прямо сейчас (это просто текущая таблица
// дивизиона — она не протухает), а место «до», форму и очки Fantasy — из
// контекста, снятого results.js перед записью счёта. Если контекста нет
// (карточка перевыпущена спустя долгое время, или сервер перезапускался
// между записью и рассылкой) — просто не показываем эти блоки.
async function buildPlayerMetas(slot, winnerIsFrom) {
  const ctx = takeCardContext(slot.challenge_id);
  if (!ctx) return [null, null];
  const fromMeta = { form: ctx.p1?.form || [], fp: Number.isFinite(ctx.fp?.p1) ? ctx.fp.p1 : null, position: { before: ctx.p1?.place } };
  const toMeta = { form: ctx.p2?.form || [], fp: Number.isFinite(ctx.fp?.p2) ? ctx.fp.p2 : null, position: { before: ctx.p2?.place } };
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
  const [winnerMeta, loserMeta] = await buildPlayerMetas(slot, winnerIsFrom).catch(() => [null, null]);
  return {
    winner: winnerIsFrom ? slot.from_name : slot.to_name,
    loser: winnerIsFrom ? slot.to_name : slot.from_name,
    winnerId: winnerIsFrom ? slot.from_telegram_id : slot.to_telegram_id,
    loserId: winnerIsFrom ? slot.to_telegram_id : slot.from_telegram_id,
    label:bothTechnical?'TECHNICAL RESULT':'',
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

