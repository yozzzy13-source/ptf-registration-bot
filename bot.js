import { sendMessage, editMessageText, answerCallbackQuery } from './telegram.js';
import { mainKeyboard, textKeyboard, paymentKeyboard, cryptoKeyboard, adminApplicationKeyboard } from './keyboards.js';
import { getBotText, getSetting, setSetting, getActiveEvents, getPaymentMethods, findApplication, updateApplication, logMessage, logPayment, updateApplicantStatusByTelegramId, findApplicantByTelegramId } from './sheets.js';
import { t } from './i18n.js';
import { langOf, nowISO, uid, escapeHtml } from './util.js';
import { notifyAdmin, notifyIncomingMessage, notifyPaymentProof, isAdminUser, handleAdminInit, adminStats, adminEvents, adminPending, adminMessages, adminProfile, startBroadcast, handleBroadcastMessage, handleBroadcastSegment, executeBroadcast, adminState, setApplicationStatus, setPaymentStatus } from './admin.js';
import { CLUB_CHAT_URL } from './config.js';

export const userState = new Map();

async function userLang(from) {
  const saved = await findApplicantByTelegramId(from.id).catch(() => null);
  return saved?.language || langOf(from.language_code);
}

async function sendMain(chatId, lang) {
  const txt = await getBotText('welcome_main', lang);
  await sendMessage(chatId, txt?.html_text || '<b>Welcome to Phuket Tennis Family</b> 🎾', { reply_markup: mainKeyboard(lang) });
}

async function sendTextSection(chatId, lang, key, editMsgId=null) {
  const txt = await getBotText(key, lang);
  const body = txt?.html_text || `<b>${escapeHtml(key)}</b>`;
  const opts = { reply_markup: textKeyboard(lang, key) };
  if (editMsgId) await editMessageText(chatId, editMsgId, body, opts);
  else await sendMessage(chatId, body, opts);
}

async function handlePaymentMenu(chatId, lang, applicationId) {
  await sendMessage(chatId, t(lang, 'choose_payment'), { reply_markup: paymentKeyboard(lang, applicationId) });
}

async function sendPaymentInstructions(chatId, lang, applicationId, methodId) {
  const app = await findApplication(applicationId);
  if (!app) return sendMessage(chatId, 'Application not found.');
  const methods = await getPaymentMethods();
  const method = methods.find(m => m.method_id === methodId);
  if (!method) return sendMessage(chatId, 'Payment method not found.');
  const paymentId = uid('payment');
  const isCrypto = method.method_type === 'crypto';
  const amount = isCrypto ? (app.payment_amount || 80) : (app.payment_amount || app.payment_amount_thb || 2490);
  const currency = isCrypto ? 'USDT' : (method.currency || 'THB');
  const network = method.network || '';
  const recipient = method.recipient || '';

  await logPayment({
    payment_id: paymentId,
    application_id: applicationId,
    telegram_id: app.telegram_id,
    player_name: app.player_name,
    event_id: app.event_id,
    event_name: app.event_name,
    method: method.display_name_en || methodId,
    network,
    amount,
    currency,
    invoice_text: `${methodId} ${amount} ${currency}`,
    status: 'invoice_created',
    notes: ''
  });
  await updateApplication(applicationId, {
    application_status: 'waiting_payment',
    payment_status: 'waiting_payment',
    payment_id: paymentId,
    payment_method: method.method_type,
    payment_network: network,
    payment_amount: amount,
    payment_currency: currency
  });
  await updateApplicantStatusByTelegramId(app.telegram_id, 'waiting_payment');

  userState.set(String(chatId), { mode: 'awaiting_payment_proof', applicationId, paymentId, methodId });

  let text;
  if (isCrypto) {
    text = lang === 'ru'
      ? `<b>💵 Оплата USDT ${escapeHtml(network)}</b>\n\nСумма: <b>${escapeHtml(amount)} USDT</b>\n\nАдрес кошелька ${escapeHtml(network)}:\n<code>${escapeHtml(recipient)}</code>\n\n⚠️ Убедитесь, что вы выбрали правильную сеть: <b>${escapeHtml(network)}</b>.\n\n${escapeHtml(t(lang, 'payment_refund_note'))}\n\n${t(lang, 'send_proof')}`
      : `<b>💵 USDT ${escapeHtml(network)} payment</b>\n\nAmount: <b>${escapeHtml(amount)} USDT</b>\n\nWallet address ${escapeHtml(network)}:\n<code>${escapeHtml(recipient)}</code>\n\n⚠️ Make sure you use the correct network: <b>${escapeHtml(network)}</b>.\n\n${escapeHtml(t(lang, 'payment_refund_note'))}\n\n${t(lang, 'send_proof')}`;
  } else {
    text = lang === 'ru'
      ? `<b>🏦 Оплата переводом на Thai Bank</b>\n\nСумма: <b>${escapeHtml(amount)} THB</b>\n\nРеквизиты:\n<code>${escapeHtml(recipient)}</code>\n\n${escapeHtml(t(lang, 'payment_refund_note'))}\n\n${t(lang, 'send_proof')}`
      : `<b>🏦 Thai bank transfer</b>\n\nAmount: <b>${escapeHtml(amount)} THB</b>\n\nBank details:\n<code>${escapeHtml(recipient)}</code>\n\n${escapeHtml(t(lang, 'payment_refund_note'))}\n\n${t(lang, 'send_proof')}`;
  }
  await sendMessage(chatId, text);
}

