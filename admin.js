import { sendMessage, sendPhoto, sendDocument, sendVideo, sendVoice, sendAudio, sendVideoNote, sendSticker, copyMessage, sendPoll, createForumTopic, getChat, getWebhookInfo, getMe } from './telegram.js';
import { getSetting, setSetting, getRows, getSegmentContacts, getMissingRatingContacts, logBroadcast, logBroadcastResult, findApplication, findLatestApplicationByTelegramId, logPayment, updateApplication, updateApplicantStatusByTelegramId, updatePayment, findApplicantByTelegramId, updateApplicantByTelegramId, findApplicantByTelegramIdentity, upsertPollResult, findPollResultsByBroadcastId, summarizePollRows, updateApplicantAdminTopic, ensureApplicantAdminColumns, ensureApplicantLead } from './sheets.js';
import { SHEETS, ADMIN_IDS, CLUB_CHAT_URL, PUBLIC_URL } from './config.js';
import { nowISO, escapeHtml, uid } from './util.js';
import { t } from './i18n.js';
import { adminApplicationKeyboard, adminPaymentKeyboard, clubKeyboard, welcomeKeyboard } from './keyboards.js';
import { parseTemplate, renderText, renderButtons, destinationLabel, getBotUsername, linksCheatSheet } from './links.js';

export const adminState = new Map();
const topicLocks = new Map();
const recentlyNotifiedApplications = new Map();

async function withTopicLock(telegramId, fn) {
  const key = String(telegramId || '');
  if (!key) return fn();
  const previous = topicLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  topicLocks.set(key, previous.then(() => current, () => current));
  try {
    await previous.catch(() => {});
    return await fn();
  } finally {
    release();
    // The next waiter, if any, will continue after release. Remove stale lock later.
    setTimeout(() => { if (topicLocks.get(key) === current) topicLocks.delete(key); }, 30000).unref?.();
  }
}

function rememberApplicationNotification(applicationId) {
  const id = String(applicationId || '').trim();
  if (!id) return false;
  const now = Date.now();
  for (const [key, ts] of recentlyNotifiedApplications.entries()) {
    if (now - ts > 10 * 60 * 1000) recentlyNotifiedApplications.delete(key);
  }
  if (recentlyNotifiedApplications.has(id)) return true;
  recentlyNotifiedApplications.set(id, now);
  return false;
}

export function isAdminUser(userId) {
  if (!ADMIN_IDS.length) return false; // admin panel is closed until ADMIN_IDS is configured.
  return ADMIN_IDS.includes(String(userId));
}

export async function getAdminChatId() {
  return await getSetting('admin_chat_id');
}

function playerTopicName(profileOrFrom={}) {
  const name = String(profileOrFrom.name || [profileOrFrom.first_name, profileOrFrom.last_name].filter(Boolean).join(' ') || 'Player').trim();
  const username = String(profileOrFrom.telegram_username || profileOrFrom.username || '').replace(/^@/, '');
  const id = String(profileOrFrom.telegram_id || profileOrFrom.id || '').trim();
  const base = `${name}${username ? ' @' + username : id ? ' ' + id : ''}`.trim();
  return base.slice(0, 120) || `Player ${id}`;
}

// telegram_id -> { threadId, topicName }. Saves a Sheets round-trip on every message and
// protects against a second topic being created while the sheet write is still in flight.
// Ключ кэша — telegram_id + чат: при смене админской группы старые треды не подхватываются.
const topicCache = new Map();
const cacheKey = (telegramId, chatId) => `${chatId}:${telegramId}`;
export function forgetPlayerTopic(telegramId, chatId='') {
  const id = String(telegramId || '');
  if (chatId) { topicCache.delete(cacheKey(id, chatId)); return; }
  for (const k of [...topicCache.keys()]) if (k.endsWith(`:${id}`)) topicCache.delete(k);
}

export async function getOrCreatePlayerTopic(player={}) {
  const chatId = await getAdminChatId();
  if (!chatId) return null;
  const telegramId = player.telegram_id || player.id;
  if (!telegramId) return null;
  const key = cacheKey(telegramId, chatId);

  const cached = topicCache.get(key);
  if (cached?.threadId) return { chatId, message_thread_id: Number(cached.threadId), topicName: cached.topicName, existing:true };

  return withTopicLock(telegramId, async () => {
    const again = topicCache.get(key);
    if (again?.threadId) return { chatId, message_thread_id: Number(again.threadId), topicName: again.topicName, existing:true };

    // One Applicants row per telegram_id is the source of truth for the topic id.
    let freshProfile = await findApplicantByTelegramId(telegramId).catch(() => null);
    if (!freshProfile && (player.username || player.telegram_username)) {
      freshProfile = await findApplicantByTelegramIdentity({ id: telegramId, username: player.username || player.telegram_username }).catch(() => null);
    }
    if (!freshProfile) {
      freshProfile = await ensureApplicantLead({ ...player, id: telegramId }).catch(e => { console.error('ensureApplicantLead failed:', e.message); return null; });
    }
    const currentTopicId = String(freshProfile?.admin_topic_id || player.admin_topic_id || '').trim();
    // Сохранённый чат темы: пусто — наследие старой версии, тему принимаем и проставляем
    // текущий чат (иначе разовая правка кода пересоздала бы все темы разом).
    // Заполнено и не совпадает — тема из другой группы, её номер здесь чужой.
    const savedChat = String(freshProfile?.admin_topic_chat_id || '').trim();
    const sameChat = !savedChat || savedChat === String(chatId);
    if (currentTopicId && sameChat) {
      const topicName = freshProfile?.admin_topic_name || playerTopicName(freshProfile || player);
      topicCache.set(key, { threadId: currentTopicId, topicName });
      if (!savedChat) {
        await updateApplicantAdminTopic(telegramId, { admin_topic_chat_id:String(chatId) }, player)
          .catch(e => console.error('backfill admin_topic_chat_id failed:', e.message));
      }
      return { chatId, message_thread_id: Number(currentTopicId), topicName, existing:true };
    }
    if (currentTopicId && !sameChat) {
      console.warn(`topic ${currentTopicId} for ${telegramId} belongs to chat ${savedChat}, current is ${chatId} — creating a new one`);
    }

    const topicName = playerTopicName(freshProfile || player);
    try {
      const topic = await createForumTopic(chatId, topicName);
      const threadId = topic?.message_thread_id;
      if (threadId) {
        topicCache.set(key, { threadId: String(threadId), topicName });
        await updateApplicantAdminTopic(telegramId, {
          admin_topic_id:String(threadId),
          admin_topic_name:topicName,
          admin_topic_chat_id:String(chatId),
          admin_topic_created_at:nowISO(),
          admin_topic_last_used_at:nowISO()
        }, player).catch(e => console.error('save admin_topic_id failed:', e.message));
        return { chatId, message_thread_id: threadId, topicName, existing:false };
      }
    } catch (e) {
      console.error('createForumTopic failed; falling back to General:', e.message);
    }
    return { chatId, topicName, existing:false };
  });
}

// Отметка «тема живая». Пишем не чаще раза в час на игрока: иначе каждое сообщение
// стоило бы записи в таблицу.
const lastUsedWrites = new Map();
const LAST_USED_THROTTLE_MS = 60 * 60 * 1000;
function markTopicUsed(telegramId) {
  const id = String(telegramId || '');
  if (!id) return;
  const prev = lastUsedWrites.get(id) || 0;
  if (Date.now() - prev < LAST_USED_THROTTLE_MS) return;
  lastUsedWrites.set(id, Date.now());
  updateApplicantAdminTopic(id, { admin_topic_last_used_at: nowISO() })
    .catch(e => console.error('mark topic used failed:', e.message));
}

// Recreate a topic only when Telegram says the thread itself is gone/closed.
// Any other failure (rate limit, HTML parse error, network) must NOT spawn a new topic.
function isTopicGoneError(e) {
  // Только ответ самого Telegram считается приговором теме. Сетевой сбой, таймаут
  // или ошибка нашего кода не должны приводить к пересозданию: так игрок терял
  // историю переписки на ровном месте.
  const tg = e?.telegram;
  if (!tg || tg.ok !== false) return false;
  // 429 и 5xx — заведомо временные, даже если в тексте мелькнёт знакомое слово.
  const code = Number(tg.error_code || 0);
  if (code === 429 || (code >= 500 && code < 600)) return false;
  const desc = String(tg.description || '').toLowerCase();
  return desc.includes('message thread not found')
    || desc.includes('thread not found')
    || desc.includes('topic_deleted')
    || desc.includes('topic deleted')
    || desc.includes('topic_closed')
    || desc.includes('topic closed');
}

function withTopicOpts(topic, opts={}) {
  if (topic?.message_thread_id) return { ...opts, message_thread_id: topic.message_thread_id };
  return opts;
}

export async function notifyAdmin(text, opts={}) {
  const chatId = await getAdminChatId();
  if (!chatId) return null;
  return sendMessage(chatId, text, opts);
}

// ------------------------------------------------------------------ аватарки
// Утверждение организатором убрано намеренно: игрок сам смотрит свои варианты
// и выбирает. Кнопки уходят прямо под картинкой в его чате.
export async function notifyAvatarVariant({ telegramId, index, left, stub }) {
  const rows = [[{ text: '✅ Выбрать этот', callback_data: `avpick:${index}` }]];
  if (left > 0) rows.push([{ text: `🔄 Ещё вариант (${left})`, callback_data: 'avmore' }]);
  return sendMessage(telegramId, stub
    ? 'Выбери вариант или сгенерируй ещё.'
    : 'Выбери вариант или сгенерируй ещё — все сохранены.', { reply_markup: { inline_keyboard: rows } })
    .catch(e => { console.error('notifyAvatarVariant failed:', e.message); return null; });
}

