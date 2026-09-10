import { ADMIN_IDS, SHEETS, BOT_TOKEN, PUBLIC_URL } from './config.js';
import { parseInitData, verifyTelegramInitData, nowISO, uid, escapeHtml } from './util.js';
import { getRows, logBroadcast, logBroadcastResult, logMessage, markSelfieRequested, hasMissingRating, needsRatingCheck } from './sheets.js';
import { sendMessage } from './telegram.js';
import { ratingUpdateKeyboard, missingRatingMessage } from './admin.js';
import { parseTemplate, renderText, renderButtons, getBotUsername, linksCheatSheet, DESTINATIONS, destinationLabel } from './links.js';

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
      res.json({ ok:true, admin:auth.user, stats:{ contacts:contacts.length, applications:applications.length, active, waitlist, unpaid, proofReceived, paid, rejectedPayments, paidThb, paidUsdt, missingSelfie }, contacts:contacts.map(publicContact), events, divisions, statuses,
        link_codes: DESTINATIONS.map(d => ({ code: d.aliases[0] || d.code, label: d.ru })) });
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

  // Предпросмотр рассылки: как будет выглядеть текст и какие кнопки прилипнут.
  app.post('/api/admin/broadcast-preview', async (req, res) => {
    try {
      const auth = adminFromInitData(req.body.initData || '');
      if (!auth.ok) return res.status(403).json(auth);
      const lang = String(req.body.lang || 'ru').toLowerCase() === 'en' ? 'en' : 'ru';
      const parsed = parseTemplate(String(req.body.message || ''));
      res.json({
        ok: true,
        text: renderText(parsed, lang, await getBotUsername()),
        buttons: parsed.buttons.map(b => b.custom || destinationLabel(b.dest, lang)),
        inline: parsed.inline.length,
        unknown: parsed.unknown
      });
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
      // Коды разделов в тексте ({оплата}, {состав}, {!гонка}) превращаются
      // в кнопки под сообщением с названием на языке получателя.
      const parsed = parseTemplate(message);
      const username = await getBotUsername();
      const broadcastId = uid('broadcast');
      let sent = 0, failed = 0;
      for (const c of contacts) {
        try {
          const lang = String(c.language || '').toLowerCase() === 'ru' ? 'ru' : 'en';
          const body = parsed.hasLinks ? renderText(parsed, lang, username) : message;
          // Кнопка из выпадающего списка панели добавляется отдельной строкой снизу.
          const fromCodes = renderButtons(parsed, lang);
          const fromPicker = broadcastButtonMarkup(button, lang);
          const rows = [...(fromCodes?.inline_keyboard || []), ...(fromPicker?.inline_keyboard || [])];
          const markup = rows.length ? { inline_keyboard: rows } : null;
          await sendMessage(c.telegram_id, body, markup ? { reply_markup: markup } : {});
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
      // scope=recheck — вместе с теми, чью цифру организатор не подтверждал.
      const pick = req.body.scope === 'recheck' ? needsRatingCheck : hasMissingRating;
      const contacts = applyFilters(await getContacts(), req.body.filters || {}).filter(pick);
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
      // В персональное сообщение вешаем кнопки так же, как в рассылке: коды
      // разделов прямо в тексте плюс кнопка из выпадающего списка.
      const contact = (await getContacts()).find(c => String(c.telegram_id) === telegramId);
      const lang = String(contact?.language || '').toLowerCase() === 'ru' ? 'ru' : 'en';
      const parsed = parseTemplate(message);
      const username = await getBotUsername();
      const body = parsed.hasLinks ? renderText(parsed, lang, username) : message;
      const rows = [
        ...(renderButtons(parsed, lang)?.inline_keyboard || []),
        ...(broadcastButtonMarkup(String(req.body.button || '').trim(), lang)?.inline_keyboard || [])
      ];
      await sendMessage(telegramId, body, rows.length ? { reply_markup: { inline_keyboard: rows } } : {});
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
          ? '<b>🖼 Сделай себе аватарку PTF</b>\n\nЗагрузи одно селфи — и получишь аватарку для своей карточки игрока. Можно сделать до трёх вариантов и выбрать тот, что больше нравится.\n\nЧто нужно от фото: лицо крупно, дневной свет, без кепки и тёмных очков, один человек в кадре.'
          : '<b>🖼 Create your PTF avatar</b>\n\nUpload one selfie and get an avatar for your player card. You can make up to three versions and pick the one you like best.\n\nWhat the photo needs: face close up, daylight, no cap or sunglasses, one person in the frame.';
        try {
          // Кнопка ведёт сразу на экран аватарки в своей карточке — раньше она
          // просто просила прислать фото в чат, и половина людей терялась.
          await sendMessage(c.telegram_id, text, { reply_markup:{ inline_keyboard:[
            [{ text: lang === 'ru' ? '🖼 Сделать аватарку' : '🖼 Create my avatar', web_app:{ url: `${PUBLIC_URL}/league?player=me` } }]
          ] } });
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

  // --- события ---------------------------------------------------------------
  // Карточка создаётся здесь, а подтверждение и рассылка идут в боте: так
  // организатор видит событие ровно тем сообщением, которое получат игроки.
  // Подтверждение участия из панели: то же, что кнопка в карточке игрока.
  app.post('/api/admin/activate-player', async (req, res) => {
    try {
      const auth = adminFromInitData(req.body.initData || '');
      if (!auth.ok) return res.status(403).json(auth);
      const telegramId = String(req.body.telegram_id || '').trim();
      if (!telegramId) return res.status(400).json({ ok:false, error:'Нужен telegram_id' });
      const { activatePlayer } = await import('./admin.js');
      await activatePlayer({ chatId: auth.user.id, telegramId });
      res.json({ ok:true });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  app.get('/api/admin/events', async (req, res) => {
    try {
      const auth = adminFromInitData(req.query.initData || '');
      if (!auth.ok) return res.status(403).json(auth);
      const { listEvents, listSignups } = await import('./events.js');
      const events = await listEvents({ includeDrafts:true });
      const signups = await listSignups();
      res.json({ ok:true, events: events.map(e => ({
        ...e,
        signups: signups.filter(s => s.event_id === e.event_id && s.status !== 'cancelled').length,
        seats: signups.filter(s => s.event_id === e.event_id && s.status !== 'cancelled')
          .reduce((n, s) => n + 1 + (s.guests || 0), 0)
      })) });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  app.post('/api/admin/event-save', async (req, res) => {
    try {
      const auth = adminFromInitData(req.body.initData || '');
      if (!auth.ok) return res.status(403).json(auth);
      const { createEvent, updateEvent, findEvent } = await import('./events.js');
      const body = req.body.event || {};
      // Что было до правки — чтобы сказать записавшимся, если поменялись дата,
      // время, место или срок записи.
      const before = body.event_id ? await findEvent(body.event_id).catch(() => null) : null;
      const event = body.event_id
        ? await updateEvent(body.event_id, {
            title_ru:body.title_ru, title_en:body.title_en,
            description_ru:body.description_ru, description_en:body.description_en,
            date:body.date, time:body.time, place:body.place, place_url:body.place_url || '',
            price_thb:body.price_thb ?? '', guest_price_thb:body.guest_price_thb ?? '',
            capacity:body.capacity ?? '', signup_deadline:body.signup_deadline || '',
            payment_required: body.payment_required ? 'TRUE' : 'FALSE',
            guests_allowed: body.guests_allowed ? 'TRUE' : 'FALSE',
            max_guests: body.max_guests ?? '', refund_hours: body.refund_hours ?? '',
            audience: body.audience || 'all',
            audience_division: String(body.audience_division || '').toUpperCase(),
            invite_only: body.invite_only ? 'TRUE' : 'FALSE',
            invited_ids: Array.isArray(body.invited_ids) ? body.invited_ids.join(',') : String(body.invited_ids || '')
          })
        : await createEvent(body, auth.user.id);
      if (!event) return res.status(404).json({ ok:false, error:'Событие не найдено' });
      let notified = 0;
      if (before && before.status === 'published') {
        const { describeEventChanges, notifyEventChanged } = await import('./eventflow.js');
        const changes = describeEventChanges(before, event);
        if (changes.length) {
          const { getAdminChatId } = await import('./admin.js');
          const adminChatId = await getAdminChatId().catch(() => '');
          const r = await notifyEventChanged(event, changes, adminChatId).catch(() => ({ sent: 0 }));
          notified = r.sent || 0;
        }
      }
      res.json({ ok:true, event, notified });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  // Отправляет организатору предпросмотр карточки с кнопками подтверждения.
  app.post('/api/admin/event-preview', async (req, res) => {
    try {
      const auth = adminFromInitData(req.body.initData || '');
      if (!auth.ok) return res.status(403).json(auth);
      const { eventPreview } = await import('./admin.js');
      await eventPreview(auth.user.id, String(req.body.event_id || ''));
      res.json({ ok:true });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  app.get('/api/admin/balances', async (req, res) => {
    try {
      const auth = adminFromInitData(req.query.initData || '');
      if (!auth.ok) return res.status(403).json(auth);
      const { allBalances } = await import('./events.js');
      res.json({ ok:true, balances: await allBalances() });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  // Начисление и списание руками: депозит игрока правится только отсюда.
  app.post('/api/admin/balance-change', async (req, res) => {
    try {
      const auth = adminFromInitData(req.body.initData || '');
      if (!auth.ok) return res.status(403).json(auth);
      const { addTransaction } = await import('./events.js');
      const amount = Number(req.body.amount || 0);
      if (!req.body.telegram_id || !amount) return res.status(400).json({ ok:false, error:'Нужны игрок и сумма' });
      const left = await addTransaction({
        telegramId: String(req.body.telegram_id), name: String(req.body.name || ''),
        type: amount > 0 ? 'пополнение' : 'списание', amount,
        description: String(req.body.comment || 'правка организатора')
      });
      res.json({ ok:true, balance:left });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });
}
