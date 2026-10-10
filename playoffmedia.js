// Картинки плей-офф: постеры матчей, постеры мест, сетка, — и их публикация.
//
// Главное правило: ничего не уходит людям само. Всё сначала приходит в
// админский чат (два варианта, где это генерация), и только кнопка
// «Опубликовать» / «Разослать всем» отправляет картинку в ленту результатов
// и всем подписчикам бота. Кнопка «В сторис» — отдельно.
//
//   1. Результат матча плей-офф подтверждён → matches.js не рассылает
//      карточку, а зовёт startMatchPoster: два варианта постера в админский
//      чат с кнопками «Опубликовать · N», «В сторис · N», «Переделать».
//      Нет согласия на фото или генерация не удалась — кнопка «Опубликовать
//      карточкой».
//   2. «Опубликовать» → лента + личная рассылка с постером (та же рассылка,
//      что у обычного результата, только с картинкой постера).
//      После финала и матча за 3-е место сразу запускаются постеры мест:
//      CHAMPION / RUNNER-UP / 3RD PLACE / 4TH PLACE — каждому игроку свой,
//      тоже два варианта на утверждение.
//   3. Сетка картинкой (сторис 1080×1920): после публикации сетки и по кнопке
//      в разделе «Плей-офф» — предпросмотр в админский чат, «Разослать всем»,
//      «В сторис».
//
// Готовые картинки держим в памяти (последние 40). После перезапуска
// сервера кнопка честно скажет «сделайте заново».
import { ADMIN_IDS } from './config.js';

const txt = v => String(v ?? '').trim();
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const runs = new Map();
const remember = (key, value) => {
  runs.set(key, { ...(runs.get(key) || {}), ...value });
  while (runs.size > 40) runs.delete(runs.keys().next().value);
  return runs.get(key);
};
export const __runs = runs;
const short = () => Math.random().toString(36).slice(2, 9);

// Куда присылать на утверждение: админский чат, иначе личка организатора.
export async function adminChat() {
  const { getAdminChatId } = await import('./admin.js');
  return txt(await getAdminChatId().catch(() => '')) || txt(ADMIN_IDS[0]);
}
async function say(text, markup = null) {
  const to = await adminChat();
  if (!to) return null;
  const { sendMessage } = await import('./telegram.js');
  return sendMessage(to, text, markup ? { reply_markup: markup } : {}).catch(e => { console.error('playoff media note:', e.message); return null; });
}
async function sendFile(buffer, name, caption, markup) {
  const to = await adminChat();
  if (!to) throw new Error('admin_chat_missing');
  const { sendDocumentBuffer } = await import('./telegram.js');
  return sendDocumentBuffer(to, buffer, name, { caption, parse_mode: 'HTML', ...(markup ? { reply_markup: markup } : {}) });
}
const stageName = s => ({ QF: 'Четвертьфинал', SF: 'Полуфинал', Final: 'Финал', '3rd': 'Матч за 3-е место' })[s] || s;
const PLACE_RU = { champion: '🏆 Чемпион', runner_up: '🥈 Второе место', third: '🥉 Третье место', fourth: '4-е место' };

