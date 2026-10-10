// Картинки плей-офф рисуются по-настоящему (sharp + шрифты из assets):
// карточки 4 стадий, постеры матчей 4 стадий, постеры мест, сетка (группы и
// одна группа, предварительная и с чемпионом), афиша дня. Проверяем размеры,
// что картинки не пустые и что стадии действительно отличаются.
// Запуск: node tests/playoff-render.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
process.env.BOT_TOKEN ||= 'test';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||= '{}';
const sharp = createRequire(import.meta.url)('sharp');
const card = await import('../matchcard.js');
const poster = await import('../matchposter.js');
let checks = 0;
const check = (c, m) => { assert.ok(c, m); checks++; };
const size = async buf => { const m = await sharp(buf).metadata(); return `${m.width}x${m.height}`; };
const differ = async (a, b) => {
  const [x, y] = await Promise.all([a, b].map(buf => sharp(buf).resize(64, 64, { fit: 'fill' }).raw().toBuffer()));
  let d = 0; for (let i = 0; i < x.length; i++) d += Math.abs(x[i] - y[i]);
  return d / x.length;
};
const bg = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: { r: 60, g: 80, b: 110 } } }).png().toBuffer();
const meta = { form: ['W', 'L', 'W'] };

// Карточки: 4 стадии, у каждой свой цвет.
const cards = {};
for (const [st, sc] of [['QF', '6:2 6:4'], ['SF', '6:4 3:6 10:7'], ['3rd', '4:6 6:3 10:5'], ['Final', '7:6 (7:4) 6:3']]) {
  cards[st] = await card.renderInstagramMatchCard({ stage: st, winner: 'Roman Vengerak', loser: 'Michael Gofshteyn', score: sc, division: 'A', season: '2', winnerMeta: meta, loserMeta: meta });
  check(await size(cards[st]) === '1080x1148', `Карточка ${st}: 1080×1148`);
}
check(await differ(cards.QF, cards.Final) > 2 && await differ(cards.SF, cards['3rd']) > 2, 'Карточки разных стадий выглядят по-разному');
const plain = await card.renderInstagramMatchCard({ winner: 'A B', loser: 'C D', score: '6:4 6:4', division: 'A', season: '2' });
check(await size(plain) === '1080x1148' && await differ(plain, cards.SF) > 2, 'Обычная карточка регулярки не изменилась по формату');
check(card.cardStage('Semifinal S2').key === 'SF' && card.cardStage('2') === null && card.cardStage('') === null, 'Стадия карточки распознаётся по подписи, номер раунда — не стадия');
check(card.cardStage('QF').places === false && card.cardStage('Final').win === 'CHAMPION' && card.cardStage('3rd').lose === '4TH PLACE', 'Плашки мест — только в финале и матче за 3-е');

// Постеры матчей: вариант B, 4 стадии.
const posters = {};
for (const st of ['QF', 'SF', '3rd', 'Final']) {
  posters[st] = await poster.composeMatchPoster(bg, { stage: st, winner: 'Louie Murray', loser: 'Philipp Meyer-Galow', score: '7:6 (7:4) 6:3', division: 'PRIME', season: '2' });
  check(await size(posters[st]) === '1080x1920', `Постер ${st}: 1080×1920`);
}
check(await differ(posters.QF, posters.Final) > 1, 'Постеры стадий отличаются оформлением');
const regular = await poster.composeMatchPoster(bg, { winner: 'A B', loser: 'C D', score: '6:4 6:4', division: 'A', season: '2' });
check(await differ(regular, posters.SF) > 1, 'Обычный постер не превратился в плей-офф');
const layoutA = await poster.composePlayoffPoster(bg, { stage: 'SF', winner: 'A B', loser: 'C D', score: '6:4', division: 'A', season: '2' }, undefined, { layout: 'A' });
check(await differ(layoutA, posters.SF) > 0.5, 'По умолчанию — утверждённый вариант B (логотип по центру)');
// Промпты: своя сцена на стадию, кубок только в финале, обычный промпт без изменений.
const pq = poster.buildPosterPrompt({ stage: 'QF', winner: 'A', loser: 'B' }), pf = poster.buildPosterPrompt({ stage: 'Final', winner: 'A', loser: 'B' });
const pr = poster.buildPosterPrompt({ winner: 'A', loser: 'B' });
check(/floodlights/i.test(pq) && !/trophy stands/i.test(pq), 'Четвертьфинал — прожекторы, без кубка');
check(/championship trophy/i.test(pf) && /QUARTER|FINAL/.test(pf), 'Финал — с кубком');
check(!/STAGE:/.test(pr) && /Do not show tennis rackets, tennis balls, trophies/.test(pr), 'Обычный промпт не тронут');
check(poster.buildPosterPrompt({ stage: 'SF', winner: 'A', loser: 'B' }, { variant: 2 }) !== poster.buildPosterPrompt({ stage: 'SF', winner: 'A', loser: 'B' }, { variant: 1 }), 'Два варианта — два разных промпта');

