// Хранилище турниров: отдельные таблицы «PTF Tournaments» (боевая) и
// «PTF Tournaments TEST» (тестовая), лежат в папке PTF рядом с остальными.
//
// Зачем отдельно от основной таблицы. Турниры пишут много и часто (жеребьёвка —
// это сотни строк, каждый счёт — обновление), а у Google на пользователя
// лимит запросов в минуту. Пока турниры жили в общей таблице, они делили этот
// лимит с рассылками, анкетами и матчами лиги. Теперь у них свой файл и свой
// кэш: запись в турнир не сбрасывает кэш всего остального.
//
// Тестовый режим — это вторая таблица, а не суффикс на листах: боевые и
// тестовые данные физически не могут смешаться, и тест можно стереть целиком,
// не думая, что заденешь боевое.
//
// Устроено так же, как остальной слой листов (строки приходят объектами с
// _rowNumber, записи идут в очередь на лист), но привязано к конкретной
// таблице, а кэш и запись трогают только свой лист.
import { sheets as sheetsClient } from './google.js';
import { TOURNAMENTS_SPREADSHEET_ID, TOURNAMENTS_TEST_SPREADSHEET_ID } from './config.js';

const FRESH_MS = 15_000;
const colToA1 = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - m) / 26); } return s; };
const DEFAULT_TITLES = /^(sheet\s*1|лист\s*1)$/i;

export const tournamentSpreadsheetId = (test = false) => test ? TOURNAMENTS_TEST_SPREADSHEET_ID : TOURNAMENTS_SPREADSHEET_ID;

const stores = new Map();
export function tournamentStore(test = false) {
  const id = tournamentSpreadsheetId(test);
  if (!id) throw new Error(test ? 'Не задана тестовая таблица турниров' : 'Не задана таблица турниров');
  if (!stores.has(id)) stores.set(id, makeStore(id));
  return stores.get(id);
}
// Для тестов: забыть всё, что помним о таблицах.
export function __resetTournamentStores() { stores.clear(); }

