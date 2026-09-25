// Публичность игрока: опрос про Instagram, отказ от публикаций и сама
// публикация — сторис с постером и еженедельная карусель карточек.
//
// Три правила, вокруг которых всё собрано:
//
//  1. Публикуем по умолчанию. Нет инстаграма — просто не отметим. Молчание не
//     считается отказом: лига и так публичная. Останавливает только явное
//     «не публиковать меня».
//  2. Отказ одного человека снимает с публикации ВЕСЬ матч. В карточке двое,
//     вырезать одного нельзя.
//  3. Ничего не уходит в Instagram само. Сторис публикуется кнопкой под
//     постером, карусель собирается по воскресеньям и тоже ждёт кнопки.
import { sendMessage, sendDocumentAlbumBuffers, answerCallbackQuery, getFileBuffer } from './telegram.js';
import { TIMEZONE } from './config.js';
import {
  getAllActiveLeaguePlayers, findApplicantByTelegramId, updateApplicantByTelegramId,
  ensurePublicityColumns, setPhotoConsent, setPlayerInstagram, normalizeInstagramHandle,
  publicationAllowed, getSetting, setSetting, getRows
} from './sheets.js';
import { IG_ACCOUNT, IG_PROFILE_URL, instagramEnabled, publishStory, publishCarousel, CAROUSEL_MAX } from './instagram.js';
import { nowISO } from './util.js';

const txt = v => String(v ?? '').trim();
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ru = lang => lang !== 'en';

// -------------------------------------------------------------- опросник
export function instagramAskText(lang = 'ru') {
  return ru(lang)
    ? `📸 <b>Отмечаем игроков в Instagram</b>\n\n`
      + `Мы публикуем постеры матчей и карточки результатов в нашем аккаунте. Хотите, чтобы вас отмечали — пришлите свой Instagram, и мы будем ставить отметку на ваших публикациях.\n\n`
      + `И подпишитесь на <b>@${esc(IG_ACCOUNT)}</b> — отметить можно только того, кто виден в ленте.\n\n`
      + `Не ответите — ничего страшного: матчи публикуются как обычно, просто без отметки.\n\n`
      + `Если публиковаться не хотите — нажмите «Не публиковать меня», и ваши матчи в Instagram не попадут. В самой лиге всё останется как есть.`
    : `📸 <b>Getting tagged on Instagram</b>\n\n`
      + `We publish match posters and result cards on our account. If you want to be tagged, send us your Instagram and we will mention you in posts about your matches.\n\n`
      + `Please also follow <b>@${esc(IG_ACCOUNT)}</b> — we can only tag accounts that can see the post.\n\n`
      + `No answer is fine too: your matches are published as usual, just without a tag.\n\n`
      + `If you would rather not appear there, tap "Don't publish me" and your matches will stay out of Instagram. Nothing changes inside the league itself.`;
}
export function instagramAskKeyboard(lang = 'ru') {
  return { inline_keyboard: [
    [{ text: ru(lang) ? `📸 Открыть @${IG_ACCOUNT}` : `📸 Open @${IG_ACCOUNT}`, url: IG_PROFILE_URL }],
    [{ text: ru(lang) ? '✍️ Прислать свой Instagram' : '✍️ Send my Instagram', callback_data: 'pub:send' }],
    [{ text: ru(lang) ? '🚫 Не публиковать меня' : '🚫 Don\'t publish me', callback_data: 'pub:no' }]
  ] };
}
export async function sendInstagramAsk(chatId, lang = 'ru') {
  await ensurePublicityColumns().catch(() => {});
  return sendMessage(chatId, instagramAskText(lang), { reply_markup: instagramAskKeyboard(lang) });
}

