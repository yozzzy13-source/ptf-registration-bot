import { ADMIN_IDS, SHEETS, BOT_TOKEN, PUBLIC_URL } from './config.js';
import { parseInitData, verifyTelegramInitData, nowISO, uid, escapeHtml } from './util.js';
import { getRows, logBroadcast, logBroadcastResult, logMessage, markSelfieRequested, hasMissingRating } from './sheets.js';
import { sendMessage } from './telegram.js';
import { ratingUpdateKeyboard, missingRatingMessage } from './admin.js';

function isAdminId(id) {
  if (!ADMIN_IDS.length) return false;
  return ADMIN_IDS.includes(String(id));
}

function adminFromInitData(initData='') {
  const { user } = parseInitData(initData || '');
  const verified = verifyTelegramInitData(initData || '');
  if (BOT_TOKEN && process.env.NODE_ENV === 'production' && !verified) return { ok:false, error:'Invalid Telegram initData' };
  if (!user?.id) return { ok:false, error:'Telegram user not found' };
  if (!isAdminId(user.id)) return { ok:false, error:'Access denied' };
  return { ok:true, user };
}

function norm(v) { return String(v || '').trim().toLowerCase(); }
function publicContact(row) {
  return {
    row: row._rowNumber,
    telegram_id: row.telegram_id || '',
    telegram_username: row.telegram_username || '',
    name: row.name || '',
    status: row.status || '',
    division: row.division || '',
    language: row.language || '',
    selfie_status: row.selfie_status || '',
    last_application_event: row.last_application_event || '',
    country: row.country_of_origin || '',
    whatsapp: row.whatsapp || '',
    crm_tags: row.crm_tags || '',
    ntrp: row.ntrp || '',
    missing_rating: hasMissingRating(row)
  };
}


// Optional inline button attached to a panel broadcast. WebApp buttons open the mini app directly.
function broadcastButtonMarkup(kind='', lang='en') {
  const ru = lang === 'ru';
  if (kind === 'participants') return { inline_keyboard: [[{ text: ru ? '👥 Список участников' : '👥 Participants List', web_app: { url: `${PUBLIC_URL}/participants` } }]] };
  if (kind === 'join_event') return { inline_keyboard: [[{ text: ru ? '🏆 Участвовать в событии' : '🏆 Join Event', web_app: { url: `${PUBLIC_URL}/apply?mode=event` } }]] };
  if (kind === 'payment') return { inline_keyboard: [[{ text: ru ? '💳 Оплата' : '💳 Payment', callback_data: 'payment_entry' }]] };
  if (kind === 'main') return { inline_keyboard: [[{ text: ru ? '🏠 Главное меню' : '🏠 Main menu', callback_data: 'main' }]] };
  return null;
}

