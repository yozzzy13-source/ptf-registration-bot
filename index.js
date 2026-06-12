import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { PORT, PUBLIC_URL, BOT_TOKEN, SPREADSHEET_ID, DEFAULT_USDT_AMOUNT, SHEETS, ADMIN_IDS } from './config.js';
import { setWebhook, setCommands, sendMessage } from './telegram.js';
import { handleMessage, handleCallback } from './bot.js';
import { isResultsMessage, isResultsCallback, handleResultsMessage, handleResultsCallback } from './results.js';
import { getActiveEvents, upsertApplicant, createApplication, getPaymentMethods, findApplicantByTelegramIdentity, isProfileCompleted, openAdminChatByTelegramId } from './sheets.js';
import { langOf, parseInitData, verifyTelegramInitData, uid, nowISO, safe } from './util.js';
import { notifyNewApplication } from './admin.js';
import { registerAdminRoutes } from './adminPanel.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.send('PTF Registration Bot is running'));
app.get('/apply', (req, res) => res.sendFile(path.join(__dirname, 'public', 'apply.html')));
registerAdminRoutes(app);

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
    if (update.callback_query && isResultsCallback(update.callback_query)) {
      await handleResultsCallback(update.callback_query);
    } else if (update.message && isResultsMessage(update.message)) {
      await handleResultsMessage(update.message);
    } else if (update.message && shouldPassToRegistration(update.message)) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }
  } catch (e) {
    console.error('webhook error', e);
  }
});

function shouldPassToRegistration(msg) {
  if (msg.chat?.type === 'private') return true;
  const text = (msg.text || msg.caption || '').trim();
  if (text.startsWith('/')) return true;
  if (msg.reply_to_message && ADMIN_IDS.includes(String(msg.from?.id || ''))) return true;
  return false;
}

app.get('/api/bootstrap', async (req, res) => {
  try {
    const initData = req.query.initData || '';
    const { user } = parseInitData(initData);
    const lang = langOf(user?.language_code);
    const events = await getActiveEvents();
    const existingProfile = user ? await findApplicantByTelegramIdentity(user) : null;
    res.json({ ok: true, user, lang, events, usdtAmount: DEFAULT_USDT_AMOUNT, existingProfile, profileCompleted: isProfileCompleted(existingProfile) });
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
    const { initData = '', profile = {}, event_id, mode = 'profile' } = req.body || {};
    const verified = verifyTelegramInitData(initData);
    const { user } = parseInitData(initData);
    if (!user?.id) return res.status(400).json({ ok:false, error:'Telegram WebApp user not found' });
    if (BOT_TOKEN && !verified && process.env.NODE_ENV === 'production') {
      return res.status(403).json({ ok:false, error:'Invalid Telegram initData' });
    }

    const events = await getActiveEvents();
    const event = event_id ? events.find(e => e.event_id === event_id) : null;

    const lang = langOf(user.language_code);
    const username = user.username || '';
    const existingProfile = await findApplicantByTelegramIdentity(user);
    const eventOnlyWithProfile = mode === 'event' && isProfileCompleted(existingProfile);
    const effectiveProfile = eventOnlyWithProfile ? {
      name: existingProfile.name,
      ntrp: existingProfile.ntrp,
      ntrp_unknown: existingProfile.ntrp === 'unknown',
      experience: existingProfile.experience,
      gender: existingProfile.gender,
      age: existingProfile.age,
      country_of_origin: existingProfile.country_of_origin,
      whatsapp: existingProfile.whatsapp,
      notes: existingProfile.notes
    } : profile;
    const fullName = safe(effectiveProfile.name) || [user.first_name, user.last_name].filter(Boolean).join(' ');
    const isEventApplication = Boolean(event);
    const eventName = event
      ? (lang === 'ru' ? (event.event_name_ru || event.event_name_en) : (event.event_name_en || event.event_name_ru))
      : 'PTF Player Profile / Waitlist';
    const finalEventId = event?.event_id || 'ptf_waitlist';
    const applicationId = uid('app');
    const priceThb = Number(event?.price_thb || 0);
    const applicationStatus = isEventApplication ? 'submitted' : 'waitlist';
    const paymentStatus = 'not_required';

    const applicant = await upsertApplicant({
      name: fullName,
      ntrp: effectiveProfile.ntrp_unknown ? 'unknown' : safe(effectiveProfile.ntrp),
      status: applicationStatus,
      experience: safe(effectiveProfile.experience),
      gender: safe(effectiveProfile.gender),
      age: safe(effectiveProfile.age),
      country_of_origin: safe(effectiveProfile.country_of_origin),
      telegram: username ? `t.me/${username}` : '',
      whatsapp: safe(effectiveProfile.whatsapp),
      notes: safe(effectiveProfile.notes),
      telegram_id: user.id,
      telegram_username: username,
      language: lang,
      source: 'telegram_webapp',
      last_application_event: eventName,
      selfie_status: 'optional_missing',
      crm_tags: isEventApplication ? `league_interested,${finalEventId}` : 'ptf_waitlist,profile_completed'
    });

    const appRow = {
      application_id: applicationId,
      telegram_id: user.id,
      telegram_username: username,
      player_name: fullName,
      event_id: finalEventId,
      event_name: eventName,
      application_status: applicationStatus,
      submitted_at: nowISO(),
      payment_status: paymentStatus,
      selfie_required: 'no',
      selfie_status: 'optional_missing',
      source: 'telegram_webapp',
      notes: safe(effectiveProfile.notes),
      payment_amount: '',
      payment_currency: '',
      payment_amount_usdt: '',
      payment_amount_thb: '',
      price_thb: priceThb || ''
    };
    await createApplication(appRow);
    await notifyNewApplication(appRow, applicant);
    await sendMessage(
      user.id,
      isEventApplication
        ? (lang === 'ru' ? '✅ Заявка сохранена. Оплату пока не просим — мы сообщим отдельно, когда откроем оплату.' : '✅ Application saved. Payment is not required yet — we will notify you separately when payment opens.')
        : (lang === 'ru' ? '✅ Анкета сохранена в системе PTF. Вы добавлены в waitlist и сможете податься в открытые события позже.' : '✅ Your profile has been saved in the PTF system. You have been added to the waitlist and will be able to join open events later.')
    );
    await openAdminChatByTelegramId(user.id, 'application_saved', {});

    res.json({ ok:true, application_id:applicationId, event:eventName, price_thb:priceThb, payment_required:false });
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