export async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const lang = await userLang(from);
  const text = (msg.text || '').trim();

  if (text === '/cancel') {
    userState.delete(String(chatId));
    adminState.delete(String(from.id));
    return sendMessage(chatId, t(lang, 'cancelled'));
  }

  if (text === '/start') return sendMain(chatId, lang);
  if (text === '/help') {
    if (isAdminUser(from.id) && (msg.chat.type === 'group' || msg.chat.type === 'supergroup' || await getSetting('admin_chat_id') === String(chatId))) {
      return sendMessage(chatId, t(lang, 'admin_help'));
    }
    return sendMessage(chatId, t(lang, 'help_user'), { reply_markup: mainKeyboard(lang) });
  }

  if (text === '/admin_init') {
    if (!isAdminUser(from.id)) return sendMessage(chatId, t(lang, 'admin_only'));
    return handleAdminInit(msg);
  }

  if (isAdminUser(from.id)) {
    if (text === '/stats') return adminStats(chatId);
    if (text === '/events') return adminEvents(chatId);
    if (text === '/pending') return adminPending(chatId);
    if (text === '/messages') return adminMessages(chatId);
    if (text.startsWith('/profile')) return adminProfile(chatId, text);
    if (text === '/broadcast') return startBroadcast(chatId, from.id);
    if (text === '/segments') return sendMessage(chatId, 'Segments: all, season2, active, waitlist, payment, ru, en, or crm_tags value.');

    const aState = adminState.get(String(from.id));
    if (aState?.mode === 'reply_waiting') {
      await sendMessage(aState.targetTelegramId, msg.text || msg.caption || '');
      await logMessage({ message_id: uid('msg'), telegram_id: aState.targetTelegramId, direction:'outgoing', message_type:'text', message_text: msg.text || msg.caption || '', timestamp:nowISO(), admin_id:from.id, admin_name:from.username || from.first_name || '', status:'sent' });
      adminState.delete(String(from.id));
      return sendMessage(chatId, '✅ Reply sent.');
    }
    if (aState?.mode === 'broadcast_message') return handleBroadcastMessage(msg, aState);

    if (msg.reply_to_message && (msg.reply_to_message.text || msg.reply_to_message.caption)) {
      const body = msg.reply_to_message.text || msg.reply_to_message.caption || '';
      const match = body.match(/TGID:\s*(?:<code>)?(\d+)/i) || body.match(/TGID:\s*(\d+)/i);
      if (match && text) {
        await sendMessage(match[1], text);
        await logMessage({ message_id: uid('msg'), telegram_id: match[1], direction:'outgoing', message_type:'text', message_text:text, timestamp:nowISO(), admin_id:from.id, admin_name:from.username || from.first_name || '', status:'sent' });
        return sendMessage(chatId, '✅ Reply sent.');
      }
    }
  }

  const state = userState.get(String(chatId));
  if (state?.mode === 'contact') {
    userState.delete(String(chatId));
    await logMessage({ message_id: uid('msg'), telegram_id: from.id, telegram_username: from.username || '', name: [from.first_name, from.last_name].filter(Boolean).join(' '), direction:'incoming', message_type:'text', message_text:text, timestamp:nowISO(), status:'new', telegram_message_id: msg.message_id });
    await notifyIncomingMessage({ id: from.id, username: from.username, name: [from.first_name, from.last_name].filter(Boolean).join(' ') }, text, msg.message_id);
    return sendMessage(chatId, t(lang, 'contact_sent'));
  }

  if (state?.mode === 'awaiting_payment_proof') {
    if (!msg.photo?.length && !msg.document) return sendMessage(chatId, t(lang, 'send_proof'));
    const app = await findApplication(state.applicationId);
    if (!app) return sendMessage(chatId, 'Application not found.');
    const fileId = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
    await updateApplication(state.applicationId, {
      application_status: 'proof_received',
      payment_status: 'proof_received',
      payment_proof_status: 'proof_received',
      payment_proof_file_id: fileId
    });
    await updateApplicantStatusByTelegramId(from.id, 'proof_received');
    await logPayment({
      payment_id: state.paymentId,
      application_id: state.applicationId,
      telegram_id: from.id,
      player_name: app.player_name,
      event_id: app.event_id,
      event_name: app.event_name,
      proof_file_id: fileId,
      proof_received_at: nowISO(),
      status: 'proof_received'
    });
    userState.delete(String(chatId));
    await notifyPaymentProof({ app, payment: { payment_id: state.paymentId, method: app.payment_method || state.methodId, network: app.payment_network, amount: app.payment_amount, currency: app.payment_currency }, from, originalMessage: msg });
    return sendMessage(chatId, t(lang, 'proof_received'));
  }

  return sendMain(chatId, lang);
}