// Рассылка по всем активным игрокам лиги. Тем, кто уже ответил — и прислал
// инстаграм, и отказался, — второй раз не пишем.
export async function broadcastInstagramAsk(adminChatId, { force = false } = {}) {
  await ensurePublicityColumns().catch(() => {});
  const players = await getAllActiveLeaguePlayers().catch(() => []);
  let sent = 0, skipped = 0, failed = 0;
  for (const player of players) {
    const id = txt(player.telegram_id);
    if (!id) { skipped++; continue; }
    const profile = await findApplicantByTelegramId(id).catch(() => null);
    const answered = txt(profile?.instagram) || txt(profile?.photo_publication_consent);
    if (answered && !force) { skipped++; continue; }
    const lang = txt(profile?.language) === 'ru' ? 'ru' : 'en';
    const ok = await sendInstagramAsk(id, lang).then(() => true).catch(e => {
      console.error('instagram ask failed:', id, e.message); return false;
    });
    if (ok) sent++; else failed++;
  }
  if (adminChatId) {
    await sendMessage(adminChatId,
      `📸 <b>Опрос про Instagram разослан</b>\n\nОтправлено: <b>${sent}</b>\nПропущено (уже отвечали): <b>${skipped}</b>`
      + (failed ? `\nНе доставлено: <b>${failed}</b>` : '')).catch(() => {});
  }
  return { sent, skipped, failed };
}

// ------------------------------------------------------------- ответы
const awaiting = new Map();
const AWAIT_TTL = 30 * 60 * 1000;
export function isAwaitingInstagram(userId) {
  const at = awaiting.get(String(userId));
  if (!at) return false;
  if (Date.now() - at > AWAIT_TTL) { awaiting.delete(String(userId)); return false; }
  return true;
}
export const isPublicityCallback = data => String(data || '').startsWith('pub:');

export async function handlePublicityCallback(q, lang = 'ru', { adminChatId = '' } = {}) {
  const data = String(q.data || '');
  const from = q.from || {};
  const chatId = q.message?.chat?.id || from.id;
  const action = data.split(':')[1] || '';
  try {
    await ensurePublicityColumns().catch(() => {});
    if (action === 'send') {
      awaiting.set(String(from.id), Date.now());
      return sendMessage(chatId, ru(lang)
        ? '✍️ Пришлите свой Instagram одним сообщением — можно ником или ссылкой.\n\nНапример: <code>@phukettennisfamily</code>'
        : '✍️ Send your Instagram in one message — a handle or a link works.\n\nFor example: <code>@phukettennisfamily</code>');
    }
    if (action === 'no') {
      await setPhotoConsent(from.id, 'NO');
      awaiting.delete(String(from.id));
      const name = txt(from.first_name) + (txt(from.last_name) ? ' ' + txt(from.last_name) : '');
      if (adminChatId) {
        await sendMessage(adminChatId,
          `🚫 <b>Отказ от публикаций</b>\n\n<b>${esc(name || from.id)}</b> просит не публиковать его в Instagram.\n\n`
          + `Постеры и карточки с ним в Instagram больше не уходят — ни в сторис, ни в еженедельную карусель. Внутри лиги всё по-прежнему.`).catch(() => {});
      }
      return sendMessage(chatId, ru(lang)
        ? '✅ Принято. Ваши матчи в Instagram публиковаться не будут.\n\nПередумаете — напишите организатору, вернём обратно.'
        : '✅ Noted. Your matches will not be published on Instagram.\n\nChange your mind — just tell the organiser and we will switch it back.');
    }
  } catch (e) {
    console.error('publicity callback failed:', e.message);
    await answerCallbackQuery(q.id, e.message.slice(0, 190), true).catch(() => {});
  }
  return null;
}

