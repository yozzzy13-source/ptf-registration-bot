// Матчи между игроками PTF.
//
// Заявка = свободное окно игрока: НЕСКОЛЬКО дат, интервал времени и НЕСКОЛЬКО
// подходящих кортов. Отвечающий выбирает из этого конкретную дату и корт —
// поэтому «Играю» в чате дивизиона ведёт в мини-приложение, где нужно выбрать,
// а не назначает матч вслепую.
//
//   open   — заявка рассылается всем активным игрокам дивизиона, забрать может любой;
//   direct — та же заявка, адресованная конкретному сопернику.
//
// Окна не публикуются в общий чат: бот адресно рассылает их активным игрокам того же
// дивизиона в личку. Данные и журнал живут в ОТДЕЛЬНОЙ таблице (matchesdb.js).
import { sendMessage, sendPhoto } from './telegram.js';
import { getSetting, setSetting, findApplicantByTelegramId, getDivisionOpponents, getAllBotSubscribers } from './sheets.js';
import { cellToScore, reverseScore, formatScore } from './tennis.js';
import { findSlot, updateSlot, cellToList, logMatchEvent, awaitingSide, proposerSide, getCourts } from './matchesdb.js';
import { PUBLIC_URL, RESULTS_CHAT_ID, RESULTS_TOPIC_ID } from './config.js';
import { escapeHtml, nowISO } from './util.js';
import { getAdminChatId, getOrCreatePlayerTopic } from './admin.js';

function playerLink(name, username) {
  const safeName = escapeHtml(name || 'Игрок');
  return username ? `<a href="https://t.me/${escapeHtml(String(username).replace(/^@/, ''))}">${safeName}</a>` : `<b>${safeName}</b>`;
}

const DAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
// Якорь ставим в полдень UTC: при чтении через getUTC* дата не съезжает на соседний
// день, как это происходит с полуночью и офсетом +07:00.
export function formatDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

