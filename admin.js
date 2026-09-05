import { sendMessage, sendPhoto, sendDocument, sendVideo, sendVoice, sendAudio, sendVideoNote, sendSticker, copyMessage, sendPoll, createForumTopic, getChat, getWebhookInfo, getMe } from './telegram.js';
import { getSetting, setSetting, getRows, getSegmentContacts, getMissingRatingContacts, logBroadcast, logBroadcastResult, findApplication, updateApplication, updateApplicantStatusByTelegramId, updatePayment, findApplicantByTelegramId, findApplicantByTelegramIdentity, upsertPollResult, findPollResultsByBroadcastId, summarizePollRows, updateApplicantAdminTopic, ensureApplicantLead } from './sheets.js';
import { SHEETS, ADMIN_IDS, CLUB_CHAT_URL, PUBLIC_URL } from './config.js';
import { nowISO, escapeHtml, uid } from './util.js';
import { t } from './i18n.js';
import { adminApplicationKeyboard, adminPaymentKeyboard, clubKeyboard } from './keyboards.js';

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
const topicCache = new Map();
export function forgetPlayerTopic(telegramId) { topicCache.delete(String(telegramId || '')); }

export async function getOrCreatePlayerTopic(player={}) {
  const chatId = await getAdminChatId();
  if (!chatId) return null;
  const telegramId = player.telegram_id || player.id;
  if (!telegramId) return null;
  const key = String(telegramId);

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
    if (currentTopicId) {
      const topicName = freshProfile?.admin_topic_name || playerTopicName(freshProfile || player);
      topicCache.set(key, { threadId: currentTopicId, topicName });
      return { chatId, message_thread_id: Number(currentTopicId), topicName, existing:true };
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
          admin_topic_created_at:nowISO()
        }, player).catch(e => console.error('save admin_topic_id failed:', e.message));
        return { chatId, message_thread_id: threadId, topicName, existing:false };
      }
    } catch (e) {
      console.error('createForumTopic failed; falling back to General:', e.message);
    }
    return { chatId, topicName, existing:false };
  });
}

// Recreate a topic only when Telegram says the thread itself is gone/closed.
// Any other failure (rate limit, HTML parse error, network) must NOT spawn a new topic.
function isTopicGoneError(e) {
  const desc = String(e?.telegram?.description || e?.message || '').toLowerCase();
  return desc.includes('thread not found') || desc.includes('topic_deleted') || desc.includes('topic_closed') || desc.includes('topic closed') || desc.includes('message thread not found');
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
  await updateApplicantAdminTopic(telegramId, { admin_topic_id:'', admin_topic_name:'', admin_topic_created_at:'' }).catch(() => {});
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

async function deliverPlayerMessage({ chatId, topic, from, originalMessage, text, replyMarkup={}, fallbackTitle='Player message' }) {
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
  const replyMarkup = { reply_markup: { inline_keyboard: [[{ text: '💬 Reply', callback_data: `admin_reply:${from.id}` }]] } };
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
  return sendMessage(msg.chat.id, `<b>Проверка таблицы матчей</b>\n\n${lines.join('\n')}`);
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
  } catch (e) { lines.push(`topic test failed: <code>${escapeHtml(e.message)}</code>`); }
  return sendMessage(msg.chat.id, `<b>Topic diagnostics</b>\n\n${lines.join('\n')}`);
}


export function ratingUpdateKeyboard(lang='en') {
  const url = `${PUBLIC_URL}/apply?mode=rating`;
  return { inline_keyboard: [[{ text: lang === 'ru' ? '🎾 Указать NTRP (Raketo)' : '🎾 Add NTRP (Raketo)', web_app: { url } }]] };
}

export function missingRatingMessage(lang='en') {
  return lang === 'ru'
    ? `<b>🎾 Обновите рейтинг NTRP (Raketo)</b>

В вашей анкете Phuket Tennis Family не указан рейтинг NTRP (Raketo).

Чтобы анкета считалась заполненной полностью, укажите свой рейтинг из приложения Raketo. Если рейтинга Raketo у вас нет, пройдите короткий тест по кнопке ниже — бот рассчитает примерный уровень и обновит вашу уже существующую анкету.`
    : `<b>🎾 Update your NTRP (Raketo)</b>

Your Phuket Tennis Family profile does not include NTRP (Raketo).

To complete your profile, enter your rating from the Raketo app. If you do not have a Raketo rating, take the short test using the button below — the bot will estimate your level and update your existing profile.`;
}