// ------------------------------------------------------------ постер матча
const inFlight = new Set();
export async function startMatchPoster(slot = {}, { comment = '', only = 0 } = {}) {
  const id = txt(slot.challenge_id);
  const lock = 'm:' + id;
  if (inFlight.has(lock)) return { ok: false, reason: 'in_flight' };
  inFlight.add(lock);
  const fallback = { inline_keyboard: [[{ text: '🔄 Повторить', callback_data: `pm:redo:${id}` }], [{ text: '📣 Опубликовать карточкой', callback_data: `pm:card:${id}` }]] };
  try {
    const mp = await import('./matchposter.js');
    const { winnerFirstScore } = await import('./matches.js');
    const job = await mp.preparePosterJob(slot, { winnerFirstScore, season: txt(slot.season), comment, variants: 2 });
    if (only) job.prompts = job.prompts.filter(p => Number(p.variant) === Number(only));
    const head = `🏆 <b>${esc(stageName(slot.stage))} · постер</b>\n${esc(job.match.winner)} — ${esc(job.match.loser)} · <b>${esc(job.match.score)}</b>`;
    if (job.status === 'blocked_consent') {
      await say(`${head}\n\n⛔ Один из игроков запретил публикацию своего фото — постер сгенерировать нельзя. Можно опубликовать результат карточкой.`, { inline_keyboard: [[{ text: '📣 Опубликовать карточкой', callback_data: `pm:card:${id}` }]] });
      return { ok: false, reason: 'blocked_consent' };
    }
    if (!mp.posterEnabled()) {
      await say(`${head}\n\n⛔ Генератор не подключён (OPENAI_API_KEY). Можно опубликовать результат карточкой.`, { inline_keyboard: [[{ text: '📣 Опубликовать карточкой', callback_data: `pm:card:${id}` }]] });
      return { ok: false, reason: 'api_not_configured' };
    }
    await say(`${head}\n\n⏳ Генерирую ${job.prompts.length === 1 ? 'вариант' : 'два варианта'} — несколько минут. Результат пока никому не отправлен.`);
    const photos = await mp.loadPosterSourcePhotos(job);
    const backs = await mp.generatePosterBackgrounds(job, photos);
    for (const item of backs) {
      const buffer = await mp.composeMatchPoster(item.buffer, job.match);
      const v = Number(item.variant);
      remember(lock, { [v]: { buffer }, slotId: id });
      await sendFile(buffer, `playoff-${slot.stage}-${v}.png`, `${head}\n\nВариант ${v}`, { inline_keyboard: [
        [{ text: `📣 Опубликовать · ${v}`, callback_data: `pm:pub:${v}:${id}` }],
        [{ text: `📤 В сторис · ${v}`, callback_data: `pm:ig:${v}:${id}` }]
      ] });
    }
    await say('Выберите вариант под картинкой — или переделайте.', { inline_keyboard: [[{ text: '🔄 Переделать оба', callback_data: `pm:redo:${id}` }], [{ text: '📣 Опубликовать карточкой', callback_data: `pm:card:${id}` }]] });
    return { ok: true, variants: backs.length };
  } catch (e) {
    console.error('playoff poster failed:', id, e.message);
    await say(`⛔ <b>Постер не создан</b>: ${esc(e.message)}`, fallback);
    return { ok: false, reason: e.message };
  } finally { inFlight.delete(lock); }
}

// «Опубликовать»: та же рассылка результата (лента + подписчики), но с постером.
export async function publishMatchPoster(id, variant) {
  const run = runs.get('m:' + id) || {};
  if (run.published) return { ok: false, reason: 'already_published', variant: run.published };
  const saved = run[variant];
  if (!saved?.buffer) return { ok: false, reason: 'not_in_memory' };
  const { findSlot } = await import('./matchesdb.js');
  const slot = await findSlot(id);
  if (!slot) return { ok: false, reason: 'not_found' };
  remember('m:' + id, { published: variant });
  const { broadcastResult } = await import('./matches.js');
  const out = await broadcastResult(slot, { media: saved.buffer });
  // Финал и матч за 3-е место — следом постеры мест игроков.
  const { placesForStage } = await import('./matchposter.js');
  const places = placesForStage(txt(slot.stage));
  for (const [side, kind] of places) startPlacePoster(slot, side, kind).catch(e => console.error('place poster failed:', e.message));
  return { ok: true, sent: out?.sent || 0, places: places.length };
}
export async function publishAsCard(id) {
  const run = runs.get('m:' + id) || {};
  if (run.published) return { ok: false, reason: 'already_published' };
  const { findSlot } = await import('./matchesdb.js');
  const slot = await findSlot(id);
  if (!slot) return { ok: false, reason: 'not_found' };
  remember('m:' + id, { published: 'card' });
  const { broadcastResult } = await import('./matches.js');
  const out = await broadcastResult(slot, { asCard: true });
  const { placesForStage } = await import('./matchposter.js');
  for (const [side, kind] of placesForStage(txt(slot.stage))) startPlacePoster(slot, side, kind).catch(() => {});
  return { ok: true, sent: out?.sent || 0 };
}

