// Проверка языка игроков (команда /lang_check).
//
// Язык человека живёт в листе Applicants, колонка language. Сбой «переключаю
// язык, а сообщения всё равно по-русски» получался так:
//   · у человека несколько строк (лид + анкета, ручной перенос) с разным языком,
//     и разные части бота находили разные строки;
//   · язык записан не «ru» / «en», а «English», «RUS», «EN » — одни места его
//     понимали, другие нет;
//   · telegram_id в таблице показан как «1,234,567,890» или «1.23E+9» — по нему
//     человек не находился, и бот брал язык Telegram или язык по умолчанию.
// Чтение листа теперь само приводит язык и id к одному виду, смена языка
// пишется во все строки человека, а эта проверка находит и чинит то, что уже
// лежит в таблице.
import { getRows, updateObjectByRow, normTgId, normLang, sameName, findApplicantByTelegramId, findApplicantByTelegramIdentity, getAllBotSubscribers } from './sheets.js';
import { SHEETS } from './config.js';
import { nowISO, escapeHtml } from './util.js';

const txt = v => String(v ?? '').trim();
const nick = r => {
  const a = txt(r.telegram_username).replace(/^@/, '').toLowerCase();
  const b = txt(r.telegram).replace(/^https?:\/\/t\.me\//, '').replace(/^t\.me\//, '').replace(/^@/, '').toLowerCase();
  return [a, b].filter(Boolean);
};
const stamp = r => Date.parse(txt(r.updated_at) || txt(r.created_at) || txt(r.date)) || 0;

// Кластеры «один человек»: строки с общим id Telegram или общим ником.
export function clusters(rows = []) {
  const parent = rows.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent[y] = x; };
  const byKey = new Map();
  rows.forEach((r, i) => {
    const keys = [];
    const id = normTgId(r.telegram_id);
    if (id) keys.push('id:' + id);
    for (const n of nick(r)) keys.push('u:' + n);
    for (const k of keys) { if (byKey.has(k)) join(byKey.get(k), i); else byKey.set(k, i); }
  });
  const groups = new Map();
  rows.forEach((r, i) => { const g = find(i); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); });
  return [...groups.values()];
}

export function scanRows(rows = []) {
  const dupes = clusters(rows).filter(g => g.length > 1).map(g => {
    const langs = [...new Set(g.map(r => normLang(r.language)).filter(Boolean))];
    const latest = g.slice().sort((a, b) => stamp(b) - stamp(a)).find(r => normLang(r.language)) || null;
    return { rows: g, langs, conflict: langs.length > 1, target: latest ? normLang(latest.language) : '' };
  });
  const raw = r => (r._lang_raw !== undefined ? r._lang_raw : r.language);
  const rawId = r => (r._id_raw !== undefined ? r._id_raw : r.telegram_id);
  const oddLang = rows.filter(r => txt(raw(r)) && !['ru', 'en'].includes(txt(raw(r))));
  const oddId = rows.filter(r => txt(rawId(r)) && !/^\d+$/.test(txt(rawId(r))));
  const noLang = rows.filter(r => normTgId(r.telegram_id) && !normLang(r.language));
  // Одноимённые строки с разным языком — по имени язык ищет сводка темпа.
  const sameNameConflicts = [];
  const seen = new Set();
  for (const r of rows) {
    if (!txt(r.name) || seen.has(r._rowNumber)) continue;
    const twins = rows.filter(o => o !== r && sameName(o.name, r.name));
    if (!twins.length) continue;
    const all = [r, ...twins];
    all.forEach(x => seen.add(x._rowNumber));
    const langs = new Set(all.map(x => normLang(x.language)).filter(Boolean));
    if (langs.size > 1) sameNameConflicts.push(all);
  }
  return { total: rows.length, dupes, oddLang, oddId, noLang, sameNameConflicts };
}

export async function scanApplicants() {
  const { rows } = await getRows(SHEETS.applicants, { useCache: false });
  return scanRows(rows);
}

const rowLine = r => `стр. ${r._rowNumber}: ${escapeHtml(txt(r.name) || '—')} · id ${escapeHtml(txt(r._id_raw ?? r.telegram_id) || '—')}${nick(r)[0] ? ' · @' + escapeHtml(nick(r)[0]) : ''} · язык «${escapeHtml(txt(r._lang_raw ?? r.language) || '—')}»${txt(r.updated_at) ? ' · ' + escapeHtml(txt(r.updated_at).slice(0, 10)) : ''}`;

