// Отказ (RET), когда снялся тот, кто вёл по счёту.
//
// Таблица дивизиона определяет победителя (Winner ID) по сетам. Если снялся
// ведущий, победа ушла бы ему. Договорились: такой матч пишется как сыгранный
// (счёт на момент снятия, Completed? = Yes — сеты и геймы идут в разницу), а в
// колонке «Tech Result» стоит сторона победителя: P1 или P2. Формула Winner ID
// сначала смотрит туда, потом — на сеты, как раньше.
//
// Разовая починка (fixRetWinnerFormulas) переписывает формулу Winner ID во всех
// таблицах дивизионов сезона: только ячейки со стандартной формулой, в формате
// таблицы (запятая или точка с запятой), с проверкой и откатом. Плюс правит
// строку матча Илья Изотов — Никита Тати (B), записанную до этой починки.
import { sheets as sheetsClient } from './google.js';
import { formulaIn, sameFormula, formulaSep } from './playoff.js';

const txt = v => String(v ?? '').trim();
const COLS = { S: 'Completed?', T: 'Tech Result', U: 'P1 Sets Won', V: 'P2 Sets Won', Y: 'Winner ID' };
const colIdx = l => l.charCodeAt(0) - 65;

export const oldWinnerFormula = r => `=IF(S${r}<>"Yes","",IF(U${r}>V${r},B${r},IF(V${r}>U${r},D${r},"")))`;
export const newWinnerFormula = r => `=IF(S${r}<>"Yes","",IF(T${r}="P1",B${r},IF(T${r}="P2",D${r},IF(U${r}>V${r},B${r},IF(V${r}>U${r},D${r},"")))))`;

async function get(spreadsheetId, range, render = 'FORMATTED_VALUE') {
  const r = await sheetsClient().spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: render });
  return r?.data?.values || [];
}
async function put(spreadsheetId, cells) {
  if (!cells.length) return;
  await sheetsClient().spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED',
    data: cells.map(([a1, v]) => ({ range: `Match_Log!${a1}`, values: [[v]] })) } });
}

// Одна таблица: переписать формулы, проверить, при ошибке — вернуть как было.
export async function fixSheetFormulas(spreadsheetId) {
  const head = (await get(spreadsheetId, 'Match_Log!A1:Z1'))[0] || [];
  for (const [l, name] of Object.entries(COLS)) {
    if (txt(head[colIdx(l)]).toLowerCase() !== name.toLowerCase()) return { ok: false, reason: `колонка ${l} — «${txt(head[colIdx(l)])}», ждали «${name}»` };
  }
  const formulas = await get(spreadsheetId, 'Match_Log!Y1:Y200', 'FORMULA');
  const cells = [];
  formulas.forEach((row, i) => {
    const r = i + 1, f = txt(row?.[0]);
    if (r < 2 || !f) return;
    if (sameFormula(f, oldWinnerFormula(r))) cells.push([`Y${r}`, f]);
  });
  if (!cells.length) return { ok: true, changed: 0, skipped: formulas.length - 1 };
  const sep = await formulaSep(spreadsheetId);
  await put(spreadsheetId, cells.map(([a1]) => [a1, formulaIn(newWinnerFormula(Number(a1.slice(1))), sep)]));
  // Проверка: формула записалась той, что нужна, и не показывает ошибку.
  const after = await get(spreadsheetId, 'Match_Log!Y1:Y200', 'FORMULA');
  const shown = await get(spreadsheetId, 'Match_Log!Y1:Y200');
  const bad = cells.filter(([a1]) => {
    const r = Number(a1.slice(1));
    return !sameFormula(txt(after[r - 1]?.[0]), newWinnerFormula(r)) || /^#/.test(txt(shown[r - 1]?.[0]));
  });
  if (bad.length) {
    await put(spreadsheetId, cells).catch(e => console.error('ret formula rollback failed:', e.message));
    return { ok: false, reason: `ошибка в ${bad.map(c => c[0]).slice(0, 5).join(', ')} — откатил все ${cells.length}`, changed: 0 };
  }
  return { ok: true, changed: cells.length };
}