export async function startMissingRatingBroadcast(chatId, adminId) {
  const contacts = await getMissingRatingContacts();
  adminState.set(String(adminId), { mode:'missing_rating_confirm', count:contacts.length });
  return sendMessage(chatId, `<b>Missing NTRP (Raketo) broadcast</b>

Recipients found: <b>${contacts.length}</b>

This will send a fixed message with a WebApp button to update NTRP (Raketo).`, { reply_markup:{ inline_keyboard:[[ { text:'✅ Send', callback_data:'bcconfirm_missing_rating' }, { text:'❌ Cancel', callback_data:'bccancel' } ]] } });
}

export async function executeMissingRatingBroadcast(callbackQuery) {
  const adminId = callbackQuery.from.id;
  const state = adminState.get(String(adminId));
  if (!state || state.mode !== 'missing_rating_confirm') return;
  const contacts = await getMissingRatingContacts();
  const broadcastId = uid('broadcast');
  let sent = 0, failed = 0;
  for (const c of contacts) {
    const lang = c.language === 'ru' ? 'ru' : 'en';
    try {
      await sendMessage(c.telegram_id, missingRatingMessage(lang), { reply_markup: ratingUpdateKeyboard(lang) });
      sent++;
      await logBroadcastResult({ broadcast_id:broadcastId, telegram_id:c.telegram_id, name:c.name, telegram_username:c.telegram_username, status:'sent', sent_at:nowISO(), language:lang, segment_filter:'missing_rating' });
      await new Promise(r => setTimeout(r, 45));
    } catch (e) {
      failed++;
      await logBroadcastResult({ broadcast_id:broadcastId, telegram_id:c.telegram_id, name:c.name, telegram_username:c.telegram_username, status:'failed', sent_at:nowISO(), error:String(e.message || e), language:lang, segment_filter:'missing_rating' });
    }
  }
  await logBroadcast({ broadcast_id:broadcastId, created_at:nowISO(), admin_id:adminId, admin_name:callbackQuery.from.username || callbackQuery.from.first_name || '', segment_filter:'missing_rating', language:'mixed', message_text:'Update NTRP (Raketo)', media_type:'text', recipients_count:contacts.length, sent_count:sent, failed_count:failed, status:'sent' });
  adminState.delete(String(adminId));
  return sendMessage(callbackQuery.message.chat.id, `✅ Missing rating broadcast finished

Sent: <b>${sent}</b>
Failed: <b>${failed}</b>`);
}

export async function startBroadcastWithMenu(chatId, adminId) {
  const contacts = await getSegmentContacts('all');
  adminState.set(String(adminId), { mode: 'broadcast_menu_message', segment: 'all', count: contacts.length });
  await sendMessage(chatId, `<b>Broadcast with menu button</b>\n\nRecipients: <b>${contacts.length}</b>\n\nSend the text that should go to all users. The bot will attach a button that opens the main menu.`);
}

export async function handleBroadcastMenuMessage(msg, state) {
  const text = msg.text || msg.caption || '';
  if (!text) return sendMessage(msg.chat.id, 'Send a text message for this broadcast.');
  adminState.set(String(msg.from.id), { ...state, mode: 'broadcast_menu_confirm', message_text: text });
  await sendMessage(msg.chat.id, `<b>Broadcast preview</b>\n\nSegment: <b>all</b>\nRecipients: <b>${state.count}</b>\n\n${escapeHtml(text)}\n\nButton: <b>🎾 Open menu</b>\n\nSend now?`, { reply_markup: { inline_keyboard: [[
    { text: '✅ Send now', callback_data: 'bcconfirm_menu' },
    { text: '❌ Cancel', callback_data: 'bccancel' }
  ]]}});
}

