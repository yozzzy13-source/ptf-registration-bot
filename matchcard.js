// Карточка матча: одна картинка со счётом и двумя портретами.
//
// Это НЕ генерация: аватарки игроков берутся как есть, режутся в круг и
// кладутся на фон. Лица настоящие, ничего не выдумывается, денег не стоит,
// собирается примерно за сотню миллисекунд.
//
// Фото ищем по той же цепочке, что и везде в приложении:
//   1) своя аватарка игрока (avatar_file_id, лежит в Telegram);
//   2) фото из витрины сайта;
//   3) фото из Players_Master;
//   4) инициалы в кружке — если фото нет вовсе.
//
// Подписи на карточке английские: одна картинка уходит всем сразу, а имена у
// нас латиницей. Кириллицу выбранный шрифт тянет плохо, поэтому не смешиваем.
import sharp from 'sharp';
import { getFileBuffer } from './telegram.js';
import { findApplicantByTelegramId, getLeagueProfiles, getMasterPhotos } from './sheets.js';

const FONT = 'Poppins, DejaVu Sans, Arial, sans-serif';
const W = 1200, H = 630, R = 300;

// Палитра Noir — та же, что в мини-приложении, чтобы картинка не выглядела
// чужой рядом с интерфейсом.
const C = {
  bg1: '#0C0B0B', bg2: '#17130F', text: '#EFEBE4', dim: '#B9B1A5', mute: '#8A7F6F',
  amber: '#E8A45C', win: '#8FBF9A', line: 'rgba(255,255,255,.10)',
  chipBg: 'rgba(143,191,154,.15)', chipLine: 'rgba(143,191,154,.34)', avBg: '#1C1A18'
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
function initials(name = '') {
  const parts = txt(name).split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

// --------------------------------------------------------------- портреты
// Кадрируем по «интересной» области, а не по центру: на селфи лицо редко
// стоит ровно посередине, и центральная обрезка режет его пополам.
async function toCircle(buffer, size, ring) {
  const photo = await sharp(buffer)
    .rotate()                                   // учитываем поворот из EXIF
    .resize(size, size, { fit: 'cover', position: sharp.strategy.attention })
    .toBuffer();
  const mask = Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`);
  const round = await sharp(photo).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  return withRing(round, size, ring);
}
async function withRing(buffer, size, ring) {
  const w = Math.round(size * 0.035);
  const frame = Buffer.from(`<svg width="${size}" height="${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - w / 2}" fill="none" stroke="${ring}" stroke-width="${w}"/>
  </svg>`);
  return sharp(buffer).composite([{ input: frame }]).png().toBuffer();
}
// Заглушка вместо фото: инициалы, как в приложении.
async function initialsCircle(name, size, ring) {
  const svg = Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${C.avBg}"/>
    <text x="${size / 2}" y="${size / 2 + size * 0.13}" text-anchor="middle" font-family="${FONT}"
      font-size="${Math.round(size * 0.34)}" font-weight="800" fill="${C.mute}">${esc(initials(name))}</text>
  </svg>`);
  return withRing(await sharp(svg).png().toBuffer(), size, ring);
}

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
async function playerPhoto({ telegramId = '', name = '' } = {}) {
  const key = `p:${telegramId || name.toLowerCase()}`;
  if (photoCache.has(key)) return photoCache.get(key);

  if (telegramId) {
    const row = await findApplicantByTelegramId(telegramId).catch(() => null);
    const fileId = txt(row?.avatar_file_id);
    if (fileId) {
      const hit = await getFileBuffer(fileId).then(f => f.buffer).catch(() => null);
      if (hit) return remember(key, hit);
    }
  }
  const wanted = txt(name).toLowerCase();
  if (wanted) {
    const profiles = await getLeagueProfiles().catch(() => []);
    const site = profiles.find(p => txt(p.name).toLowerCase() === wanted);
    if (site?.photo) {
      const hit = await fromUrl(site.photo).catch(() => null);
      if (hit) return remember(key, hit);
    }
    const master = await getMasterPhotos().catch(() => new Map());
    for (const [n, url] of master) {
      if (txt(n).toLowerCase() !== wanted || !url) continue;
      const hit = await fromUrl(url).catch(() => null);
      if (hit) return remember(key, hit);
      break;
    }
  }
  return remember(key, null);
}

// ------------------------------------------------------------------ карточка
// match: { winner, loser, score, division, season, date, court }
export async function renderMatchCard(match = {}) {
  const m = {
    winner: txt(match.winner), loser: txt(match.loser), score: txt(match.score),
    division: txt(match.division), season: txt(match.season),
    date: txt(match.date), court: txt(match.court)
  };
  const chip = [m.division, m.season ? `Season ${m.season}` : ''].filter(Boolean).join(' · ');
  const chipW = Math.max(200, chip.length * 11 + 48);

  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.bg1}"/><stop offset="1" stop-color="${C.bg2}"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
    <rect width="${W}" height="4" fill="${C.amber}" opacity=".9"/>
    <text x="${W / 2}" y="72" text-anchor="middle" font-family="${FONT}" font-size="22" font-weight="700"
      letter-spacing="6" fill="${C.mute}">PHUKET TENNIS FAMILY</text>
    ${chip ? `<rect x="${W / 2 - chipW / 2}" y="96" width="${chipW}" height="40" rx="20"
      fill="${C.chipBg}" stroke="${C.chipLine}"/>
    <text x="${W / 2}" y="123" text-anchor="middle" font-family="${FONT}" font-size="19" font-weight="700"
      fill="${C.win}">${esc(chip)}</text>` : ''}
    <text x="${W / 2}" y="352" text-anchor="middle" font-family="${FONT}" font-size="${m.score.length > 14 ? 56 : 76}"
      font-weight="800" fill="${C.amber}" letter-spacing="2">${esc(m.score || '—')}</text>
    ${m.date ? `<text x="${W / 2}" y="392" text-anchor="middle" font-family="${FONT}" font-size="20"
      font-weight="700" fill="${C.mute}" letter-spacing="3">${esc(m.date)}</text>` : ''}
    <text x="280" y="540" text-anchor="middle" font-family="${FONT}" font-size="34" font-weight="800"
      fill="${C.text}">${esc(fit(m.winner))}</text>
    <text x="280" y="578" text-anchor="middle" font-family="${FONT}" font-size="20" font-weight="700"
      fill="${C.win}" letter-spacing="4">WINNER</text>
    <text x="920" y="540" text-anchor="middle" font-family="${FONT}" font-size="34" font-weight="700"
      fill="${C.dim}">${esc(fit(m.loser))}</text>
    ${m.court ? `<text x="${W / 2}" y="606" text-anchor="middle" font-family="${FONT}" font-size="17"
      font-weight="600" fill="${C.mute}">${esc(m.court)}</text>` : ''}
  </svg>`;

  const [wp, lp] = await Promise.all([
    playerPhoto({ telegramId: match.winnerId, name: m.winner }).catch(() => null),
    playerPhoto({ telegramId: match.loserId, name: m.loser }).catch(() => null)
  ]);
  const [a, b] = await Promise.all([
    wp ? toCircle(wp, R, C.amber).catch(() => initialsCircle(m.winner, R, C.amber))
       : initialsCircle(m.winner, R, C.amber),
    lp ? toCircle(lp, R, C.line).catch(() => initialsCircle(m.loser, R, C.line))
       : initialsCircle(m.loser, R, C.line)
  ]);

  return sharp(Buffer.from(svg))
    .composite([{ input: a, left: 130, top: 170 }, { input: b, left: 770, top: 170 }])
    .png({ compressionLevel: 6 }).toBuffer();
}

// Карточка по слоту матча из таблицы матчей. Победитель всегда первым, счёт
// развёрнут в его сторону — так же, как в тексте ленты.
export async function cardForSlot(slot = {}, { winnerFirstScore, season = '' } = {}) {
  const winnerIsFrom = String(slot.result_winner) === String(slot.from_telegram_id);
  const score = typeof winnerFirstScore === 'function' ? winnerFirstScore(slot) : txt(slot.result_score);
  return renderMatchCard({
    winner: winnerIsFrom ? slot.from_name : slot.to_name,
    loser: winnerIsFrom ? slot.to_name : slot.from_name,
    winnerId: winnerIsFrom ? slot.from_telegram_id : slot.to_telegram_id,
    loserId: winnerIsFrom ? slot.to_telegram_id : slot.from_telegram_id,
    score, division: slot.division, season,
    date: slot.agreed_date ? fmtDate(slot.agreed_date) : '',
    court: slot.agreed_court || ''
  });
}
function fmtDate(iso = '') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso).trim();
}

export function forgetPhotoCache() { photoCache.clear(); }