// Игрок выбрал вариант — публикуем сразу, без чьего-либо подтверждения.
export async function pickAvatarVariant(telegramId, index) {
  const { optionList } = await import('./avatars.js');
  const profile = await findApplicantByTelegramId(telegramId).catch(() => null);
  const list = optionList(profile?.avatar_options);
  const fileId = list[Number(index) - 1];
  if (!fileId) return { ok: false, error: 'Вариант не найден' };
  await updateApplicantByTelegramId(telegramId, {
    avatar_file_id: fileId, avatar_status: 'published', avatar_updated_at: nowISO()
  });
  return { ok: true, fileId, index: Number(index) };
}

// Показать сохранённые варианты заново — по команде /avatar.
export async function showAvatarGallery(chatId, telegramId) {
  const { optionList, MAX_ATTEMPTS } = await import('./avatars.js');
  const profile = await findApplicantByTelegramId(telegramId).catch(() => null);
  const list = optionList(profile?.avatar_options);
  // Ни одного варианта — значит человек здесь впервые. Даём кнопку прямо на
  // экран загрузки, а не отправляем его искать раздел руками.
  if (!list.length) {
    return sendMessage(chatId,
      '🖼 <b>Аватарка PTF</b>\n\nЗагрузи одно селфи — сделаю до трёх вариантов, выберешь любой.\n\nЛицо крупно, дневной свет, без кепки и тёмных очков, один человек в кадре.',
      { reply_markup: { inline_keyboard: [[{ text: '📸 Загрузить селфи', web_app: { url: `${PUBLIC_URL}/league?player=me` } }]] } });
  }
  const chosen = String(profile?.avatar_file_id || '');
  for (let i = 0; i < list.length; i++) {
    const mark = list[i] === chosen ? ' · выбран сейчас' : '';
    await sendPhoto(chatId, list[i], {
      caption: `Вариант ${i + 1} из ${list.length}${mark}`,
      reply_markup: { inline_keyboard: [[{ text: '✅ Выбрать этот', callback_data: `avpick:${i + 1}` }]] }
    }).catch(e => console.error('gallery photo failed:', e.message));
  }
  const left = Math.max(0, MAX_ATTEMPTS - Number(profile?.avatar_attempts || 0));
  if (left > 0) {
    return sendMessage(chatId, `Можно сгенерировать ещё: осталось ${left}.`,
      { reply_markup: { inline_keyboard: [[{ text: `🔄 Ещё вариант (${left})`, callback_data: 'avmore' }]] } });
  }
  return sendMessage(chatId, 'Попытки генерации закончились — выбери из того, что есть.');
}

// Служебное уведомление о конкретном игроке — тоже в его тему.
export async function notifyAboutPlayer(telegramId, text, opts={}) {
  const chatId = await getAdminChatId();
  if (!chatId) return null;
  return replyInPlayerTopic(chatId, telegramId, text, opts);
}

export async function handleAdminInit(msg) {
  await setSetting('admin_chat_id', String(msg.chat.id), 'Telegram group chat for PTF Admin Inbox');
  await sendMessage(msg.chat.id, `✅ Admin inbox connected.\n\nchat_id: <code>${msg.chat.id}</code>`);
}

export async function adminStats(chatId) {
  const applicants = (await getRows(SHEETS.applicants, { useCache:false })).rows;
  const apps = (await getRows(SHEETS.applications, { useCache:false })).rows;
  const payments = (await getRows(SHEETS.payments, { useCache:false })).rows;
  const active = applicants.filter(r => r.status === 'active').length;
  const waitlist = applicants.filter(r => r.status === 'waitlist').length;
  const norm = v => String(v || '').trim().toLowerCase();
  const unpaid = apps.filter(r => ['payment_required','waiting_payment'].includes(norm(r.payment_status))).length;
  const proof = apps.filter(r => norm(r.payment_status) === 'proof_received' || norm(r.payment_proof_status) === 'proof_received').length;
  const approved = apps.filter(r => norm(r.payment_status) === 'approved').length;
  const rejected = apps.filter(r => norm(r.payment_status) === 'rejected').length;
  const approvedPayments = payments.filter(p => norm(p.status) === 'approved');
  const paidThb = approvedPayments.filter(p => norm(p.currency) === 'thb').reduce((sum,p) => sum + Number(p.amount || 0), 0);
  const paidUsdt = approvedPayments.filter(p => norm(p.currency) === 'usdt').reduce((sum,p) => sum + Number(p.amount || 0), 0);
  await sendMessage(chatId, `<b>PTF Stats</b>

Contacts: <b>${applicants.length}</b>
Applications: <b>${apps.length}</b>
Active: <b>${active}</b>
Waitlist: <b>${waitlist}</b>

<b>Payments</b>
Unpaid / waiting: <b>${unpaid}</b>
Proofs waiting review: <b>${proof}</b>
Approved: <b>${approved}</b>
Rejected: <b>${rejected}</b>
Paid THB: <b>${paidThb}</b>
Paid USDT: <b>${paidUsdt}</b>
Payment rows: <b>${payments.length}</b>`);
}


export async function adminEvents(chatId) {
  const rows = (await getRows(SHEETS.events, { useCache:false })).rows;
  const text = rows.map(r => `• <b>${escapeHtml(r.event_name_en || r.event_id)}</b> — ${escapeHtml(r.status)} — ${escapeHtml(r.price_thb)} ${escapeHtml(r.currency)}`).join('\n') || 'No events';
  await sendMessage(chatId, `<b>Events</b>\n\n${text}`);
}

export async function adminPending(chatId) {
  const rows = (await getRows(SHEETS.applications, { useCache:false })).rows
    .filter(r => ['submitted','waiting_payment','proof_received','payment_approved','waitlist'].includes(r.application_status))
    .slice(-20).reverse();
  if (!rows.length) return sendMessage(chatId, 'No pending applications.');
  for (const r of rows) {
    await sendMessage(chatId, `<b>Application</b>\nID: <code>${escapeHtml(r.application_id)}</code>\nTGID: <code>${escapeHtml(r.telegram_id)}</code>\nPlayer: <b>${escapeHtml(r.player_name)}</b> ${r.telegram_username ? '@'+escapeHtml(r.telegram_username) : ''}\nEvent: ${escapeHtml(r.event_name)}\nStatus: <b>${escapeHtml(r.application_status)}</b>\nPayment: ${escapeHtml(r.payment_status || '')}`, {
      reply_markup: adminApplicationKeyboard(r.application_id, r.telegram_id)
    });
  }
}

export async function adminMessages(chatId) {
  const rows = (await getRows(SHEETS.messages, { useCache:false })).rows
    .filter(r => r.direction === 'incoming' && r.status !== 'closed')
    .slice(-20).reverse();
  if (!rows.length) return sendMessage(chatId, 'No open incoming messages.');
  for (const r of rows) {
    await sendMessage(chatId, `<b>Incoming message</b>\nTGID: <code>${escapeHtml(r.telegram_id)}</code>\nFrom: <b>${escapeHtml(r.name)}</b> ${r.telegram_username ? '@'+escapeHtml(r.telegram_username) : ''}\n\n${escapeHtml(r.message_text)}`, {
      reply_markup: { inline_keyboard: [[{ text: '💬 Reply', callback_data: `admin_reply:${r.telegram_id}` }]] }
    });
  }
}

export async function adminProfile(chatId, query) {
  const q = String(query || '').replace('/profile', '').trim().replace(/^@/, '');
  if (!q) return sendMessage(chatId, 'Usage: /profile @username or /profile telegram_id');
  const rows = (await getRows(SHEETS.applicants, { useCache:false })).rows;
  const r = rows.find(x => String(x.telegram_id) === q || String(x.telegram_username || '').replace(/^@/, '').toLowerCase() === q.toLowerCase() || String(x.name || '').toLowerCase().includes(q.toLowerCase()));
  if (!r) return sendMessage(chatId, 'Profile not found.');
  await sendMessage(chatId, `<b>Player profile</b>\n\nName: <b>${escapeHtml(r.name)}</b>\nTGID: <code>${escapeHtml(r.telegram_id)}</code>\nUsername: ${r.telegram_username ? '@'+escapeHtml(r.telegram_username) : '-'}\nStatus: <b>${escapeHtml(r.status)}</b>\nDivision: ${escapeHtml(r.division)}\nNTRP: ${escapeHtml(r.ntrp)}\nExperience: ${escapeHtml(r.experience)}\nCountry: ${escapeHtml(r.country_of_origin)}\nWhatsApp: ${escapeHtml(r.whatsapp)}\nLast event: ${escapeHtml(r.last_application_event)}\nNotes: ${escapeHtml(r.notes)}`);
}

export async function notifyNewApplication(app, profile) {
  if (rememberApplicationNotification(app?.application_id)) return null;
  const topic = await getOrCreatePlayerTopic({ ...profile, telegram_id: app.telegram_id });
  const chatId = topic?.chatId || await getAdminChatId();
  if (!chatId) return null;
  await sendMessage(chatId, `<b>🎾 New application</b>

Application: <code>${escapeHtml(app.application_id)}</code>
TGID: <code>${escapeHtml(app.telegram_id)}</code>
Player: <b>${escapeHtml(profile.name)}</b> ${profile.telegram_username ? '@'+escapeHtml(profile.telegram_username) : ''}
Event: <b>${escapeHtml(app.event_name)}</b>
Status: <b>${escapeHtml(app.application_status)}</b>

NTRP: ${escapeHtml(profile.ntrp)}
Experience: ${escapeHtml(profile.experience)}
Gender: ${escapeHtml(profile.gender)}
Age: ${escapeHtml(profile.age)}
Country: ${escapeHtml(profile.country_of_origin)}
WhatsApp: ${escapeHtml(profile.whatsapp)}
Notes: ${escapeHtml(profile.notes)}`, withTopicOpts(topic, {
    reply_markup: adminApplicationKeyboard(app.application_id, app.telegram_id)
  }));
}

