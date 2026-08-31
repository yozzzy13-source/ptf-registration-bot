import { sendMessage, sendPhoto, sendDocument, sendVideo, sendVoice, sendAudio, sendVideoNote, sendSticker, copyMessage, sendPoll, createForumTopic } from './telegram.js';
import { getSetting, setSetting, getRows, getSegmentContacts, logBroadcast, logBroadcastResult, findApplication, updateApplication, updateApplicantStatusByTelegramId, updatePayment, findApplicantByTelegramId, upsertPollResult, findPollResultsByBroadcastId, summarizePollRows, updateApplicantAdminTopic } from './sheets.js';
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

function playerTopicName(profileOrFrom={}) {
  const name = String(profileOrFrom.name || [profileOrFrom.first_name, profileOrFrom.last_name].filter(Boolean).join(' ') || 'Player').trim();
  const username = String(profileOrFrom.telegram_username || profileOrFrom.username || '').replace(/^@/, '');
  const id = String(profileOrFrom.telegram_id || profileOrFrom.id || '').trim();
  const base = `${name}${username ? ' @' + username : id ? ' ' + id : ''}`.trim();
  return base.slice(0, 120) || `Player ${id}`;
}

export async function getOrCreatePlayerTopic(player={}) {
  const chatId = await getAdminChatId();
  if (!chatId) return null;
  const telegramId = player.telegram_id || player.id;
  if (!telegramId) return null;
  const profile = await findApplicantByTelegramId(telegramId).catch(() => null);
  const currentTopicId = profile?.admin_topic_id || player.admin_topic_id || '';
  if (currentTopicId) return { chatId, message_thread_id: Number(currentTopicId), topicName: profile?.admin_topic_name || playerTopicName(profile || player), existing:true };
  const topicName = playerTopicName(profile || player);
  try {
    const topic = await createForumTopic(chatId, topicName);
    const threadId = topic?.message_thread_id;
    if (threadId) {
      await updateApplicantAdminTopic(telegramId, { admin_topic_id:String(threadId), admin_topic_name:topicName, admin_topic_created_at:nowISO() }).catch(() => {});
      return { chatId, message_thread_id: threadId, topicName, existing:false };
    }
  } catch (e) {
    console.error('createForumTopic failed; falling back to General:', e.message);
  }
  return { chatId, topicName, existing:false };
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

export async function notifyIncomingMessage(from, text, telegramMessageId, sourceChatId=null, originalMessage=null) {
  const topic = await getOrCreatePlayerTopic(from);
  const chatId = topic?.chatId || await getAdminChatId();
  if (!chatId) return null;
  const header = `<b>💬 New message from player</b>

TGID: <code>${escapeHtml(from.id)}</code>
From: <b>${escapeHtml(from.name || '')}</b> ${from.username ? '@'+escapeHtml(from.username) : ''}`;
  const topicOpts = withTopicOpts(topic, {
    reply_markup: { inline_keyboard: [[{ text: '💬 Reply', callback_data: `admin_reply:${from.id}` }]] }
  });
  const hasMedia = originalMessage && (originalMessage.photo?.length || originalMessage.document || originalMessage.video || originalMessage.voice || originalMessage.audio || originalMessage.sticker || originalMessage.video_note);
  if (hasMedia && sourceChatId && telegramMessageId) {
    await sendMessage(chatId, `${header}

${escapeHtml(text || '[media]')}`, topicOpts);
    return copyMessage(chatId, sourceChatId, telegramMessageId, withTopicOpts(topic, {}));
  }
  return sendMessage(chatId, `${header}

${escapeHtml(text)}`, topicOpts);
}

function paymentProofFile(originalMessage={}) {
  if (originalMessage.photo?.length) return { type:'photo', fileId: originalMessage.photo[originalMessage.photo.length - 1].file_id };
  if (originalMessage.document) return { type:'document', fileId: originalMessage.document.file_id };
  if (originalMessage.video) return { type:'video', fileId: originalMessage.video.file_id };
  if (originalMessage.voice) return { type:'voice', fileId: originalMessage.voice.file_id };
  if (originalMessage.audio) return { type:'audio', fileId: originalMessage.audio.file_id };
  if (originalMessage.video_note) return { type:'video_note', fileId: originalMessage.video_note.file_id };
  if (originalMessage.sticker) return { type:'sticker', fileId: originalMessage.sticker.file_id };
  return null;
}

async function sendProofFileToTopic(chatId, topic, originalMessage) {
  if (originalMessage?.chat?.id && originalMessage?.message_id) {
    try {
      await copyMessage(chatId, originalMessage.chat.id, originalMessage.message_id, withTopicOpts(topic, {}));
      return true;
    } catch (copyError) {
      console.error('copy payment proof failed; trying file_id fallback:', copyError.message);
    }
  }

  const proof = paymentProofFile(originalMessage || {});
  if (!proof?.fileId) return false;
  const opts = withTopicOpts(topic, {});
  if (proof.type === 'photo') await sendPhoto(chatId, proof.fileId, withTopicOpts(topic, { caption: 'Payment proof screenshot' }));
  else if (proof.type === 'document') await sendDocument(chatId, proof.fileId, withTopicOpts(topic, { caption: 'Payment proof file' }));
  else if (proof.type === 'video') await sendVideo(chatId, proof.fileId, opts);
  else if (proof.type === 'voice') await sendVoice(chatId, proof.fileId, opts);
  else if (proof.type === 'audio') await sendAudio(chatId, proof.fileId, opts);
  else if (proof.type === 'video_note') await sendVideoNote(chatId, proof.fileId, opts);
  else if (proof.type === 'sticker') await sendSticker(chatId, proof.fileId, opts);
  return true;
}

export async function notifyPaymentProof({ app, payment={}, from, originalMessage }) {
  const topic = await getOrCreatePlayerTopic({ ...from, id: from.id, name: app.player_name, telegram_id: app.telegram_id });
  const chatId = topic?.chatId || await getAdminChatId();
  if (!chatId) return;
  const paymentId = payment.payment_id || app.payment_id || '';
  const caption = `<b>💳 Payment proof received</b>

Application: <code>${escapeHtml(app.application_id)}</code>
${paymentId ? `Payment: <code>${escapeHtml(paymentId)}</code>
` : ''}TGID: <code>${escapeHtml(from.id)}</code>
Player: <b>${escapeHtml(app.player_name)}</b> ${from.username ? '@'+escapeHtml(from.username) : ''}
Event: ${escapeHtml(app.event_name)}
Method: <b>${escapeHtml(payment.method || app.payment_method || '')}</b> ${escapeHtml(payment.network || app.payment_network || '')}
Amount: <b>${escapeHtml(payment.amount || app.payment_amount || '')} ${escapeHtml(payment.currency || app.payment_currency || '')}</b>

Proof is copied below.`;
  const reviewOpts = withTopicOpts(topic, { reply_markup: adminPaymentKeyboard(app.application_id, paymentId, from.id) });

  await sendMessage(chatId, caption, reviewOpts);

  const copied = await sendProofFileToTopic(chatId, topic, originalMessage).catch(e => {
    console.error('send payment proof file to topic failed:', e.message);
    return false;
  });

  if (!copied) {
    await sendMessage(chatId, '<b>⚠️ Payment proof was received, but the bot could not copy the media file. Please ask the player to resend the screenshot.</b>', withTopicOpts(topic, {}));
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
