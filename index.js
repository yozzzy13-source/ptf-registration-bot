import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { PORT, PUBLIC_URL, BOT_TOKEN, SPREADSHEET_ID, DEFAULT_USDT_AMOUNT, SHEETS } from './config.js';
import { setWebhook, setCommands, sendMessage } from './telegram.js';
import { handleMessage, handleCallback, sendPaymentStart } from './bot.js';
import { getActiveEvents, upsertApplicant, createApplication, getPaymentMethods, getRows } from './sheets.js';
import { langOf, parseInitData, verifyTelegramInitData, uid, nowISO, safe } from './util.js';
import { notifyNewApplication } from './admin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.send('PTF Registration Bot is running'));
app.get('/apply', (req, res) => res.sendFile(path.join(__dirname, 'public', 'apply.html')));

const seen = new Set();
app.post('/webhook', async (req, res) => {
  res.status(200).send('ok');
  try {
    const update = req.body;
    if (update.update_id !== undefined) {
      if (seen.has(update.update_id)) return;
      seen.add(update.update_id);
      if (seen.size > 2000) seen.clear();
    }
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
  } catch (e) {
    console.error('webhook error', e);
  }
});

app.get('/api/bootstrap', async (req, res) => {
  try {
    const initData = req.query.initData || '';
    const { user } = parseInitData(initData);
    const lang = langOf(user?.language_code);
    const events = await getActiveEvents();
    const apps = (await getRows(SHEETS.applications, { useCache:false })).rows;
    const enrichedEvents = events.map(ev => ({ ...ev, applications_count: apps.filter(a => String(a.event_id) === String(ev.event_id)).length }));
    res.json({ ok: true, user, lang, events: enrichedEvents, usdtAmount: DEFAULT_USDT_AMOUNT });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get('/api/payment-methods', async (req, res) => {
  try {
    const methods = await getPaymentMethods();
    res.json({ ok:true, methods });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/submit-application', async (req, res) => {
  try {
    const { initData = '', profile = {}, event_id } = req.body || {};
    const verified = verifyTelegramInitData(initData);
    const { user } = parseInitData(initData);
    if (!user?.id) return res.status(400).json({ ok:false, error:'Telegram WebApp user not found' });
    if (BOT_TOKEN && !verified && process.env.NODE_ENV === 'production') {
      return res.status(403).json({ ok:false, error:'Invalid Telegram initData' });
    }

    const events = await getActiveEvents();
    const event = events.find(e => e.event_id === event_id);
    if (!event) return res.status(400).json({ ok:false, error:'Event not active' });

    const lang = langOf(user.language_code);
    const username = user.username || '';
    const fullName = safe(profile.name) || [user.first_name, user.last_name].filter(Boolean).join(' ');
    const eventName = lang === 'ru' ? (event.event_name_ru || event.event_name_en) : (event.event_name_en || event.event_name_ru);
    const applicationId = uid('app');
    const priceThb = Number(event.price_thb || 0);

    const applicant = await upsertApplicant({
      name: fullName,
      ntrp: profile.ntrp_unknown ? 'unknown' : safe(profile.ntrp),
      status: 'waiting_payment',
      experience: safe(profile.experience),
      gender: safe(profile.gender),
      age: safe(profile.age),
      country_of_origin: safe(profile.country_of_origin),
      telegram: username ? `t.me/${username}` : '',
      whatsapp: safe(profile.whatsapp),
      notes: safe(profile.notes),
      telegram_id: user.id,
      telegram_username: username,
      language: lang,
      source: 'telegram_webapp',
      last_application_event: eventName,
      selfie_status: 'optional_missing',
      crm_tags: `league_interested,${event.event_id}`
    });

    const appRow = {
      application_id: applicationId,
      telegram_id: user.id,
      telegram_username: username,
      player_name: fullName,
      event_id: event.event_id,
      event_name: eventName,
      application_status: 'waiting_payment',
      submitted_at: nowISO(),
      payment_status: 'waiting_payment',
      selfie_required: 'no',
      selfie_status: 'optional_missing',
      source: 'telegram_webapp',
      notes: safe(profile.notes),
      payment_amount: DEFAULT_USDT_AMOUNT,
      payment_currency: 'USDT',
      payment_amount_usdt: DEFAULT_USDT_AMOUNT,
      payment_amount_thb: priceThb,
      price_thb: priceThb
    };
    await createApplication(appRow);
    await notifyNewApplication(appRow, applicant);
    await sendPaymentStart(user.id, lang, applicationId);

    res.json({ ok:true, application_id:applicationId, event:eventName, price_thb:priceThb });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.listen(PORT, async () => {
  console.log(`PTF Registration Bot listening on ${PORT}`);
  console.log(`Spreadsheet: ${SPREADSHEET_ID}`);
  if (!BOT_TOKEN) console.warn('BOT_TOKEN is empty. Set it in Railway Variables.');
  if (!PUBLIC_URL) console.warn('PUBLIC_URL is empty. Set it in Railway Variables.');
  try {
    if (BOT_TOKEN && PUBLIC_URL) {
      await setWebhook();
      await setCommands();
      console.log('Webhook and commands installed');
    }
  } catch (e) {
    console.error('Startup Telegram setup failed:', e.message);
  }
});