async function resetPlayerTopic(telegramId) {
  if (!telegramId) return null;
  forgetPlayerTopic(telegramId);
  await updateApplicantAdminTopic(telegramId, { admin_topic_id:'', admin_topic_name:'', admin_topic_chat_id:'', admin_topic_created_at:'' }).catch(() => {});
}

async function getFreshPlayerTopic(from, oldTopic=null, error=null) {
  if (!oldTopic?.message_thread_id) return oldTopic;
  if (error && !isTopicGoneError(error)) return oldTopic; // transient error: keep the existing topic
  await resetPlayerTopic(from.id || from.telegram_id);
  return getOrCreatePlayerTopic(from).catch(() => oldTopic);
}

async function sendMessageToTopicOrGeneral({ chatId, topic, text, opts={}, from, fallbackTitle='Admin inbox fallback' }) {
  try {
    const res = await sendMessage(chatId, text, withTopicOpts(topic, opts));
    return { sent:true, topic, usedTopic: !!topic?.message_thread_id, result:res };
  } catch (e) {
    console.error(`${fallbackTitle}: send to topic failed:`, e.message);
    let freshTopic = null;
    if (topic?.message_thread_id) {
      freshTopic = await getFreshPlayerTopic(from, topic, e).catch(() => null);
      if (freshTopic?.message_thread_id && String(freshTopic.message_thread_id) !== String(topic.message_thread_id)) {
        try {
          const res = await sendMessage(chatId, text, withTopicOpts(freshTopic, opts));
          return { sent:true, topic:freshTopic, usedTopic:true, result:res };
        } catch (e2) {
          console.error(`${fallbackTitle}: send to fresh topic failed:`, e2.message);
        }
      }
    }
    const label = `<b>⚠️ ${escapeHtml(fallbackTitle)}</b>\n\nThis message could not be delivered to the player's topic, so it is shown in General.\n\n${text}`;
    const res = await sendMessage(chatId, label, opts);
    return { sent:true, topic:null, usedTopic:false, result:res };
  }
}

function paymentProofFile(originalMessage={}) {
  if (originalMessage.photo?.length) return { type:'photo', fileId: originalMessage.photo[originalMessage.photo.length - 1].file_id };
  if (originalMessage.document) return { type:'document', fileId: originalMessage.document.file_id };
  if (originalMessage.video) return { type:'video', fileId: originalMessage.video.file_id };
  if (originalMessage.animation) return { type:'animation', fileId: originalMessage.animation.file_id };
  if (originalMessage.voice) return { type:'voice', fileId: originalMessage.voice.file_id };
  if (originalMessage.audio) return { type:'audio', fileId: originalMessage.audio.file_id };
  if (originalMessage.video_note) return { type:'video_note', fileId: originalMessage.video_note.file_id };
  if (originalMessage.sticker) return { type:'sticker', fileId: originalMessage.sticker.file_id };
  return null;
}
export function hasMedia(originalMessage={}) { return Boolean(paymentProofFile(originalMessage)); }

// Media types that accept a caption, so the header text + buttons travel with the file in ONE message.
const CAPTIONABLE = new Set(['photo','document','video','animation','voice','audio']);

async function sendByFileId(chatId, proof, opts={}) {
  if (proof.type === 'photo') return sendPhoto(chatId, proof.fileId, opts);
  if (proof.type === 'document') return sendDocument(chatId, proof.fileId, opts);
  if (proof.type === 'video' || proof.type === 'animation') return sendVideo(chatId, proof.fileId, opts);
  if (proof.type === 'voice') return sendVoice(chatId, proof.fileId, opts);
  if (proof.type === 'audio') return sendAudio(chatId, proof.fileId, opts);
  if (proof.type === 'video_note') return sendVideoNote(chatId, proof.fileId, opts);
  if (proof.type === 'sticker') return sendSticker(chatId, proof.fileId, opts);
  throw new Error(`unsupported media type ${proof.type}`);
}

// Delivers a player's media message into the player's admin topic.
// Order of attempts, each into the given topic:
//   1) copyMessage (keeps original file, adds our caption + buttons)
//   2) send by file_id
// If Telegram reports the topic is gone, the topic is recreated once and both attempts repeat.
// If everything fails inside the topic, the same attempts run into General.
// Returns { delivered, topic, captioned } — `captioned` = header text already attached to the media.
async function deliverMediaToTopic({ chatId, topic, from, originalMessage, caption='', replyMarkup={} }) {
  const proof = paymentProofFile(originalMessage || {});
  if (!proof) return { delivered:false, topic, captioned:false };
  const captioned = Boolean(caption) && CAPTIONABLE.has(proof.type);
  const mediaOpts = captioned ? { caption, parse_mode:'HTML', ...replyMarkup } : { ...(CAPTIONABLE.has(proof.type) ? {} : replyMarkup) };

  const attempt = async (tp) => {
    const opts = withTopicOpts(tp, mediaOpts);
    if (originalMessage?.chat?.id && originalMessage?.message_id) {
      try {
        await copyMessage(chatId, originalMessage.chat.id, originalMessage.message_id, opts);
        return true;
      } catch (e) {
        if (isTopicGoneError(e)) throw e;
        console.error('deliverMediaToTopic: copyMessage failed, trying file_id:', e.message);
      }
    }
    await sendByFileId(chatId, proof, opts);
    return true;
  };

  let currentTopic = topic;
  let delivered = false;
  try {
    delivered = await attempt(currentTopic);
  } catch (e) {
    console.error('deliverMediaToTopic: topic delivery failed:', e.message);
    if (isTopicGoneError(e) && currentTopic?.message_thread_id) {
      const fresh = await getFreshPlayerTopic(from, currentTopic, e).catch(() => null);
      if (fresh?.message_thread_id && String(fresh.message_thread_id) !== String(currentTopic.message_thread_id)) {
        currentTopic = fresh;
        try { delivered = await attempt(currentTopic); } catch (e2) { console.error('deliverMediaToTopic: fresh topic delivery failed:', e2.message); }
      }
    }
  }
  if (!delivered && currentTopic?.message_thread_id) {
    try {
      const general = withTopicOpts(null, mediaOpts);
      if (originalMessage?.chat?.id && originalMessage?.message_id) {
        try { await copyMessage(chatId, originalMessage.chat.id, originalMessage.message_id, general); delivered = true; }
        catch (e) { console.error('deliverMediaToTopic: copy to General failed:', e.message); }
      }
      if (!delivered) { await sendByFileId(chatId, proof, general); delivered = true; }
      currentTopic = null;
    } catch (e) {
      console.error('deliverMediaToTopic: General delivery failed:', e.message);
    }
  }
  return { delivered, topic: currentTopic, captioned };
}

async function deliverPlayerMessage(args) {
  const res = await deliverPlayerMessageInner(args);
  if (res?.usedTopic) markTopicUsed(args?.from?.telegram_id || args?.from?.id);
  return res;
}

async function deliverPlayerMessageInner({ chatId, topic, from, originalMessage, text, replyMarkup={}, fallbackTitle='Player message' }) {
  // Text-only or media-with-caption goes as ONE message when possible; otherwise header first, media second.
  const media = hasMedia(originalMessage || {});
  if (!media) {
    const sent = await sendMessageToTopicOrGeneral({ chatId, topic, text, opts: replyMarkup, from, fallbackTitle });
    return { delivered:true, topic: sent.topic, usedTopic: sent.usedTopic };
  }
  const proof = paymentProofFile(originalMessage);
  if (CAPTIONABLE.has(proof.type) && text.length <= 1000) {
    const res = await deliverMediaToTopic({ chatId, topic, from, originalMessage, caption:text, replyMarkup });
    if (res.delivered) return { delivered:true, topic:res.topic, usedTopic: !!res.topic?.message_thread_id };
    const sent = await sendMessageToTopicOrGeneral({ chatId, topic, text: `${text}\n\n⚠️ Media could not be copied. Please ask the player to resend it.`, opts: replyMarkup, from, fallbackTitle });
    return { delivered:false, topic: sent.topic, usedTopic: sent.usedTopic };
  }
  const sent = await sendMessageToTopicOrGeneral({ chatId, topic, text, opts: replyMarkup, from, fallbackTitle });
  const res = await deliverMediaToTopic({ chatId, topic: sent.topic, from, originalMessage, caption:'', replyMarkup:{} });
  if (!res.delivered) await sendMessage(chatId, '⚠️ Media could not be copied. Please ask the player to resend it.', withTopicOpts(sent.topic, {})).catch(() => {});
  return { delivered: res.delivered, topic: res.topic || sent.topic, usedTopic: !!(res.topic || sent.topic)?.message_thread_id };
}

function playerHeader(from) {
  return `TGID: <code>${escapeHtml(from.id)}</code>\nFrom: <b>${escapeHtml(from.name || '')}</b> ${from.username ? '@'+escapeHtml(from.username) : ''}`;
}

export async function notifyIncomingMessage(from, text, telegramMessageId, sourceChatId=null, originalMessage=null) {
  const topic = await getOrCreatePlayerTopic(from);
  const chatId = topic?.chatId || await getAdminChatId();
  if (!chatId) return null;
  const body = `<b>💬 New message from player</b>\n\n${playerHeader(from)}\n\n${escapeHtml(text && text !== '[media]' ? text : (hasMedia(originalMessage || {}) ? '' : '[media]'))}`.trimEnd();
  const replyMarkup = { reply_markup: { inline_keyboard: [[{ text: '💬 Reply', callback_data: `admin_reply:${from.id}` }]] } };
  return deliverPlayerMessage({ chatId, topic, from, originalMessage, text: body, replyMarkup, fallbackTitle:'Player message topic fallback' });
}

