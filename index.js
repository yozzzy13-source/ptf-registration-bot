import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { PORT, PUBLIC_URL, BOT_TOKEN, SPREADSHEET_ID, DEFAULT_USDT_AMOUNT, SHEETS } from './config.js';
import { setWebhook, setCommands, sendMessage } from './telegram.js';
import { handleMessage, handleCallback, sendPaymentStart } from './bot.js';
import { getActiveEvents, upsertApplicant, createApplication, createOrUpdateApplication, getPaymentMethods, getRows, findApplicantByTelegramIdentity, findApplicantByTelegramId, updateApplicantByTelegramId, updateObjectByRow, isProfileCompleted, enrichEventsWithStats, getEventPlayers } from './sheets.js';
import { parseInitData, verifyTelegramInitData, uid, nowISO, safe } from './util.js';
import { notifyNewApplication, handlePollUpdate } from './admin.js';
import { registerAdminRoutes } from './adminPanel.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.send('PTF Registration Bot is running'));
app.get('/apply', (req, res) => { res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate'); res.set('Pragma','no-cache'); res.set('Expires','0'); res.sendFile(path.join(__dirname, 'public', 'apply.html')); });
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
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.poll) await handlePollUpdate(update.poll);
  } catch (e) {
    console.error('webhook error', e);
  }
});

