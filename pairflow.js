// Запись в парный турнир: от «хочу играть» до собранной пары и выбора, кто
// платит. Отдельным файлом, потому что это самостоятельная цепочка с
// собственными состояниями, а bot.js и без того велик.
//
// Смысл цепочки, по порядку:
//   1. Человек открывает список парных турниров и жмёт «Записаться».
//   2. Заявка создаётся СРАЗУ, даже если партнёра нет. Такая пара видна
//      остальным на доске поиска — партнёр может найтись сам.
//   3. Партнёра зовут двумя способами: выбрав из списка игроков лиги или
//      ссылкой, которую можно переслать хоть в WhatsApp.
//   4. Отказ не убивает заявку: пара возвращается в «ищу партнёра».
//   5. Двое позвали друг друга — это согласие, спрашивать больше нечего.
//   6. После согласия место держится, и обоим уходит вопрос, кто платит.
//      Пока второй не решил, место никому не отдаётся.
import { sendMessage, answerCallbackQuery } from './telegram.js';
import { PUBLIC_URL } from './config.js';
import {
  ensureTournamentSheets, listTournaments, getTournament, listPairs, createPair, updatePair,
  invitePartner, acceptInvite, declineInvite, findInvite, findPair, candidatePlayers, pairLabel, listEntries
} from './tournaments.js';

const txt = v => String(v ?? '').trim();
const lower = v => txt(v).toLowerCase();
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ru = lang => lang !== 'en';

// Список кандидатов держим в памяти на пользователя: в callback_data влезает
// 64 байта, имя туда не положить, а индекс — легко.
const pickCache = new Map();
const PICK_TTL = 30 * 60 * 1000;
function rememberPicks(userId, list) {
  pickCache.set(String(userId), { at: Date.now(), list });
  for (const [k, v] of pickCache) if (Date.now() - v.at > PICK_TTL) pickCache.delete(k);
}
function picks(userId) {
  const hit = pickCache.get(String(userId));
  return hit && Date.now() - hit.at < PICK_TTL ? hit.list : null;
}

let cachedBotName = '';
export function setPairBotUsername(name) { cachedBotName = txt(name).replace(/^@/, ''); }
export const pairInviteLink = inviteId => cachedBotName
  ? `https://t.me/${cachedBotName}?start=pair_${inviteId}`
  : `${PUBLIC_URL}/`;

// Тестовый режим здесь всегда выключен: игроки работают с боевыми данными.
// Проверять цепочку целиком организатор может из турнирной админки.
const TEST = false;