// Any media a player sends outside the payment flow (no open application, already active, etc.)
// still lands in the player's topic instead of being dropped.
export async function notifyPlayerMedia(from, originalMessage, note='') {
  const topic = await getOrCreatePlayerTopic(from);
  const chatId = topic?.chatId || await getAdminChatId();
  if (!chatId) return null;
  const caption = originalMessage?.caption ? `\n\n${escapeHtml(originalMessage.caption)}` : '';
  const body = `<b>📎 Media from player</b>\n\n${playerHeader(from)}${note ? `\n${escapeHtml(note)}` : ''}${caption}`;
  // Кнопка «привязать к оплате» — для случая, когда игрок прислал чек без нажатия
  // «оплатил» и открытой заявки бот не нашёл. Она подтянет последнюю заявку игрока.
  const replyMarkup = { reply_markup: { inline_keyboard: [
    [{ text: '💳 Привязать к оплате', callback_data: `admin_attach_pay:${from.id}` }],
    [{ text: '💬 Reply', callback_data: `admin_reply:${from.id}` }]
  ] } };
  return deliverPlayerMessage({ chatId, topic, from, originalMessage, text: body, replyMarkup, fallbackTitle:'Player media topic fallback' });
}

export async function notifyPaymentProof({ app, payment={}, from, originalMessage }) {
  const player = { ...from, id: from.id, telegram_id: app.telegram_id, name: app.player_name || from.name || '' };
  let topic = null;
  let chatId = null;
  try {
    topic = await getOrCreatePlayerTopic(player);
    chatId = topic?.chatId || await getAdminChatId();
  } catch (e) {
    console.error('get payment proof topic failed:', e.message);
    chatId = await getAdminChatId().catch(() => null);
  }
  if (!chatId) { console.error('notifyPaymentProof: admin_chat_id is not configured (/admin_init)'); return null; }

  const paymentId = payment.payment_id || app.payment_id || '';
  const caption = `<b>💳 Payment proof received</b>

Application: <code>${escapeHtml(app.application_id)}</code>
${paymentId ? `Payment: <code>${escapeHtml(paymentId)}</code>
` : ''}TGID: <code>${escapeHtml(from.id)}</code>
Player: <b>${escapeHtml(app.player_name)}</b> ${from.username ? '@'+escapeHtml(from.username) : ''}
Event: ${escapeHtml(app.event_name)}
Method: <b>${escapeHtml(payment.method || app.payment_method || '')}</b> ${escapeHtml(payment.network || app.payment_network || '')}
Amount: <b>${escapeHtml(payment.amount || app.payment_amount || '')} ${escapeHtml(payment.currency || app.payment_currency || '')}</b>`;
  const reviewMarkup = { reply_markup: adminPaymentKeyboard(app.application_id, paymentId, from.id) };

  const res = await deliverPlayerMessage({ chatId, topic, from: player, originalMessage, text: caption, replyMarkup: reviewMarkup, fallbackTitle:'Payment proof topic fallback' });
  if (!res.delivered) {
    const proof = paymentProofFile(originalMessage || {});
    await sendMessage(chatId, `<b>⚠️ Payment proof was received, but the bot could not copy the media file.</b>

Application: <code>${escapeHtml(app.application_id)}</code>
TGID: <code>${escapeHtml(from.id)}</code>
Player: <b>${escapeHtml(app.player_name)}</b> ${from.username ? '@'+escapeHtml(from.username) : ''}
${proof?.fileId ? `file_id: <code>${escapeHtml(proof.fileId)}</code>\n` : ''}
Please ask the player to resend the screenshot.`, withTopicOpts(res.topic, reviewMarkup)).catch(e => console.error('send proof failure notice failed:', e.message));
  }
  return res.delivered;
}

// Разовая сверка после ввода admin_topic_chat_id: у строк, где номер темы есть,
// а чат не записан, проставляем текущий admin_chat_id. Тем самым старые темы
// признаются своими и не пересоздаются. Ничего не удаляет.
export async function adminTopicSync(msg) {
  const chatId = await getAdminChatId();
  if (!chatId) return sendMessage(msg.chat.id, '⚠️ admin_chat_id не задан. Выполните /admin_init внутри админской супергруппы.');
  await ensureApplicantAdminColumns().catch(() => {});
  const { rows } = await getRows(SHEETS.applicants, { useCache:false });
  const pending = rows.filter(r => String(r.admin_topic_id || '').trim() && !String(r.admin_topic_chat_id || '').trim());
  if (!pending.length) {
    const withTopic = rows.filter(r => String(r.admin_topic_id || '').trim()).length;
    return sendMessage(msg.chat.id, `<b>Topic sync</b>\n\nВсе темы уже привязаны к чату.\nВсего тем: <b>${withTopic}</b>\nadmin_chat_id: <code>${escapeHtml(chatId)}</code>`, msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {});
  }
  let done = 0, failed = 0;
  for (const r of pending) {
    try {
      await updateApplicantAdminTopic(r.telegram_id, { admin_topic_chat_id: String(chatId) });
      done++;
    } catch (e) { failed++; console.error('topic sync failed for', r.telegram_id, e.message); }
    await new Promise(res => setTimeout(res, 60));
  }
  return sendMessage(msg.chat.id, `<b>Topic sync</b>\n\nПривязано тем: <b>${done}</b>\nОшибок: <b>${failed}</b>\nadmin_chat_id: <code>${escapeHtml(chatId)}</code>`, msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {});
}

// Admin diagnostic: verifies admin chat, forum mode and topic delivery for the admin's own topic.
// Самопроверка подключения таблицы матчей: видно ли переменную, доступна ли таблица
// сервисному аккаунту, какие листы в ней есть.
export async function adminMatchTest(msg) {
  const lines = [];
  const { MATCHES_SPREADSHEET_ID, MATCH_SHEETS } = await import('./config.js');
  lines.push(`MATCHES_SPREADSHEET_ID: <b>${MATCHES_SPREADSHEET_ID ? 'задан' : 'НЕ ЗАДАН ⚠️'}</b>`);
  if (!MATCHES_SPREADSHEET_ID) {
    lines.push('', 'Добавьте переменную в Railway и <b>сделайте редеплой</b> — без него процесс её не увидит.');
    return sendMessage(msg.chat.id, `<b>Проверка таблицы матчей</b>\n\n${lines.join('\n')}`);
  }
  lines.push(`id: <code>${escapeHtml(MATCHES_SPREADSHEET_ID)}</code>`);
  try {
    const { sheets } = await import('./google.js');
    const meta = await sheets().spreadsheets.get({ spreadsheetId: MATCHES_SPREADSHEET_ID });
    const titles = (meta.data.sheets || []).map(s => s.properties?.title).filter(Boolean);
    lines.push(`доступ: <b>есть ✅</b>`, `таблица: <b>${escapeHtml(meta.data.properties?.title || '')}</b>`);
    lines.push(`листы: ${titles.map(t => `<code>${escapeHtml(t)}</code>`).join(', ') || '(пусто)'}`);
    for (const need of [MATCH_SHEETS.slots, MATCH_SHEETS.log]) {
      lines.push(`${titles.includes(need) ? '✅' : '⏳'} ${escapeHtml(need)}${titles.includes(need) ? '' : ' — создастся при первой заявке'}`);
    }
  } catch (e) {
    lines.push(`доступ: <b>НЕТ ⚠️</b>`, `<code>${escapeHtml(e.message).slice(0, 300)}</code>`);
    lines.push('', 'Чаще всего это значит, что таблица не расшарена сервисному аккаунту как «Редактор».');
  }
  // Вторая причина, по которой раздел матчей может не открыться, — статус игрока.
  lines.push('', '<b>Ваш доступ к матчам</b>');
  try {
    const { getPlayerLeagueInfo } = await import('./sheets.js');
    const profile = await findApplicantByTelegramId(msg.from.id).catch(() => null);
    if (!profile) {
      lines.push('анкета: <b>не найдена ⚠️</b> — раздел матчей закрыт');
    } else {
      lines.push(`анкета: <b>${escapeHtml(profile.name || '(без имени)')}</b>`);
      const info = await getPlayerLeagueInfo({ ...profile, id: msg.from.id });
      if (!info.found) {
        lines.push(`в составе: <b>НЕТ ⚠️</b>${info.matched_by === 'name_conflict' ? ' (в таблице участников у этого имени указан другой telegram_id)' : ''}`);
        lines.push('Проверьте, что имя в анкете совпадает с именем в таблице участников.');
      } else {
        const active = String(info.status || '').toLowerCase() === 'active';
        lines.push(`в составе: <b>да</b> (привязка по ${escapeHtml(info.matched_by === 'telegram_id' ? 'telegram_id' : 'имени')})`);
        lines.push(`дивизион: <b>${escapeHtml(info.division || '— не указан ⚠️')}</b>`);
        lines.push(`статус: <b>${escapeHtml(info.status || '—')}</b>`);
        lines.push(active && info.division ? 'кнопка «Матчи» — <b>показывается ✅</b>' : 'кнопка «Матчи» — <b>скрыта</b>: нужен статус active и дивизион');
      }
    }
  } catch (e) { lines.push(`<code>${escapeHtml(e.message).slice(0, 200)}</code>`); }

  // Подтверждённый счёт зеркалится в таблицы лиги. Если их ID не заданы или нет
  // доступа — счёт останется только в таблице матчей, и в Match_Log ничего не появится.
  lines.push('', '<b>Таблицы лиги (куда пишется счёт)</b>');
  try {
    const { LEAGUE_RESULTS_SHEET_ID, LEAGUE_RESULTS_SHEETS, DIVISION_SPREADSHEETS } = await import('./config.js');
    const { sheets } = await import('./google.js');
    if (!LEAGUE_RESULTS_SHEET_ID) {
      lines.push('LEAGUE_RESULTS_SHEET_ID: <b>НЕ ЗАДАН ⚠️</b> — счёт никуда не зеркалится');
    } else {
      try {
        const meta = await sheets().spreadsheets.get({ spreadsheetId: LEAGUE_RESULTS_SHEET_ID });
        const titles = (meta.data.sheets || []).map(s => s.properties?.title).filter(Boolean);
        lines.push(`общая таблица: <b>${escapeHtml(meta.data.properties?.title || '')}</b> ✅`);
        for (const need of [LEAGUE_RESULTS_SHEETS.log, LEAGUE_RESULTS_SHEETS.master]) {
          lines.push(`${titles.includes(need) ? '✅' : '⚠️'} ${escapeHtml(need)}${titles.includes(need) ? '' : ' — листа нет'}`);
        }
      } catch (e) {
        lines.push(`общая таблица: <b>НЕТ ДОСТУПА ⚠️</b> — расшарьте её сервисному аккаунту`);
      }
    }
    for (const [letter, id] of Object.entries(DIVISION_SPREADSHEETS)) {
      if (!id) { lines.push(`Division ${letter}: <b>ID не задан</b>`); continue; }
      try {
        const meta = await sheets().spreadsheets.get({ spreadsheetId: id });
        const titles = (meta.data.sheets || []).map(s => s.properties?.title).filter(Boolean);
        lines.push(`Division ${letter}: ✅ ${titles.includes('Match_Log') ? 'Match_Log есть' : '<b>нет листа Match_Log ⚠️</b>'}`);
      } catch (e) { lines.push(`Division ${letter}: <b>нет доступа ⚠️</b>`); }
    }
    lines.push('', '<i>Счёт пишется в существующую строку пары в Match_Log. Если строки этой пары в расписании нет, писать некуда — это самая частая причина «результат не появился».</i>');
  } catch (e) { lines.push(`<code>${escapeHtml(e.message).slice(0, 200)}</code>`); }

  return sendMessage(msg.chat.id, `<b>Проверка таблицы матчей</b>\n\n${lines.join('\n')}`);
}

