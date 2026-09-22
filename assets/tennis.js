// Теннисный счёт: разбор, проверка и форматирование.
//
// Логика перенесена из results-бота, который читал счёт из общего чата. Здесь она
// живёт отдельным модулем без побочных эффектов — её использует и приём результата
// из мини-приложения, и запись в таблицы лиги.
//
// Формат счёта (совместим с прежними колонками таблиц):
//   { s1p1, s1p2, s1tb1, s1tb2, s2..., s3... } — строки или числа, пустая строка = нет.

export function getSets(p = {}) {
  const sets = [];
  const push = (a, b, tba, tbb) => {
    if (a !== '' && b !== '' && a !== undefined && b !== undefined) {
      sets.push({ a: Number(a), b: Number(b), tba: tba ?? '', tbb: tbb ?? '' });
    }
  };
  push(p.s1p1, p.s1p2, p.s1tb1, p.s1tb2);
  push(p.s2p1, p.s2p2, p.s2tb1, p.s2tb2);
  push(p.s3p1, p.s3p2, p.s3tb1, p.s3tb2);
  return sets;
}

function validateTieBreak(set, setWinner, minWinningPoints) {
  if (set.tba === '' && set.tbb === '') return { ok: true };
  if (set.tba === '' || set.tbb === '') return { ok: false, message: 'Счёт тай-брейка неполный.' };
  const tba = Number(set.tba), tbb = Number(set.tbb);
  if (!Number.isFinite(tba) || !Number.isFinite(tbb)) return { ok: false, message: 'Счёт тай-брейка не число.' };
  if (tba === tbb) return { ok: false, message: 'Тай-брейк не может закончиться вничью.' };
  const tbWinner = tba > tbb ? 'p1' : 'p2';
  const max = Math.max(tba, tbb), min = Math.min(tba, tbb);
  if (tbWinner !== setWinner) return { ok: false, message: 'Победитель тай-брейка не совпадает с победителем сета.' };
  if (max < minWinningPoints) return { ok: false, message: 'Слишком мало очков у победителя тай-брейка.' };
  if (max - min < 2) return { ok: false, message: 'Тай-брейк выигрывается с разницей в 2 очка.' };
  return { ok: true };
}

export function classifyNormalSet(set) {
  const { a, b } = set;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: false, message: 'Счёт сета не число.' };
  if (a === b) return { ok: false, message: 'Сет не может закончиться вничью.' };
  const max = Math.max(a, b), min = Math.min(a, b);
  const winner = a > b ? 'p1' : 'p2';
  const isRegularSix = max === 6 && min >= 0 && min <= 4;
  const isSevenFive = max === 7 && min === 5;
  const isSevenSix = max === 7 && min === 6;
  if (!isRegularSix && !isSevenFive && !isSevenSix) {
    return { ok: false, message: `Недопустимый счёт сета ${a}:${b}. Допустимо, например: 6:4, 7:5, 7:6.` };
  }
  if (isSevenSix) {
    const tb = validateTieBreak(set, winner, 7);
    if (!tb.ok) return tb;
  }
  return { ok: true, winner };
}

export function classifyMatchTieBreak(set) {
  const { a, b } = set;
  if (a === b) return { ok: false, message: 'Чемпионский тай-брейк не может закончиться вничью.' };
  const max = Math.max(a, b), min = Math.min(a, b);
  const winner = a > b ? 'p1' : 'p2';
  if (max < 10) return { ok: false, message: 'В чемпионском тай-брейке победителю нужно минимум 10 очков.' };
  if (max - min < 2) return { ok: false, message: 'Чемпионский тай-брейк выигрывается с разницей в 2 очка.' };
  if (max > 30) return { ok: false, message: 'Слишком большой счёт для тай-брейка — проверьте.' };
  return { ok: true, winner, mode: 'Match TB' };
}

export function classifyThirdSet(set) {
  const { a, b } = set;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: false, message: 'Счёт сета не число.' };
  if (a >= 10 || b >= 10) return classifyMatchTieBreak(set);
  const normal = classifyNormalSet(set);
  if (!normal.ok) return normal;
  return { ok: true, winner: normal.winner, mode: 'Full Set' };
}

