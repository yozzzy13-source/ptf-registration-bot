// Скорость витрины: сколько отвечали страницы данных (главная, таблица
// дивизиона, итоги сезонов). Без команд: если за сутки что-то открывалось
// дольше SLOW_MS, утром (с 9:00) организатору приходит одна строка с цифрами;
// всё быстро — тишина. Замеры живут в памяти до перезапуска.
import { getSetting, setSetting } from './sheets.js';

const SLOW_MS = 2000;
const KEEP = 2000;
const log = [];
export function noteSpeed(name, ms) {
  log.push({ name, ms: Math.round(ms), at: Date.now() });
  if (log.length > KEEP) log.shift();
  if (ms >= SLOW_MS) console.log(`slow page data: ${name} ${Math.round(ms)} мс`);
}
// Обёртка для обработчика: замер от входа до ответа.
export function timed(name, handler) {
  return async (req, res, next) => {
    const t0 = Date.now();
    try { return await handler(req, res, next); }
    finally { noteSpeed(name, Date.now() - t0); }
  };
}
export function speedStats(since = Date.now() - 24 * 3600 * 1000) {
  const by = new Map();
  for (const x of log) if (x.at >= since) (by.get(x.name) || by.set(x.name, []).get(x.name)).push(x.ms);
  return [...by].map(([name, list]) => {
    const s = list.slice().sort((a, b) => a - b);
    return { name, count: s.length, median: s[Math.floor(s.length / 2)], max: s[s.length - 1], slow: s.filter(v => v >= SLOW_MS).length };
  });
}
export function speedText(stats) {
  const names = { bootstrap: 'главная', division: 'таблица дивизиона', summary: 'итоги сезонов' };
  return '🐢 <b>Скорость сайта за сутки</b>\n' + stats.map(s => `• ${names[s.name] || s.name}: открытий ${s.count}, обычно ${s.median} мс, самое долгое ${(s.max / 1000).toFixed(1)} с${s.slow ? `, дольше 2 с — ${s.slow}` : ''}`).join('\n');
}
// Раз в сутки, с 9:00 по Пхукету, только если были медленные открытия.
export async function runSpeedReport(now = Date.now(), say = async () => {}) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(now));
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', hour12: false }).format(new Date(now)));
  if (hour < 9) return { sent: false, reason: 'early' };
  if (String(await getSetting('speed_report_on').catch(() => '') || '') === day) return { sent: false, reason: 'done' };
  const stats = speedStats(now - 24 * 3600 * 1000);
  await setSetting('speed_report_on', day, 'Отчёт о скорости сайта за этот день отправлен (пишет бот)').catch(() => {});
  if (!stats.some(s => s.slow)) return { sent: false, reason: 'fast' };
  await say(speedText(stats));
  return { sent: true, stats };
}