// Сводка по матчам: одним экраном видно, куда нужно вмешаться.
// Раньше это было размазано по топикам игроков — целиком картину никто не видел.
export async function adminMatchesOverview(msg) {
  let data;
  try {
    const { matchesOverview, slotStartMs } = await import('./matchesdb.js');
    data = { ...(await matchesOverview()), slotStartMs };
  } catch (e) {
    return sendMessage(msg.chat.id, `Не удалось прочитать матчи: <code>${escapeHtml(e.message).slice(0, 200)}</code>`);
  }
  const { formatDate } = await import('./matches.js');
  const when = (s) => `${formatDate(s.agreed_date)}${s.agreed_time ? ` ${s.agreed_time}` : ''}`;
  const pair = (s) => `${escapeHtml(s.from_name || '?')} — ${escapeHtml(s.to_name || '?')}`;
  const block = (title, rows, line) => {
    if (!rows.length) return '';
    const shown = rows.slice(0, 12).map(line).join('\n');
    const more = rows.length > 12 ? `\n<i>…и ещё ${rows.length - 12}</i>` : '';
    return `\n\n<b>${title}: ${rows.length}</b>\n${shown}${more}`;
  };

  let body = '<b>🎾 Матчи — сводка</b>';
  // Ближайшие показываем по дням: сплошной список из пятнадцати строк глазами
  // не разбирается, а расписание читают именно по дням.
  if (data.upcoming.length) {
    const byDay = new Map();
    for (const s of data.upcoming) {
      const key = s.agreed_date || '';
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(s);
    }
    body += `\n\n<b>Ближайшие: ${data.upcoming.length}</b>`;
    let shown = 0;
    for (const [date, list] of byDay) {
      if (shown >= 15) { body += `\n<i>…и ещё ${data.upcoming.length - shown}</i>`; break; }
      body += `\n\n<u>${escapeHtml(formatDate(date))}</u>`;
      for (const s of list) {
        if (shown >= 15) break;
        body += `\n• ${escapeHtml(s.agreed_time || '—')} · ${pair(s)}${s.agreed_court ? ` · ${escapeHtml(s.agreed_court)}` : ' · корт не выбран'}${s.court_confirmed_at ? ' ✅' : ' ⏳'}`;
        shown++;
      }
    }
  }
  body += block('Ждут подтверждения корта', data.awaitingCourt, s => `• ${when(s)} · ${pair(s)}`);
  body += block('Ждут ответа соперника', data.awaitingAnswer, s =>
    `• ${pair(s)}${s.division ? ` · ${escapeHtml(s.division)}` : ''}`);
  body += block('Сыграны, счёта нет', data.awaitingResult, s =>
    `• ${when(s)} · ${pair(s)} — ${s._stage === 'verify' ? 'ждёт подтверждения счёта' : 'счёт не внесён'}`);
  body += block('Открытые окна', data.openSlots, s =>
    `• ${escapeHtml(s.from_name || '?')}${s.division ? ` · ${escapeHtml(s.division)}` : ''} · ${escapeHtml(String(s.dates || '').slice(0, 40))}`);

  const total = data.upcoming.length + data.awaitingAnswer.length + data.awaitingResult.length + data.openSlots.length;
  if (!total) body += '\n\nСейчас ничего нет: ни назначенных матчей, ни открытых окон.';
  return sendMessage(msg.chat.id, body);
}

export async function adminTopicTest(msg) {
  // 1. Вебхук: если он указывает не на наш PUBLIC_URL, бот вообще не получает сообщения
  // от игроков (их забирает другой сервис) — при этом заявки из WebApp продолжают приходить,
  // потому что идут HTTP-запросом мимо Telegram. Это первое, что нужно исключать.
  const lines = [];
  try {
    const me = await getMe();
    const info = await getWebhookInfo();
    const expected = `${PUBLIC_URL}/webhook`;
    const match = String(info.url || '') === expected;
    lines.push(`bot: <b>@${escapeHtml(me.username || '')}</b>`);
    lines.push(`webhook: <code>${escapeHtml(info.url || '(не задан)')}</code>`);
    lines.push(`ожидается: <code>${escapeHtml(expected)}</code>`);
    lines.push(`совпадает: <b>${match ? 'да ✅' : 'НЕТ ⚠️ — сообщения игроков забирает другой сервис'}</b>`);
    if (info.pending_update_count) lines.push(`в очереди недоставлено: <b>${info.pending_update_count}</b>`);
    if (info.last_error_message) lines.push(`последняя ошибка Telegram: <code>${escapeHtml(info.last_error_message)}</code>${info.last_error_date ? ' (' + new Date(info.last_error_date * 1000).toISOString() + ')' : ''}`);
  } catch (e) { lines.push(`getWebhookInfo failed: <code>${escapeHtml(e.message)}</code>`); }
  lines.push('');

  const chatId = await getAdminChatId();
  if (!chatId) return sendMessage(msg.chat.id, `<b>Topic diagnostics</b>\n\n${lines.join('\n')}\n⚠️ admin_chat_id не задан. Выполните /admin_init внутри админской супергруппы.`);
  lines.push(`admin_chat_id: <code>${escapeHtml(chatId)}</code>`);
  try {
    const chat = await getChat(chatId);
    lines.push(`chat: <b>${escapeHtml(chat.title || '')}</b> (${escapeHtml(chat.type)})`, `is_forum: <b>${chat.is_forum ? 'yes' : 'NO — enable Topics in group settings'}</b>`);
  } catch (e) { lines.push(`getChat failed: <code>${escapeHtml(e.message)}</code>`); }
  const from = { id: msg.from.id, username: msg.from.username, name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') };
  try {
    const topic = await getOrCreatePlayerTopic(from);
    lines.push(`your topic: <b>${topic?.message_thread_id ? '#' + topic.message_thread_id + (topic.existing ? ' (existing)' : ' (created)') : 'NONE — bot needs admin rights with “Manage Topics”'}</b>`);
    const res = await deliverPlayerMessage({ chatId, topic, from, originalMessage: msg, text: `<b>🧪 Topic test</b>\n\n${playerHeader(from)}\n\nIf you see this inside your topic, delivery works.`, fallbackTitle:'Topic test' });
    lines.push(`delivery: <b>${res.usedTopic ? 'into topic ✅' : 'into General ⚠️'}</b>`);
    const { rows } = await getRows(SHEETS.applicants, { useCache:false });
    const withTopic = rows.filter(r => String(r.admin_topic_id || '').trim());
    const unbound = withTopic.filter(r => !String(r.admin_topic_chat_id || '').trim()).length;
    const foreign = withTopic.filter(r => { const c = String(r.admin_topic_chat_id || '').trim(); return c && c !== String(chatId); }).length;
    lines.push('', `тем всего: <b>${withTopic.length}</b>`,
      `без привязки к чату: <b>${unbound}</b>${unbound ? ' — выполните /topic_sync' : ' ✅'}`,
      `из другой группы: <b>${foreign}</b>${foreign ? ' — будут пересозданы при первом сообщении' : ' ✅'}`);
  } catch (e) { lines.push(`topic test failed: <code>${escapeHtml(e.message)}</code>`); }
  return sendMessage(msg.chat.id, `<b>Topic diagnostics</b>\n\n${lines.join('\n')}`);
}


export function ratingUpdateKeyboard(lang='en') {
  const url = `${PUBLIC_URL}/apply?mode=rating`;
  return { inline_keyboard: [[{ text: lang === 'ru' ? '🎾 Указать уровень' : '🎾 Set my level', web_app: { url } }]] };
}

// Одно письмо на две ситуации сразу: у кого рейтинга нет и у кого он есть, но
// получен старым тестом. Формулировка объясняет, почему просим пройти заново —
// иначе повторный тест выглядит как ошибка системы.
export function missingRatingMessage(lang='en') {
  return lang === 'ru'
    ? `<b>🎾 Уточняем уровень игроков перед сезоном</b>

В вашей анкете PTF либо не указан уровень, либо он проставлен по старой версии теста — она заметно завышала середину, и почти все получали 3.5.

Мы пересобрали тест: 11 коротких вопросов про стаж, соревновательный опыт и то, как обычно складываются ваши матчи. Пара минут.

Зачем это нужно: по уровню мы разводим игроков по дивизионам. Завышенная цифра — это разгромные матчи и испорченное впечатление от сезона, заниженная — скучные.

Если вы играете в приложении <b>Raketo</b> и знаете свой рейтинг оттуда — просто впишите его, это точнее любого теста.`
    : `<b>🎾 Confirming player levels before the season</b>

Your PTF profile either has no level, or it was set by the old version of the test — that version pushed almost everyone to 3.5.

We have rebuilt it: 11 short questions about your experience, competitive play and how your matches usually go. It takes a couple of minutes.

Why it matters: your level decides your division. An inflated number means one-sided matches and a season you will not enjoy; too low means matches that are not challenging.

If you use the <b>Raketo</b> app and know your rating there, just enter it — it beats any self-assessment test.`;
}

// Точечная отправка одному игроку: /rating_to 123456789 или /rating_to @username.
// Нужна, когда человек пришёл лично и рассылку гнать незачем.
export async function sendRatingRequestTo(chatId, argument='') {
  const raw = String(argument || '').trim();
  if (!raw) return sendMessage(chatId, 'Кому отправить? Пример: <code>/rating_to @username</code> или <code>/rating_to 309678431</code>');
  const looksLikeId = /^\d+$/.test(raw);
  const handle = raw.replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '');
  const player = await findApplicantByTelegramIdentity(looksLikeId ? { id: raw } : { username: handle });
  const target = player?.telegram_id || (looksLikeId ? raw : '');
  if (!target) return sendMessage(chatId, `Не нашёл игрока <b>${escapeHtml(raw)}</b> в анкетах. Пришли его telegram_id — по нему отправлю в любом случае.`);
  const lang = String(player?.language || '').toLowerCase() === 'ru' ? 'ru' : 'en';
  try {
    await sendMessage(target, missingRatingMessage(lang), { reply_markup: ratingUpdateKeyboard(lang) });
  } catch (e) {
    return sendMessage(chatId, `Не доставлено игроку <b>${escapeHtml(player?.name || raw)}</b>: ${escapeHtml(e.message)}\nЧаще всего это значит, что человек не запускал бота или заблокировал его.`);
  }
  return sendMessage(chatId, `✅ Отправил просьбу указать уровень: <b>${escapeHtml(player?.name || raw)}</b> (${lang})`);
}

