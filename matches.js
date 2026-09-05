// Матчи между игроками PTF.
//
// Заявка = свободное окно игрока: НЕСКОЛЬКО дат, интервал времени и НЕСКОЛЬКО
// подходящих кортов. Отвечающий выбирает из этого конкретную дату и корт —
// поэтому «Играю» в чате дивизиона ведёт в мини-приложение, где нужно выбрать,
// а не назначает матч вслепую.
//
//   open   — заявка публикуется в топик дивизиона, забрать может любой из дивизиона;
//   direct — та же заявка, адресованная конкретному сопернику (уходит ему в личку).
//
// Данные и журнал живут в ОТДЕЛЬНОЙ таблице (matchesdb.js), основная таблица PTF не трогается.
import { sendMessage, editMessageText, createForumTopic } from './telegram.js';
import { getSetting, setSetting, findApplicantByTelegramId } from './sheets.js';
import { findSlot, updateSlot, cellToList, logMatchEvent } from './matchesdb.js';
import { LEAGUE_CHAT_ID, PUBLIC_URL } from './config.js';
import { escapeHtml, nowISO } from './util.js';
import { getAdminChatId, getOrCreatePlayerTopic } from './admin.js';

const topicLocks = new Map();
const topicCache = new Map();

async function withLock(key, fn) {
  const k = String(key || '');
  const prev = topicLocks.get(k) || Promise.resolve();
  let release;
  const cur = new Promise(r => { release = r; });
  topicLocks.set(k, prev.then(() => cur, () => cur));
  try {
    await prev.catch(() => {});
    return await fn();
  } finally {
    release();
    setTimeout(() => { if (topicLocks.get(k) === cur) topicLocks.delete(k); }, 30000).unref?.();
  }
}

export async function leagueChatId() {
  return LEAGUE_CHAT_ID || await getSetting('league_chat_id') || await getAdminChatId();
}

// Один топик на дивизион: id хранится в Settings основной таблицы, в памяти — кэш,
// параллельные публикации разводит замок (иначе два топика на один дивизион).
export async function getOrCreateDivisionTopic(division) {
  const chatId = await leagueChatId();
  if (!chatId) return null;
  const key = String(division || '').trim();
  if (!key) return { chatId };

  const cached = topicCache.get(key);
  if (cached) return { chatId, message_thread_id: Number(cached), division: key };

  return withLock(`div:${key}`, async () => {
    const again = topicCache.get(key);
    if (again) return { chatId, message_thread_id: Number(again), division: key };
    const settingKey = `division_topic_${key}`;
    const saved = await getSetting(settingKey).catch(() => '');
    if (saved) {
      topicCache.set(key, saved);
      return { chatId, message_thread_id: Number(saved), division: key };
    }
    try {
      const topic = await createForumTopic(chatId, `🎾 ${key}`.slice(0, 120));
      const threadId = topic?.message_thread_id;
      if (threadId) {
        topicCache.set(key, String(threadId));
        await setSetting(settingKey, String(threadId), `Топик дивизиона ${key} для окон матчей`).catch(() => {});
        return { chatId, message_thread_id: threadId, division: key };
      }
    } catch (e) {
      console.error('createForumTopic (division) failed:', e.message);
    }
    return { chatId, division: key };
  });
}

export function forgetDivisionTopic(division) { topicCache.delete(String(division || '')); }

function isTopicGoneError(e) {
  const d = String(e?.telegram?.description || e?.message || '').toLowerCase();
  return d.includes('thread not found') || d.includes('topic_deleted') || d.includes('topic_closed') || d.includes('topic closed') || d.includes('message thread not found');
}

function playerLink(name, username) {
  const safeName = escapeHtml(name || 'Игрок');
  return username ? `<a href="https://t.me/${escapeHtml(String(username).replace(/^@/, ''))}">${safeName}</a>` : `<b>${safeName}</b>`;
}

const DAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export function formatDate(iso) {
  const d = new Date(`${iso}T00:00:00+07:00`);
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
  const dur = slot.duration_min ? ` · ${Number(slot.duration_min) / 60} ч` : '';
  const courts = courtsLine(slot);
  return `📅 <b>${escapeHtml(datesLine(slot))}</b>\n🕐 <b>${time}</b>${dur}${courts ? `\n📍 ${escapeHtml(courts)}` : ''}`;
}
function agreedBlock(slot) {
  const time = slot.agreed_time || slot.time_from || '';
  return `📅 <b>${escapeHtml(formatDate(slot.agreed_date))}</b>\n🕐 <b>${escapeHtml(time)}</b>${slot.agreed_court ? `\n📍 ${escapeHtml(slot.agreed_court)}` : ''}`;
}