// Ответ с ником. Присланный инстаграм сам по себе означает согласие: человек
// специально прислал его, чтобы его отметили.
export async function handleInstagramReply(msg, lang = 'ru', { adminChatId = '' } = {}) {
  const from = msg.from || {};
  const value = txt(msg.text);
  const handle = normalizeInstagramHandle(value);
  if (!handle) {
    return sendMessage(msg.chat.id, ru(lang)
      ? '❌ Не похоже на Instagram. Пришлите ник вида <code>@nickname</code> или ссылку на профиль.'
      : '❌ That does not look like an Instagram account. Send a handle like <code>@nickname</code> or a profile link.');
  }
  awaiting.delete(String(from.id));
  await setPlayerInstagram(from.id, handle);
  const profile = await findApplicantByTelegramId(from.id).catch(() => null);
  if (String(profile?.photo_publication_consent || '').toUpperCase() !== 'NO') {
    await setPhotoConsent(from.id, 'YES').catch(() => {});
  }
  if (adminChatId) {
    await sendMessage(adminChatId, `📸 <b>${esc(txt(profile?.name) || from.first_name || from.id)}</b> прислал Instagram: ${esc(handle)}`).catch(() => {});
  }
  return sendMessage(msg.chat.id, ru(lang)
    ? `✅ Записал: <b>${esc(handle)}</b>. Будем отмечать вас в публикациях.\n\nЕсли ещё не подписаны — загляните на @${esc(IG_ACCOUNT)}.`
    : `✅ Saved: <b>${esc(handle)}</b>. We will tag you in posts.\n\nIf you have not followed us yet, drop by @${esc(IG_ACCOUNT)}.`);
}

// --------------------------------------------------- кто участвует в матче
// Возвращает согласие и ники обоих игроков одним ответом: на публикацию
// смотрят и сторис, и карусель.
export async function matchPublicity(slot = {}) {
  const ids = [txt(slot.from_telegram_id), txt(slot.to_telegram_id)].filter(Boolean);
  const people = await Promise.all(ids.map(id => findApplicantByTelegramId(id).catch(() => null)));
  const blocked = [];
  const handles = [];
  people.forEach((person, index) => {
    const name = index === 0 ? txt(slot.from_name) : txt(slot.to_name);
    if (person && !publicationAllowed(person)) blocked.push(txt(person.name) || name);
    const handle = normalizeInstagramHandle(person?.instagram);
    if (handle) handles.push(handle.replace(/^@/, ''));
  });
  return { allowed: !blocked.length, blocked, handles };
}

// ------------------------------------------------------ публикация сторис
export async function publishPosterToStory(buffer, slot = {}) {
  if (!instagramEnabled()) throw new Error('Instagram не подключён: задайте IG_USER_ID и IG_ACCESS_TOKEN');
  const who = await matchPublicity(slot);
  if (!who.allowed) throw new Error(`Публикация запрещена: ${who.blocked.join(', ')} просил не публиковать его`);
  return publishStory(buffer, { handles: who.handles });
}