export async function startMissingRatingBroadcast(chatId, adminId) {
  const [missing, recheck] = await Promise.all([
    getMissingRatingContacts('missing'),
    getMissingRatingContacts('recheck')
  ]);
  adminState.set(String(adminId), { mode:'missing_rating_confirm', count:missing.length });
  return sendMessage(chatId, `<b>Рассылка про уровень игрока</b>

Без рейтинга вообще: <b>${missing.length}</b>
Плюс те, чью цифру ты не подтверждал: <b>${recheck.length}</b>

Подтверждённой считается анкета с меткой <code>ntrp:admin</code> в колонке <code>crm_tags</code>. Тексты одинаковые, отличается только охват.`, { reply_markup:{ inline_keyboard:[
    [{ text:`📨 Только без рейтинга (${missing.length})`, callback_data:'bcconfirm_missing_rating' }],
    [{ text:`📨 Все на перепрохождение (${recheck.length})`, callback_data:'bcconfirm_rating_recheck' }],
    [{ text:'❌ Отмена', callback_data:'bccancel' }]
  ] } });
}

// Повторный запуск той же рассылки — частая беда: адмнин жмёт кнопку дважды.
// Состояние снимаем ДО отправки, поэтому второе нажатие уже ничего не делает.
export async function executeMissingRatingBroadcast(callbackQuery, scope='missing') {
  const adminId = callbackQuery.from.id;
  const state = adminState.get(String(adminId));
  if (!state || state.mode !== 'missing_rating_confirm') return;
  adminState.delete(String(adminId));
  const contacts = await getMissingRatingContacts(scope);
  const broadcastId = uid('broadcast');
  let sent = 0, failed = 0;
  for (const c of contacts) {
    const lang = c.language === 'ru' ? 'ru' : 'en';
    try {
      await sendMessage(c.telegram_id, missingRatingMessage(lang), { reply_markup: ratingUpdateKeyboard(lang) });
      sent++;
      await logBroadcastResult({ broadcast_id:broadcastId, telegram_id:c.telegram_id, name:c.name, telegram_username:c.telegram_username, status:'sent', sent_at:nowISO(), language:lang, segment_filter:`missing_rating:${scope}` });
      await new Promise(r => setTimeout(r, 45));
    } catch (e) {
      failed++;
      await logBroadcastResult({ broadcast_id:broadcastId, telegram_id:c.telegram_id, name:c.name, telegram_username:c.telegram_username, status:'failed', sent_at:nowISO(), error:String(e.message || e), language:lang, segment_filter:`missing_rating:${scope}` });
    }
  }
  await logBroadcast({ broadcast_id:broadcastId, created_at:nowISO(), admin_id:adminId, admin_name:callbackQuery.from.username || callbackQuery.from.first_name || '', segment_filter:`missing_rating:${scope}`, language:'mixed', message_text:'Update NTRP (Raketo)', media_type:'text', recipients_count:contacts.length, sent_count:sent, failed_count:failed, status:'sent' });
  return sendMessage(callbackQuery.message.chat.id, `✅ Рассылка про уровень отправлена

Sent: <b>${sent}</b>
Failed: <b>${failed}</b>`);
}

export async function startBroadcastWithMenu(chatId, adminId) {
  const contacts = await getSegmentContacts('all');
  adminState.set(String(adminId), { mode: 'broadcast_menu_message', segment: 'all', count: contacts.length });
  await sendMessage(chatId, `<b>Broadcast with menu button</b>\n\nRecipients: <b>${contacts.length}</b>\n\nПришлите текст рассылки. Если не поставить ни одного кода раздела, снизу будет кнопка «Открыть меню».\n\nКоды разделов: <code>{оплата}</code>, <code>{игроки}</code>, <code>{!гонка}</code> — полный список /links`);
}

export async function handleBroadcastMenuMessage(msg, state) {
  const text = msg.text || msg.caption || '';
  if (!text) return sendMessage(msg.chat.id, 'Send a text message for this broadcast.');
  // Без своих кодов работает как раньше — одна кнопка «Открыть меню».
  const parsed = parseTemplate(text.includes('{') ? text : `${text}\n{menu}`);
  adminState.set(String(msg.from.id), { ...state, mode: 'broadcast_menu_confirm', message_text: text, parsed });
  const username = await getBotUsername();
  await sendMessage(msg.chat.id, `<b>Broadcast preview</b>\n\nSegment: <b>all</b>\nRecipients: <b>${state.count}</b>\n\n${renderText(parsed, 'ru', username)}${linksPreview(parsed)}\n\nSend now?`, { reply_markup: { inline_keyboard: [[
    { text: '✅ Send now', callback_data: 'bcconfirm_menu' },
    { text: '❌ Cancel', callback_data: 'bccancel' }
  ]]}});
}

export async function executeBroadcastWithMenu(callbackQuery) {
  const adminId = callbackQuery.from.id;
  const state = adminState.get(String(adminId));
  if (!state || state.mode !== 'broadcast_menu_confirm') return;
  const contacts = await getSegmentContacts('all');
  const parsed = state.parsed || parseTemplate(`${state.message_text}\n{menu}`);
  const username = await getBotUsername();
  const broadcastId = uid('broadcast');
  let sent = 0, failed = 0;
  for (const c of contacts) {
    try {
      const view = renderFor(parsed, c, username);
      await sendMessage(c.telegram_id, view.text, view.reply_markup ? { reply_markup: view.reply_markup } : {});
      sent++;
      await logBroadcastResult({ broadcast_id:broadcastId, telegram_id:c.telegram_id, name:c.name, telegram_username:c.telegram_username, status:'sent', sent_at:nowISO(), language:c.language, segment_filter:'all_menu_button' });
      await new Promise(r => setTimeout(r, 45));
    } catch (e) {
      failed++;
      await logBroadcastResult({ broadcast_id:broadcastId, telegram_id:c.telegram_id, name:c.name, telegram_username:c.telegram_username, status:'failed', sent_at:nowISO(), error:String(e.message || e), language:c.language, segment_filter:'all_menu_button' });
    }
  }
  await logBroadcast({ broadcast_id:broadcastId, created_at:nowISO(), admin_id:adminId, admin_name:callbackQuery.from.username || callbackQuery.from.first_name || '', segment_filter:'all_menu_button', language:'mixed', message_text:state.message_text, media_type:'text', recipients_count:contacts.length, sent_count:sent, failed_count:failed, status:'sent' });
  adminState.delete(String(adminId));
  await sendMessage(callbackQuery.message.chat.id, `✅ Broadcast finished\n\nSent: <b>${sent}</b>\nFailed: <b>${failed}</b>`);
}


export async function startBroadcastPoll(chatId, adminId, testOnly=false) {
  const contacts = testOnly ? [{ telegram_id: adminId, name:'Admin', telegram_username:'', language:'mixed' }] : await getSegmentContacts('all');
  adminState.set(String(adminId), { mode: 'broadcast_poll_message', segment: testOnly ? 'test' : 'all', count: contacts.length, testOnly });
  await sendMessage(chatId, `<b>${testOnly ? 'Test anonymous poll' : 'Anonymous poll broadcast'}</b>

Recipients: <b>${contacts.length}</b>

Send the poll in this format:

Question text
Option 1
Option 2
Option 3

The poll will be anonymous. Results will be saved in the <b>Poll Results</b> sheet and can be checked with /poll_stats.`);
}