export async function handleCallback(q) {
  const data = q.data || '';
  const msg = q.message;
  const chatId = msg.chat.id;
  const from = q.from || {};
  const lang = await userLang(from);
  await answerCallbackQuery(q.id).catch(() => {});

  if (data === 'main') return sendMain(chatId, lang);
  if (data.startsWith('text:')) return sendTextSection(chatId, lang, data.slice(5), msg.message_id);
  if (data === 'contact') {
    userState.set(String(chatId), { mode: 'contact' });
    return sendMessage(chatId, t(lang, 'contact_prompt'));
  }
  if (data.startsWith('payment_menu:')) return handlePaymentMenu(chatId, lang, data.split(':')[1]);
  if (data.startsWith('crypto:')) return sendMessage(chatId, t(lang, 'choose_crypto_network'), { reply_markup: cryptoKeyboard(lang, data.split(':')[1]) });
  if (data.startsWith('paylater:')) return sendMessage(chatId, t(lang, 'payment_later'));
  if (data.startsWith('pay:')) {
    const [, applicationId, methodId] = data.split(':');
    return sendPaymentInstructions(chatId, lang, applicationId, methodId);
  }

  if (isAdminUser(from.id)) {
    if (data.startsWith('admin_reply:')) {
      const targetTelegramId = data.split(':')[1];
      adminState.set(String(from.id), { mode:'reply_waiting', targetTelegramId });
      return sendMessage(chatId, `Write reply to TGID <code>${escapeHtml(targetTelegramId)}</code>.`);
    }
    if (data.startsWith('admin_status:')) {
      const [, applicationId, status] = data.split(':');
      return setApplicationStatus({ chatId, applicationId, status });
    }
    if (data.startsWith('admin_payment:')) {
      const [, applicationId, paymentId, status] = data.split(':');
      return setPaymentStatus({ chatId, applicationId, paymentId, status });
    }
    if (data.startsWith('bcseg:')) return handleBroadcastSegment(q, data.split(':')[1]);
    if (data === 'bcconfirm') return executeBroadcast(q);
    if (data === 'bccancel') { adminState.delete(String(from.id)); return sendMessage(chatId, 'Broadcast cancelled.'); }
  }
}

export async function sendPaymentStart(chatId, lang, applicationId) {
  await sendMessage(chatId, t(lang, 'application_received'), { reply_markup: paymentKeyboard(lang, applicationId) });
}
