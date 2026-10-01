// Очередь к Google Таблицам (google.js): лимит в окне, приоритеты, ожидание
// после ответа «лимит». Окно и паузы сжаты переменными, Google не трогаем.
import assert from 'node:assert/strict';
process.env.SHEETS_WINDOW_MS = '400';
process.env.SHEETS_READS_PER_MIN = '5';
process.env.SHEETS_WRITES_PER_MIN = '5';
process.env.SHEETS_QUOTA_WAIT_SCALE = '200';
const { __wrapForTest, withPriority, sheetsQueueStats } = await import('../google.js');

// Таймеры очереди не держат процесс (unref) — в бою его держит сервер, здесь — этот интервал.
const keep = setInterval(() => {}, 1000);
const calls = [];
let failNext = 0;
const fake = { spreadsheets: { get: async () => ({}), batchUpdate: async () => ({}), values: {
  get: async ({ range }) => {
    calls.push({ range, at: Date.now() });
    if (failNext > 0) { failNext--; const e = new Error("Quota exceeded for quota metric 'Read requests'"); e.code = 429; throw e; }
    return { data: { values: [[range]] } };
  },
  update: async () => ({}), append: async () => ({}), batchGet: async () => ({}), batchUpdate: async () => ({})
} } };
const api = __wrapForTest(fake);

// 1. Не больше лимита в окне.
const t0 = Date.now();
await Promise.all(Array.from({ length: 12 }, (_, i) => api.spreadsheets.values.get({ range: 'n' + i })));
for (const c of calls) {
  const inWindow = calls.filter(x => x.at <= c.at && c.at - x.at < 400).length;
  assert.ok(inWindow <= 5, 'в окне не больше лимита: ' + inWindow);
}
assert.ok(Date.now() - t0 >= 700, '12 запросов при лимите 5 занимают минимум два окна');

// 2. Действие человека обгоняет фон, стоящий в очереди.
calls.length = 0;
const lows = Array.from({ length: 10 }, (_, i) => withPriority('low', () => api.spreadsheets.values.get({ range: 'low' + i })));
await new Promise(r => setTimeout(r, 5));
const high = withPriority('high', () => api.spreadsheets.values.get({ range: 'HIGH' }));
await Promise.all([...lows, high]);
const pos = calls.findIndex(c => c.range === 'HIGH');
assert.ok(pos <= 4, 'счёт игрока уходит в первом же окне, а не после фона: позиция ' + pos);

// 3. Фону — не весь лимит: запас остаётся людям.
calls.length = 0;
await new Promise(r => setTimeout(r, 450));
const bg = Array.from({ length: 5 }, (_, i) => withPriority('low', () => api.spreadsheets.values.get({ range: 'bg' + i })));
await new Promise(r => setTimeout(r, 30));
assert.ok(calls.length <= 3, 'фон берёт не больше 70% окна: ' + calls.length);
await Promise.all(bg);

// 4. «Лимит» от Google: пауза и повтор, а не ошибка.
calls.length = 0; failNext = 1;
const r = await withPriority('high', () => api.spreadsheets.values.get({ range: 'retry' }));
assert.equal(r.data.values[0][0], 'retry');
assert.equal(calls.length, 2, 'после «лимита» — один повтор после паузы');

// 5. Фон сдаётся быстрее: после повторов — честная ошибка.
failNext = 5;
await assert.rejects(withPriority('low', () => api.spreadsheets.values.get({ range: 'bg-fail' })), /Quota exceeded/);
failNext = 0;
const st = sheetsQueueStats();
assert.equal(st.read.limit, 5);
clearInterval(keep);
console.log('PASS: Sheets queue — limit per window, priorities, background share, quota pause and retry.');