export async function handleBroadcastPollMessage(msg, state) {
  const text = (msg.text || msg.caption || '').trim();
  if (!text) return sendMessage(msg.chat.id, 'Send poll question and options as text.');
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const question = lines[0] || '';
  const options = lines.slice(1, 11);
  if (!question || options.length < 2) return sendMessage(msg.chat.id, 'Format: first line is question, next lines are at least 2 answer options.');
  adminState.set(String(msg.from.id), { ...state, mode: 'broadcast_poll_confirm', question, options });
  await sendMessage(msg.chat.id, `<b>Poll preview</b>

Recipients: <b>${state.count}</b>
Question: <b>${escapeHtml(question)}</b>

${options.map((o,i)=>`${i+1}. ${escapeHtml(o)}`).join('\n')}

Send anonymous Telegram poll now?`, { reply_markup: { inline_keyboard: [[
    { text: '✅ Send poll', callback_data: 'bcconfirm_poll' },
    { text: '❌ Cancel', callback_data: 'bccancel' }
  ]]} });
}

export async function executeBroadcastPoll(callbackQuery) {
  const adminId = callbackQuery.from.id;
  const state = adminState.get(String(adminId));
  if (!state || state.mode !== 'broadcast_poll_confirm') return;
  const contacts = state.testOnly ? [{ telegram_id: adminId, name:'Admin', telegram_username:'', language:'mixed' }] : await getSegmentContacts(state.segment || 'all');
  const broadcastId = uid('poll');
  let sent = 0, failed = 0;
  for (const c of contacts) {
    try {
      const message = await sendPoll(c.telegram_id, state.question, state.options, { is_anonymous: true, allows_multiple_answers: false });
      sent++;
      if (message?.poll?.id) await upsertPollResult({ poll_id: message.poll.id, broadcast_id: broadcastId, question: state.question, options: state.options.map(text => ({ text, voter_count:0 })), total_votes:0, sent_count: contacts.length, status:'open' });
      await logBroadcastResult({ broadcast_id:broadcastId, telegram_id:c.telegram_id, name:c.name, telegram_username:c.telegram_username, status:'sent', sent_at:nowISO(), language:c.language, segment_filter:'poll_anonymous' });
      await new Promise(r => setTimeout(r, 45));
    } catch (e) {
      failed++;
      await logBroadcastResult({ broadcast_id:broadcastId, telegram_id:c.telegram_id, name:c.name, telegram_username:c.telegram_username, status:'failed', sent_at:nowISO(), error:String(e.message || e), language:c.language, segment_filter:'poll_anonymous' });
    }
  }
  await logBroadcast({ broadcast_id:broadcastId, created_at:nowISO(), admin_id:adminId, admin_name:callbackQuery.from.username || callbackQuery.from.first_name || '', segment_filter:'poll_anonymous', language:'mixed', message_text:state.question + '\n' + state.options.join('\n'), media_type:'poll', recipients_count:contacts.length, sent_count:sent, failed_count:failed, status:'sent' });
  adminState.delete(String(adminId));
  await sendMessage(callbackQuery.message.chat.id, `✅ Poll broadcast finished\n\nBroadcast ID: <code>${escapeHtml(broadcastId)}</code>\nSent: <b>${sent}</b>\nFailed: <b>${failed}</b>\n\nResults will appear in the <b>Poll Results</b> sheet. You can also use:\n<code>/poll_stats ${escapeHtml(broadcastId)}</code>`);
}

export async function handlePollUpdate(poll) {
  if (!poll?.id) return;
  await upsertPollResult({ poll_id: poll.id, question: poll.question || '', options: poll.options || [], total_votes: poll.total_voter_count || 0, status: poll.is_closed ? 'closed' : 'open' });
}

export async function adminPollStats(chatId, text='') {
  const broadcastId = String(text || '').replace('/poll_stats','').trim();
  if (!broadcastId) return sendMessage(chatId, 'Usage: /poll_stats poll_xxxxx');
  const rows = await findPollResultsByBroadcastId(broadcastId);
  if (!rows.length) return sendMessage(chatId, 'No poll results found for this broadcast ID yet.');
  const summary = summarizePollRows(rows);
  const question = rows.find(r => r.question)?.question || 'Poll';
  const body = summary.options.map(o => `• ${escapeHtml(o.text)} — <b>${Number(o.votes || 0)}</b>`).join('\n') || 'No votes yet.';
  await sendMessage(chatId, `<b>Poll stats</b>\n\nBroadcast: <code>${escapeHtml(broadcastId)}</code>\nQuestion: <b>${escapeHtml(question)}</b>\nPoll copies: <b>${rows.length}</b>\nTotal votes: <b>${summary.total_votes}</b>\n\n${body}`);
}

export async function startBroadcast(chatId, adminId) {
  adminState.set(String(adminId), { mode: 'broadcast_segment' });
  await sendMessage(chatId, '<b>Create broadcast</b>\n\nВ тексте можно ставить коды разделов: <code>{оплата}</code>, <code>{игроки}</code>, <code>{!гонка}</code>. Полный список — /links\n\nChoose segment:', { reply_markup: { inline_keyboard: [
    [{ text: 'All contacts', callback_data: 'bcseg:all' }],
    [{ text: 'Season 2 applicants', callback_data: 'bcseg:season2' }],
    [{ text: 'Active', callback_data: 'bcseg:active' }, { text: 'Waitlist', callback_data: 'bcseg:waitlist' }],
    [{ text: 'Payment-related', callback_data: 'bcseg:payment' }],
    [{ text: 'RU', callback_data: 'bcseg:ru' }, { text: 'EN', callback_data: 'bcseg:en' }],
    [{ text: 'Cancel', callback_data: 'bccancel' }]
  ]}});
}

export async function handleBroadcastSegment(callbackQuery, segment) {
  const adminId = callbackQuery.from.id;
  const contacts = await getSegmentContacts(segment);
  adminState.set(String(adminId), { mode: 'broadcast_message', segment, count: contacts.length });
  await sendMessage(callbackQuery.message.chat.id, `Segment: <b>${escapeHtml(segment)}</b>\nRecipients found: <b>${contacts.length}</b>\n\nNow send the broadcast text/message.`);
}

// Общий кусок предпросмотра: что увидят люди и какие кнопки прилипнут.
// Показываем русский вариант — англоязычным подставятся английские названия.
function linksPreview(parsed) {
  if (!parsed.hasLinks && !parsed.unknown.length) return '';
  const lines = [];
  if (parsed.buttons.length) {
    lines.push('', '<b>Кнопки под сообщением:</b>',
      ...parsed.buttons.map(b => `• ${escapeHtml(b.custom || destinationLabel(b.dest, 'ru'))}`));
  }
  if (parsed.inline.length) {
    lines.push('', `<b>Ссылок внутри текста:</b> ${parsed.inline.length}`);
  }
  if (parsed.unknown.length) {
    lines.push('', `⚠️ <b>Неизвестные коды:</b> ${parsed.unknown.map(u => escapeHtml(u)).join(', ')}`,
      'Они останутся в тексте как есть. Проверьте написание — /links');
  }
  return lines.join('\n');
}

// Текст и кнопки под конкретного получателя.
function renderFor(parsed, contact, username) {
  const lang = String(contact.language || '').toLowerCase() === 'ru' ? 'ru' : 'en';
  return { lang, text: renderText(parsed, lang, username), reply_markup: renderButtons(parsed, lang) };
}

export async function handleBroadcastMessage(msg, state) {
  const text = msg.text || msg.caption || '';
  if (!text && !msg.photo && !msg.document && !msg.video) {
    return sendMessage(msg.chat.id, 'Send text, photo, document or video for broadcast.');
  }
  const parsed = parseTemplate(text);
  const hasMediaMsg = Boolean(msg.photo || msg.document || msg.video);
  adminState.set(String(msg.from.id), { ...state, mode: 'broadcast_confirm', sourceMessage: msg, parsed, hasMediaMsg });
  const username = await getBotUsername();
  const body = renderText(parsed, 'ru', username);
  const tooLong = hasMediaMsg && parsed.hasLinks && body.length > 1024;
  await sendMessage(msg.chat.id, `<b>Broadcast preview</b>\n\nSegment: <b>${escapeHtml(state.segment)}</b>\nRecipients: <b>${state.count}</b>\n\n${body}${linksPreview(parsed)}${tooLong ? '\n\n⚠️ Подпись к медиа длиннее 1024 символов — коды разделов работать не будут. Сократите текст.' : ''}\n\nSend now?`, { reply_markup: { inline_keyboard: [[
    { text: '✅ Send now', callback_data: 'bcconfirm' },
    { text: '❌ Cancel', callback_data: 'bccancel' }
  ]]}});
}

export async function executeBroadcast(callbackQuery) {
  const adminId = callbackQuery.from.id;
  const state = adminState.get(String(adminId));
  if (!state || state.mode !== 'broadcast_confirm') return;
  const contacts = await getSegmentContacts(state.segment);
  const parsed = state.parsed || parseTemplate(state.sourceMessage.text || state.sourceMessage.caption || '');
  const username = await getBotUsername();
  const broadcastId = uid('broadcast');
  let sent = 0, failed = 0;
  for (const c of contacts) {
    try {
      const view = parsed.hasLinks ? renderFor(parsed, c, username) : null;
      if (view && !state.hasMediaMsg) {
        // Текстовая рассылка с кодами: у каждого свой язык кнопок и ссылок.
        await sendMessage(c.telegram_id, view.text, view.reply_markup ? { reply_markup: view.reply_markup } : {});
      } else if (view) {
        // Медиа сохраняем копированием, подпись и кнопки подменяем на свои.
        await copyMessage(c.telegram_id, state.sourceMessage.chat.id, state.sourceMessage.message_id, {
          caption: view.text, parse_mode: 'HTML',
          ...(view.reply_markup ? { reply_markup: view.reply_markup } : {})
        });
      } else {
        await copyMessage(c.telegram_id, state.sourceMessage.chat.id, state.sourceMessage.message_id);
      }
      sent++;
      await logBroadcastResult({ broadcast_id:broadcastId, telegram_id:c.telegram_id, name:c.name, telegram_username:c.telegram_username, status:'sent', sent_at:nowISO(), language:c.language, segment_filter:state.segment });
      await new Promise(r => setTimeout(r, 45));
    } catch (e) {
      failed++;
      await logBroadcastResult({ broadcast_id:broadcastId, telegram_id:c.telegram_id, name:c.name, telegram_username:c.telegram_username, status:'failed', sent_at:nowISO(), error:String(e.message || e), language:c.language, segment_filter:state.segment });
    }
  }
  await logBroadcast({ broadcast_id:broadcastId, created_at:nowISO(), admin_id:adminId, admin_name:callbackQuery.from.username || callbackQuery.from.first_name || '', segment_filter:state.segment, language:'mixed', message_text:state.sourceMessage.text || state.sourceMessage.caption || '[media]', media_type: state.sourceMessage.photo ? 'photo' : state.sourceMessage.document ? 'document' : state.sourceMessage.video ? 'video' : 'text', recipients_count:contacts.length, sent_count:sent, failed_count:failed, status:'sent' });
  adminState.delete(String(adminId));
  await sendMessage(callbackQuery.message.chat.id, `✅ Broadcast finished\n\nSent: <b>${sent}</b>\nFailed: <b>${failed}</b>`);
}