function applyFilters(rows, filters={}) {
  const status = norm(filters.status);
  const division = norm(filters.division);
  const language = norm(filters.language);
  const selfie = norm(filters.selfie_status);
  const event = norm(filters.event);
  const search = norm(filters.search);
  const rating = norm(filters.rating);
  const selected = Array.isArray(filters.selected_ids) ? filters.selected_ids.map(String) : [];
  return rows.filter(r => {
    if (!r.telegram_id) return false;
    if (selected.length && !selected.includes(String(r.telegram_id))) return false;
    if (status && norm(r.status) !== status) return false;
    if (division && norm(r.division) !== division) return false;
    if (language && (language === 'ru' ? norm(r.language) !== 'ru' : norm(r.language) === 'ru')) return false;
    if (selfie) {
      if (selfie === 'missing') {
        if (norm(r.selfie_status) === 'received') return false;
      } else if (norm(r.selfie_status) !== selfie) return false;
    }
    if (event && !norm(r.last_application_event).includes(event)) return false;
    if (rating === 'missing' && !hasMissingRating(r)) return false;
    if (rating === 'set' && hasMissingRating(r)) return false;
    if (search) {
      const hay = [r.name, r.telegram_username, r.telegram_id, r.whatsapp, r.country_of_origin, r.crm_tags].map(norm).join(' ');
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

async function getContacts() {
  return (await getRows(SHEETS.applicants, { useCache:false })).rows;
}

export function registerAdminRoutes(app) {
  app.get('/admin', (req, res) => res.sendFile(process.cwd() + '/public/admin.html'));

  app.get('/api/admin/bootstrap', async (req, res) => {
    try {
      const auth = adminFromInitData(req.query.initData || '');
      if (!auth.ok) return res.status(403).json(auth);
      const contacts = await getContacts();
      const applications = (await getRows(SHEETS.applications, { useCache:false })).rows;
      const payments = (await getRows(SHEETS.payments, { useCache:false })).rows;
      const events = (await getRows(SHEETS.events, { useCache:false })).rows;
      const active = contacts.filter(r => r.status === 'active').length;
      const waitlist = contacts.filter(r => r.status === 'waitlist').length;
      const missingSelfie = contacts.filter(r => r.status === 'active' && String(r.selfie_status || '').toLowerCase() !== 'received').length;
      const payStatus = s => applications.filter(a => norm(a.payment_status) === s).length;
      const unpaid = applications.filter(a => ['payment_required','waiting_payment'].includes(norm(a.payment_status))).length;
      const proofReceived = payStatus('proof_received');
      const paid = payStatus('approved');
      const rejectedPayments = payStatus('rejected');
      const approvedPayments = payments.filter(p => norm(p.status) === 'approved');
      const paidThb = approvedPayments.filter(p => norm(p.currency) === 'thb').reduce((sum,p) => sum + Number(p.amount || 0), 0);
      const paidUsdt = approvedPayments.filter(p => norm(p.currency) === 'usdt').reduce((sum,p) => sum + Number(p.amount || 0), 0);
      const divisions = [...new Set(contacts.map(r => r.division).filter(Boolean))].sort();
      const statuses = [...new Set(contacts.map(r => r.status).filter(Boolean))].sort();
      res.json({ ok:true, admin:auth.user, stats:{ contacts:contacts.length, applications:applications.length, active, waitlist, unpaid, proofReceived, paid, rejectedPayments, paidThb, paidUsdt, missingSelfie }, contacts:contacts.map(publicContact), events, divisions, statuses });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  app.post('/api/admin/preview', async (req, res) => {
    try {
      const auth = adminFromInitData(req.body.initData || '');
      if (!auth.ok) return res.status(403).json(auth);
      const contacts = applyFilters(await getContacts(), req.body.filters || {});
      res.json({ ok:true, count:contacts.length, contacts:contacts.map(publicContact) });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  app.post('/api/admin/broadcast', async (req, res) => {
    try {
      const auth = adminFromInitData(req.body.initData || '');
      if (!auth.ok) return res.status(403).json(auth);
      const message = String(req.body.message || '').trim();
      if (!message) return res.status(400).json({ ok:false, error:'Message is empty' });
      const button = String(req.body.button || '').trim();
      const contacts = applyFilters(await getContacts(), req.body.filters || {});
      const broadcastId = uid('broadcast');
      let sent = 0, failed = 0;
      for (const c of contacts) {
        try {
          const markup = broadcastButtonMarkup(button, c.language === 'ru' ? 'ru' : 'en');
          await sendMessage(c.telegram_id, message, markup ? { reply_markup: markup } : {});
          await logBroadcastResult({ broadcast_id:broadcastId, telegram_id:c.telegram_id, name:c.name, telegram_username:c.telegram_username, status:'sent', sent_at:nowISO(), language:c.language, segment_filter:JSON.stringify(req.body.filters || {}) });
          sent++;
        } catch (e) {
          await logBroadcastResult({ broadcast_id:broadcastId, telegram_id:c.telegram_id, name:c.name, telegram_username:c.telegram_username, status:'failed', sent_at:nowISO(), error:e.message, language:c.language, segment_filter:JSON.stringify(req.body.filters || {}) });
          failed++;
        }
      }
      await logBroadcast({ broadcast_id:broadcastId, created_at:nowISO(), admin_id:auth.user.id, admin_name:auth.user.username || auth.user.first_name || '', segment_filter:JSON.stringify(req.body.filters || {}), language:'mixed', message_text:message, media_type: button ? `text+button:${button}` : 'text', recipients_count:contacts.length, sent_count:sent, failed_count:failed, status:'sent' });
      res.json({ ok:true, broadcast_id:broadcastId, recipients:contacts.length, sent, failed });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });


  app.post('/api/admin/request-rating', async (req, res) => {
    try {
      const auth = adminFromInitData(req.body.initData || '');
      if (!auth.ok) return res.status(403).json(auth);
      const contacts = applyFilters(await getContacts(), req.body.filters || {}).filter(hasMissingRating);
      const broadcastId = uid('broadcast');
      let sent = 0, failed = 0;
      for (const c of contacts) {
        const lang = c.language === 'ru' ? 'ru' : 'en';
        try {
          await sendMessage(c.telegram_id, missingRatingMessage(lang), { reply_markup: ratingUpdateKeyboard(lang) });
          await logBroadcastResult({ broadcast_id:broadcastId, telegram_id:c.telegram_id, name:c.name, telegram_username:c.telegram_username, status:'sent', sent_at:nowISO(), language:lang, segment_filter:'missing_rating_panel' });
          sent++;
        } catch(e) {
          await logBroadcastResult({ broadcast_id:broadcastId, telegram_id:c.telegram_id, name:c.name, telegram_username:c.telegram_username, status:'failed', sent_at:nowISO(), error:e.message, language:lang, segment_filter:'missing_rating_panel' });
          failed++;
        }
      }
      await logBroadcast({ broadcast_id:broadcastId, created_at:nowISO(), admin_id:auth.user.id, admin_name:auth.user.username || auth.user.first_name || '', segment_filter:'missing_rating_panel', language:'mixed', message_text:'Update NTRP (Raketo)', media_type:'text', recipients_count:contacts.length, sent_count:sent, failed_count:failed, status:'sent' });
      res.json({ ok:true, broadcast_id:broadcastId, recipients:contacts.length, sent, failed });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  app.post('/api/admin/direct-message', async (req, res) => {
    try {
      const auth = adminFromInitData(req.body.initData || '');
      if (!auth.ok) return res.status(403).json(auth);
      const telegramId = String(req.body.telegram_id || '').trim();
      const message = String(req.body.message || '').trim();
      if (!telegramId || !message) return res.status(400).json({ ok:false, error:'telegram_id and message are required' });
      await sendMessage(telegramId, message);
      await logMessage({ message_id:uid('msg'), telegram_id:telegramId, direction:'outgoing', message_type:'text', message_text:message, timestamp:nowISO(), admin_id:auth.user.id, admin_name:auth.user.username || auth.user.first_name || '', status:'sent' });
      res.json({ ok:true });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  // Broadcast history: one row per broadcast (newest first), recipients loaded on demand.
  app.get('/api/admin/broadcasts', async (req, res) => {
    try {
      const auth = adminFromInitData(req.query.initData || '');
      if (!auth.ok) return res.status(403).json(auth);
      const limit = Math.min(200, Math.max(1, Number(req.query.limit || 60)));
      const rows = (await getRows(SHEETS.broadcasts, { useCache:false })).rows
        .filter(r => r.broadcast_id)
        .sort((a,b) => Number(b._rowNumber || 0) - Number(a._rowNumber || 0))
        .slice(0, limit)
        .map(r => ({ broadcast_id:r.broadcast_id, created_at:r.created_at || '', admin_name:r.admin_name || r.admin_id || '', segment_filter:r.segment_filter || '', message_text:String(r.message_text || ''), media_type:r.media_type || 'text', recipients:Number(r.recipients_count || 0), sent:Number(r.sent_count || 0), failed:Number(r.failed_count || 0) }));
      res.json({ ok:true, broadcasts:rows });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  app.get('/api/admin/broadcast-logs', async (req, res) => {
    try {
      const auth = adminFromInitData(req.query.initData || '');
      if (!auth.ok) return res.status(403).json(auth);
      const broadcastId = String(req.query.broadcast_id || '').trim();
      if (!broadcastId) return res.status(400).json({ ok:false, error:'broadcast_id is required' });
      const rows = (await getRows(SHEETS.broadcastLogs, { useCache:false })).rows
        .filter(r => String(r.broadcast_id) === broadcastId)
        .map(r => ({ telegram_id:r.telegram_id || '', name:r.name || '', telegram_username:r.telegram_username || '', status:r.status || '', sent_at:r.sent_at || '', error:r.error || '', language:r.language || '' }))
        .sort((a,b) => (a.status === 'failed' ? 0 : 1) - (b.status === 'failed' ? 0 : 1));
      res.json({ ok:true, broadcast_id:broadcastId, logs:rows });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  app.post('/api/admin/request-selfie', async (req, res) => {
    try {
      const auth = adminFromInitData(req.body.initData || '');
      if (!auth.ok) return res.status(403).json(auth);
      const contacts = applyFilters(await getContacts(), { ...(req.body.filters || {}), selfie_status:'missing' }).filter(r => String(r.status).toLowerCase() === 'active');
      const broadcastId = uid('broadcast');
      let sent = 0, failed = 0;
      for (const c of contacts) {
        const lang = c.language === 'ru' ? 'ru' : 'en';
        const text = lang === 'ru'
          ? '<b>📸 Пожалуйста, загрузите селфи</b>\n\nВы подтверждены как участник Phuket Tennis Family. Нам нужно одно селфи для вашей аватарки и карточки игрока на сайте PTF.\n\nНажмите кнопку ниже и отправьте фото в этот чат.'
          : '<b>📸 Please upload your selfie</b>\n\nYou are confirmed as a Phuket Tennis Family player. We need one selfie for your avatar and player profile card on the PTF website.\n\nTap the button below and send the photo to this chat.';
        try {
          await sendMessage(c.telegram_id, text, { reply_markup:{ inline_keyboard:[[ { text: lang === 'ru' ? '📸 Загрузить селфи' : '📸 Upload Selfie', callback_data:'upload_selfie' } ]] } });
          await markSelfieRequested(c.telegram_id);
          await logBroadcastResult({ broadcast_id:broadcastId, telegram_id:c.telegram_id, name:c.name, telegram_username:c.telegram_username, status:'sent', sent_at:nowISO(), language:lang, segment_filter:'selfie_request_panel' });
          sent++;
        } catch(e) {
          await logBroadcastResult({ broadcast_id:broadcastId, telegram_id:c.telegram_id, name:c.name, telegram_username:c.telegram_username, status:'failed', sent_at:nowISO(), error:e.message, language:lang, segment_filter:'selfie_request_panel' });
          failed++;
        }
      }
      await logBroadcast({ broadcast_id:broadcastId, created_at:nowISO(), admin_id:auth.user.id, admin_name:auth.user.username || auth.user.first_name || '', segment_filter:'selfie_request_panel', language:'mixed', message_text:'Selfie request', media_type:'text', recipients_count:contacts.length, sent_count:sent, failed_count:failed, status:'sent' });
      res.json({ ok:true, broadcast_id:broadcastId, recipients:contacts.length, sent, failed });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });
}
