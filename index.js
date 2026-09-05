import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { PORT, PUBLIC_URL, BOT_TOKEN, SPREADSHEET_ID, DEFAULT_USDT_AMOUNT, SHEETS } from './config.js';
import { setWebhook, setCommands, sendMessage, getMe } from './telegram.js';
import { handleMessage, handleCallback, sendPaymentStart } from './bot.js';
import { getCourts, getPlayerDivision, getDivisionOpponents, getActiveEvents, upsertApplicant, createApplication, createOrUpdateApplication, getPaymentMethods, getRows, findApplicantByTelegramIdentity, findApplicantByTelegramId, updateApplicantByTelegramId, updateObjectByRow, isProfileCompleted, enrichEventsWithStats, getEventPlayers, getManualParticipants } from './sheets.js';
import { parseInitData, verifyTelegramInitData, uid, nowISO, safe } from './util.js';
import { notifyNewApplication, handlePollUpdate } from './admin.js';
import { registerAdminRoutes } from './adminPanel.js';
import { publishOpenSlot, sendDirectChallenge, notifyMatchAgreed, cancelSlot as cancelMatchSlot, setBotUsername } from './matches.js';
import { createSlot, findSlot, claimSlot, listOpenSlots, listMySlots, listToCell, cellToList } from './matchesdb.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.send('PTF Registration Bot is running'));
function noCache(res) { res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate'); res.set('Pragma','no-cache'); res.set('Expires','0'); }
app.get('/participants', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'public', 'participants.html')); });
app.get('/match', (req, res) => { noCache(res); res.sendFile(path.join(__dirname, 'public', 'match.html')); });
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