export function openSlotText(slot) {
  const multi = cellToList(slot.dates).length > 1 || cellToList(slot.courts).length > 1;
  return `<b>🎾 Ищу соперника на матч</b>

👤 ${playerLink(slot.from_name, slot.from_username)}${slot.division ? ` · ${escapeHtml(slot.division)}` : ''}
${offerBlock(slot)}${slot.comment ? `\n\n💬 ${escapeHtml(slot.comment)}` : ''}

${multi ? 'Нажми «Играю» и выбери удобные дату и корт из предложенных.' : 'Нажми «Играю», и я свяжу вас напрямую.'}`;
}

export function takenSlotText(slot) {
  return `<b>✅ Матч назначен</b>

${playerLink(slot.from_name, slot.from_username)} — ${playerLink(slot.to_name, slot.to_username)}${slot.division ? `\n🏆 ${escapeHtml(slot.division)}` : ''}
${agreedBlock(slot)}

Окно закрыто.`;
}

// В чате дивизиона кнопка ведёт в мини-приложение: там соперник выбирает дату и корт.
// Telegram не умеет web_app-кнопки в группах, поэтому используем прямую ссылку на бота
// с параметром — бот откроет нужный экран.
function takeKeyboard(slot, botUsername) {
  const url = botUsername
    ? `https://t.me/${botUsername}?start=match_${slot.challenge_id}`
    : `${PUBLIC_URL}/match?slot=${encodeURIComponent(slot.challenge_id)}`;
  return { inline_keyboard: [[{ text: '🎾 Играю', url }]] };
}

let cachedBotUsername = '';
export function setBotUsername(u) { cachedBotUsername = String(u || '').replace(/^@/, ''); }

export async function publishOpenSlot(slot) {
  const topic = await getOrCreateDivisionTopic(slot.division);
  if (!topic?.chatId) return null;
  const text = openSlotText(slot);
  const opts = { reply_markup: takeKeyboard(slot, cachedBotUsername) };
  const send = (tp) => sendMessage(tp.chatId, text, tp.message_thread_id ? { ...opts, message_thread_id: tp.message_thread_id } : opts);

  let sent = null;
  try {
    sent = await send(topic);
  } catch (e) {
    console.error('publishOpenSlot failed:', e.message);
    if (isTopicGoneError(e) && topic.message_thread_id) {
      forgetDivisionTopic(slot.division);
      await setSetting(`division_topic_${slot.division}`, '', 'сброшен: топик удалён').catch(() => {});
      const fresh = await getOrCreateDivisionTopic(slot.division).catch(() => null);
      if (fresh?.message_thread_id) { try { sent = await send(fresh); } catch (e2) { console.error('publishOpenSlot retry failed:', e2.message); } }
    }
    if (!sent) { try { sent = await send({ chatId: topic.chatId }); } catch (e3) { console.error('publishOpenSlot general failed:', e3.message); } }
  }
  if (sent?.message_id) {
    await updateSlot(slot.challenge_id, {
      chat_id: String(sent.chat?.id || topic.chatId),
      message_thread_id: String(sent.message_thread_id || topic.message_thread_id || ''),
      message_id: String(sent.message_id)
    }).catch(e => console.error('save slot message ref failed:', e.message));
  }
  return sent;
}

async function closeSlotCard(slot) {
  if (!slot.chat_id || !slot.message_id) return;
  try {
    await editMessageText(slot.chat_id, Number(slot.message_id), takenSlotText(slot), { reply_markup: { inline_keyboard: [] } });
  } catch (e) { console.error('closeSlotCard failed:', e.message); }
}

function contactsKeyboard(username, profileUrl) {
  const rows = [];
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

Договоритесь о точном времени и корте напрямую. После игры передайте счёт организатору.`;

  await sendMessage(slot.from_telegram_id, card(slot.to_name, slot.to_username), { reply_markup: contactsKeyboard(slot.to_username, toUrl) }).catch(e => console.error('notify author failed:', e.message));
  await sendMessage(slot.to_telegram_id, card(slot.from_name, slot.from_username), { reply_markup: contactsKeyboard(slot.from_username, fromUrl) }).catch(e => console.error('notify taker failed:', e.message));

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
  if (slot.chat_id && slot.message_id) {
    try {
      await editMessageText(slot.chat_id, Number(slot.message_id),
        `<b>🚫 Окно снято автором</b>\n\n${escapeHtml(slot.from_name)}${slot.division ? ` · ${escapeHtml(slot.division)}` : ''}\n${offerBlock(slot)}`,
        { reply_markup: { inline_keyboard: [] } });
    } catch (e) { console.error('cancel slot card failed:', e.message); }
  }
}

export { findSlot };