app.get('/api/bootstrap', async (req, res) => {
  try {
    const initData = req.query.initData || '';
    const { user } = parseInitData(initData);
    const existingProfile = user ? await findApplicantByTelegramIdentity(user) : null;
    const lang = ['ru','en'].includes(String(existingProfile?.language || '').toLowerCase()) ? String(existingProfile.language).toLowerCase() : 'en';
    const events = await getActiveEvents();
    const enrichedEvents = await enrichEventsWithStats(events);
    res.json({ ok: true, user, lang, language_required: !existingProfile?.language, events: enrichedEvents, usdtAmount: DEFAULT_USDT_AMOUNT, existingProfile, profileCompleted: isProfileCompleted(existingProfile) });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.get('/api/event-players', async (req, res) => {
  try {
    const initData = req.query.initData || '';
    const verified = verifyTelegramInitData(initData);
    if (BOT_TOKEN && !verified && process.env.NODE_ENV === 'production') return res.status(403).json({ ok:false, error:'Invalid Telegram initData' });
    const eventId = String(req.query.event_id || '').trim();
    if (!eventId) return res.status(400).json({ ok:false, error:'event_id is required' });
    const events = await getActiveEvents();
    const event = events.find(e => String(e.event_id) === eventId) || { event_id:eventId };
    const players = await getEventPlayers(event);
    res.json({ ok:true, event_id:eventId, total:players.length, players:players.map((p,idx) => ({ n:idx+1, name:p.name })) });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});



function requireRacketRating(profile = {}) {
  const rating = safe(profile.racket_rating || profile.ntrp);
  if (!rating || ["unknown","не знаю","dont know","don\'t know","n/a","na","-"].includes(String(rating).trim().toLowerCase())) {
    throw new Error('Racket Rating is required. If the player does not know it, complete the level test.');
  }
  return rating;
}


app.post('/api/update-rating', async (req, res) => {
  try {
    const { initData = '', rating = '' } = req.body || {};
    const verified = verifyTelegramInitData(initData);
    const { user } = parseInitData(initData);
    if (!user?.id) return res.status(400).json({ ok:false, error:'Telegram WebApp user not found' });
    if (BOT_TOKEN && !verified && process.env.NODE_ENV === 'production') return res.status(403).json({ ok:false, error:'Invalid Telegram initData' });
    const existing = await findApplicantByTelegramIdentity(user) || await findApplicantByTelegramId(user.id);
    if (!existing) return res.status(404).json({ ok:false, error:'Player profile not found. Please complete the profile first.' });
    const racketRating = requireRacketRating({ ntrp: rating, racket_rating: rating });
    let updated = await updateApplicantByTelegramId(user.id, { ntrp: racketRating, telegram_id: user.id, telegram_username: user.username || existing.telegram_username || '', telegram: user.username ? `t.me/${user.username}` : existing.telegram || '', profile_completed: 'yes', source: existing.source || 'telegram_webapp' });
    if (!updated && existing?._rowNumber) {
      const patch = { ntrp: racketRating, telegram_id: user.id, telegram_username: user.username || existing.telegram_username || '', telegram: user.username ? `t.me/${user.username}` : existing.telegram || '', profile_completed: 'yes', updated_at: nowISO() };
      await updateObjectByRow(SHEETS.applicants, existing._rowNumber, patch);
      updated = { ...existing, ...patch };
    }
    res.json({ ok:true, applicant: updated, rating: racketRating });
  } catch(e) {
    console.error(e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.post('/api/save-profile'
, async (req, res) => {
  try {
    const { initData = '', profile = {} } = req.body || {};
    const verified = verifyTelegramInitData(initData);
    const { user } = parseInitData(initData);
    if (!user?.id) return res.status(400).json({ ok:false, error:'Telegram WebApp user not found' });
    if (BOT_TOKEN && !verified && process.env.NODE_ENV === 'production') return res.status(403).json({ ok:false, error:'Invalid Telegram initData' });
    const existingProfile = await findApplicantByTelegramIdentity(user);
    const lang = ['ru','en'].includes(String(existingProfile?.language || '').toLowerCase()) ? String(existingProfile.language).toLowerCase() : 'en'; const username = user.username || '';
    const racketRating = requireRacketRating(profile);
    const applicant = await upsertApplicant({ name:safe(profile.name)||[user.first_name,user.last_name].filter(Boolean).join(' '), ntrp:racketRating, status:'waitlist', experience:safe(profile.experience), gender:safe(profile.gender), age:safe(profile.age), country_of_origin:safe(profile.country_of_origin), telegram:username?`t.me/${username}`:'', whatsapp:safe(profile.whatsapp), notes:safe(profile.notes), telegram_id:user.id, telegram_username:username, language:lang, source:'telegram_webapp', last_application_event:'PTF Player Profile / Waitlist', selfie_status:'optional_missing', crm_tags:'ptf_waitlist,profile_completed', increment_application_count:false });
    res.json({ok:true,applicant,profileCompleted:true});
  } catch(e){ console.error(e); res.status(500).json({ok:false,error:e.message}); }
});


function noFlag(value) { return ['no','false','0','off','disabled','inactive','нет'].includes(String(value || '').trim().toLowerCase()); }
function isPaymentEnabledForEvent(event) {
  if (!event) return false;
  const priceThb = Number(event.price_thb || 0);
  if (!(priceThb > 0)) return false;
  if (noFlag(event.payment_enabled)) return false;
  return true;
}
function eventPriceThb(event) { return Number(event?.price_thb || 0); }
function eventPriceUsdt(event) { return Number(event?.price_usdt || event?.usdt_amount || DEFAULT_USDT_AMOUNT || 0); }

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

    const username = user.username || '';
    const existingProfile = await findApplicantByTelegramIdentity(user);
    const lang = ['ru','en'].includes(String(existingProfile?.language || '').toLowerCase()) ? String(existingProfile.language).toLowerCase() : 'en';
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
    const racketRating = requireRacketRating(effectiveProfile);
    const fullName = safe(effectiveProfile.name) || [user.first_name, user.last_name].filter(Boolean).join(' ');
    const isEventApplication = Boolean(event);
    const eventName = event
      ? (lang === 'ru' ? (event.event_name_ru || event.event_name_en) : (event.event_name_en || event.event_name_ru))
      : 'PTF Player Profile / Waitlist';
    const finalEventId = event?.event_id || 'ptf_waitlist';
    const applicationId = uid('app');
    const priceThb = eventPriceThb(event);
    const priceUsdt = eventPriceUsdt(event);
    const paymentRequired = isPaymentEnabledForEvent(event);
    const applicationStatus = event ? (paymentRequired ? 'waiting_payment' : 'application_received') : 'waitlist';
    const paymentStatus = paymentRequired ? 'payment_required' : 'not_required';

    const applicant = await upsertApplicant({
      name: fullName,
      ntrp: racketRating,
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
      crm_tags: isEventApplication ? `event_application,${finalEventId}` : 'ptf_waitlist,profile_completed',
      increment_application_count: true
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
      payment_amount: paymentRequired ? priceThb : '',
      payment_currency: paymentRequired ? 'THB' : '',
      payment_amount_usdt: paymentRequired ? priceUsdt : '',
      payment_amount_thb: paymentRequired ? priceThb : '',
      price_thb: paymentRequired ? priceThb : '',
      price_usdt: paymentRequired ? priceUsdt : ''
    };
    const savedApplication = await createOrUpdateApplication(appRow);
    appRow.application_id = savedApplication.application_id || applicationId;
    // Do not spam admin topics when the same player presses submit again for the same event.
    // The row in Applications is updated, but the admin application card is sent only for a fresh application.
    if (!savedApplication.isUpdated) {
      try {
        await notifyNewApplication(appRow, applicant);
      } catch (notifyError) {
        // Do not block player registration/payment if the admin chat is misconfigured or migrated.
        console.error('notifyNewApplication failed:', notifyError.message);
      }
    }
    if (isEventApplication && paymentRequired) {
      await sendMessage(user.id, lang === 'ru' ? `✅ Заявка на событие сохранена: ${eventName}.

<b>Следующий шаг — оплата участия.</b>

⚠️ Неоплаченная заявка не является активным участием в сезоне. Заявки с подтверждённой оплатой будут рассматриваться в первую очередь.

Выберите удобный способ оплаты ниже.` : `✅ Your event application has been saved: ${eventName}.

<b>Next step — participation payment.</b>

⚠️ An unpaid application is not an active season entry. Applications with confirmed payment will be processed first.

Please choose a payment method below.`);
      await sendPaymentStart(user.id, lang, appRow.application_id);
    } else if (isEventApplication) {
      await sendMessage(user.id, lang === 'ru' ? `✅ Заявка на событие сохранена: ${eventName}. Детали подтверждения участия будут отправлены через Telegram-бота.` : `✅ Your event application has been saved: ${eventName}. Participation confirmation details will be sent through the Telegram bot.`);
    } else await sendMessage(user.id, lang === 'ru' ? `✅ Анкета сохранена в системе PTF.

Теперь вы можете подать заявку в открытое событие.` : `✅ Your profile has been saved in the PTF system.

You can now join an open event.`, { reply_markup:{ inline_keyboard:[[ { text: lang === 'ru' ? '🏆 Участвовать в событии' : '🏆 Join Event', web_app:{ url:`${PUBLIC_URL}/apply?mode=event` } } ],[ { text: lang === 'ru' ? '🏠 Главное меню' : '🏠 Main menu', callback_data:'main' } ]] } });

    res.json({ ok:true, application_id:appRow.application_id, event:eventName, price_thb:priceThb, price_usdt:priceUsdt, payment_required:paymentRequired, application_status: applicationStatus, payment_status: paymentStatus });
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
