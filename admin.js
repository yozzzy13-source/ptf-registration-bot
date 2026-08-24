import { sendMessage, sendPhoto, sendDocument, copyMessage } from './telegram.js';
import { getSetting, setSetting, getRows, getSegmentContacts, logBroadcast, logBroadcastResult, findApplication, updateApplication, updateApplicantStatusByTelegramId, updatePayment, findApplicantByTelegramId } from './sheets.js';
import { SHEETS, ADMIN_IDS, CLUB_CHAT_URL } from './config.js';
import { nowISO, escapeHtml, uid } from './util.js';
import { t } from './i18n.js';
import { adminApplicationKeyboard, adminPaymentKeyboard, clubKeyboard } from './keyboards.js';

export const adminState = new Map();

export function isAdminUser(userId) {
  if (!ADMIN_IDS.length) return false; // admin panel is closed until ADMIN_IDS is configured.
  return ADMIN_IDS.includes(String(userId));
}

export async function getAdminChatId() {
  return await getSetting('admin_chat_id');
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
  await notifyAdmin(`<b>🎾 New application</b>\n\nApplication: <code>${escapeHtml(app.application_id)}</code>\nTGID: <code>${escapeHtml(app.telegram_id)}</code>\nPlayer: <b>${escapeHtml(profile.name)}</b> ${profile.telegram_username ? '@'+escapeHtml(profile.telegram_username) : ''}\nEvent: <b>${escapeHtml(app.event_name)}</b>\nStatus: <b>${escapeHtml(app.application_status)}</b>\n\nNTRP: ${escapeHtml(profile.ntrp)}\nExperience: ${escapeHtml(profile.experience)}\nGender: ${escapeHtml(profile.gender)}\nAge: ${escapeHtml(profile.age)}\nCountry: ${escapeHtml(profile.country_of_origin)}\nWhatsApp: ${escapeHtml(profile.whatsapp)}\nNotes: ${escapeHtml(profile.notes)}`, {
    reply_markup: adminApplicationKeyboard(app.application_id, app.telegram_id)
  });
}

export async function notifyIncomingMessage(from, text, telegramMessageId) {
  const adminMsg = await notifyAdmin(`<b>💬 New message from player</b>\n\nTGID: <code>${escapeHtml(from.id)}</code>\nFrom: <b>${escapeHtml(from.name || '')}</b> ${from.username ? '@'+escapeHtml(from.username) : ''}\n\n${escapeHtml(text)}`, {
    reply_markup: { inline_keyboard: [[{ text: '💬 Reply', callback_data: `admin_reply:${from.id}` }]] }
  });
  return adminMsg;
}

export async function notifyPaymentProof({ app, payment, from, originalMessage }) {
  const chatId = await getAdminChatId();
  if (!chatId) return;
  const caption = `<b>💳 Payment proof received</b>\n\nApplication: <code>${escapeHtml(app.application_id)}</code>\nPayment: <code>${escapeHtml(payment.payment_id)}</code>\nTGID: <code>${escapeHtml(from.id)}</code>\nPlayer: <b>${escapeHtml(app.player_name)}</b> ${from.username ? '@'+escapeHtml(from.username) : ''}\nEvent: ${escapeHtml(app.event_name)}\nMethod: <b>${escapeHtml(payment.method)}</b> ${escapeHtml(payment.network || '')}\nAmount: <b>${escapeHtml(payment.amount)} ${escapeHtml(payment.currency)}</b>`;
  if (originalMessage.photo?.length) {
    const fileId = originalMessage.photo[originalMessage.photo.length - 1].file_id;
    await sendPhoto(chatId, fileId, { caption, reply_markup: adminPaymentKeyboard(app.application_id, payment.payment_id, from.id) });
  } else if (originalMessage.document) {
    await sendDocument(chatId, originalMessage.document.file_id, { caption, reply_markup: adminPaymentKeyboard(app.application_id, payment.payment_id, from.id) });
  } else {
    await sendMessage(chatId, caption, { reply_markup: adminPaymentKeyboard(app.application_id, payment.payment_id, from.id) });
  }
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
  const keyboard = { inline_keyboard: [[{ text: '🎾 Open menu / Открыть меню', callback_data: 'main' }]] };
  let sent = 0, failed = 0;
  for (const c of contacts) {
    try {
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