export function scanText(rep) {
  const lines = [`🌐 <b>Язык игроков</b> · строк в Applicants: ${rep.total}`];
  const conflicts = rep.dupes.filter(d => d.conflict);
  lines.push('');
  lines.push(conflicts.length ? `<b>Один человек — несколько строк с разным языком: ${conflicts.length}</b>` : 'Дублей с разным языком нет.');
  for (const d of conflicts.slice(0, 15)) {
    lines.push(`• станет «${d.target}» (по последней правке):`);
    for (const r of d.rows) lines.push('   ' + rowLine(r));
  }
  const same = rep.dupes.filter(d => !d.conflict).length;
  if (same) lines.push(`Дублей с одинаковым языком: ${same} (на язык не влияют).`);
  if (rep.oddLang.length) {
    lines.push('');
    lines.push(`<b>Язык записан не как «ru» / «en»: ${rep.oddLang.length}</b>`);
    for (const r of rep.oddLang.slice(0, 15)) lines.push('• ' + rowLine(r) + (normLang(r.language) ? ` → ${normLang(r.language)}` : ' → не распознан'));
  }
  if (rep.oddId.length) {
    lines.push('');
    lines.push(`<b>telegram_id в странном виде: ${rep.oddId.length}</b> (бот теперь их понимает, fix перепишет)`);
    for (const r of rep.oddId.slice(0, 15)) lines.push('• ' + rowLine(r) + ` → ${normTgId(r.telegram_id) || '?'}`);
  }
  if (rep.sameNameConflicts.length) {
    lines.push('');
    lines.push(`<b>Одноимённые строки с разным языком: ${rep.sameNameConflicts.length}</b> (разные id — проверьте руками)`);
    for (const g of rep.sameNameConflicts.slice(0, 10)) for (const r of g) lines.push('• ' + rowLine(r));
  }
  if (rep.noLang.length) lines.push(`\nБез языка (бот спросит при первом сообщении): ${rep.noLang.length}`);
  const fixable = conflicts.length + rep.oddLang.filter(r => normLang(r.language)).length + rep.oddId.length;
  if (fixable) lines.push('\nИсправить: <code>/lang_check fix</code>');
  else if (!rep.sameNameConflicts.length) lines.push('\n✅ Всё в порядке.');
  return lines.join('\n');
}

export async function fixApplicants(rep) {
  const done = new Set(), ids = new Set();
  for (const d of rep.dupes.filter(x => x.conflict && x.target)) {
    for (const r of d.rows) {
      if (normLang(r.language) === d.target) continue;
      await updateObjectByRow(SHEETS.applicants, r._rowNumber, { language: d.target, updated_at: nowISO() });
      done.add(r._rowNumber);
      if (normTgId(r.telegram_id)) ids.add(normTgId(r.telegram_id));
    }
  }
  // Строка перечитывается при записи уже в обычном виде (язык и id приведены
  // при чтении) — достаточно её переписать.
  for (const r of [...rep.oddLang.filter(x => normLang(x.language)), ...rep.oddId]) {
    if (done.has(r._rowNumber)) continue;
    const patch = {};
    if (normLang(r.language)) patch.language = normLang(r.language);
    if (normTgId(r.telegram_id)) patch.telegram_id = normTgId(r.telegram_id);
    await updateObjectByRow(SHEETS.applicants, r._rowNumber, patch);
    done.add(r._rowNumber);
    if (normTgId(r.telegram_id)) ids.add(normTgId(r.telegram_id));
  }
  return { rows: done.size, ids: [...ids] };
}

// Один человек: все его строки и какой язык видит каждый канал.
export async function personReport(query = '', { memoryOf = () => null } = {}) {
  const { rows } = await getRows(SHEETS.applicants, { useCache: false });
  const q = txt(query);
  let hits;
  if (/^\d[\d\s,.]*$/.test(q)) hits = rows.filter(r => normTgId(r.telegram_id) === normTgId(q));
  else if (q.startsWith('@')) hits = rows.filter(r => nick(r).includes(q.slice(1).toLowerCase()));
  else hits = rows.filter(r => sameName(r.name, q) || txt(r.name).toLowerCase().includes(q.toLowerCase()));
  if (!hits.length) return `Никого не нашёл по «${escapeHtml(q)}».`;
  const group = clusters(rows).filter(g => g.some(r => hits.includes(r)));
  const lines = [];
  for (const g of group.slice(0, 4)) {
    const ids = [...new Set(g.map(r => normTgId(r.telegram_id)).filter(Boolean))];
    const users = [...new Set(g.flatMap(nick))];
    lines.push(`🌐 <b>${escapeHtml(txt(g[0].name) || q)}</b> — строк: ${g.length}`);
    for (const r of g) lines.push('• ' + rowLine(r));
    const id = ids[0] || '';
    if (id) {
      const mem = memoryOf(id);
      const bot = mem?.fresh ? `${mem.v} (память бота)` : (normLang((await findApplicantByTelegramId(id).catch(() => null))?.language) || 'не задан — бот спросит');
      const app = normLang((await findApplicantByTelegramIdentity({ id, username: users[0] || '' }).catch(() => null))?.language) || 'не задан — по языку Telegram';
      const sub = (await getAllBotSubscribers().catch(() => [])).find(s => normTgId(s.telegram_id) === id);
      const feed = sub ? (normLang(sub.language) === 'en' ? 'en' : normLang(sub.language) === 'ru' ? 'ru' : 'ru (язык не задан)') : 'не получает (отписан или неактивен)';
      lines.push(`Бот: ${bot} · Приложение: ${app} · Лента результатов: ${feed}`);
    } else lines.push('⚠️ Ни в одной строке нет telegram_id — бот узнаёт человека только по нику.');
    const langs = [...new Set(g.map(r => normLang(r.language)).filter(Boolean))];
    if (ids.length > 1) lines.push(`⚠️ Разные telegram_id в строках: ${ids.join(', ')}`);
    if (langs.length > 1) lines.push('⚠️ Строки расходятся по языку — <code>/lang_check fix</code> выровняет по последней правке.');
    lines.push('');
  }
  return lines.join('\n').trim();
}