// --------------------------------------------------- еженедельная карусель
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const dayKey = (ms, timeZone = TIMEZONE) => new Intl.DateTimeFormat('en-CA',
  { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
export function localParts(now = Date.now(), timeZone = TIMEZONE) {
  const p = new Intl.DateTimeFormat('en-GB',
    { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(now));
  const get = t => p.find(x => x.type === t)?.value || '';
  return { weekday: get('weekday'), hour: Number(get('hour')), minute: Number(get('minute')) };
}
// Воскресенье, 19:00 по местному времени. Проверяем раз в пятнадцать минут,
// поэтому попадание в час, а не в минуту; повтор отсекается отметкой в Settings.
export function carouselDue(now = Date.now(), timeZone = TIMEZONE) {
  const { weekday, hour } = localParts(now, timeZone);
  return weekday === 'Sun' && hour === 19;
}

// Какой отрезок собираем. По умолчанию последние семь дней, но подборку можно
// сделать и за любую прошлую неделю: «-2» — позапрошлая, пара дат — точный
// отрезок. Нужно, чтобы догнать первые недели сезона задним числом.
export function parseRange(input = '', now = Date.now()) {
  const text = txt(input);
  const dates = text.match(/\d{4}-\d{2}-\d{2}/g) || [];
  if (dates.length >= 2) {
    const from = Date.parse(`${dates[0]}T00:00:00+07:00`);
    const to = Date.parse(`${dates[1]}T23:59:59+07:00`);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) return { from, to, shownTo: to, label: `${dates[0]} — ${dates[1]}` };
  }
  if (dates.length === 1) {
    const from = Date.parse(`${dates[0]}T00:00:00+07:00`);
    if (Number.isFinite(from)) return { from, to: from + WEEK_MS, shownTo: from + WEEK_MS, label: `${dates[0]} + 7 дней` };
  }
  const back = /(?:^|\s)-(\d{1,2})(?:\s|$)/.exec(text);
  if (back) {
    const weeks = Number(back[1]);
    const to = now - (weeks - 1) * WEEK_MS;
    return { from: to - WEEK_MS, to, shownTo: to, label: `${weeks} ${weeks === 1 ? 'неделя' : 'недели'} назад` };
  }
  return { from: now - WEEK_MS, to: now + 24 * 60 * 60 * 1000, shownTo: now, label: 'последние 7 дней' };
}

// Матчи недели: подтверждённые результаты за последние семь дней, без тех,
// где хоть один игрок просил его не публиковать.
export async function weeklyMatches(now = Date.now(), range = null) {
  const { allSlots } = await import('./matchesdb.js');
  const rows = await allSlots();
  const { from, to } = range || parseRange('', now);
  const played = rows.filter(r => {
    if (String(r.result_status || '').toLowerCase() !== 'confirmed') return false;
    const day = Date.parse(`${txt(r.agreed_date)}T12:00:00+07:00`);
    return Number.isFinite(day) && day >= from && day <= to;
  }).sort((a, b) => txt(a.agreed_date).localeCompare(txt(b.agreed_date)));
  const out = [], skipped = [];
  for (const slot of played) {
    const who = await matchPublicity(slot);
    if (!who.allowed) { skipped.push({ slot, blocked: who.blocked }); continue; }
    out.push({ slot, handles: who.handles });
  }
  // Ограничение Instagram применяем только при публикации: организатору
  // показываем всё, что было за неделю, чтобы он видел полную картину.
  return { matches: out, extra: Math.max(0, out.length - CAROUSEL_MAX), skipped };
}

// Подпись к посту. Счёт каждого матча не пишем — он и так на карточках, а в
// подписи превращается в простыню. Вместо этого короткий обзор недели: живая
// первая фраза, пара настоящих цифр, упоминания игроков и хэштеги.
//
// Первая фраза берётся из набора по номеру недели, поэтому две недели подряд
// текст не повторяется. Набор, а не нейросеть: подпись должна быть готова
// мгновенно, ничего не стоить и никогда не выдумать того, чего не было.
const WEEK_OPENERS = [
  'A busy week on the Phuket courts.',
  'Another hot week in Phuket — and not only because of the weather.',
  'The week is in the books. Here is how it went.',
  'Long rallies, close sets and a few surprises this week.',
  'Match week recap from the Phuket Tennis Family.',
  'Seven days, a full set of results. Here they are.',
  'The courts did not stay empty this week.',
  'Sunset tennis, tight scorelines — that was our week.',
  'A week worth scrolling through.',
  'Fresh results from the league. Swipe through.'
];
export const CAROUSEL_HASHTAGS = ['#phuket', '#tennis', '#phukettennis', '#phukettennisfamily'];
const weekIndex = (now = Date.now()) => Math.floor(now / (7 * 24 * 60 * 60 * 1000));

export function carouselCaption(matches = [], span = Date.now(), handles = []) {
  const range = typeof span === 'number' ? { from: span - WEEK_MS, to: span, shownTo: span } : span;
  const day = ms => new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, day: '2-digit', month: 'short' }).format(new Date(ms));
  const opener = WEEK_OPENERS[weekIndex(range.from) % WEEK_OPENERS.length];
  const count = matches.length;
  const divisions = [...new Set(matches.map(m => txt(m.slot?.division)).filter(Boolean))].sort();
  const players = new Set();
  for (const m of matches) { players.add(txt(m.slot?.from_name)); players.add(txt(m.slot?.to_name)); }
  players.delete('');
  // Три сухих факта вместо перечисления счетов: сколько матчей, сколько людей,
  // какие дивизионы. Всё честное, ничего не выдумано.
  const facts = [
    `${count} ${count === 1 ? 'match' : 'matches'} played`,
    players.size ? `${players.size} players on court` : '',
    divisions.length ? (divisions.length === 1 ? divisions[0] : `${divisions.length} divisions in action`) : ''
  ].filter(Boolean).join(' · ');
  const mentions = (handles || []).map(h => '@' + String(h).replace(/^@/, '')).join(' ');
  return [
    `🎾 ${opener}`,
    '',
    `${day(range.from)} — ${day(range.shownTo ?? range.to)}`,
    facts,
    '',
    'Swipe for every result. Full tables and match history in the league app.',
    mentions ? '' : null,
    mentions || null,
    '',
    CAROUSEL_HASHTAGS.join(' ')
  ].filter(x => x !== null).join('\n');
}