// Полная проверка матча: два или три сета, победитель определён однозначно.
export function validateMatchScore(p) {
  const sets = getSets(p);
  if (sets.length < 2) return { ok: false, message: 'В завершённом матче должно быть минимум два сета.' };
  if (sets.length > 3) return { ok: false, message: 'В матче не может быть больше трёх сетов.' };

  const first = classifyNormalSet(sets[0]);
  if (!first.ok) return { ok: false, message: `Сет 1: ${first.message}` };
  const second = classifyNormalSet(sets[1]);
  if (!second.ok) return { ok: false, message: `Сет 2: ${second.message}` };

  const p1 = (first.winner === 'p1' ? 1 : 0) + (second.winner === 'p1' ? 1 : 0);
  const p2 = (first.winner === 'p2' ? 1 : 0) + (second.winner === 'p2' ? 1 : 0);

  if (p1 === 2 || p2 === 2) {
    if (sets.length > 2) return { ok: false, message: 'Матч уже закончен после двух сетов, но указан третий.' };
    return { ok: true, winner: p1 === 2 ? 'p1' : 'p2', set3Mode: '' };
  }
  if (p1 === 1 && p2 === 1) {
    if (sets.length < 3) return { ok: false, message: 'После двух сетов 1:1 — укажите третий сет или чемпионский тай-брейк.' };
    const third = classifyThirdSet(sets[2]);
    if (!third.ok) return { ok: false, message: `Сет 3: ${third.message}` };
    return { ok: true, winner: third.winner, set3Mode: third.mode };
  }
  return { ok: false, message: 'Счёт матча неполный.' };
}

export function scoreValues(p = {}) {
  return [p.s1p1, p.s1p2, p.s1tb1, p.s1tb2, p.s2p1, p.s2p2, p.s2tb1, p.s2tb2, p.s3p1, p.s3p2, p.s3tb1, p.s3tb2]
    .map(v => (v === undefined || v === null ? '' : v));
}

export function formatSet(a, b, tba, tbb) {
  let s = `${a}:${b}`;
  if (tba !== '' && tbb !== '' && tba !== undefined && tbb !== undefined) s += ` (${tba}:${tbb})`;
  return s;
}

export function formatScore(p = {}) {
  return getSets(p).map(s => formatSet(s.a, s.b, s.tba, s.tbb)).join('  ');
}

export function detectSet3Mode(p = {}) {
  if (p.s3p1 === '' || p.s3p2 === '' || p.s3p1 === undefined || p.s3p2 === undefined) return '';
  const a = Number(p.s3p1), b = Number(p.s3p2);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  return a >= 10 || b >= 10 ? 'Match TB' : 'Full Set';
}

// Счёт всегда хранится «от первого игрока». Если результат вносил соперник,
// его нужно перевернуть перед записью.
export function reverseScore(p = {}) {
  return {
    s1p1: p.s1p2, s1p2: p.s1p1, s1tb1: p.s1tb2, s1tb2: p.s1tb1,
    s2p1: p.s2p2, s2p2: p.s2p1, s2tb1: p.s2tb2, s2tb2: p.s2tb1,
    s3p1: p.s3p2, s3p2: p.s3p1, s3tb1: p.s3tb2, s3tb2: p.s3tb1
  };
}

// Плоская строка для хранения в таблице заявок: «6:4 7:6 (7:4)».
export function scoreToCell(p = {}) { return formatScore(p); }

export function cellToScore(cell = '') {
  const out = { s1p1:'', s1p2:'', s1tb1:'', s1tb2:'', s2p1:'', s2p2:'', s2tb1:'', s2tb2:'', s3p1:'', s3p2:'', s3tb1:'', s3tb2:'' };
  const re = /(\d{1,2})\s*[:\-]\s*(\d{1,2})(?:\s*\(\s*(\d{1,2})\s*[:\-]\s*(\d{1,2})\s*\))?/g;
  let m, i = 0;
  while ((m = re.exec(String(cell || ''))) !== null && i < 3) {
    const n = i + 1;
    out[`s${n}p1`] = m[1]; out[`s${n}p2`] = m[2];
    out[`s${n}tb1`] = m[3] || ''; out[`s${n}tb2`] = m[4] || '';
    i++;
  }
  return out;
}
