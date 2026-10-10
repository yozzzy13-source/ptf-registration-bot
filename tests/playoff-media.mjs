// Публикации плей-офф: постер матча → утверждение → лента и рассылка →
// постеры мест; запреты и сбои; сетка картинкой; кнопки и повторные нажатия.
// Генератор, Telegram и таблицы — в памяти.
// Запуск: node --experimental-vm-modules tests/playoff-media.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const check = (c, m) => { assert.ok(c, m); checks++; };

const docs = [], notes = [], feed = [], queue = [], broadcasts = [], stories = [], generated = [];
let consent = 'YES', apiOn = true, failGen = false;
const slots = new Map();
const slot = (id, stage, extra = {}) => { const s = { challenge_id: id, stage, from_name: 'Roman Vengerak', to_name: 'Michael Gofshteyn', from_telegram_id: '1', to_telegram_id: '2', result_winner: '1', result_score: '6:4 6:3', division: 'Division A', season: '2', ...extra }; slots.set(id, s); return s; };
const context = vm.createContext({ console, Date, Math, JSON, Map, Set, Promise, Number, String, Boolean, Array, Object, Error, RegExp, Buffer, setTimeout: fn => { queueMicrotask(fn); return 1; } });
const syn = values => new vm.SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v); }, { context });
const KINDS = { Final: [['winner', 'champion'], ['loser', 'runner_up']], '3rd': [['winner', 'third'], ['loser', 'fourth']] };
const mods = {
  'config.js': syn({ ADMIN_IDS: ['999'], RESULTS_CHAT_ID: 'feed', RESULTS_TOPIC_ID: '' }),
  'admin.js': syn({ getAdminChatId: async () => 'admin-chat' }),
  'telegram.js': syn({
    sendMessage: async (to, text, opts) => { notes.push({ to, text, opts }); return {}; },
    sendDocumentBuffer: async (to, buf, name, opts) => { docs.push({ to, name, opts, buf }); return { document: { file_id: 'd' } }; },
    sendPhotoBuffer: async (to, buf, mime, opts) => { feed.push({ to, opts }); return { photo: [{ file_id: 'small' }, { file_id: 'photo-' + feed.length }] }; }
  }),
  'sheets.js': syn({ getSetting: async () => '', getSegmentContacts: async () => [{ telegram_id: '1', language: 'ru' }, { telegram_id: '2', language: 'en' }, { telegram_id: '3' }], findApplicantByTelegramId: async () => ({ instagram: '@roman' }) }),
  'broadcast.js': syn({ enqueueBroadcast: async (job) => { queue.push(job); return { recipients: job.recipients.length }; } }),
  'playoff.js': syn({
    ensurePosterKind: async () => {}, letterKey: v => String(v).toUpperCase(),
    outcomeOf: r => (String(r.status) === 'confirmed' && r.winner ? { W: r.winner, L: r.winner === r.player_1 ? r.player_2 : r.player_1 } : null),
    placeholderOf: (slot, side) => (side ? 'Winner SF2' : 'Winner SF1'),
    playoffState: async () => ({ season: '2', divisions: [{ letter: 'A', title: 'Division A', grouped: false, published: true, rows: [
      { slot: 'SF1', player_1: 'Roman Vengerak', player_2: 'Ramon Puchades', status: 'confirmed', winner: 'Ramon Puchades', score: '6:4  6:3' },
      { slot: 'SF2', player_1: 'Nikita Secret', player_2: 'Michael Gofshteyn', status: 'scheduled' }, { slot: 'Final', player_1: 'Ramon Puchades', player_2: '', status: 'tbd' }, { slot: '3rd', status: 'tbd' }], preview: [] }] })
  }),
  'matchcard.js': syn({ renderBracketImage: async (data) => { generated.push(['bracket', data]); return Buffer.from('bracket'); } }),
  'matchesdb.js': syn({ findSlot: async id => slots.get(id) || null }),
  'matches.js': syn({ winnerFirstScore: s => s.result_score, broadcastResult: async (s, opts) => { broadcasts.push({ id: s.challenge_id, opts }); return { sent: 7 }; } }),
  'matchposter.js': syn({
    posterEnabled: () => apiOn,
    preparePosterJob: async (s) => ({ status: consent === 'NO' ? 'blocked_consent' : 'ready_to_generate', match: { winner: s.from_name, loser: s.to_name, score: s.result_score }, prompts: [{ variant: 1 }, { variant: 2 }], consent: [] }),
    loadPosterSourcePhotos: async () => [Buffer.from('a'), Buffer.from('b')],
    generatePosterBackgrounds: async (job) => { if (failGen) throw new Error('OpenAI 500'); return job.prompts.map(p => ({ variant: p.variant, buffer: Buffer.from('bg' + p.variant) })); },
    composeMatchPoster: async (bg, match) => { generated.push(['poster', match]); return Buffer.from('poster-' + bg); },
    placesForStage: k => KINDS[k] || [],
    preparePlacePosterJob: async (o) => ({ ...o, status: 'ready_to_generate', prompts: [{ variant: 1 }, { variant: 2 }], consent: [{ allowed: true }] }),
    generatePlaceBackgrounds: async (job) => job.prompts.map(p => ({ variant: p.variant, buffer: Buffer.from('pbg' + p.variant) })),
    composePlacePoster: async (bg, o) => { generated.push(['place', o]); return Buffer.from('place-' + o.kind); }
  }),
  'publicity.js': syn({ publishPosterToStory: async (buf, s) => { stories.push(['match', s.challenge_id]); return {}; } }),
  'instagram.js': syn({ instagramEnabled: () => true, publishStory: async (buf, o) => { stories.push(['story', o?.handles || []]); return {}; } })
};
const src = await fs.readFile(path.join(root, 'playoffmedia.js'), 'utf8');
const mod = new vm.SourceTextModule(src, { context, identifier: 'playoffmedia.js', importModuleDynamically: async spec => {
  const d = mods[spec.replace('./', '')]; if (!d) throw Error('no mock ' + spec);
  if (d.status === 'unlinked') await d.link(() => {}); if (d.status === 'linked') await d.evaluate(); return d;
} });
await mod.link(spec => { const d = mods[spec.replace('./', '')]; if (!d) throw Error('no mock ' + spec); return d; });
await mod.evaluate();
const M = mod.namespace;
const flush = () => new Promise(r => setTimeout(r, 5));
const buttons = d => (d.opts?.reply_markup?.inline_keyboard || []).flat().map(b => b.callback_data);