// Ответ админа должен лечь в тему игрока, а не в общую ленту: иначе скриншот
// лежит в подтопике, а вердикт по нему — отдельно и без контекста.
async function replyInPlayerTopic(chatId, telegramId, text, opts={}) {
  let topic = null;
  if (telegramId) topic = await getOrCreatePlayerTopic({ id: telegramId, telegram_id: telegramId }).catch(() => null);
  const target = topic?.chatId || chatId;
  try {
    const res = await sendMessage(target, text, withTopicOpts(topic, opts));
    if (topic?.message_thread_id) markTopicUsed(telegramId);
    return res;
  } catch (e) {
    console.error('replyInPlayerTopic failed, falling back:', e.message);
    return sendMessage(chatId, text, opts).catch(() => null);
  }
}

// Игрок прислал чек вне платёжного потока: привязываем файл к его последней заявке
// и показываем обычную карточку проверки с Approve/Reject.
export async function attachMediaToPayment({ chatId, telegramId }) {
  const app = await findLatestApplicationByTelegramId(telegramId).catch(() => null);
  if (!app?.application_id) {
    return replyInPlayerTopic(chatId, telegramId, '⚠️ У игрока нет ни одной заявки — привязывать не к чему.');
  }
  const payStatus = String(app.payment_status || '').toLowerCase();
  if (payStatus === 'approved') {
    return replyInPlayerTopic(chatId, telegramId, `⚠️ По заявке <code>${escapeHtml(app.application_id)}</code> оплата уже подтверждена. Если это новый платёж, заведите заявку на нужное событие.`);
  }
  const paymentId = app.payment_id || uid('payment');
  await updateApplication(app.application_id, {
    application_status: String(app.application_status || '').toLowerCase() === 'active' ? app.application_status : 'proof_received',
    payment_status: 'proof_received',
    payment_proof_status: 'proof_received',
    payment_id: paymentId
  }).catch(e => console.error('attach: update application failed:', e.message));
  await logPayment({
    payment_id: paymentId,
    application_id: app.application_id,
    telegram_id: telegramId,
    player_name: app.player_name,
    event_id: app.event_id,
    event_name: app.event_name,
    method: app.payment_method || '',
    network: app.payment_network || '',
    amount: app.payment_amount || '',
    currency: app.payment_currency || '',
    proof_received_at: nowISO(),
    status: 'proof_received',
    notes: 'attached manually from player media'
  }).catch(e => console.error('attach: log payment failed:', e.message));

  const text = `<b>💳 Файл привязан к оплате</b>

Application: <code>${escapeHtml(app.application_id)}</code>
Payment: <code>${escapeHtml(paymentId)}</code>
Player: <b>${escapeHtml(app.player_name || '')}</b>
Event: ${escapeHtml(app.event_name || '')}
Amount: <b>${escapeHtml(app.payment_amount || '')} ${escapeHtml(app.payment_currency || '')}</b>

Скриншот — в сообщении выше.`;
  return replyInPlayerTopic(chatId, telegramId, text, { reply_markup: adminPaymentKeyboard(app.application_id, paymentId, telegramId) });
}

// Приветствие после подтверждения участия. Один текст на оба пути — и когда
// организатор подтверждает оплату кнопкой, и когда ставит статус вручную:
// раньше это были два разных сообщения, и они разъезжались.
export function welcomeMessage(lang = 'en') {
  return lang === 'ru' ? `<b>Добро пожаловать в Phuket Tennis Family</b> 🎾

Оплата подтверждена, место в сезоне за тобой. Спасибо за доверие — сделаем этот сезон классным.

<b>Что умеет бот</b>

🎾 <b>Матчи</b> — вызвать соперника, принять вызов, согласовать дату и корт
📅 <b>Корт</b> — забронировать площадку прямо в интерфейсе
📊 <b>Результат</b> — внести счёт после игры
🏆 <b>Лига</b> — таблицы дивизионов, годовая гонка, история матчей
👥 <b>Состав</b> — кто играет в сезоне

Кнопки ниже открывают эти разделы, и они же всегда под рукой внизу экрана.

<b>Клубный чат</b>

Заходи — там живое общение: ищем партнёров на корт, делимся впечатлениями, шутим. Отзывы и идеи по боту тоже пиши туда, они реально идут в работу.

⚠️ Только не блокируй бота — через него приходят вызовы на матч, согласование времени, напоминания и результаты. Без него легко пропустить свою игру.` : `<b>Welcome to Phuket Tennis Family</b> 🎾

Your payment is confirmed and your place in the season is secured. Thank you for trusting us — let's make this season a great one.

<b>What the bot can do</b>

🎾 <b>Matches</b> — challenge an opponent, accept a challenge, agree on a date and court
📅 <b>Court</b> — book a court right inside the app
📊 <b>Result</b> — submit the score after your match
🏆 <b>League</b> — division tables, Yearly Race, match history
👥 <b>Line-up</b> — who is playing this season

The buttons below open these sections, and the same ones stay at the bottom of your screen.

<b>Club chat</b>

Come join us — that is where it all happens: finding hitting partners, sharing impressions, having a laugh. Feedback and ideas about the bot go there too, and they really do get acted on.

⚠️ Just please don't block the bot — match challenges, time coordination, reminders and results all come through it. Without it, it is easy to miss your own match.`;
}

export async function setApplicationStatus({ chatId, applicationId, status }) {
  const app = await updateApplication(applicationId, { application_status: status, reviewed_at: nowISO() });
  if (!app) return sendMessage(chatId, 'Application not found.');
  await updateApplicantStatusByTelegramId(app.telegram_id, status === 'confirmed' ? 'active' : status);
  const lang = (await findApplicantByTelegramId(app.telegram_id))?.language || 'en';
  if (status === 'active' || status === 'confirmed') {
    const l = lang === 'ru' ? 'ru' : 'en';
    if (!app.confirmed_message_sent_at) {
      await sendMessage(app.telegram_id, welcomeMessage(l), { reply_markup: welcomeKeyboard(l) });
      await updateApplication(applicationId, { confirmed_message_sent_at: nowISO() });
    }
  } else if (status === 'waitlist') {
    await sendMessage(app.telegram_id, t(lang, 'waitlist'));
  }
  await replyInPlayerTopic(chatId, app.telegram_id, `Status updated: <b>${escapeHtml(app.player_name)}</b> → <b>${escapeHtml(status)}</b>`);
}

export async function setPaymentStatus({ chatId, applicationId, paymentId = '', status }) {
  // Кнопка передаёт только заявку — платёж берём из её строки (в callback_data
  // оба идентификатора не помещаются, лимит Telegram 64 байта).
  let pid = String(paymentId || '').trim();
  if (!pid) {
    const current = await findApplication(applicationId).catch(() => null);
    pid = String(current?.payment_id || '').trim();
  }
  if (pid) await updatePayment(pid, { status: status === 'approved' ? 'approved' : 'rejected', admin_checked_at: nowISO() });
  else console.error(`setPaymentStatus: payment_id not found for ${applicationId}`);
  // Подтверждённая оплата — это и есть участие: игрок сразу становится активным,
  // иначе он застревал в payment_approved, а мини-приложение пускает только
  // активных. Отдельно жать «Set Active» больше не нужно.
  const appStatus = status === 'approved' ? 'active' : 'waiting_payment';
  const app = await updateApplication(applicationId, { application_status: appStatus, payment_status: status === 'approved' ? 'approved' : 'rejected', payment_proof_status: status, payment_reviewed_at: nowISO() });
  if (app) await updateApplicantStatusByTelegramId(app.telegram_id, appStatus);
  // Дальше обычная ветка подтверждения: поздравление и приглашение в клубный чат.
  if (status === 'approved' && app?.telegram_id && !app.confirmed_message_sent_at) {
    const lang = (await findApplicantByTelegramId(app.telegram_id))?.language === 'ru' ? 'ru' : 'en';
    await sendMessage(app.telegram_id, welcomeMessage(lang), { reply_markup: welcomeKeyboard(lang) })
      .catch(e => console.error('confirm message failed:', e.message));
    await updateApplication(applicationId, { confirmed_message_sent_at: nowISO() }).catch(() => {});
  }
  const icon = status === 'approved' ? '✅' : '❌';
  await replyInPlayerTopic(chatId, app?.telegram_id, `<b>${icon} Payment ${escapeHtml(status)}</b>\n\nApplication: <code>${escapeHtml(applicationId)}</code>\nPlayer: <b>${escapeHtml(app?.player_name || '')}</b>\n\nParticipation status is still separate.`);
}