// ------------------------------------------------------------ постеры мест
const sideOf = (slot, side) => {
  const fromWon = String(slot.result_winner) === String(slot.from_telegram_id);
  const winner = fromWon ? { name: slot.from_name, tg: slot.from_telegram_id } : { name: slot.to_name, tg: slot.to_telegram_id };
  const loser = fromWon ? { name: slot.to_name, tg: slot.to_telegram_id } : { name: slot.from_name, tg: slot.from_telegram_id };
  return side === 'winner' ? winner : loser;
};
export async function startPlacePoster(slot = {}, side = 'winner', kind = 'champion', { only = 0 } = {}) {
  const id = txt(slot.challenge_id), key = `p:${id}:${side}`;
  if (inFlight.has(key)) return { ok: false, reason: 'in_flight' };
  inFlight.add(key);
  const who = sideOf(slot, side);
  const head = `${PLACE_RU[kind] || kind} · <b>${esc(who.name)}</b>`;
  try {
    const mp = await import('./matchposter.js');
    const division = txt(slot.division).replace(/^division\s*/i, '');
    const job = await mp.preparePlacePosterJob({ name: who.name, telegramId: who.tg, kind, division, season: txt(slot.season) });
    if (only) job.prompts = job.prompts.filter(p => Number(p.variant) === Number(only));
    if (job.status === 'blocked_consent') { await say(`${head}\n\n⛔ Игрок запретил публикацию фото — постер места не делаем.`); return { ok: false, reason: 'blocked_consent' }; }
    if (!mp.posterEnabled()) { await say(`${head}\n\n⛔ Генератор не подключён (OPENAI_API_KEY).`); return { ok: false, reason: 'api_not_configured' }; }
    await say(`${head}\n\n⏳ Генерирую постер места — два варианта.`);
    const backs = await mp.generatePlaceBackgrounds(job);
    for (const item of backs) {
      const buffer = await mp.composePlacePoster(item.buffer, { name: who.name, kind, division, season: txt(slot.season) });
      const v = Number(item.variant);
      remember(key, { [v]: { buffer }, slotId: id, side, kind, name: who.name, tg: who.tg, division, season: txt(slot.season) });
      await sendFile(buffer, `place-${kind}-${v}.png`, `${head}\n\nВариант ${v}`, { inline_keyboard: [
        [{ text: `📣 Опубликовать · ${v}`, callback_data: `pm:ppub:${v}:${id}:${side}` }],
        [{ text: `📤 В сторис · ${v}`, callback_data: `pm:pig:${v}:${id}:${side}` }]
      ] });
    }
    await say(`${head}: выберите вариант или переделайте.`, { inline_keyboard: [[{ text: '🔄 Переделать', callback_data: `pm:predo:${id}:${side}` }]] });
    return { ok: true, variants: backs.length };
  } catch (e) {
    console.error('place poster failed:', key, e.message);
    await say(`⛔ <b>Постер места не создан</b> (${esc(who.name)}): ${esc(e.message)}`, { inline_keyboard: [[{ text: '🔄 Повторить', callback_data: `pm:predo:${id}:${side}` }]] });
    return { ok: false, reason: e.message };
  } finally { inFlight.delete(key); }
}
export function placeCaptions({ kind, name, division, season }) {
  const d = /^prime$/i.test(division) ? 'PRIME' : `Division ${division}`;
  const en = { champion: `🏆 <b>${esc(name)}</b> — champion of ${esc(d)}!`, runner_up: `🥈 <b>${esc(name)}</b> — runner-up of ${esc(d)}.`, third: `🥉 <b>${esc(name)}</b> — 3rd place in ${esc(d)}.`, fourth: `<b>${esc(name)}</b> — 4th place in ${esc(d)}.` }[kind];
  const ru = { champion: `🏆 <b>${esc(name)}</b> — чемпион ${esc(d)}!`, runner_up: `🥈 <b>${esc(name)}</b> — второе место в ${esc(d)}.`, third: `🥉 <b>${esc(name)}</b> — третье место в ${esc(d)}.`, fourth: `<b>${esc(name)}</b> — четвёртое место в ${esc(d)}.` }[kind];
  const tail = season ? `\nPTF Playoffs · Season ${season}` : '';
  const tailRu = season ? `\nПлей-офф PTF · сезон ${season}` : '';
  return { en: en + tail, ru: ru + tailRu };
}
export async function publishPlacePoster(id, side, variant) {
  const key = `p:${id}:${side}`, run = runs.get(key) || {};
  if (run.published) return { ok: false, reason: 'already_published' };
  if (!run[variant]?.buffer) return { ok: false, reason: 'not_in_memory' };
  remember(key, { published: variant });
  const c = placeCaptions(run);
  return publishImage(run[variant].buffer, { caption: c.en, caption_ru: c.ru, label: `place:${run.kind}` });
}