// Сборка и отправка организатору на подтверждение. Сама публикация — кнопкой:
// пост в ленту уходит навсегда, и отдавать это расписанию без человека нельзя.
export async function buildWeeklyCarousel(now = Date.now(), range = null) {
  const { cardForSlot } = await import('./matchcard.js');
  const span = range || parseRange('', now);
  const { matches, extra, skipped } = await weeklyMatches(now, span);
  const images = [];
  for (const item of matches) {
    const buffer = await cardForSlot(item.slot).catch(e => { console.error('weekly card failed:', e.message); return null; });
    if (buffer) images.push({ buffer, slot: item.slot });
  }
  const handles = [...new Set(matches.flatMap(m => m.handles))];
  return { images, handles, caption: carouselCaption(matches, span, handles), extra, skipped, limit: CAROUSEL_MAX, range: span };
}

export async function publishWeeklyCarousel(prepared) {
  if (!instagramEnabled()) throw new Error('Instagram не подключён: задайте IG_USER_ID и IG_ACCESS_TOKEN');
  if (!prepared?.images?.length) throw new Error('За неделю нет матчей, которые можно опубликовать');
  return publishCarousel(prepared.images.slice(0, CAROUSEL_MAX), { caption: prepared.caption, handles: prepared.handles });
}

// Куда складывать подборку недели. Отдельная тема удобнее админского чата:
// там лежат только материалы для Instagram, и их легко сохранить пачкой.
// Привязывается командой /instagram_here прямо в нужной теме.
export async function instagramTarget(fallbackChatId = '') {
  const bound = txt(await getSetting('instagram_chat_id').catch(() => ''));
  if (bound) return { chatId: bound, threadId: txt(await getSetting('instagram_topic_id').catch(() => '')) };
  return { chatId: txt(fallbackChatId), threadId: '' };
}

