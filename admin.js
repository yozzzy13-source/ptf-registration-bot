import { sendMessage, editMessageText, sendPhoto, sendDocument, copyMessage, getChat, createForumTopic, deleteForumTopic } from './telegram.js';
import { getSetting, setSetting, getRows, getSegmentContacts, logBroadcast, logBroadcastResult, findApplication, updateApplication, updateApplicantStatusByTelegramId, updatePayment, findApplicantByTelegramId, findLeadByTelegramId, findApplicantByAdminTopic, openAdminChatByTelegramId, setAdminTopicByTelegramId, updateContactByTelegramId, logMessage } from './sheets.js';
import { SHEETS, ADMIN_IDS, CLUB_CHAT_URL, ADMIN_CRM_CHAT_ID, BROADCAST_DELAY_MS } from './config.js';
import { nowISO, escapeHtml, uid } from './util.js';
import { t } from './i18n.js';
import { adminApplicationKeyboard, adminPaymentKeyboard, clubKeyboard } from './keyboards.js';

export const adminState = new Map();
const topicCreationLocks = new Map();
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

export function isAdminUser(userId) {
  if (!ADMIN_IDS.length) return true; // first launch mode. Fill ADMIN_IDS later for stricter access.
  return ADMIN_IDS.includes(String(userId));
}

export async function getAdminChatId() {
  return await getSetting('admin_chat_id');
}