function makeStore(spreadsheetId) {
  const cache = new Map();          // лист → { t, v }
  const ready = new Map();          // лист → promise «лист заведён»
  const queue = new Map();          // лист → хвост очереди записей
  let meta = null;                  // { title → { sheetId, rowCount } }

  const api = () => sheetsClient();

  async function loadMeta(force = false) {
    if (meta && !force) return meta;
    const res = await api().spreadsheets.get({ spreadsheetId });
    meta = new Map((res.data.sheets || []).map(s => [s.properties.title, {
      sheetId: s.properties.sheetId,
      rowCount: Number(s.properties.gridProperties?.rowCount || 0)
    }]));
    return meta;
  }

  async function valuesGet(range) {
    const res = await api().spreadsheets.values.get({ spreadsheetId, range });
    return res.data.values || [];
  }
  async function valuesUpdate(range, values) {
    await api().spreadsheets.values.update({ spreadsheetId, range, valueInputOption: 'USER_ENTERED', requestBody: { values } });
  }

  // Лист с заголовками. Новую таблицу Google создаёт с пустым «Sheet1» — его
  // переименовываем под первый нужный лист, а не оставляем мусор рядом.
  async function ensureSheet(name, headers) {
    if (!ready.has(name)) {
      ready.set(name, (async () => {
        let m = await loadMeta();
        if (!m.has(name)) {
          const defaults = [...m.entries()].filter(([t]) => DEFAULT_TITLES.test(t));
          if (m.size === 1 && defaults.length === 1) {
            await api().spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [
              { updateSheetProperties: { properties: { sheetId: defaults[0][1].sheetId, title: name, gridProperties: { frozenRowCount: 1 } }, fields: 'title,gridProperties.frozenRowCount' } }
            ] } });
          } else {
            await api().spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [
              { addSheet: { properties: { title: name, gridProperties: { rowCount: 1000, columnCount: Math.max(headers.length, 20), frozenRowCount: 1 } } } }
            ] } });
          }
          m = await loadMeta(true);
        }
        const first = (await valuesGet(`'${name}'!A1:BZ1`).catch(() => []))[0] || [];
        const merged = [...first];
        for (const h of headers) if (!merged.includes(h)) merged.push(h);
        if (merged.join('|') !== first.join('|')) await valuesUpdate(`'${name}'!A1:${colToA1(merged.length)}1`, [merged]);
        return merged;
      })().catch(e => { ready.delete(name); throw e; }));
    }
    return ready.get(name);
  }

  async function readSheet(name) {
    const values = await valuesGet(`'${name}'!A:BZ`);
    const headers = values[0] || [];
    const rows = values.slice(1).map((r, i) => {
      const o = { _rowNumber: i + 2 };
      headers.forEach((h, k) => { o[h] = r[k] ?? ''; });
      return o;
    });
    const out = { headers, rows, values };
    cache.set(name, { t: Date.now(), v: out });
    return out;
  }
  async function getRows(name, { useCache = true } = {}) {
    const hit = cache.get(name);
    if (useCache && hit && Date.now() - hit.t < FRESH_MS) return hit.v;
    return readSheet(name);
  }
  const forget = name => cache.delete(name);
  const invalidate = () => cache.clear();

  async function ensureCapacity(name, lastRow) {
    const m = await loadMeta();
    const info = m.get(name);
    if (!info || lastRow <= info.rowCount) return;
    const add = Math.max(lastRow - info.rowCount, 300);
    await api().spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [
      { appendDimension: { sheetId: info.sheetId, dimension: 'ROWS', length: add } }
    ] } });
    m.set(name, { ...info, rowCount: info.rowCount + add });
  }

  // Записи одного листа идут строго по очереди: два одновременных сохранения
  // иначе вычислят один и тот же номер строки и затрут друг друга.
  const enqueue = (name, job) => {
    const prev = queue.get(name) || Promise.resolve();
    const task = prev.catch(() => {}).then(job);
    queue.set(name, task);
    return task;
  };

  const appendObjects = (name, list = []) => {
    const items = (list || []).filter(Boolean);
    if (!items.length) return Promise.resolve([]);
    return enqueue(name, async () => {
      const { headers, values } = await getRows(name, { useCache: false });
      if (!headers.length) throw new Error(`В листе «${name}» нет строки заголовков`);
      const start = values.length + 1;
      await ensureCapacity(name, start + items.length);
      await valuesUpdate(`'${name}'!A${start}:${colToA1(headers.length)}${start + items.length - 1}`,
        items.map(o => headers.map(h => o[h] ?? '')));
      forget(name);
      return items.map((o, i) => ({ ...o, _rowNumber: start + i, isNew: true }));
    });
  };
  const appendObject = async (name, obj) => (await appendObjects(name, [obj]))[0];

  // Обновление одной строки: читаем только её, а не весь лист.
  const updateObjectByRow = (name, rowNumber, patch) => enqueue(name, async () => {
    const { headers } = await getRows(name);
    const end = colToA1(headers.length);
    const cur = (await valuesGet(`'${name}'!A${rowNumber}:${end}${rowNumber}`))[0] || [];
    const merged = {};
    headers.forEach((h, i) => { merged[h] = cur[i] ?? ''; });
    Object.assign(merged, patch);
    await valuesUpdate(`'${name}'!A${rowNumber}:${end}${rowNumber}`, [headers.map(h => merged[h] ?? '')]);
    forget(name);
    return { ...merged, _rowNumber: rowNumber };
  });

  // Много строк за один запрос: правки, которые раньше шли строка за строкой.
  const updateRows = (name, changes = []) => enqueue(name, async () => {
    const list = (changes || []).filter(c => c && c.row >= 2);
    if (!list.length) return [];
    const { headers, rows } = await getRows(name, { useCache: false });
    const end = colToA1(headers.length);
    const data = list.map(c => {
      const cur = rows.find(r => r._rowNumber === c.row) || {};
      const merged = { ...cur, ...c.patch };
      return { range: `'${name}'!A${c.row}:${end}${c.row}`, values: [headers.map(h => merged[h] ?? '')] };
    });
    await api().spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data } });
    forget(name);
    return list.map(c => c.row);
  });

  return { spreadsheetId, ensureSheet, getRows, appendObject, appendObjects, updateObjectByRow, updateRows, invalidate, forget };
}
