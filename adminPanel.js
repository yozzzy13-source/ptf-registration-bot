import { ADMIN_IDS, SHEETS, BOT_TOKEN } from './config.js';
import { parseInitData, verifyTelegramInitData, nowISO, uid, escapeHtml } from './util.js';
import { getRows, logBroadcast, logBroadcastResult, logMessage, markSelfieRequested } from './sheets.js';
import { sendMessage } from './telegram.js';

function isAdminId(id) {
  if (!ADMIN_IDS.length) return true;
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
    crm_tags: row.crm_tags || ''
  };
}

function applyFilters(rows, filters={}) {
  const status = norm(filters.status);
  const division = norm(filters.division);
  const language = norm(filters.language);
  const selfie = norm(filters.selfie_status);
  const event = norm(filters.event);
  const search = norm(filters.search);
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
      const divisions = [...new Set(contacts.map(r => r.division).filter(Boolean))].sort();
      const statuses = [...new Set(contacts.map(r => r.status).filter(Boolean))].sort();
      res.json({ ok:true, admin:auth.user, stats:{ contacts:contacts.length, applications:applications.length, payments:payments.length, active, waitlist, missingSelfie }, contacts:contacts.map(publicContact), events, divisions, statuses });
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
      const contacts = applyFilters(await getContacts(), req.body.filters || {});
      const broadcastId = uid('broadcast');
      let sent = 0, failed = 0;
      for (const c of contacts) {
        try {
          await sendMessage(c.telegram_id, message);
          await logBroadcastResult({ broadcast_id:broadcastId, telegram_id:c.telegram_id, name:c.name, telegram_username:c.telegram_username, status:'sent', sent_at:nowISO(), language:c.language, segment_filter:JSON.stringify(req.body.filters || {}) });
          sent++;
        } catch (e) {
          await logBroadcastResult({ broadcast_id:broadcastId, telegram_id:c.telegram_id, name:c.name, telegram_username:c.telegram_username, status:'failed', sent_at:nowISO(), error:e.message, language:c.language, segment_filter:JSON.stringify(req.body.filters || {}) });
          failed++;
        }
      }
      await logBroadcast({ broadcast_id:broadcastId, created_at:nowISO(), admin_id:auth.user.id, admin_name:auth.user.username || auth.user.first_name || '', segment_filter:JSON.stringify(req.body.filters || {}), language:'mixed', message_text:message, media_type:'text', recipients_count:contacts.length, sent_count:sent, failed_count:failed, status:'sent' });
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

  app.post('/api/admin/request-selfie', async (req, res) => {
    try {
      const auth = adminFromInitData(req.body.initData || '');
      if (!auth.ok) return res.status(403).json(auth);
      const contacts = applyFilters(await getContacts(), { ...(req.body.filters || {}), selfie_status:'missing' }).filter(r => String(r.status).toLowerCase() === 'active');
      let sent = 0, failed = 0;
      for (const c of contacts) {
        const lang = c.language === 'ru' ? 'ru' : 'en';
        const text = lang === 'ru'
          ? '<b>📸 Пожалуйста, загрузите селфи</b>\n\nВы подтверждены как участник Phuket Tennis Family. Нам нужно одно селфи для вашей аватарки и карточки игрока на сайте PTF.\n\nНажмите кнопку ниже и отправьте фото в этот чат.'
          : '<b>📸 Please upload your selfie</b>\n\nYou are confirmed as a Phuket Tennis Family player. We need one selfie for your avatar and player profile card on the PTF website.\n\nTap the button below and send the photo to this chat.';
        try {
          await sendMessage(c.telegram_id, text, { reply_markup:{ inline_keyboard:[[ { text: lang === 'ru' ? '📸 Загрузить селфи' : '📸 Upload Selfie', callback_data:'upload_selfie' } ]] } });
          await markSelfieRequested(c.telegram_id);
          sent++;
        } catch(e) { failed++; }
      }
      res.json({ ok:true, recipients:contacts.length, sent, failed });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });
}