// ------------------------------------------------------------ сетка
export async function previewBracket(letter, season) {
  const po = await import('./playoff.js');
  const st = await po.playoffState(season);
  const d = st.divisions.find(x => x.letter === po.letterKey(letter));
  if (!d) return { ok: false, reason: 'not_found' };
  const list = d.published ? d.rows : d.preview;
  const data = { division: d.letter, season: st.season, grouped: d.grouped, matches: list.map(m => {
    const o = po.outcomeOf(m);
    return { slot: m.slot, p1: txt(m.player_1), p2: txt(m.player_2), seed1: txt(m.seed_1), seed2: txt(m.seed_2),
      label1: txt(m.player_1) ? '' : po.placeholderOf(m.slot, 0, d.grouped), label2: txt(m.player_2) ? '' : po.placeholderOf(m.slot, 1, d.grouped),
      played: Boolean(o), winner: o ? o.W : '', score: o && /^.+$/.test(txt(m.score)) ? (txt(m.winner) && txt(m.player_2) && txt(m.winner).toLowerCase() === txt(m.player_2).toLowerCase() ? txt(m.score).replace(/(\d+)\s*:\s*(\d+)/g, (_, a, b) => `${b}:${a}`) : txt(m.score)) : '' };
  }) };
  const { renderBracketImage } = await import('./matchcard.js');
  const buffer = await renderBracketImage(data);
  const key = 'b:' + short();
  remember(key, { buffer, letter: d.letter, title: d.title, season: st.season });
  await sendFile(buffer, `bracket-${d.letter}.png`, `🏆 <b>Сетка плей-офф · ${esc(d.title)}</b>${d.published ? '' : ' (предварительная)'}\n\nНикому не отправлено.`, { inline_keyboard: [
    [{ text: '📣 Разослать всем', callback_data: `pm:bsend:${key}` }],
    [{ text: '📤 В сторис', callback_data: `pm:big:${key}` }]
  ] });
  return { ok: true, key, published: d.published };
}
export async function sendBracket(key) {
  const run = runs.get(key);
  if (!run?.buffer) return { ok: false, reason: 'not_in_memory' };
  if (run.sent) return { ok: false, reason: 'already_published' };
  remember(key, { sent: true });
  const title = /^PRIME$/i.test(run.letter) ? 'PRIME' : `Division ${run.letter}`;
  return publishImage(run.buffer, { caption: `🏆 <b>PTF Playoffs · ${esc(title)}</b>\nSeason ${esc(run.season)} — the bracket.`, caption_ru: `🏆 <b>Плей-офф PTF · ${esc(title)}</b>\nСезон ${esc(run.season)} — сетка.`, label: 'bracket' });
}

// ------------------------------------------------------------ публикация картинки
// Лента результатов (если задана) + рассылка всем подписчикам бота через
// очередь (она переживает перезапуск). Подпись — на языке получателя.
export async function publishImage(buffer, { caption = '', caption_ru = '', label = '' } = {}) {
  const { sendPhotoBuffer } = await import('./telegram.js');
  const { getSetting, getSegmentContacts } = await import('./sheets.js');
  const { RESULTS_CHAT_ID, RESULTS_TOPIC_ID } = await import('./config.js');
  const feedId = txt(RESULTS_CHAT_ID) || txt(await getSetting('results_chat_id').catch(() => ''));
  const topic = txt(RESULTS_TOPIC_ID) || txt(await getSetting('results_topic_id').catch(() => ''));
  const target = feedId || await adminChat();
  const res = await sendPhotoBuffer(target, buffer, 'image/png', { caption: feedId ? caption : `📎 Отправлено в рассылку\n\n${caption}`, parse_mode: 'HTML', ...(feedId && topic ? { message_thread_id: Number(topic) } : {}) });
  const fileId = (res?.photo || res?.result?.photo || []).slice(-1)[0]?.file_id || '';
  if (!fileId) throw new Error('telegram_file_id_missing');
  const { enqueueBroadcast } = await import('./broadcast.js');
  const { ensurePosterKind } = await import('./playoff.js');
  await ensurePosterKind();
  const recipients = await getSegmentContacts('all');
  const q = await enqueueBroadcast({ kind: 'playoff_poster', params: { fileId, caption, caption_ru: caption_ru || caption }, recipients, segment: 'all', messageText: caption, mediaType: 'photo', admin: { id: ADMIN_IDS[0] || '', chatId: await adminChat() } });
  return { ok: true, recipients: q.recipients, feed: Boolean(feedId), label };
}