// Доставка подборки человеку: все карточки альбомами по десять, затем подпись
// отдельным сообщением, откуда её удобно скопировать целиком.
export async function deliverWeeklyCarousel(prepared, { chatId, threadId = '', canPublish = false, title = 'Матчи недели', action = 'igweek:go', empty = 'За неделю нет подтверждённых матчей, которые можно опубликовать.' } = {}) {
  if (!chatId) return { ok: false, reason: 'no_chat' };
  const opts = threadId ? { message_thread_id: threadId } : {};
  if (!prepared?.images?.length) {
    await sendMessage(chatId, `🗓 <b>${esc(title)}</b>\n\n${esc(empty)}`, opts).catch(() => {});
    return { ok: true, empty: true };
  }
  // Telegram отдаёт максимум десять картинок за раз — шлём пачками, чтобы
  // подборка уходила целиком, сколько бы матчей ни было.
  for (let i = 0; i < prepared.images.length; i += 10) {
    // Файлами, а не фотографиями: sendPhoto ужимает картинку до 1280 px, и
    // сохранённая из чата карточка теряет качество ещё до Instagram.
    const chunk = prepared.images.slice(i, i + 10).map((x, n) => ({
      buffer: x.buffer,
      filename: `${/^image\/jpe?g$/.test(String(x.mime || '')) ? 'photo' : 'card'}-${i + n + 1}-${dayKey(Date.now())}.${/^image\/jpe?g$/.test(String(x.mime || '')) ? 'jpg' : 'png'}`
    }));
    await sendDocumentAlbumBuffers(chatId, chunk, opts).catch(e => console.error('weekly album failed:', e.message));
  }
  const skipped = prepared.skipped?.length
    ? `\n\nНе вошли (просили не публиковать): ${prepared.skipped.map(x => esc(x.blocked.join(', '))).join('; ')}`
    : '';
  const limit = prepared.limit || 20;
  const overflow = prepared.images.length > limit
    ? `\n\n⚠️ В один пост уйдут первые ${limit} карточек. Остальные ${prepared.images.length - limit} сохраните отсюда и выложите вторым постом.`
    : '';
  await sendMessage(chatId,
    `🗓 <b>${esc(title)}</b>\n\nКартинок: <b>${prepared.images.length}</b>${overflow}${skipped}\n\n`
    + `<b>Подпись к посту</b> — нажмите, чтобы скопировать:\n<code>${esc(prepared.caption)}</code>`,
    { ...opts, ...(canPublish ? { reply_markup: { inline_keyboard: [[{ text: '📤 Опубликовать карусель', callback_data: action }]] } } : {}) }
  ).catch(e => console.error('weekly caption failed:', e.message));
  return { ok: true, count: prepared.images.length };
}

// ---------------------------------------------- фотографии недели (четверг)
// Живые фотографии с корта, которые игроки прикладывали к результату. Здесь
// та же проверка согласия: отказался один — матч не публикуем целиком.
const PHOTO_OPENERS = [
  'Faces of the week on the Phuket courts.',
  'Straight from the court — this week in photos.',
  'Our players, our week.',
  'A few frames from the last seven days.',
  'This is what league week looks like in Phuket.',
  'Sweat, sunsets and smiles — the week in pictures.',
  'Behind the scores: the people who played them.',
  'Photo round-up from the league.',
  'Some moments from the courts this week.',
  'The week as our players saw it.'
];
export function photosCaption(matches = [], span = Date.now(), handles = []) {
  const range = typeof span === 'number' ? { from: span - WEEK_MS, to: span, shownTo: span } : span;
  const day = ms => new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, day: '2-digit', month: 'short' }).format(new Date(ms));
  const opener = PHOTO_OPENERS[weekIndex(range.from) % PHOTO_OPENERS.length];
  const players = new Set();
  for (const m of matches) { players.add(txt(m.slot?.from_name)); players.add(txt(m.slot?.to_name)); }
  players.delete('');
  const mentions = (handles || []).map(h => '@' + String(h).replace(/^@/, '')).join(' ');
  return [
    `📸 ${opener}`,
    '',
    `${day(range.from)} — ${day(range.shownTo ?? range.to)}`,
    players.size ? `${players.size} players on court` : '',
    '',
    'Photos sent in by the players themselves. Results and tables in the league app.',
    mentions ? '' : null,
    mentions || null,
    '',
    CAROUSEL_HASHTAGS.join(' ')
  ].filter(x => x !== null && x !== '' || x === '').filter((x, i, arr) => !(x === '' && arr[i - 1] === '')).join('\n');
}

// Четверг, 19:00. Отдельный день от карточек нарочно: две подборки в один
// вечер читаются как спам.
export function photosDue(now = Date.now(), timeZone = TIMEZONE) {
  const { weekday, hour } = localParts(now, timeZone);
  return weekday === 'Thu' && hour === 19;
}