// ------------------------------------------------------------ постер матча
{
  const s = slot('m-final', 'Final');
  const r = await M.startMatchPoster(s);
  const mine = docs.filter(d => d.to === 'admin-chat');
  check(r.ok && mine.length === 2, 'Два варианта постера приходят в админский чат');
  check(buttons(mine[0]).includes('pm:pub:1:m-final') && buttons(mine[0]).includes('pm:ig:1:m-final') && buttons(mine[1]).includes('pm:pub:2:m-final'), 'Под каждым вариантом — «Опубликовать» и «В сторис»');
  check(notes.some(n => (n.opts?.reply_markup?.inline_keyboard || []).flat().some(b => b.callback_data === 'pm:redo:m-final')), 'Есть «Переделать оба»');
  check(!broadcasts.length && !feed.length && !queue.length, 'До кнопки никому ничего не отправлено');
  check(/Финал/.test(mine[0].opts.caption), 'В подписи — стадия');
  // Публикация варианта 2.
  const before = docs.length;
  const pub = await M.handleCallback('pm:pub:2:m-final');
  await flush();
  check(/опубликован/.test(pub.text) && broadcasts.length === 1 && String(broadcasts[0].opts.media) === 'poster-bg2', 'Опубликован выбранный вариант — та же рассылка результата, с постером');
  const placeDocs = docs.slice(before).filter(d => /place-/.test(d.name));
  check(placeDocs.length === 4 && placeDocs.some(d => /champion/.test(d.name)) && placeDocs.some(d => /runner_up/.test(d.name)), 'После финала — постеры мест: чемпион и раннер-ап, по два варианта');
  check(generated.some(g => g[0] === 'place' && g[1].kind === 'champion' && g[1].name === 'Roman Vengerak') && generated.some(g => g[0] === 'place' && g[1].kind === 'runner_up' && g[1].name === 'Michael Gofshteyn'), 'Чемпион — победитель финала, раннер-ап — проигравший');
  const again = await M.handleCallback('pm:pub:1:m-final');
  check(/уже опубликовано/.test(again.text) && broadcasts.length === 1, 'Повторное «Опубликовать» второй раз не рассылает');
  const redo = await M.handleCallback('pm:redo:m-final');
  check(/уже опубликован/.test(redo.text), 'После публикации «Переделать» не запускает генерацию');
  // Постер места: публикация → лента + очередь с подписью на двух языках.
  const ppub = await M.handleCallback('pm:ppub:1:m-final:winner');
  check(/опубликован/.test(ppub.text) && feed.length === 1 && feed[0].to === 'feed' && queue.length === 1, 'Постер места — в ленту и всем в боте');
  check(/champion of Division A/.test(queue[0].params.caption) && /чемпион Division A/.test(queue[0].params.caption_ru) && queue[0].params.fileId === 'photo-1', 'Подпись на языке получателя, картинка из ленты по file_id');
  check(queue[0].recipients.length === 3, 'Рассылка — всем в боте');
  check(/уже опубликовано/.test((await M.handleCallback('pm:ppub:2:m-final:winner')).text) && queue.length === 1, 'Постер места второй раз не уходит');
  await M.handleCallback('pm:pig:1:m-final:loser');
  check(stories.some(s => s[0] === 'story' && s[1][0] === 'roman'), 'Постер места — в сторис с отметкой игрока');
  await M.handleCallback('pm:ig:1:m-final');
  check(stories.some(s => s[0] === 'match' && s[1] === 'm-final'), 'Постер матча — в сторис отдельной кнопкой');
}
// Полуфинал: постеров мест нет.
{
  const s = slot('m-sf', 'SF'); const before = docs.length;
  await M.startMatchPoster(s); await M.handleCallback('pm:pub:1:m-sf'); await flush();
  check(!docs.slice(before).some(d => /place-/.test(d.name)), 'После полуфинала постеров мест нет');
}
// Матч за 3-е место: 3-е и 4-е места.
{
  const s = slot('m-3rd', '3rd'); const before = docs.length;
  await M.startMatchPoster(s); await M.handleCallback('pm:pub:1:m-3rd'); await flush();
  const p = docs.slice(before).filter(d => /place-/.test(d.name));
  check(p.some(d => /third/.test(d.name)) && p.some(d => /fourth/.test(d.name)), 'После матча за 3-е — постеры 3-го и 4-го мест');
}
// Нет согласия на фото / генератор выключен / сбой генерации — можно опубликовать карточкой.
{
  consent = 'NO'; const s = slot('m-noc', 'QF');
  const r = await M.startMatchPoster(s);
  check(!r.ok && notes.slice(-1)[0].opts.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'pm:card:m-noc'), 'Запрет фото — предлагается «Опубликовать карточкой»');
  consent = 'YES'; apiOn = false;
  check(!(await M.startMatchPoster(slot('m-off', 'QF'))).ok && /OPENAI_API_KEY/.test(notes.slice(-1)[0].text), 'Генератор не подключён — честное сообщение и карточка');
  apiOn = true; failGen = true;
  const f = await M.startMatchPoster(slot('m-fail', 'QF'));
  check(!f.ok && notes.slice(-1)[0].opts.reply_markup.inline_keyboard.flat().map(b => b.callback_data).join() === 'pm:redo:m-fail,pm:card:m-fail', 'Сбой генерации — «Повторить» и «Опубликовать карточкой»');
  failGen = false;
  const card = await M.handleCallback('pm:card:m-fail');
  check(/карточкой/.test(card.text) && broadcasts.slice(-1)[0].opts.asCard === true, 'Публикация карточкой — обычная рассылка результата');
  check(/уже опубликовано/.test((await M.handleCallback('pm:card:m-fail')).text), 'Карточка второй раз не уходит');
  check(/не в памяти/.test((await M.handleCallback('pm:pub:1:unknown')).text), 'Картинки нет в памяти (перезапуск) — просьба сделать заново');
}
// Сетка картинкой.
{
  const before = docs.length;
  const r = await M.previewBracket('A', '2');
  const d = docs.slice(before)[0];
  check(r.ok && d.to === 'admin-chat' && buttons(d).includes('pm:bsend:' + r.key) && buttons(d).includes('pm:big:' + r.key), 'Сетка — в админский чат с «Разослать всем» и «В сторис»');
  const data = generated.filter(g => g[0] === 'bracket').slice(-1)[0][1];
  const sf1 = data.matches.find(m => m.slot === 'SF1');
  check(sf1.played && sf1.winner === 'Ramon Puchades' && sf1.score === '4:6  3:6', 'В сетке счёт развёрнут к победителю');
  check(data.matches.find(m => m.slot === 'Final').label2 === 'Winner SF2', 'Пустое место подписано «Winner SF2»');
  const q0 = queue.length;
  const s1 = await M.handleCallback('pm:bsend:' + r.key);
  check(/рассылке/.test(s1.text) && queue.length === q0 + 1 && /Division A/.test(queue.slice(-1)[0].params.caption) && /Плей-офф PTF/.test(queue.slice(-1)[0].params.caption_ru), 'Сетка уходит всем, подпись на двух языках');
  check(/уже опубликовано/.test((await M.handleCallback('pm:bsend:' + r.key)).text) && queue.length === q0 + 1, 'Сетка второй раз не уходит');
  await M.handleCallback('pm:big:' + r.key);
  check(stories.some(s => s[0] === 'story' && !s[1].length), 'Сетка — в сторис');
}
check(/Неизвестная/.test((await M.handleCallback('pm:zzz')).text), 'Неизвестная кнопка не роняет бота');
const caps = M.placeCaptions({ kind: 'runner_up', name: 'Philipp M', division: 'PRIME', season: '2' });
check(/runner-up of PRIME/.test(caps.en) && /второе место в PRIME/.test(caps.ru), 'PRIME пишется без «Division»');

console.log(`PASS: ${checks} playoff media checks — posters, place posters, bracket, approvals and repeats.`);