async function toStory(buffer, handles = []) {
  const { instagramEnabled, publishStory } = await import('./instagram.js');
  if (!instagramEnabled()) throw new Error('Instagram не подключён');
  return publishStory(buffer, { handles });
}

// ------------------------------------------------------------ кнопки
export async function handleCallback(data = '') {
  const parts = String(data).split(':');
  const act = parts[1];
  try {
    if (act === 'pub') { const r = await publishMatchPoster(parts.slice(3).join(':'), Number(parts[2])); return reply(r, `📣 Постер опубликован: лента и рассылка подписчикам (${r.sent || 0}).${r.places ? ' Запускаю постеры мест.' : ''}`); }
    if (act === 'card') { const r = await publishAsCard(parts.slice(2).join(':')); return reply(r, '📣 Опубликовано карточкой.'); }
    if (act === 'redo') {
      const id = parts.slice(2).join(':');
      const { findSlot } = await import('./matchesdb.js');
      const slot = await findSlot(id);
      if (!slot) return { text: 'Матч не найден.' };
      if ((runs.get('m:' + id) || {}).published) return { text: 'Постер этого матча уже опубликован.' };
      startMatchPoster(slot).catch(() => {});
      return { text: '🔄 Делаю новые варианты…' };
    }
    if (act === 'ig') {
      const v = Number(parts[2]), id = parts.slice(3).join(':'), saved = (runs.get('m:' + id) || {})[v];
      if (!saved?.buffer) return { text: 'Картинка уже не в памяти — сделайте постер заново.' };
      const { findSlot } = await import('./matchesdb.js');
      const { publishPosterToStory } = await import('./publicity.js');
      await publishPosterToStory(saved.buffer, await findSlot(id));
      return { text: '📤 Опубликовано в сторис.' };
    }
    if (act === 'ppub') { const r = await publishPlacePoster(parts[3], parts[4], Number(parts[2])); return reply(r, `📣 Постер места опубликован (${r.recipients || 0}).`); }
    if (act === 'pig') {
      const run = runs.get(`p:${parts[3]}:${parts[4]}`) || {}, saved = run[Number(parts[2])];
      if (!saved?.buffer) return { text: 'Картинка уже не в памяти — сделайте заново.' };
      const { findApplicantByTelegramId } = await import('./sheets.js');
      const ig = txt((await findApplicantByTelegramId(run.tg).catch(() => null))?.instagram).replace(/^@/, '');
      await toStory(saved.buffer, ig ? [ig] : []);
      return { text: '📤 Опубликовано в сторис.' };
    }
    if (act === 'predo') {
      const { findSlot } = await import('./matchesdb.js');
      const slot = await findSlot(parts[2]);
      if (!slot) return { text: 'Матч не найден.' };
      const { placesForStage } = await import('./matchposter.js');
      const pair = placesForStage(txt(slot.stage)).find(([side]) => side === parts[3]);
      if (!pair) return { text: 'Для этого матча постер места не положен.' };
      runs.delete(`p:${parts[2]}:${parts[3]}`);
      startPlacePoster(slot, pair[0], pair[1]).catch(() => {});
      return { text: '🔄 Делаю новые варианты…' };
    }
    if (act === 'bsend') { const r = await sendBracket(parts.slice(2).join(':')); return reply(r, `📣 Сетка в рассылке (${r.recipients || 0}).`); }
    if (act === 'big') {
      const run = runs.get(parts.slice(2).join(':'));
      if (!run?.buffer) return { text: 'Картинка уже не в памяти — сделайте заново.' };
      await toStory(run.buffer);
      return { text: '📤 Сетка опубликована в сторис.' };
    }
    return { text: 'Неизвестная кнопка.' };
  } catch (e) {
    return { text: '⛔ ' + esc(e.message) };
  }
}
function reply(r, okText) {
  if (r?.ok) return { text: okText };
  const why = { already_published: 'это уже опубликовано — второй раз не отправляю', not_in_memory: 'картинка уже не в памяти (сервер перезапускался) — сделайте заново', not_found: 'матч не найден' }[r?.reason] || r?.reason || 'не получилось';
  return { text: '⛔ ' + why };
}
