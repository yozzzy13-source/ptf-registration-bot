// Переходы между дивизионами (movement.js): отметки, «борьба» групп, стыки.
import assert from 'node:assert/strict';
import { movementFrom, rankPlayers } from '../movement.js';

let n = 0;
const check = (ok, msg) => { assert.ok(ok, msg); n++; };
// Таблица из 8 игроков: места по порядку, очки убывают.
const table = (prefix, pts = [20, 17, 15, 13, 11, 9, 7, 5]) => pts.map((p, i) => ({ name: `${prefix}${i + 1}`, place: i + 1, points: p, wins: Math.floor(p / 3), matches: 7, setDiff: 0, gameDiff: 0, setsWon: 0 }));
const single = (L, rows) => ({ letter: L, grouped: false, groups: [{ group: '', players: rows }] });
const grouped = (L, a, b) => ({ letter: L, grouped: true, groups: [{ group: '1', players: a }, { group: '2', players: b }] });

// Сезон 2: Prime, A, B, C (две группы), W (две группы); D нет.
const c1 = table('C1-', [16, 15, 14, 12, 9, 8, 6, 4]);
const c2 = table('C2-', [19, 18, 13, 12, 10, 7, 5, 3]);
const w1 = table('W1-', [15, 12, 10, 8, 6, 4]), w2 = table('W2-', [14, 13, 9, 7, 5, 3]);
const mv = movementFrom({ PRIME: single('PRIME', table('P')), A: single('A', table('A')), B: single('B', table('B')), C: grouped('C', c1, c2), W: grouped('W', w1, w2) }, '2');
const m = (L, name) => mv.divisions[L].marks[name.toLowerCase()];

check(movementFrom({ A: single('A', table('A')) }, '1') === null, 'Сезон 1 — по старым правилам (нет расчёта)');
check(Object.keys(mv.divisions.PRIME.marks).length === 1 && m('PRIME', 'P8')?.k === 'down' && m('PRIME', 'P8').to === 'A', 'Prime: только #8 — вылет в A');
check(!m('PRIME', 'P7'), 'Prime #7 — без стыка');
check(m('A', 'A1')?.k === 'up' && m('A', 'A1').to === 'PRIME' && !m('A', 'A2'), 'A: #1 → Prime, #2 без стыка');
check(m('A', 'A7')?.k === 'po_down' && m('A', 'A8')?.k === 'down' && m('A', 'A8').to === 'B', 'A: #7 стык за сохранение, #8 → B');
check(m('B', 'B1')?.k === 'up' && m('B', 'B2')?.k === 'po_up' && m('B', 'B7')?.k === 'po_down' && m('B', 'B8')?.k === 'down', 'B: #1 ↑, #2 ↕, #7 ↕, #8 ↓');
check(!m('B', 'B3') && !m('B', 'B6'), 'B: 3–6 остаются');
const C = mv.divisions.C;
check(C.top.length === 8 && C.top.map(r => r.name).join() === 'C2-1,C2-2,C1-1,C1-2,C1-3,C2-3,C1-4,C2-4', 'C: «борьба за повышение» — первые 4 места обеих групп в общем порядке');
check(C.top[0].mark === 'up' && C.top[0].to === 'B' && C.top[1].mark === 'po_up' && C.top[1].name === 'C2-2', 'C: общий #1 ↑, общий #2 ↕ — оба могут быть из одной группы');
check(C.bottom.length === 8 && C.bottom[7].name === 'C2-8' && C.bottom[7].mark === 'down' && C.bottom[7].to === 'D', 'C: худший из последних 4 мест обеих групп — вылет в D');
check(!C.bottom[6].mark, 'C без D в сезоне: второй худший без стыка');
check(C.notes.includes('groups') && C.notes.includes('forms_D') && !C.notes.includes('lowest'), 'C: пометки «две группы» и «D собирается заново»');
const W = mv.divisions.W;
check(W.top[0].name === 'W1-1' && W.top[0].mark === 'opt' && W.top[0].to === 'C' && !W.top[1].mark && !W.bottom, 'W: общий #1 — право на переход в C, вылета нет');
check(mv.duels.length === 2 && mv.duels[0].key === 'A-B' && mv.duels[0].upper_player === 'A7' && mv.duels[0].lower_player === 'B2', 'Стык A #7 — B #2');
check(mv.duels[1].key === 'B-C' && mv.duels[1].upper_player === 'B7' && mv.duels[1].lower_player === 'C2-2' && mv.duels[1].lower_label === 'гр. 2 · #2', 'Стык B #7 — общий #2 C (с подписью группы)');

// Следующий сезон: D есть — C ↔ D со стыком, D — нижний дивизион.
const mv3 = movementFrom({ A: single('A', table('A')), B: single('B', table('B')), C: grouped('C', c1, c2), D: single('D', table('D')) }, '3');
check(mv3.divisions.C.bottom[6].mark === 'po_down' && mv3.divisions.C.bottom[7].mark === 'down', 'C при D: второй худший — стык, худший — вылет');
check(mv3.divisions.D.marks.d1?.k === 'up' && mv3.divisions.D.marks.d2?.k === 'po_up' && !mv3.divisions.D.marks.d8 && mv3.divisions.D.notes.includes('lowest'), 'D: #1 ↑, #2 ↕, вылета нет');
check(mv3.duels.some(d => d.key === 'C-D' && d.upper_player === mv3.divisions.C.bottom[6].name && d.lower_player === 'D2'), 'Стык C (второй худший) — D #2');
check(!mv3.divisions.A.marks.a1, 'A без Prime: наверх никто');

// Критерии сравнения: очки → победы → сеты → геймы → выигранные сеты.
const x = { name: 'X', points: 10, wins: 3, setDiff: 2, gameDiff: 5, setsWon: 7 }, y = { ...x, name: 'Y', gameDiff: 6 };
check([x, y].sort(rankPlayers)[0].name === 'Y', 'При равенстве очков, побед и сетов решает разница геймов');
console.log(`PASS: ${n} movement checks — marks, group races, promotion playoffs.`);