// ------------------------------------------------------------------- список
export async function sendDoublesTournaments(chatId, user = {}, lang = 'ru') {
  await ensureTournamentSheets(TEST);
  const all = await listTournaments(TEST);
  const open = all.filter(t => lower(t.kind) === 'doubles' && lower(t.status) === 'registration');
  if (!open.length) {
    return sendMessage(chatId, ru(lang)
      ? '👥 <b>Парные турниры</b>\n\nСейчас открытых записей нет. Как только запись откроется, бот пришлёт приглашение.'
      : '👥 <b>Doubles tournaments</b>\n\nNo open registrations right now. The bot will let you know when one opens.');
  }
  const blocks = [];
  const buttons = [];
  for (const t of open) {
    const pairs = await listPairs(t.tournament_id, TEST);
    const entries = await listEntries(t.tournament_id, TEST);
    const mine = pairs.find(p => lower(p.status) !== 'dissolved'
      && [txt(p.player_a_id), txt(p.player_b_id)].includes(String(user.id)));
    const seeking = pairs.filter(p => lower(p.status) === 'seeking');
    const taken = entries.filter(e => ['applied', 'accepted'].includes(lower(e.status))).length;
    blocks.push([
      `🏆 <b>${esc(ru(lang) ? t.name : (t.name_en || t.name))}</b>`,
      t.starts_on ? (ru(lang) ? `Старт: ${esc(t.starts_on)}` : `Starts: ${esc(t.starts_on)}`) : '',
      t.registration_closes ? (ru(lang) ? `Запись до: ${esc(t.registration_closes)}` : `Registration until: ${esc(t.registration_closes)}`) : '',
      t.entry_fee_thb || t.entry_fee_usdt
        ? (ru(lang) ? `Взнос: ${esc([t.entry_fee_thb ? t.entry_fee_thb + ' ฿' : '', t.entry_fee_usdt ? t.entry_fee_usdt + ' USDT' : ''].filter(Boolean).join(' / '))}` : `Entry fee: ${esc([t.entry_fee_thb ? t.entry_fee_thb + ' THB' : '', t.entry_fee_usdt ? t.entry_fee_usdt + ' USDT' : ''].filter(Boolean).join(' / '))}`)
        : '',
      ru(lang) ? `Пар записано: ${taken}${t.max_entries ? ' из ' + esc(t.max_entries) : ''}` : `Pairs entered: ${taken}${t.max_entries ? ' of ' + esc(t.max_entries) : ''}`,
      seeking.length ? (ru(lang) ? `Ищут партнёра: ${seeking.length}` : `Looking for a partner: ${seeking.length}`) : '',
      mine ? (ru(lang) ? `\n✅ Вы записаны: ${esc(pairLabel(mine))} — ${esc(pairStatusRu(mine.status, lang))}` : `\n✅ You are entered: ${esc(pairLabel(mine))} — ${esc(pairStatusRu(mine.status, lang))}`) : ''
    ].filter(Boolean).join('\n'));
    if (mine) {
      if (lower(mine.status) === 'seeking') buttons.push([{ text: ru(lang) ? '👤 Найти партнёра' : '👤 Find a partner', callback_data: `pr:who:${mine.pair_id}` }]);
    } else {
      buttons.push([{ text: (ru(lang) ? '✍️ Записаться · ' : '✍️ Enter · ') + t.name.slice(0, 28), callback_data: `pr:join:${t.tournament_id}` }]);
    }
  }
  return sendMessage(chatId, blocks.join('\n\n'), { reply_markup: { inline_keyboard: buttons } });
}
function pairStatusRu(status, lang = 'ru') {
  const map = ru(lang)
    ? { seeking: 'ищете партнёра', invite_pending: 'ждём ответа партнёра', confirmed: 'пара собрана', dissolved: 'распалась' }
    : { seeking: 'looking for a partner', invite_pending: 'waiting for the partner', confirmed: 'pair confirmed', dissolved: 'dissolved' };
  return map[lower(status)] || txt(status);
}

// ------------------------------------------------------------------ запись
async function joinTournament(chatId, from, lang, tournamentId) {
  const tournament = await getTournament(tournamentId, TEST);
  if (!tournament) return sendMessage(chatId, ru(lang) ? 'Турнир не найден.' : 'Tournament not found.');
  if (lower(tournament.status) !== 'registration') {
    return sendMessage(chatId, ru(lang) ? 'Запись на этот турнир закрыта.' : 'Registration for this tournament is closed.');
  }
  const name = txt(from.first_name) + (txt(from.last_name) ? ' ' + txt(from.last_name) : '');
  const pair = await createPair(tournamentId, { playerAId: String(from.id), playerAName: name }, { id: from.id, name }, TEST);
  return sendMessage(chatId, ru(lang)
    ? `✅ Заявка принята: <b>${esc(tournament.name)}</b>.\n\nПартнёра можно выбрать сейчас или позже — заявка остаётся живой в любом случае. Пока партнёра нет, вы видны остальным на доске поиска.`
    : `✅ Entry accepted: <b>${esc(tournament.name_en || tournament.name)}</b>.\n\nYou can pick a partner now or later — your entry stays alive either way. Until then, others can see that you are looking.`, {
    reply_markup: { inline_keyboard: [
      [{ text: ru(lang) ? '👤 Выбрать партнёра из списка' : '👤 Pick a partner from the list', callback_data: `pr:who:${pair.pair_id}` }],
      [{ text: ru(lang) ? '🔗 Позвать ссылкой' : '🔗 Invite by link', callback_data: `pr:link:${pair.pair_id}` }],
      [{ text: ru(lang) ? '⏳ Пока без партнёра' : '⏳ No partner yet', callback_data: `pr:solo:${pair.pair_id}` }]
    ] }
  });
}