export async function getCrmChatId() {
  return ADMIN_CRM_CHAT_ID || await getSetting('admin_crm_chat_id') || await getAdminChatId();
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

export async function handleCrmInit(msg) {
  const chat = await getChat(msg.chat.id).catch(e => ({ error: e }));

  if (chat.error) {
    return sendMessage(msg.chat.id, `<b>CRM topic group was not connected</b>\n\nTelegram error:\n<code>${escapeHtml(chat.error.message || chat.error)}</code>`);
  }

  if (msg.chat.type !== 'supergroup' || chat.is_forum !== true) {
    return sendMessage(
      msg.chat.id,
      `<b>CRM topics are not enabled in this group</b>\n\nPlease open group settings and enable Topics first. The group must be a Telegram forum/supergroup. After that, run /crm_init again.`
    );
  }

  try {
    const probe = await createForumTopic(msg.chat.id, 'CRM setup test');
    if (probe?.message_thread_id) {
      await deleteForumTopic(msg.chat.id, probe.message_thread_id).catch(() => {});
    }
  } catch (e) {
    return sendMessage(
      msg.chat.id,
      `<b>CRM topic group was not connected</b>\n\nThe group has Topics enabled, but the bot cannot create topics. Give the bot admin permission to manage topics, then run /crm_init again.\n\nTelegram error:\n<code>${escapeHtml(e.message || e)}</code>`
    );
  }

  await setSetting('admin_crm_chat_id', String(msg.chat.id), 'Telegram forum group for per-player CRM topics');
  await sendMessage(msg.chat.id, `CRM topic group connected.\n\nchat_id: <code>${msg.chat.id}</code>\n\nNew player conversations will now create personal topics here.`);
}

function topicNameForProfile(profile={}) {
  const baseName = profile.name || profile.player_name || [profile.first_name, profile.last_name].filter(Boolean).join(' ') || profile.telegram_username || profile.username || profile.telegram_id || profile.id || 'Unknown';
  const username = profile.telegram_username || profile.username || '';
  const id = profile.telegram_id || profile.id || '';
  const suffix = username ? ` @${String(username).replace(/^@/, '')}` : id ? ` ${id}` : '';
  return `${baseName}${suffix}`.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function getOrCreateAdminTopicForTelegramIdUnlocked(telegramId, fallback={}) {
  const chatId = await getCrmChatId();
  if (!chatId || !telegramId) return null;

  const profile = await findApplicantByTelegramId(telegramId).catch(() => null)
    || await findLeadByTelegramId(telegramId).catch(() => null);
  const contact = profile || { ...fallback, telegram_id: telegramId };

  if (contact.admin_topic_id) {
    return {
      chatId,
      messageThreadId: Number(contact.admin_topic_id),
      topicName: contact.admin_topic_name || topicNameForProfile(contact),
      profile: contact
    };
  }

  const topicName = topicNameForProfile(contact);

  try {
    const topic = await createForumTopic(chatId, topicName);
    const messageThreadId = topic.message_thread_id;

    if (profile) {
      await setAdminTopicByTelegramId(telegramId, {
        admin_topic_id: String(messageThreadId),
        admin_topic_name: topicName,
        admin_topic_chat_id: String(chatId)
      });
    }

    return { chatId, messageThreadId, topicName, profile: contact };
  } catch (e) {
    console.error('createForumTopic failed', e.message || e);
    return { chatId, messageThreadId: null, topicName, profile: contact, topicError: e };
  }
}

async function getOrCreateAdminTopicForTelegramId(telegramId, fallback={}) {
  const key = String(telegramId || '');
  if (!key) return null;
  if (topicCreationLocks.has(key)) return topicCreationLocks.get(key);

  const pending = getOrCreateAdminTopicForTelegramIdUnlocked(telegramId, fallback)
    .finally(() => topicCreationLocks.delete(key));
  topicCreationLocks.set(key, pending);
  return pending;
}

export async function handleAdminTopicMessage(msg) {
  const chatId = String(msg.chat?.id || '');
  const crmChatId = String(await getCrmChatId() || '');

  if (!crmChatId || chatId !== crmChatId) return false;
  if (!msg.message_thread_id) return false;
  if (msg.from?.is_bot) return true;
  if (msg.forum_topic_created || msg.forum_topic_closed || msg.forum_topic_reopened || msg.general_forum_topic_hidden || msg.general_forum_topic_unhidden) return true;

  const applicant = await findApplicantByAdminTopic(msg.message_thread_id, chatId);
  if (!applicant?.telegram_id) return false;

  const text = msg.text || msg.caption || '';
  if (!text && !msg.photo && !msg.document && !msg.video && !msg.voice && !msg.audio && !msg.sticker) return true;

  await copyMessage(applicant.telegram_id, msg.chat.id, msg.message_id);
  await openAdminChatByTelegramId(applicant.telegram_id, 'admin_topic_reply', {
    id: msg.from?.id,
    name: msg.from?.username || msg.from?.first_name || ''
  });
  await logMessage({
    message_id: uid('msg'),
    telegram_id: applicant.telegram_id,
    direction: 'outgoing',
    message_type: msg.photo ? 'photo' : msg.document ? 'document' : msg.video ? 'video' : 'text',
    message_text: text || '[media]',
    timestamp: nowISO(),
    admin_id: msg.from?.id || '',
    admin_name: msg.from?.username || msg.from?.first_name || '',
    status: 'sent',
    related_event: `admin_topic:${msg.message_thread_id}`
  });

  return true;
}

export async function recordAdminOutbound(telegramId, text, admin={}, source='admin_outbound') {
  const topic = await getOrCreateAdminTopicForTelegramId(telegramId, {
    telegram_id: telegramId,
    name: ''
  });

  if (!topic?.chatId || !topic.messageThreadId) return null;

  const label = source.replace(/_/g, ' ');
  return sendMessage(
    topic.chatId,
    `<b>Outgoing · ${escapeHtml(label)}</b>\n\n${escapeHtml(text || '[media]')}`,
    { message_thread_id: topic.messageThreadId }
  ).catch(e => {
    console.error('recordAdminOutbound failed', e.message || e);
    return null;
  });
}

export async function adminStats(chatId) {
  const applicants = (await getRows(SHEETS.applicants, { useCache:false })).rows;
  const apps = (await getRows(SHEETS.applications, { useCache:false })).rows;
  const payments = (await getRows(SHEETS.payments, { useCache:false })).rows;
  const active = applicants.filter(r => r.status === 'active').length;
  const waitlist = applicants.filter(r => r.status === 'waitlist').length;
  const proof = apps.filter(r => r.application_status === 'proof_received').length;
  await sendMessage(chatId, `<b>PTF Stats</b>\n\nContacts: <b>${applicants.length}</b>\nApplications: <b>${apps.length}</b>\nActive: <b>${active}</b>\nWaitlist: <b>${waitlist}</b>\nPayment proofs waiting: <b>${proof}</b>\nPayments: <b>${payments.length}</b>`);
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
  const topic = await getOrCreateAdminTopicForTelegramId(app.telegram_id, profile);
  const text = `<b>🎾 New application</b>\n\nApplication: <code>${escapeHtml(app.application_id)}</code>\nTGID: <code>${escapeHtml(app.telegram_id)}</code>\nPlayer: <b>${escapeHtml(profile.name)}</b> ${profile.telegram_username ? '@'+escapeHtml(profile.telegram_username) : ''}\nEvent: <b>${escapeHtml(app.event_name)}</b>\nStatus: <b>${escapeHtml(app.application_status)}</b>\n\nNTRP: ${escapeHtml(profile.ntrp)}\nExperience: ${escapeHtml(profile.experience)}\nGender: ${escapeHtml(profile.gender)}\nAge: ${escapeHtml(profile.age)}\nCountry: ${escapeHtml(profile.country_of_origin)}\nWhatsApp: ${escapeHtml(profile.whatsapp)}\nNotes: ${escapeHtml(profile.notes)}`;
  const opts = { reply_markup: adminApplicationKeyboard(app.application_id, app.telegram_id) };

  if (app.admin_notification_message_id && app.admin_notification_chat_id) {
    return editMessageText(
      app.admin_notification_chat_id,
      app.admin_notification_message_id,
      text,
      opts
    ).catch(e => {
      console.error('application notification edit failed', e.message || e);
      return null;
    });
  }

  if (profile.admin_lead_message_id && profile.admin_lead_chat_id) {
    const edited = await editMessageText(
      profile.admin_lead_chat_id,
      profile.admin_lead_message_id,
      text,
      opts
    ).catch(e => {
      console.error('lead notification promotion failed', e.message || e);
      return null;
    });
    if (edited) {
      await updateApplication(app.application_id, {
        admin_notification_message_id: String(profile.admin_lead_message_id),
        admin_notification_chat_id: String(profile.admin_lead_chat_id),
        admin_notification_topic_id: String(topic?.messageThreadId || ''),
        admin_notification_sent_at: nowISO()
      });
      return edited;
    }
  }

  if (topic?.chatId && topic.messageThreadId) {
    const sent = await sendMessage(topic.chatId, text, { ...opts, message_thread_id: topic.messageThreadId });
    await updateApplication(app.application_id, {
      admin_notification_message_id: String(sent.message_id),
      admin_notification_chat_id: String(topic.chatId),
      admin_notification_topic_id: String(topic.messageThreadId),
      admin_notification_sent_at: nowISO()
    });
    return sent;
  }

  const sent = await notifyAdmin(text, opts);
  if (sent?.message_id) {
    await updateApplication(app.application_id, {
      admin_notification_message_id: String(sent.message_id),
      admin_notification_chat_id: String(sent.chat?.id || ''),
      admin_notification_topic_id: '',
      admin_notification_sent_at: nowISO()
    });
  }
  return sent;
}

export async function notifyNewLead(profile) {
  const topic = await getOrCreateAdminTopicForTelegramId(profile.telegram_id, profile);
  const text = `<b>New lead</b>\n\nTGID: <code>${escapeHtml(profile.telegram_id)}</code>\nName: <b>${escapeHtml(profile.name || '')}</b> ${profile.telegram_username ? '@'+escapeHtml(profile.telegram_username) : ''}`;

  if (topic?.chatId && topic.messageThreadId) {
    const sent = await sendMessage(topic.chatId, text, { message_thread_id: topic.messageThreadId });
    await updateContactByTelegramId(profile.telegram_id, {
      admin_lead_message_id: String(sent.message_id),
      admin_lead_chat_id: String(topic.chatId),
      admin_lead_sent_at: nowISO()
    });
    return sent;
  }

  const sent = await notifyAdmin(text);
  if (sent?.message_id) {
    await updateContactByTelegramId(profile.telegram_id, {
      admin_lead_message_id: String(sent.message_id),
      admin_lead_chat_id: String(sent.chat?.id || ''),
      admin_lead_sent_at: nowISO()
    });
  }
  return sent;
}

export async function notifyIncomingMessage(from, text, telegramMessageId, sourceChatId=null, shouldCopy=false) {
  const topic = await getOrCreateAdminTopicForTelegramId(from.id, {
    name: from.name || '',
    telegram_username: from.username || '',
    telegram_id: from.id
  });
  const body = `<b>💬 New message from player</b>\n\nTGID: <code>${escapeHtml(from.id)}</code>\nFrom: <b>${escapeHtml(from.name || '')}</b> ${from.username ? '@'+escapeHtml(from.username) : ''}\n\n${escapeHtml(text)}`;
  const opts = {
    reply_markup: { inline_keyboard: [[{ text: '💬 Reply', callback_data: `admin_reply:${from.id}` }]] }
  };

  let adminMsg = null;

  if (topic?.chatId && topic.messageThreadId) {
    if (telegramMessageId) {
      adminMsg = await copyMessage(
        topic.chatId,
        sourceChatId || from.id,
        telegramMessageId,
        { message_thread_id: topic.messageThreadId }
      ).catch(e => {
        console.error('copy incoming message to topic failed', e.message || e);
        return null;
      });
    }

    if (!adminMsg) {
      adminMsg = await sendMessage(topic.chatId, escapeHtml(text || '[media]'), { message_thread_id: topic.messageThreadId });
    }
  } else {
    adminMsg = await notifyAdmin(body, opts);

    if (shouldCopy && telegramMessageId) {
      const chatId = await getAdminChatId();
      if (chatId) await copyMessage(chatId, sourceChatId || from.id, telegramMessageId).catch(e => console.error('copy incoming message failed', e.message || e));
    }
  }

  return adminMsg;
}

export async function notifyPaymentProof({ app, payment, from, originalMessage }) {
  const topic = await getOrCreateAdminTopicForTelegramId(from.id, {
    name: app.player_name || '',
    telegram_username: from.username || '',
    telegram_id: from.id
  });
  const chatId = topic?.chatId || await getAdminChatId();
  if (!chatId) return;
  const threadOpts = topic?.messageThreadId ? { message_thread_id: topic.messageThreadId } : {};
  const caption = `<b>💳 Payment proof received</b>\n\nApplication: <code>${escapeHtml(app.application_id)}</code>\nPayment: <code>${escapeHtml(payment.payment_id)}</code>\nTGID: <code>${escapeHtml(from.id)}</code>\nPlayer: <b>${escapeHtml(app.player_name)}</b> ${from.username ? '@'+escapeHtml(from.username) : ''}\nEvent: ${escapeHtml(app.event_name)}\nMethod: <b>${escapeHtml(payment.method)}</b> ${escapeHtml(payment.network || '')}\nAmount: <b>${escapeHtml(payment.amount)} ${escapeHtml(payment.currency)}</b>`;
  if (originalMessage.photo?.length) {
    const fileId = originalMessage.photo[originalMessage.photo.length - 1].file_id;
    await sendPhoto(chatId, fileId, { caption, reply_markup: adminPaymentKeyboard(app.application_id, payment.payment_id, from.id), ...threadOpts });
  } else if (originalMessage.document) {
    await sendDocument(chatId, originalMessage.document.file_id, { caption, reply_markup: adminPaymentKeyboard(app.application_id, payment.payment_id, from.id), ...threadOpts });
  } else {
    await sendMessage(chatId, caption, { reply_markup: adminPaymentKeyboard(app.application_id, payment.payment_id, from.id), ...threadOpts });
  }
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
    } catch (e) {
      failed++;
      await logBroadcastResult({ broadcast_id:broadcastId, telegram_id:c.telegram_id, name:c.name, telegram_username:c.telegram_username, status:'failed', sent_at:nowISO(), error:String(e.message || e), language:c.language, segment_filter:state.segment });
    }
    await delay(BROADCAST_DELAY_MS);
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
      await recordAdminOutbound(app.telegram_id, text, {}, 'status_update');
      await openAdminChatByTelegramId(app.telegram_id, 'status_update', {});
      await updateApplication(applicationId, { confirmed_message_sent_at: nowISO() });
    }
  } else if (status === 'waitlist') {
    await sendMessage(app.telegram_id, t(lang, 'waitlist'));
    await recordAdminOutbound(app.telegram_id, t(lang, 'waitlist'), {}, 'status_update');
    await openAdminChatByTelegramId(app.telegram_id, 'status_update', {});
  }
  await sendMessage(chatId, `Status updated: <b>${escapeHtml(app.player_name)}</b> → <b>${escapeHtml(status)}</b>`);
}

export async function setPaymentStatus({ chatId, applicationId, paymentId, status }) {
  await updatePayment(paymentId, { status: status === 'approved' ? 'approved' : 'rejected', admin_checked_at: nowISO() });
  const appStatus = status === 'approved' ? 'payment_approved' : 'waiting_payment';
  const app = await updateApplication(applicationId, { application_status: appStatus, payment_proof_status: status });
  if (app) await updateApplicantStatusByTelegramId(app.telegram_id, appStatus);
  await sendMessage(chatId, `Payment ${escapeHtml(status)} for application <code>${escapeHtml(applicationId)}</code>. Participation status is still separate.`);
}