// Матчи недели, к которым игрок приложил фото. Фото живёт в Telegram по
// file_id — скачиваем его здесь же.
export async function weeklyPhotos(now = Date.now(), range = null) {
  const { allSlots } = await import('./matchesdb.js');
  const rows = await allSlots();
  const { from, to } = range || parseRange('', now);
  const withPhoto = rows.filter(r => {
    if (String(r.result_status || '').toLowerCase() !== 'confirmed') return false;
    if (!txt(r.result_photo_file_id)) return false;
    const day = Date.parse(`${txt(r.agreed_date)}T12:00:00+07:00`);
    return Number.isFinite(day) && day >= from && day <= to;
  }).sort((a, b) => txt(a.agreed_date).localeCompare(txt(b.agreed_date)));
  const out = [], skipped = [];
  for (const slot of withPhoto) {
    const who = await matchPublicity(slot);
    if (!who.allowed) { skipped.push({ slot, blocked: who.blocked }); continue; }
    out.push({ slot, handles: who.handles });
  }
  return { matches: out, skipped };
}

export async function buildWeeklyPhotos(now = Date.now(), range = null) {
  const span = range || parseRange('', now);
  const { matches, skipped } = await weeklyPhotos(now, span);
  const images = [];
  for (const item of matches) {
    const file = await getFileBuffer(txt(item.slot.result_photo_file_id)).catch(e => {
      console.error('weekly photo download failed:', e.message); return null;
    });
    if (file?.buffer?.length) images.push({ buffer: file.buffer, mime: file.mime || 'image/jpeg', slot: item.slot });
  }
  const handles = [...new Set(matches.flatMap(m => m.handles))];
  return { images, handles, caption: photosCaption(matches, span, handles), skipped, limit: CAROUSEL_MAX, extra: Math.max(0, images.length - CAROUSEL_MAX), range: span };
}

export async function publishWeeklyPhotos(prepared) {
  if (!instagramEnabled()) throw new Error('Instagram не подключён: задайте IG_USER_ID и IG_ACCESS_TOKEN');
  if (!prepared?.images?.length) throw new Error('За неделю нет фотографий, которые можно опубликовать');
  return publishCarousel(prepared.images.slice(0, CAROUSEL_MAX), { caption: prepared.caption, handles: prepared.handles });
}

export async function runWeeklyPhotos(now = Date.now(), adminChatId = '', { force = false, range = null } = {}) {
  if (!force && !photosDue(now)) return { ok: false, reason: 'not_due' };
  const key = dayKey(now);
  if (!force) {
    const last = await getSetting('instagram_photos_last').catch(() => '');
    if (txt(last) === key) return { ok: false, reason: 'already_done' };
    await setSetting('instagram_photos_last', key, 'Дата последней подборки фотографий для Instagram');
  }
  const target = await instagramTarget(adminChatId);
  if (!target.chatId) return { ok: false, reason: 'no_admin_chat' };
  const prepared = await buildWeeklyPhotos(now, range);
  await deliverWeeklyCarousel(prepared, {
    ...target, canPublish: instagramEnabled(),
    title: `Фотографии · ${prepared.range.label}`, action: 'igphotos:go',
    empty: 'За этот отрезок никто не прикладывал фото к результату.'
  });
  return { ok: true, prepared, key, target };
}

// Один раз в неделю: помечаем в Settings, чтобы пятнадцатиминутный проход не
// собрал карусель четыре раза подряд.
export async function runWeeklyCarousel(now = Date.now(), adminChatId = '', { force = false, range = null } = {}) {
  if (!force && !carouselDue(now)) return { ok: false, reason: 'not_due' };
  const key = dayKey(now);
  if (!force) {
    const last = await getSetting('instagram_weekly_last').catch(() => '');
    if (txt(last) === key) return { ok: false, reason: 'already_done' };
    await setSetting('instagram_weekly_last', key, 'Дата последней еженедельной подборки для Instagram');
  }
  const target = await instagramTarget(adminChatId);
  if (!target.chatId) return { ok: false, reason: 'no_admin_chat' };
  const prepared = await buildWeeklyCarousel(now, range);
  await deliverWeeklyCarousel(prepared, { ...target, canPublish: instagramEnabled(), title: `Матчи · ${prepared.range.label}` });
  return { ok: true, prepared, key, target };
}