// Несколько дат показываем компактно, но полностью — соперник должен видеть весь выбор.
function datesLine(slot) {
  const list = cellToList(slot.dates);
  if (!list.length) return '';
  return list.map(formatDate).join(' · ');
}
function courtsLine(slot) {
  const list = cellToList(slot.courts);
  if (!list.length) return '';
  return list.join(' · ');
}
function offerBlock(slot) {
  const time = slot.time_to && slot.time_to !== slot.time_from ? `${escapeHtml(slot.time_from)}–${escapeHtml(slot.time_to)}` : escapeHtml(slot.time_from);
  const dur = ` · матч ${Number(slot.duration_min || 120) / 60} ч`;
  const courts = courtsLine(slot);
  return `📅 <b>${escapeHtml(datesLine(slot))}</b>\n🕐 <b>${time}</b>${dur}${courts ? `\n📍 ${escapeHtml(courts)}` : ''}`;
}
function endTime(start, durationMin) {
  const [h, m] = String(start || '').split(':').map(Number);
  if (Number.isNaN(h)) return '';
  const total = h * 60 + (m || 0) + Number(durationMin || 120);
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function agreedBlock(slot) {
  const start = slot.agreed_time || slot.time_from || '';
  const end = endTime(start, slot.duration_min);
  return `📅 <b>${escapeHtml(formatDate(slot.agreed_date))}</b>\n🕐 <b>${escapeHtml(start)}${end ? '–' + escapeHtml(end) : ''}</b>${slot.agreed_court ? `\n📍 ${escapeHtml(slot.agreed_court)}` : ''}`;
}

export function openSlotText(slot) {
  const multi = cellToList(slot.dates).length > 1 || cellToList(slot.courts).length > 1;
  return `<b>🎾 Ищу соперника на матч</b>

👤 ${playerLink(slot.from_name, slot.from_username)}${slot.division ? ` · ${escapeHtml(slot.division)}` : ''}
${offerBlock(slot)}${slot.comment ? `\n\n💬 ${escapeHtml(slot.comment)}` : ''}

${multi ? 'Нажми «Играю» и выбери дату, время и корт из предложенных.' : 'Нажми «Играю», и я свяжу вас напрямую.'}`;
}

export function takenSlotText(slot) {
  return `<b>✅ Матч назначен</b>

${playerLink(slot.from_name, slot.from_username)} — ${playerLink(slot.to_name, slot.to_username)}${slot.division ? `\n🏆 ${escapeHtml(slot.division)}` : ''}
${agreedBlock(slot)}

Окно закрыто.`;
}

// Окна больше не уходят в общий чат: бот рассылает их в личку каждому активному
// игроку того же дивизиона. Так игроки получают только релевантные окна, и не нужен
// ещё один общий чат. Автору своё окно не шлём.
let cachedBotUsername = '';
export function setBotUsername(u) { cachedBotUsername = String(u || '').replace(/^@/, ''); }

function openSlotKeyboard(slot) {
  return { inline_keyboard: [[{ text: '🎾 Играю', web_app: { url: `${PUBLIC_URL}/match?slot=${encodeURIComponent(slot.challenge_id)}` } }]] };
}

export async function publishOpenSlot(slot) {
  const recipients = await getDivisionOpponents(slot.division, slot.from_telegram_id).catch(e => {
    console.error('division recipients failed:', e.message);
    return [];
  });
  const text = openSlotText(slot);
  const opts = { reply_markup: openSlotKeyboard(slot) };
  let sent = 0, failed = 0;
  for (const r of recipients) {
    try {
      await sendMessage(r.telegram_id, text, opts);
      sent++;
      await new Promise(res => setTimeout(res, 45)); // мягкий темп, чтобы не упереться в лимит Telegram
    } catch (e) {
      failed++;
      console.error(`open slot to ${r.telegram_id} failed:`, e.message);
    }
  }
  await logMatchEvent('broadcast', slot, { telegram_id: slot.from_telegram_id, name: slot.from_name },
    `дивизион ${slot.division}: отправлено ${sent}, ошибок ${failed}`);

  // Автору — сводка, сколько игроков увидели окно.
  await sendMessage(slot.from_telegram_id, sent
    ? `📣 Окно отправлено игрокам дивизиона: <b>${sent}</b>.\nКак только кто-то откликнется, я пришлю предложение.`
    : `📣 В вашем дивизионе пока некому отправить окно — нет активных игроков с Telegram.`).catch(() => {});

  // Копия в админский топик — чтобы организатор видел активность.
  try {
    const topic = await getOrCreatePlayerTopic({ telegram_id: slot.from_telegram_id, name: slot.from_name, username: slot.from_username });
    const chatId = topic?.chatId || await getAdminChatId();
    if (chatId) {
      await sendMessage(chatId, `<b>📣 Новое окно</b>\n\n${text}\n\nРазослано игрокам: <b>${sent}</b>`,
        topic?.message_thread_id ? { message_thread_id: topic.message_thread_id } : {});
    }
  } catch (e) { console.error('admin copy of open slot failed:', e.message); }

  return { sent, failed };
}

// Окно рассылалось в личку многим игрокам, поэтому «закрывать карточку» негде.
// Тем, кто откроет мини-приложение, оно уже покажет, что окно занято.
async function closeSlotCard() { /* больше не требуется */ }

function contactsKeyboard(username, profileUrl, slot) {
  const rows = [];
  if (slot?.challenge_id) rows.push([{ text: '📲 Забронировать корт', callback_data: `match_book:${slot.challenge_id}` }]);
  if (username) rows.push([{ text: '💬 Написать сопернику', url: `https://t.me/${String(username).replace(/^@/, '')}` }]);
  if (profileUrl) rows.push([{ text: '👤 Профиль игрока', url: profileUrl }]);
  rows.push([{ text: '🎾 Мои матчи', web_app: { url: `${PUBLIC_URL}/match?tab=mine` } }]);
  return { inline_keyboard: rows };
}

async function profileUrlFor(telegramId) {
  const p = await findApplicantByTelegramId(telegramId).catch(() => null);
  return p?.player_profile_url || '';
}

export async function notifyMatchAgreed(slot) {
  await closeSlotCard(slot);
  const [fromUrl, toUrl] = await Promise.all([profileUrlFor(slot.from_telegram_id), profileUrlFor(slot.to_telegram_id)]);
  const card = (oppName, oppUsername) => `<b>🎾 Матч назначен!</b>

Соперник: ${playerLink(oppName, oppUsername)}${slot.division ? `\n🏆 ${escapeHtml(slot.division)}` : ''}
${agreedBlock(slot)}

Нажмите «Забронировать корт», и я подготовлю сообщение для площадки. После игры передайте счёт организатору.`;

  await sendMessage(slot.from_telegram_id, card(slot.to_name, slot.to_username), { reply_markup: contactsKeyboard(slot.to_username, toUrl, slot) }).catch(e => console.error('notify author failed:', e.message));
  await sendMessage(slot.to_telegram_id, card(slot.from_name, slot.from_username), { reply_markup: contactsKeyboard(slot.from_username, fromUrl, slot) }).catch(e => console.error('notify taker failed:', e.message));

  try {
    const topic = await getOrCreatePlayerTopic({ telegram_id: slot.from_telegram_id, name: slot.from_name, username: slot.from_username });
    const chatId = topic?.chatId || await getAdminChatId();
    if (chatId) {
      const text = `<b>🎾 Матч назначен</b>\n\n${escapeHtml(slot.from_name)} — ${escapeHtml(slot.to_name)}${slot.division ? `\n🏆 ${escapeHtml(slot.division)}` : ''}\n${agreedBlock(slot)}`;
      await sendMessage(chatId, text, topic?.message_thread_id ? { message_thread_id: topic.message_thread_id } : {});
    }
  } catch (e) { console.error('notify admin about match failed:', e.message); }
}

// Адресный вызов: соперник выбирает дату/корт в мини-приложении, поэтому кнопка ведёт туда.
export async function sendDirectChallenge(slot) {
  const url = await profileUrlFor(slot.from_telegram_id);
  const rows = [[{ text: '✅ Выбрать время и принять', web_app: { url: `${PUBLIC_URL}/match?slot=${encodeURIComponent(slot.challenge_id)}` } }],
                [{ text: '❌ Отклонить', callback_data: `match_decline:${slot.challenge_id}` }]];
  if (url) rows.push([{ text: '👤 Профиль игрока', url }]);
  const text = `<b>🎾 Вызов на матч</b>

${playerLink(slot.from_name, slot.from_username)} предлагает сыграть${slot.division ? ` · ${escapeHtml(slot.division)}` : ''}
${offerBlock(slot)}${slot.comment ? `\n\n💬 ${escapeHtml(slot.comment)}` : ''}`;
  return sendMessage(slot.to_telegram_id, text, { reply_markup: { inline_keyboard: rows } });
}

export async function declineDirectChallenge(slot, actor = {}) {
  await updateSlot(slot.challenge_id, { status: 'declined', responded_at: nowISO() });
  await logMatchEvent('declined', slot, actor);
  await sendMessage(slot.from_telegram_id, `❌ ${escapeHtml(slot.to_name || 'Игрок')} отклонил вызов на ${escapeHtml(datesLine(slot))}.`).catch(() => {});
}

export async function cancelSlot(slot, actor = {}) {
  await updateSlot(slot.challenge_id, { status: 'cancelled', cancelled_at: nowISO() });
  await logMatchEvent('cancelled', slot, actor);
}

// ---------------------------------------------------------------------------
// Переговоры. Отклик и контрпредложение приходят второй стороне в личку с теми же
// кнопками, что у заявки на тренировку в боте тренера: принять, другое время,
// другой корт, отклонить.
// ---------------------------------------------------------------------------
function proposalKeyboard(slot) {
  return { inline_keyboard: [
    [{ text: '✅ Принять', callback_data: `match_ok:${slot.challenge_id}` }],
    [{ text: '🕐 Другое время', web_app: { url: `${PUBLIC_URL}/match?counter=${encodeURIComponent(slot.challenge_id)}&f=time` } },
     { text: '📍 Другой корт', web_app: { url: `${PUBLIC_URL}/match?counter=${encodeURIComponent(slot.challenge_id)}&f=court` } }],
    [{ text: '❌ Отклонить', callback_data: `match_no:${slot.challenge_id}` }]
  ] };
}

export async function notifyProposal(slot, { isCounter = false } = {}) {
  const to = awaitingSide(slot);
  const by = proposerSide(slot);
  if (!to.id) return null;
  const head = isCounter ? '<b>🔄 Встречное предложение</b>' : '<b>🎾 Отклик на твоё окно</b>';
  const text = `${head}

${playerLink(by.name, by.username)} предлагает сыграть:
${agreedBlock(slot)}${slot.division ? `\n🏆 ${escapeHtml(slot.division)}` : ''}

Подтверди или предложи своё.`;
  return sendMessage(to.id, text, { reply_markup: proposalKeyboard(slot) }).catch(e => console.error('notifyProposal failed:', e.message));
}

export async function notifyProposalRejected(slot, previous = {}) {
  const rejectedFor = String(previous.pending_by || '');
  if (!rejectedFor) return null;
  const reopened = String(slot.status || '').toLowerCase() === 'open';
  const text = reopened
    ? `❌ Предложение на ${escapeHtml(formatDate(previous.agreed_date))} отклонено. Окно снова свободно — можно предложить другое время.`
    : `❌ ${escapeHtml(previous.from_name || 'Игрок')} отклонил вызов.`;
  return sendMessage(rejectedFor, text).catch(() => {});
}

// ---------------------------------------------------------------------------
// Бронь корта в WhatsApp. Номер площадки берём из листа Courts основной таблицы.
// Бот НИЧЕГО не отправляет сам — только готовит текст и ссылку, отправляет игрок.
// ---------------------------------------------------------------------------
export async function courtByName(name) {
  if (!name) return null;
  const list = await getCourts().catch(() => []);
  const norm = (v) => String(v || '').trim().toLowerCase();
  return list.find(c => norm(c.name) === norm(name)) || null;
}

export function bookingMessage(slot, court) {
  const dur = Number(slot.duration_min || 120);
  const start = slot.agreed_time || slot.time_from || '';
  const end = endTime(start, dur);
  const d = new Date(`${slot.agreed_date}T12:00:00Z`);
  const human = Number.isNaN(d.getTime()) ? slot.agreed_date
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  // Пишем напрямую администратору площадки, поэтому корт и число игроков не повторяем.
  // Пометка PTF нужна, чтобы админ понимал, от какой организации бронь.
  return [
    'Hello! I would like to book a court for a PTF match.',
    '',
    `Date: ${human}`,
    `Time: ${start}${end ? '–' + end : ''} (${dur / 60}h)`,
    '',
    'Is it available? Thank you!'
  ].join('\n');
}

export async function sendBookingHelper(chatId, slot) {
  const court = await courtByName(slot.agreed_court);
  const text = bookingMessage(slot, court);
  const confirmRow = [{ text: '✅ Корт подтвердил', callback_data: `match_court_ok:${slot.challenge_id}` }];
  if (!court?.whatsapp) {
    return sendMessage(chatId, `<b>📲 Сообщение для брони корта</b>

${slot.agreed_court ? `Для площадки «${escapeHtml(slot.agreed_court)}» не указан номер WhatsApp в листе Courts, поэтому кнопки нет — скопируйте текст и отправьте сами.` : 'Площадка не выбрана — укажите её в переписке с соперником.'}

<code>${escapeHtml(text)}</code>`, { reply_markup: { inline_keyboard: [confirmRow] } });
  }
  return sendMessage(chatId, `<b>📲 Бронь корта</b>

Площадка: <b>${escapeHtml(court.name)}</b>${court.address ? `\n${escapeHtml(court.address)}` : ''}
Откройте WhatsApp и отправьте сообщение. Когда площадка ответит согласием — нажмите «Корт подтвердил».

<code>${escapeHtml(text)}</code>`, {
    reply_markup: { inline_keyboard: [
      [{ text: '📲 Открыть WhatsApp', url: `https://wa.me/${court.whatsapp}?text=${encodeURIComponent(text)}` }],
      confirmRow
    ] }
  });
}

// Матч подтверждён окончательно: корт забронирован, обе стороны уведомлены,
// каждому — ссылка на добавление события в календарь.
export function matchCalendarUrl(slot) {
  const start = slot.agreed_time || slot.time_from || '00:00';
  const end = endTime(start, slot.duration_min);
  const title = `🎾 PTF: ${slot.from_name} — ${slot.to_name}`;
  const params = new URLSearchParams({
    t: title,
    s: `${slot.agreed_date}T${start}:00+07:00`,
    e: `${slot.agreed_date}T${end}:00+07:00`,
    l: slot.agreed_court || ''
  });
  return `${PUBLIC_URL}/cal?${params.toString()}`;
}

export async function notifyCourtConfirmed(slot) {
  const cal = matchCalendarUrl(slot);
  const card = (oppName, oppUsername) => `<b>✅ Матч активен — корт забронирован</b>

Соперник: ${playerLink(oppName, oppUsername)}${slot.division ? `\n🏆 ${escapeHtml(slot.division)}` : ''}
${agreedBlock(slot)}

Оба игрока уведомлены. Добавьте матч в календарь, чтобы не забыть.`;
  const kb = (username) => ({ inline_keyboard: [
    [{ text: '📅 Добавить в календарь', web_app: { url: cal } }],
    ...(username ? [[{ text: '💬 Написать сопернику', url: `https://t.me/${String(username).replace(/^@/, '')}` }]] : [])
  ] });
  await sendMessage(slot.from_telegram_id, card(slot.to_name, slot.to_username), { reply_markup: kb(slot.to_username) }).catch(e => console.error('confirm notify author failed:', e.message));
  await sendMessage(slot.to_telegram_id, card(slot.from_name, slot.from_username), { reply_markup: kb(slot.from_username) }).catch(e => console.error('confirm notify taker failed:', e.message));

  try {
    const topic = await getOrCreatePlayerTopic({ telegram_id: slot.from_telegram_id, name: slot.from_name, username: slot.from_username });
    const chatId = topic?.chatId || await getAdminChatId();
    if (chatId) {
      await sendMessage(chatId, `<b>✅ Матч активен (корт подтверждён)</b>\n\n${escapeHtml(slot.from_name)} — ${escapeHtml(slot.to_name)}\n${agreedBlock(slot)}`,
        topic?.message_thread_id ? { message_thread_id: topic.message_thread_id } : {});
    }
  } catch (e) { console.error('confirm notify admin failed:', e.message); }
}

// ---------------------------------------------------------------------------
// Результаты
// ---------------------------------------------------------------------------
function opponentOf(slot, telegramId) {
  return String(slot.from_telegram_id) === String(telegramId)
    ? { id: String(slot.to_telegram_id), name: slot.to_name, username: slot.to_username }
    : { id: String(slot.from_telegram_id), name: slot.from_name, username: slot.from_username };
}

// «Матч закончен — внесите результат». Уходит обоим после времени окончания.
export async function notifyResultPrompt(slot) {
  const kb = { inline_keyboard: [[{ text: '📝 Внести результат', web_app: { url: `${PUBLIC_URL}/match?result=${encodeURIComponent(slot.challenge_id)}` } }]] };
  for (const side of [slot.from_telegram_id, slot.to_telegram_id]) {
    if (!side) continue;
    const opp = opponentOf(slot, side);
    await sendMessage(side, `<b>🎾 Матч сыгран?</b>

Соперник: ${playerLink(opp.name, opp.username)}
${agreedBlock(slot)}

Внесите счёт — соперник подтвердит, и матч попадёт в статистику лиги.`, { reply_markup: kb }).catch(e => console.error('result prompt failed:', e.message));
  }
}

function resultBlock(slot) {
  const winnerName = String(slot.result_winner) === String(slot.from_telegram_id) ? slot.from_name : slot.to_name;
  return `🏆 Победитель: <b>${escapeHtml(winnerName || '')}</b>
📊 Счёт: <b>${escapeHtml(slot.result_score || '')}</b>${slot.result_set3_mode ? ` (${escapeHtml(slot.result_set3_mode)})` : ''}`;
}

// Счёт внесён одной стороной — вторая подтверждает или оспаривает.
export async function notifyResultForVerification(slot) {
  const to = opponentOf(slot, slot.result_by);
  const by = String(slot.result_by) === String(slot.from_telegram_id)
    ? { name: slot.from_name, username: slot.from_username }
    : { name: slot.to_name, username: slot.to_username };
  if (!to.id) return null;
  const text = `<b>📊 Подтвердите результат матча</b>

${playerLink(by.name, by.username)} внёс счёт:
${agreedBlock(slot)}

${resultBlock(slot)}

Если всё верно — подтвердите. Если нет — нажмите «Не согласен» и внесите свой вариант.`;
  const kb = { inline_keyboard: [
    [{ text: '✅ Подтверждаю', callback_data: `res_ok:${slot.challenge_id}` }],
    [{ text: '❌ Не согласен', callback_data: `res_no:${slot.challenge_id}` }]
  ] };
  if (slot.result_photo_file_id) {
    return sendPhoto(to.id, slot.result_photo_file_id, { caption: text, reply_markup: kb })
      .catch(async e => { console.error('result photo failed:', e.message); return sendMessage(to.id, text, { reply_markup: kb }); });
  }
  return sendMessage(to.id, text, { reply_markup: kb }).catch(e => console.error('verify request failed:', e.message));
}

export async function notifyResultConfirmed(slot, writeInfo = '') {
  const text = (opp) => `<b>✅ Результат засчитан</b>

Соперник: ${escapeHtml(opp.name || '')}
${agreedBlock(slot)}

${resultBlock(slot)}`;
  for (const side of [slot.from_telegram_id, slot.to_telegram_id]) {
    if (!side) continue;
    await sendMessage(side, text(opponentOf(slot, side))).catch(() => {});
  }
  try {
    const topic = await getOrCreatePlayerTopic({ telegram_id: slot.from_telegram_id, name: slot.from_name, username: slot.from_username });
    const chatId = topic?.chatId || await getAdminChatId();
    if (chatId) {
      const body = `<b>✅ Результат матча</b>\n\n${escapeHtml(slot.from_name)} — ${escapeHtml(slot.to_name)}${slot.division ? `\n🏆 ${escapeHtml(slot.division)}` : ''}\n${agreedBlock(slot)}\n\n${resultBlock(slot)}${writeInfo ? `\n\n<i>${escapeHtml(writeInfo)}</i>` : ''}`;
      const opts = topic?.message_thread_id ? { message_thread_id: topic.message_thread_id } : {};
      if (slot.result_photo_file_id) await sendPhoto(chatId, slot.result_photo_file_id, { caption: body, ...opts }).catch(() => sendMessage(chatId, body, opts));
      else await sendMessage(chatId, body, opts);
    }
  } catch (e) { console.error('admin result copy failed:', e.message); }
}

export async function notifyResultDisputed(slot) {
  const to = String(slot.result_by || '');
  if (!to) return null;
  const opp = opponentOf(slot, to);
  return sendMessage(to, `<b>❌ Соперник не согласен со счётом</b>

${escapeHtml(opp.name || 'Соперник')} оспорил результат:
${resultBlock(slot)}

Свяжитесь и внесите согласованный счёт заново.`, {
    reply_markup: { inline_keyboard: [[{ text: '📝 Внести заново', web_app: { url: `${PUBLIC_URL}/match?result=${encodeURIComponent(slot.challenge_id)}` } }]] }
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Лента результатов: подтверждённый матч уходит ВСЕМ живым пользователям бота —
// не только текущему составу дивизионов, чтобы каждый видел, что лига идёт, —
// плюс копией одним сообщением в общую группу игроков. Участникам матча повторно
// не шлём: они уже получили персональную карточку.
// ---------------------------------------------------------------------------
async function resultsChat() {
  const chatId = RESULTS_CHAT_ID || await getSetting('results_chat_id');
  const topicId = RESULTS_TOPIC_ID || await getSetting('results_topic_id');
  return chatId ? { chatId, topicId: topicId ? Number(topicId) : null } : null;
}

// Счёт в таблице хранится «от автора заявки», а в ленте пары идут «победитель — проигравший».
// Если победил второй игрок, счёт нужно перевернуть, иначе 6:4 в тексте читается наоборот.
export function winnerFirstScore(slot) {
  const raw = String(slot.result_score || '');
  if (!raw) return '';
  if (String(slot.result_winner) === String(slot.from_telegram_id)) return raw;
  return formatScore(reverseScore(cellToScore(raw)));
}

function feedText(slot) {
  const winnerIsFrom = String(slot.result_winner) === String(slot.from_telegram_id);
  const winner = winnerIsFrom ? slot.from_name : slot.to_name;
  const loser = winnerIsFrom ? slot.to_name : slot.from_name;
  return `<b>🎾 Результат матча</b>${slot.division ? ` · ${escapeHtml(slot.division)}` : ''}

🏆 <b>${escapeHtml(winner || '')}</b> — ${escapeHtml(loser || '')}
📊 <b>${escapeHtml(winnerFirstScore(slot))}</b>${slot.result_set3_mode === 'Match TB' ? ' <i>(чемпионский тай-брейк)</i>' : ''}
📅 ${escapeHtml(formatDate(slot.agreed_date))}`;
}

export async function broadcastResult(slot) {
  const text = feedText(slot);
  const skip = new Set([String(slot.from_telegram_id), String(slot.to_telegram_id)]);

  // 1. Общая группа — одно сообщение вместо десятков личных.
  const chat = await resultsChat();
  if (chat) {
    const opts = chat.topicId ? { message_thread_id: chat.topicId } : {};
    try {
      if (slot.result_photo_file_id) await sendPhoto(chat.chatId, slot.result_photo_file_id, { caption: text, ...opts });
      else await sendMessage(chat.chatId, text, opts);
    } catch (e) { console.error('results group post failed:', e.message); }
  }

  // 2. Личная рассылка всем живым пользователям бота.
  let sent = 0, failed = 0;
  try {
    const players = await getAllBotSubscribers();
    for (const p of players) {
      if (skip.has(String(p.telegram_id))) continue;
      try {
        await sendMessage(p.telegram_id, text);
        sent++;
        await new Promise(r => setTimeout(r, 45));
      } catch (e) { failed++; }
    }
  } catch (e) { console.error('results broadcast failed:', e.message); }
  await logMatchEvent('result_broadcast', slot, { telegram_id: slot.result_by, name: '' },
    `лента: ${chat ? 'группа + ' : ''}личных ${sent}, ошибок ${failed}`);
  return { sent, failed, group: Boolean(chat) };
}

// ---------------------------------------------------------------------------
// Свободная бронь корта: игрок выбирает дату, время, длительность и несколько
// площадок — бот выдаёт по сообщению на каждую с готовой ссылкой в WhatsApp.
// Бот сам ничего не отправляет: отправляет игрок.
// ---------------------------------------------------------------------------
export function courtRequestMessage({ date, time, durationMin }, lang = 'en') {
  const end = endTime(time, durationMin);
  const d = new Date(`${date}T12:00:00Z`);
  const human = Number.isNaN(d.getTime()) ? date
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return [
    'Hello! I would like to book a tennis court.',
    '',
    `Date: ${human}`,
    `Time: ${time}${end ? '–' + end : ''} (${Number(durationMin) / 60}h)`,
    '',
    'Is it available? Thank you!'
  ].join('\n');
}

export async function sendCourtRequests(chatId, lang, form, courtsList) {
  const ru = lang === 'ru';
  const text = courtRequestMessage(form, lang);
  const chosen = (courtsList || []).filter(c => (form.courts || []).includes(c.name));
  if (!chosen.length) return { sent: 0 };

  await sendMessage(chatId, ru
    ? `<b>📲 Запросы на бронь готовы</b>\n\n📅 <b>${escapeHtml(formatDate(form.date))}</b>\n🕐 <b>${escapeHtml(form.time)}–${escapeHtml(endTime(form.time, form.durationMin))}</b>\n\nНиже — по сообщению на каждую площадку. Откройте WhatsApp и отправьте; текст уже подставлен.`
    : `<b>📲 Booking requests ready</b>\n\n📅 <b>${escapeHtml(formatDate(form.date))}</b>\n🕐 <b>${escapeHtml(form.time)}–${escapeHtml(endTime(form.time, form.durationMin))}</b>\n\nBelow is one message per venue. Open WhatsApp and send — the text is prefilled.`);

  let sent = 0;
  for (const court of chosen) {
    const rows = [];
    if (court.whatsapp) rows.push([{ text: ru ? `📲 Написать ${court.name}` : `📲 Message ${court.name}`, url: `https://wa.me/${court.whatsapp}?text=${encodeURIComponent(text)}` }]);
    const body = `<b>${escapeHtml(court.name)}</b>${court.address ? `\n${escapeHtml(court.address)}` : ''}${court.whatsapp ? '' : `\n<i>${ru ? 'Номер WhatsApp не заполнен в листе Courts — скопируйте текст и отправьте вручную.' : 'No WhatsApp number in the Courts sheet — copy the text and send it manually.'}</i>`}\n\n<code>${escapeHtml(text)}</code>`;
    try {
      await sendMessage(chatId, body, rows.length ? { reply_markup: { inline_keyboard: rows } } : {});
      sent++;
      await new Promise(r => setTimeout(r, 45));
    } catch (e) { console.error('court request failed:', e.message); }
  }
  await logMatchEvent('court_request', { challenge_id: '', division: '' }, { telegram_id: chatId, name: '' },
    `${form.date} ${form.time} · ${Number(form.durationMin) / 60}ч · ${chosen.map(c => c.name).join(', ')}`);
  return { sent };
}

export { findSlot };