async function participantsPayload(initData='') {
  const { user } = parseInitData(initData);
  let lang = '';
  if (user?.id) {
    const profile = await findApplicantByTelegramId(user.id).catch(() => null);
    lang = ['ru','en'].includes(String(profile?.language || '').toLowerCase()) ? String(profile.language).toLowerCase() : '';
  }
  if (!lang) lang = String(user?.language_code || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
  const data = await getManualParticipants();
  const players = (data.players || []).map((p, idx) => ({ n: idx + 1, ...p }));
  return { ok:true, lang, total: players.length, totals: data.totals, note: data.note, divisions: data.divisions, groups: data.groups, players };
}

app.get('/api/participants', async (req, res) => {
  try {
    const initData = req.query.initData || '';
    const verified = verifyTelegramInitData(initData);
    if (BOT_TOKEN && !verified && process.env.NODE_ENV === 'production') return res.status(403).json({ ok:false, error:'Invalid Telegram initData' });
    res.json(await participantsPayload(initData));
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


// ---------------------------------------------------------------------------
// МАТЧИ. Заявка формируется ровно как бронь в боте тренировок: дата, интервал,
// длительность, площадка — и уходит либо в топик дивизиона (открытое окно),
// либо лично сопернику (адресный вызов).
// ---------------------------------------------------------------------------
async function matchViewer(initData) {
  const verified = verifyTelegramInitData(initData);
  const { user } = parseInitData(initData);
  if (!user?.id) return { ok:false, code:400, error:'Telegram WebApp user not found' };
  if (BOT_TOKEN && !verified && process.env.NODE_ENV === 'production') return { ok:false, code:403, error:'Invalid Telegram initData' };
  const profile = await findApplicantByTelegramIdentity(user) || await findApplicantByTelegramId(user.id);
  if (!profile) return { ok:false, code:404, error:'Player profile not found. Complete the profile first.' };
  const division = await getPlayerDivision(profile);
  const lang = ['ru','en'].includes(String(profile.language || '').toLowerCase()) ? String(profile.language).toLowerCase() : 'en';
  return { ok:true, user, profile, division, lang };
}

app.get('/api/match/bootstrap', async (req, res) => {
  try {
    const v = await matchViewer(req.query.initData || '');
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    const [courts, opponents, openSlots, mySlots] = await Promise.all([
      getCourts(),
      getDivisionOpponents(v.division, v.user.id),
      listOpenSlots(v.division, v.user.id),
      listMySlots(v.user.id)
    ]);
    const byId = new Map(opponents.map(o => [String(o.telegram_id), o]));
    const shape = (s) => ({
      ...s,
      dates: cellToList(s.dates),
      courts: cellToList(s.courts),
      from: byId.get(String(s.from_telegram_id)) || null
    });
    res.json({
      ok:true, lang:v.lang, user:{ id:v.user.id, name:v.profile.name }, division:v.division,
      courts, opponents,
      open_slots: openSlots.map(shape),
      my_matches: mySlots.map(shape),
      focus_slot: String(req.query.slot || '')
    });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/match/create', async (req, res) => {
  try {
    const b = req.body || {};
    const v = await matchViewer(b.initData || '');
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    if (!v.division) return res.status(400).json({ ok:false, error:'You are not assigned to a division yet.' });
    const dates = (Array.isArray(b.dates) ? b.dates : []).map(d => String(d).trim()).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (!dates.length) return res.status(400).json({ ok:false, error:'Pick at least one date' });
    const timeFrom = String(b.time_from || '').trim();
    const timeTo = String(b.time_to || timeFrom).trim();
    if (!/^\d{2}:\d{2}$/.test(timeFrom)) return res.status(400).json({ ok:false, error:'Time is required' });
    const duration = Number(b.duration_min || 90);
    const courts = (Array.isArray(b.courts) ? b.courts : []).map(c => String(c).trim()).filter(Boolean);
    const isDirect = String(b.match_type || 'open') === 'direct';
    let opponent = null;
    if (isDirect) {
      const list = await getDivisionOpponents(v.division, v.user.id);
      opponent = list.find(o => String(o.telegram_id) === String(b.to_telegram_id));
      if (!opponent) return res.status(400).json({ ok:false, error:'Opponent not found in your division' });
    }
    const slot = {
      challenge_id: uid('match'),
      match_type: isDirect ? 'direct' : 'open',
      status: 'open',
      division: v.division,
      from_telegram_id: String(v.user.id),
      from_name: v.profile.name || [v.user.first_name, v.user.last_name].filter(Boolean).join(' '),
      from_username: v.user.username || v.profile.telegram_username || '',
      to_telegram_id: isDirect ? String(opponent.telegram_id) : '',
      to_name: isDirect ? opponent.name : '',
      to_username: isDirect ? opponent.username : '',
      dates: listToCell(dates), time_from: timeFrom, time_to: timeTo,
      duration_min: duration, courts: listToCell(courts), comment: safe(b.comment),
      agreed_date:'', agreed_time:'', agreed_court:'',
      created_at: nowISO()
    };
    await createSlot(slot);
    if (isDirect) await sendDirectChallenge(slot).catch(e => console.error('sendDirectChallenge failed:', e.message));
    else await publishOpenSlot(slot).catch(e => console.error('publishOpenSlot failed:', e.message));
    res.json({ ok:true, challenge_id: slot.challenge_id });
  } catch (e) { console.error(e); res.status(500).json({ ok:false, error:e.message }); }
});

// Отвечающий обязан выбрать конкретную дату (и корт, если автор предложил несколько).
app.post('/api/match/take', async (req, res) => {
  try {
    const v = await matchViewer(req.body?.initData || '');
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    const result = await claimSlot(req.body.challenge_id, {
      telegram_id: v.user.id, name: v.profile.name, username: v.user.username || v.profile.telegram_username || ''
    }, { date: req.body.date, court: req.body.court, time: req.body.time });
    if (!result.ok) {
      const messages = {
        taken:'This slot has just been taken.', own:'This is your own slot.', closed:'This slot is closed.',
        not_for_you:'This challenge is addressed to another player.', not_found:'Slot not found.',
        already_yours:'You have already taken this slot.', bad_date:'Pick one of the offered dates.',
        bad_court:'Pick one of the offered courts.'
      };
      return res.status(409).json({ ok:false, error: messages[result.reason] || 'Slot unavailable' });
    }
    await notifyMatchAgreed(result.slot).catch(e => console.error('notifyMatchAgreed failed:', e.message));
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/match/cancel', async (req, res) => {
  try {
    const v = await matchViewer(req.body?.initData || '');
    if (!v.ok) return res.status(v.code).json({ ok:false, error:v.error });
    const slot = await findSlot(req.body.challenge_id);
    if (!slot) return res.status(404).json({ ok:false, error:'Slot not found' });
    if (String(slot.from_telegram_id) !== String(v.user.id)) return res.status(403).json({ ok:false, error:'Not your slot' });
    if (String(slot.status).toLowerCase() === 'accepted') return res.status(409).json({ ok:false, error:'Match is already agreed — contact your opponent.' });
    await cancelMatchSlot(slot, { telegram_id: v.user.id, name: v.profile.name });
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
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
      try { const me = await getMe(); setBotUsername(me?.username); } catch (e) { console.error('getMe failed:', e.message); }
      console.log('Webhook and commands installed');
    }
  } catch (e) {
    console.error('Startup Telegram setup failed:', e.message);
  }
});