// -------------------------------------------------------- выбор партнёра
const PAGE = 8;
async function showCandidates(chatId, from, lang, pairId, page = 0) {
  const pair = await findPair(pairId, TEST);
  if (!pair) return sendMessage(chatId, ru(lang) ? 'Заявка не найдена.' : 'Entry not found.');
  let list = picks(from.id);
  if (!list) {
    const all = await candidatePlayers();
    const pairs = await listPairs(pair.tournament_id, TEST);
    // Тех, кто уже в собранной паре, не предлагаем: звать их бессмысленно.
    const busy = new Set(pairs.filter(p => lower(p.status) === 'confirmed')
      .flatMap(p => [txt(p.player_a_id), txt(p.player_b_id)]).filter(Boolean));
    list = all.filter(p => txt(p.telegram_id) && txt(p.telegram_id) !== String(from.id) && !busy.has(txt(p.telegram_id)));
    rememberPicks(from.id, list);
  }
  if (!list.length) {
    return sendMessage(chatId, ru(lang)
      ? 'Свободных игроков для приглашения не нашлось. Позовите партнёра ссылкой.'
      : 'No free players to invite. Use the invite link instead.', {
      reply_markup: { inline_keyboard: [[{ text: ru(lang) ? '🔗 Позвать ссылкой' : '🔗 Invite by link', callback_data: `pr:link:${pairId}` }]] }
    });
  }
  const pages = Math.ceil(list.length / PAGE);
  const p = Math.max(0, Math.min(pages - 1, Number(page) || 0));
  const slice = list.slice(p * PAGE, p * PAGE + PAGE);
  const buttons = slice.map((x, i) => [{
    text: `${x.name}${x.rating ? ` · ${x.rating}` : ''}`.slice(0, 60),
    callback_data: `pr:inv:${pairId}:${p * PAGE + i}`
  }]);
  const nav = [];
  if (p > 0) nav.push({ text: '‹', callback_data: `pr:who:${pairId}:${p - 1}` });
  if (p < pages - 1) nav.push({ text: '›', callback_data: `pr:who:${pairId}:${p + 1}` });
  if (nav.length) buttons.push(nav);
  buttons.push([{ text: ru(lang) ? '🔗 Позвать ссылкой' : '🔗 Invite by link', callback_data: `pr:link:${pairId}` }]);
  return sendMessage(chatId, ru(lang)
    ? `👤 <b>Кого зовём в пару</b>\nСтраница ${p + 1} из ${pages}.\n\nПриглашение уйдёт ему в бот. Он сможет согласиться или отказаться — при отказе ваша заявка останется, и можно будет позвать другого.`
    : `👤 <b>Who are we inviting</b>\nPage ${p + 1} of ${pages}.\n\nThe invite goes to them in the bot. They can accept or decline — on a decline your entry stays and you can invite someone else.`, {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function doInvite(chatId, from, lang, pairId, index) {
  const list = picks(from.id);
  const target = list?.[Number(index)];
  if (!target) return showCandidates(chatId, from, lang, pairId, 0);
  const pair = await findPair(pairId, TEST);
  if (!pair) return sendMessage(chatId, ru(lang) ? 'Заявка не найдена.' : 'Entry not found.');
  const tournament = await getTournament(pair.tournament_id, TEST);
  const invite = await invitePartner(pairId, { toId: txt(target.telegram_id), toName: txt(target.name), channel: 'telegram' },
    { id: from.id, name: txt(pair.player_a_name) }, TEST);

  // Встречное приглашение: он уже звал нас — считаем это согласием.
  const mutual = await findMutual(pair.tournament_id, String(from.id), txt(target.telegram_id));
  if (mutual) {
    await acceptInvite(mutual.invite_id, { playerId: String(from.id), playerName: txt(pair.player_a_name) }, { id: from.id }, TEST).catch(() => {});
    await acceptInvite(invite.invite_id, { playerId: txt(target.telegram_id), playerName: txt(target.name) }, { id: from.id }, TEST).catch(() => {});
    await announcePair(pair.tournament_id, pairId, lang);
    return;
  }
  await notifyInvite(invite, pair, tournament);
  return sendMessage(chatId, ru(lang)
    ? `📨 Приглашение отправлено: <b>${esc(target.name)}</b>.\n\nМесто держим. Если он откажется, заявка останется у вас и можно будет позвать другого.`
    : `📨 Invite sent to <b>${esc(target.name)}</b>.\n\nYour spot is held. If they decline, your entry stays and you can invite someone else.`);
}

async function findMutual(tournamentId, myId, theirId) {
  const { pendingInvitesFor } = await import('./tournaments.js');
  const mine = await pendingInvitesFor(myId, TEST);
  return mine.find(i => txt(i.tournament_id) === txt(tournamentId) && txt(i.from_id) === txt(theirId)) || null;
}

// Приглашение самому партнёру: кнопки согласия прямо в сообщении.
export async function notifyInvite(invite, pair, tournament) {
  if (!txt(invite?.to_id)) return null;
  const name = txt(pair.player_a_name) || 'Игрок';
  const title = txt(tournament?.name) || 'парный турнир';
  return sendMessage(invite.to_id,
    `👥 <b>Приглашение в пару</b>\n\n<b>${esc(name)}</b> зовёт вас в пару на турнир <b>${esc(title)}</b>.\n\n` +
    `Если соглашаетесь — место за вами обоими, дальше выберете, кто вносит взнос. Если нет, просто откажитесь: у него останется заявка и он позовёт другого.`, {
    reply_markup: { inline_keyboard: [[
      { text: '✅ Согласен', callback_data: `pr:acc:${invite.invite_id}` },
      { text: '✖️ Отказаться', callback_data: `pr:dec:${invite.invite_id}` }
    ]] }
  }).catch(e => { console.error('pair invite notify failed:', e.message); return null; });
}

// Ссылка-приглашение: её можно переслать куда угодно, в том числе в WhatsApp.
async function sendInviteLink(chatId, from, lang, pairId) {
  const pair = await findPair(pairId, TEST);
  if (!pair) return sendMessage(chatId, ru(lang) ? 'Заявка не найдена.' : 'Entry not found.');
  const tournament = await getTournament(pair.tournament_id, TEST);
  const invite = await invitePartner(pairId, { toName: '', toContact: '', channel: 'link' },
    { id: from.id, name: txt(pair.player_a_name) }, TEST);
  const link = pairInviteLink(invite.invite_id);
  const text = ru(lang)
    ? `🔗 <b>Ссылка-приглашение</b>\n\nПерешлите её партнёру — в Telegram, в WhatsApp, куда удобно. Кто откроет ссылку и подтвердит, тот и станет вашим партнёром в турнире <b>${esc(tournament?.name || '')}</b>.\n\n<code>${esc(link)}</code>\n\nСсылка действует, пока кто-то не согласится или пока вы не позовёте другого.`
    : `🔗 <b>Invite link</b>\n\nForward it to your partner — Telegram, WhatsApp, anywhere. Whoever opens it and confirms becomes your partner in <b>${esc(tournament?.name_en || tournament?.name || '')}</b>.\n\n<code>${esc(link)}</code>\n\nThe link stays valid until someone accepts or you invite another player.`;
  return sendMessage(chatId, text);
}

// -------------------------------------------------- согласие и подтверждение
async function accept(chatId, from, lang, inviteId) {
  const invite = await findInvite(inviteId, TEST);
  if (!invite) return sendMessage(chatId, ru(lang) ? 'Приглашение не найдено.' : 'Invite not found.');
  if (lower(invite.status) !== 'pending') {
    return sendMessage(chatId, ru(lang)
      ? 'Это приглашение уже обработано.' : 'This invite has already been handled.');
  }
  if (txt(invite.from_id) === String(from.id)) {
    return sendMessage(chatId, ru(lang) ? 'Это ваше собственное приглашение.' : 'This is your own invite.');
  }
  if (txt(invite.to_id) && txt(invite.to_id) !== String(from.id)) {
    return sendMessage(chatId, ru(lang) ? 'Приглашение адресовано другому игроку.' : 'This invite is addressed to another player.');
  }
  const name = txt(from.first_name) + (txt(from.last_name) ? ' ' + txt(from.last_name) : '');
  await acceptInvite(inviteId, { playerId: String(from.id), playerName: name }, { id: from.id, name }, TEST);
  await announcePair(invite.tournament_id, invite.pair_id, lang);
}

async function decline(chatId, from, lang, inviteId) {
  const invite = await findInvite(inviteId, TEST);
  if (!invite) return sendMessage(chatId, ru(lang) ? 'Приглашение не найдено.' : 'Invite not found.');
  await declineInvite(inviteId, { id: from.id }, TEST);
  await sendMessage(chatId, ru(lang) ? 'Отказ записан. Спасибо, что ответили.' : 'Your decline is recorded. Thanks for answering.');
  if (txt(invite.from_id)) {
    await sendMessage(invite.from_id,
      `😔 <b>${esc(txt(invite.to_name) || 'Игрок')}</b> не сможет играть с вами в паре.\n\nВаша заявка осталась — позовите другого партнёра.`, {
      reply_markup: { inline_keyboard: [[{ text: '👤 Позвать другого', callback_data: `pr:who:${invite.pair_id}` }]] }
    }).catch(() => {});
  }
}

// Пара собрана: обоим одно и то же сообщение и вопрос, кто платит.
async function announcePair(tournamentId, pairId, lang = 'ru') {
  const pair = await findPair(pairId, TEST);
  const tournament = await getTournament(tournamentId, TEST);
  if (!pair) return;
  const label = pairLabel(pair);
  const fee = [txt(tournament?.entry_fee_thb) ? `${tournament.entry_fee_thb} ฿` : '',
    txt(tournament?.entry_fee_usdt) ? `${tournament.entry_fee_usdt} USDT` : ''].filter(Boolean).join(' / ');
  const body = `🤝 <b>Пара собрана</b>\n\n<b>${esc(label)}</b> — турнир <b>${esc(tournament?.name || '')}</b>.\n\n` +
    `Место за вами закреплено.${fee ? ` Взнос за пару: <b>${esc(fee)}</b>.` : ''}\n\n` +
    `Решите, кто вносит взнос. Пока решение не принято, место держится за вами.`;
  const keyboard = pid => ({ inline_keyboard: [
    [{ text: '💳 Плачу я', callback_data: `pr:pay:${pairId}:${pid === txt(pair.player_a_id) ? 'a' : 'b'}` }],
    [{ text: '👥 Платит партнёр', callback_data: `pr:pay:${pairId}:${pid === txt(pair.player_a_id) ? 'b' : 'a'}` }],
    [{ text: '🤝 Пополам', callback_data: `pr:pay:${pairId}:both` }]
  ] });
  for (const id of [txt(pair.player_a_id), txt(pair.player_b_id)].filter(Boolean)) {
    await sendMessage(id, body, { reply_markup: keyboard(id) }).catch(() => {});
  }
}

async function choosePayer(chatId, from, lang, pairId, who) {
  const pair = await findPair(pairId, TEST);
  if (!pair) return sendMessage(chatId, ru(lang) ? 'Пара не найдена.' : 'Pair not found.');
  if (txt(pair.payer)) {
    return sendMessage(chatId, ru(lang)
      ? `Уже выбрано: ${esc(payerLabel(pair, pair.payer))}. Если нужно поменять — напишите организатору.`
      : `Already chosen: ${esc(payerLabel(pair, pair.payer))}. Contact the organiser to change it.`);
  }
  await updatePair(pairId, { payer: who }, { id: from.id }, TEST);
  const updated = { ...pair, payer: who };
  const tournament = await getTournament(pair.tournament_id, TEST);
  const fee = [txt(tournament?.entry_fee_thb) ? `${tournament.entry_fee_thb} ฿` : '',
    txt(tournament?.entry_fee_usdt) ? `${tournament.entry_fee_usdt} USDT` : ''].filter(Boolean).join(' / ');
  const text = `💳 <b>Оплата пары</b>\n\nПлатит: <b>${esc(payerLabel(updated, who))}</b>.` +
    `${fee ? `\nСумма: <b>${esc(fee)}</b>${who === 'both' ? ' — делится пополам' : ''}.` : ''}\n\n` +
    `Реквизиты пришлёт организатор. Место за парой держится до оплаты.`;
  for (const id of [txt(pair.player_a_id), txt(pair.player_b_id)].filter(Boolean)) {
    await sendMessage(id, text).catch(() => {});
  }
}
function payerLabel(pair, who) {
  if (who === 'both') return 'оба, пополам';
  return who === 'a' ? txt(pair.player_a_name) : txt(pair.player_b_name);
}

// ----------------------------------------------------------- точки входа
// Ссылка вида t.me/bot?start=pair_<id>. Отвечаем тем же экраном согласия.
export async function handlePairStart(chatId, from, lang, inviteId) {
  await ensureTournamentSheets(TEST);
  const invite = await findInvite(inviteId, TEST);
  if (!invite) return sendMessage(chatId, ru(lang) ? 'Приглашение не найдено или уже неактуально.' : 'The invite was not found or is no longer valid.');
  if (lower(invite.status) !== 'pending') {
    return sendMessage(chatId, ru(lang) ? 'Это приглашение уже обработано.' : 'This invite has already been handled.');
  }
  if (txt(invite.from_id) === String(from.id)) {
    return sendMessage(chatId, ru(lang) ? 'Это ваша собственная ссылка — перешлите её партнёру.' : 'This is your own link — forward it to your partner.');
  }
  const pair = await findPair(invite.pair_id, TEST);
  const tournament = await getTournament(invite.tournament_id, TEST);
  return sendMessage(chatId, ru(lang)
    ? `👥 <b>Приглашение в пару</b>\n\n<b>${esc(txt(pair?.player_a_name) || 'Игрок')}</b> зовёт вас в пару на турнир <b>${esc(tournament?.name || '')}</b>.\n\nСогласившись, вы вместе занимаете место в сетке.`
    : `👥 <b>Pair invite</b>\n\n<b>${esc(txt(pair?.player_a_name) || 'A player')}</b> invites you to play as a pair in <b>${esc(tournament?.name_en || tournament?.name || '')}</b>.\n\nAccepting takes a spot for both of you.`, {
    reply_markup: { inline_keyboard: [[
      { text: ru(lang) ? '✅ Согласен' : '✅ Accept', callback_data: `pr:acc:${invite.invite_id}` },
      { text: ru(lang) ? '✖️ Отказаться' : '✖️ Decline', callback_data: `pr:dec:${invite.invite_id}` }
    ]] }
  });
}

// Возвращает true, если сообщение/нажатие относится к парной цепочке.
export function isPairCallback(data = '') { return String(data).startsWith('pr:'); }

export async function handlePairCallback(q, lang = 'ru') {
  const data = String(q.data || '');
  const from = q.from || {};
  const chatId = q.message?.chat?.id || from.id;
  const [, action, a, b] = data.split(':');
  try {
    await ensureTournamentSheets(TEST);
    if (action === 'join') return await joinTournament(chatId, from, lang, a);
    if (action === 'who') return await showCandidates(chatId, from, lang, a, b || 0);
    if (action === 'inv') return await doInvite(chatId, from, lang, a, b);
    if (action === 'link') return await sendInviteLink(chatId, from, lang, a);
    if (action === 'acc') return await accept(chatId, from, lang, a);
    if (action === 'dec') return await decline(chatId, from, lang, a);
    if (action === 'pay') return await choosePayer(chatId, from, lang, a, b);
    if (action === 'solo') {
      return await sendMessage(chatId, ru(lang)
        ? 'Хорошо. Заявка остаётся активной, вы в списке ищущих партнёра. Позвать кого-то можно в любой момент — команда /doubles.'
        : 'Alright. Your entry stays active and you are listed as looking for a partner. You can invite someone anytime with /doubles.');
    }
  } catch (e) {
    console.error('pair callback failed:', e.message);
    await answerCallbackQuery(q.id, e.message.slice(0, 190), true).catch(() => {});
  }
  return null;
}