// Строка матча: снялся P1 (вёл по счёту) — победа P2. Сеты и геймы остаются.
export async function fixRetRow(spreadsheetId, p1Name, p2Name, winnerSide) {
  const vals = await get(spreadsheetId, 'Match_Log!A1:AG200');
  const head = (vals[0] || []).map(h => txt(h).toLowerCase());
  const at = n => head.indexOf(n.toLowerCase());
  const iP1 = at('player 1'), iP2 = at('player 2'), iS = at('completed?'), iT = at('tech result'), iL1 = at('p1 techloss'), iL2 = at('p2 techloss');
  if ([iP1, iP2, iS, iT, iL1, iL2].some(i => i < 0)) return { ok: false, reason: 'не нашёл колонки' };
  const same = (a, b) => txt(a).toLowerCase() === txt(b).toLowerCase();
  const idx = vals.findIndex((r, i) => i > 0 && same(r[iP1], p1Name) && same(r[iP2], p2Name));
  if (idx < 0) return { ok: false, reason: `строка ${p1Name} — ${p2Name} не найдена` };
  const r = idx + 1;
  const col = i => (i < 26 ? String.fromCharCode(65 + i) : 'A' + String.fromCharCode(65 + i - 26));
  await put(spreadsheetId, [[`${col(iS)}${r}`, 'Yes'], [`${col(iT)}${r}`, winnerSide], [`${col(iL1)}${r}`, ''], [`${col(iL2)}${r}`, '']]);
  const back = (await get(spreadsheetId, `Match_Log!A${r}:AG${r}`))[0] || [];
  const ok = same(back[iS], 'Yes') && same(back[iT], winnerSide) && !txt(back[iL1]) && !txt(back[iL2]);
  return { ok, row: r, winner_shown: txt(back[at('winner id')]) };
}

export async function fixRetWinnerFormulas() {
  const div = await import('./division.js');
  const season = await div.latestSeason();
  const letters = await div.availableDivisions(season);
  // Снимок мест до — чтобы после сравнить: формула не должна сдвинуть ни одного
  // игрока, кроме исправленного матча.
  const sheets = [];
  for (const L of letters) {
    const groups = await div.divisionGroups(L, season).catch(() => []);
    for (const g of (groups.length ? groups.map(x => x.group) : [''])) {
      const id = await div.divisionSheetId(L, season, g).catch(() => '');
      if (id) sheets.push({ L, g, id });
    }
  }
  const snap = async () => {
    div.invalidateDivisionCache();
    const out = {};
    for (const s of sheets) {
      const t = await div.getDivisionTable(s.L, season, s.g).catch(() => null);
      out[`${s.L}${s.g}`] = t?.ok ? t.players.map(p => `${p.name}:${p.place}:${p.matches}/${p.wins}/${p.points}/${p.setDiff}/${p.gameDiff}`) : null;
    }
    return out;
  };
  const before = await snap();
  const lines = ['🛠 <b>RET: формула победителя в таблицах дивизионов</b>', ''];
  for (const s of sheets) {
    const r = await fixSheetFormulas(s.id).catch(e => ({ ok: false, reason: e.message }));
    lines.push(`${s.L}${s.g ? ' гр.' + s.g : ''}: ${r.ok ? `формул обновлено ${r.changed}` : '⚠️ ' + r.reason}`);
  }
  const b = sheets.find(s => s.L === 'B' && !s.g);
  if (b) {
    const r = await fixRetRow(b.id, 'Ilia Izotov', 'Nikita Tati', 'P2').catch(e => ({ ok: false, reason: e.message }));
    lines.push('', r.ok ? `B, Ilia Izotov — Nikita Tati (строка ${r.row}): Completed = Yes, Tech Result = P2, тех. поражение снято.` : `⚠️ B, Ilia Izotov — Nikita Tati: ${r.reason || 'проверка не сошлась'}`);
  }
  const after = await snap();
  const moved = [];
  for (const k of Object.keys(after)) {
    const a = before[k] || [], z = after[k] || [];
    for (const row of z) if (!a.includes(row)) moved.push(`${k}: ${row}`);
  }
  lines.push('', moved.length ? 'Изменилось в таблицах:\n' + moved.map(x => '• ' + x.replace(/:(\d+):(\d+)\/(\d+)\/(\d+)\/(-?\d+)\/(-?\d+)$/, ' — место $1, матчей $2, побед $3, очков $4, сеты $5, геймы $6')).join('\n') : 'Места и очки в таблицах не изменились.');
  lines.push('', 'Резервные копии таблиц сделаны до правки (BACKUP 2026-10-31 before RET fix).');
  return lines.join('\n');
}