// Постеры мест.
const places = {};
for (const k of ['champion', 'runner_up', 'third', 'fourth']) {
  places[k] = await poster.composePlacePoster(bg, { name: 'Roman Vengerak', kind: k, division: 'A', season: '2' });
  check(await size(places[k]) === '1080x1920', `Постер места ${k}: 1080×1920`);
  check(poster.buildPlacePrompt('Roman Vengerak', k).includes('Roman Vengerak'), `Промпт места ${k} с именем`);
}
check(await differ(places.champion, places.fourth) > 1, 'Постеры мест отличаются');
check(/trophy/i.test(poster.buildPlacePrompt('X', 'champion')) && /silver medal/i.test(poster.buildPlacePrompt('X', 'runner_up')) && /bronze medal/i.test(poster.buildPlacePrompt('X', 'third')), 'Чемпиону — кубок, второму — серебро, третьему — бронза');
check(JSON.stringify(poster.placesForStage('Final')) === JSON.stringify([['winner', 'champion'], ['loser', 'runner_up']]) && poster.placesForStage('3rd').length === 2 && !poster.placesForStage('SF').length, 'Постеры мест — только после финала и матча за 3-е');

// Сетка картинкой.
const W = { division: 'W', season: '2', grouped: true, matches: [
  { slot: 'QF1', p1: 'Masha Geveling', p2: 'Hyunjung Moon', seed1: '1·1', seed2: '4·2', played: true, winner: 'Masha Geveling', score: '6:3  6:2' },
  { slot: 'QF2', p1: 'Marina Banatskaia', p2: 'Elena Ian', seed1: '2·2', seed2: '3·1' }, { slot: 'QF3', p1: 'Olga Sauer', p2: 'Irina Strembitska' }, { slot: 'QF4', p1: 'Yana D', p2: 'Daria Kozitskaya' },
  { slot: 'SF1', p1: 'Masha Geveling', label2: 'Winner QF2' }, { slot: 'SF2', label1: 'Winner QF3', label2: 'Winner QF4' },
  { slot: 'Final', label1: 'Winner SF1', label2: 'Winner SF2' }, { slot: '3rd', label1: 'Loser SF1', label2: 'Loser SF2' }] };
const bw = await card.renderBracketImage(W);
check(await size(bw) === '1080x1920', 'Сетка с четвертьфиналами: сторис 1080×1920');
const A = { division: 'A', season: '2', grouped: false, matches: [
  { slot: 'SF1', p1: 'Roman Vengerak', p2: 'Ramon Puchades', played: true, winner: 'Roman Vengerak', score: '6:4 6:3' },
  { slot: 'SF2', p1: 'Nikita Secret', p2: 'Michael Gofshteyn', played: true, winner: 'Michael Gofshteyn', score: '4:6 6:3 10:8' },
  { slot: 'Final', p1: 'Roman Vengerak', p2: 'Michael Gofshteyn', played: true, winner: 'Roman Vengerak', score: '7:6 6:4' },
  { slot: '3rd', p1: 'Ramon Puchades', p2: 'Nikita Secret' }] };
const ba = await card.renderBracketImage(A);
check(await size(ba) === '1080x1920' && await differ(ba, bw) > 1, 'Сетка дивизиона из одной группы, с чемпионом');
const empty = await card.renderBracketImage({ division: 'C', season: '2', grouped: true, matches: [] });
check(await size(empty) === '1080x1920', 'Пустая сетка (ещё нет пар) не падает');

// Афиша дня.
const day = await card.renderPlayoffSchedule({ date: '2026-11-07', venue: 'The Peak Racquet Park', matches: [
  { time: '09:00', division: 'A', stage: 'SF', p1: 'Roman Vengerak', p2: 'Ramon Puchades' }, { time: '', division: 'W', stage: 'Final', p1: 'Winner SF1', p2: 'Winner SF2' }] });
check(await size(day) === '1080x1350', 'Афиша дня 1080×1350, матч без времени — «TBA», не падает');
const many = await card.renderPlayoffSchedule({ date: '2026-11-08', matches: Array.from({ length: 12 }, (_, i) => ({ time: `${8 + i}:00`, division: 'A', stage: 'SF', p1: 'Player ' + i, p2: 'Rival ' + i })) });
check(await size(many) === '1080x1350', 'Афиша на 12 матчей помещается');

console.log(`PASS: ${checks} playoff render checks — cards, posters, place posters, bracket and day schedule drawn for real.`);
process.exit(0);