export async function executeBroadcastWithMenu(callbackQuery) {
  const adminId = callbackQuery.from.id;
  const state = adminState.get(String(adminId));
  if (!state || state.mode !== 'broadcast_menu_confirm') return;
  const contacts = await getSegmentContacts('all');
  const broadcastId = uid('broadcast');
  let sent = 0, failed = 0;
  for (const c of contacts) {
    try {
      const l = String(c.language || '').toLowerCase() === 'ru' ? 'ru' : 'en';
      const keyboard = { inline_keyboard: [[{ text: l === 'ru' ? '🎾 Открыть меню' : '🎾 Open menu', callback_data: 'main' }]] };
      await sendMessage(c.telegram_id, state.message_text, { reply_markup: keyboard });
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
  await sendMessage(chatId, '<b>Create broadcast</b>\n\nChoose segment:', { reply_markup: { inline_keyboard: [
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

export async function handleBroadcastMessage(msg, state) {
  const text = msg.text || msg.caption || '';
  if (!text && !msg.photo && !msg.document && !msg.video) {
    return sendMessage(msg.chat.id, 'Send text, photo, document or video for broadcast.');
  }
  adminState.set(String(msg.from.id), { ...state, mode: 'broadcast_confirm', sourceMessage: msg });
  await sendMessage(msg.chat.id, `<b>Broadcast preview</b>\n\nSegment: <b>${escapeHtml(state.segment)}</b>\nRecipients: <b>${state.count}</b>\n\nSend now?`, { reply_markup: { inline_keyboard: [[
    { text: '✅ Send now', callback_data: 'bcconfirm' },
    { text: '❌ Cancel', callback_data: 'bccancel' }
  ]]}});
}

export async function executeBroadcast(callbackQuery) {
  const adminId = callbackQuery.from.id;
  const state = adminState.get(String(adminId));
  if (!state || state.mode !== 'broadcast_confirm') return;
  const contacts = await getSegmentContacts(state.segment);
  const broadcastId = uid('broadcast');
  let sent = 0, failed = 0;
  for (const c of contacts) {
    try {
      await copyMessage(c.telegram_id, state.sourceMessage.chat.id, state.sourceMessage.message_id);
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

export async function setApplicationStatus({ chatId, applicationId, status }) {
  const app = await updateApplication(applicationId, { application_status: status, reviewed_at: nowISO() });
  if (!app) return sendMessage(chatId, 'Application not found.');
  await updateApplicantStatusByTelegramId(app.telegram_id, status === 'confirmed' ? 'active' : status);
  const lang = (await findApplicantByTelegramId(app.telegram_id))?.language || 'en';
  if (status === 'active' || status === 'confirmed') {
    const text = lang === 'ru'
      ? '<b>Поздравляем!</b> 🎾\n\nТы стал частью <b>Phuket Tennis Family</b>, и твоё участие в сезоне подтверждено.\n\nТеперь ты можешь присоединиться к нашему клубному чату, где начнётся твоя дорога внутри нашей теннисной семьи.'
      : '<b>Congratulations!</b> 🎾\n\nYou are now part of <b>Phuket Tennis Family</b>, and your participation in the season has been confirmed.\n\nYou can now join our club chat and start your journey inside our tennis family.';
    if (!app.confirmed_message_sent_at) {
      await sendMessage(app.telegram_id, text, { reply_markup: clubKeyboard(lang, CLUB_CHAT_URL) });
      await updateApplication(applicationId, { confirmed_message_sent_at: nowISO() });
    }
  } else if (status === 'waitlist') {
    await sendMessage(app.telegram_id, t(lang, 'waitlist'));
  }
  await sendMessage(chatId, `Status updated: <b>${escapeHtml(app.player_name)}</b> → <b>${escapeHtml(status)}</b>`);
}

export async function setPaymentStatus({ chatId, applicationId, paymentId, status }) {
  await updatePayment(paymentId, { status: status === 'approved' ? 'approved' : 'rejected', admin_checked_at: nowISO() });
  const appStatus = status === 'approved' ? 'payment_approved' : 'waiting_payment';
  const app = await updateApplication(applicationId, { application_status: appStatus, payment_status: status === 'approved' ? 'approved' : 'rejected', payment_proof_status: status, payment_reviewed_at: nowISO() });
  if (app) await updateApplicantStatusByTelegramId(app.telegram_id, appStatus);
  await sendMessage(chatId, `Payment ${escapeHtml(status)} for application <code>${escapeHtml(applicationId)}</code>. Participation status is still separate.`);
}
