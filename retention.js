// Автоочистка журналов: старые строки удаляются сами, чтобы таблицы не
// разрастались. Удаляется только то, что старше срока хранения; заголовок и
// последние строки листа не трогаются (см. deleteOldRows в sheets.js).
//
// Сроки хранения (дни) можно поменять в Settings без деплоя:
//   retain_broadcast_logs_days   — построчный журнал рассылок (по умолчанию 45)
//   retain_broadcasts_days       — итоги рассылок для вкладки «История» (365)
//   retain_result_logs_days      — журнал ленты результатов (14)
import { getSetting, deleteOldRows } from './sheets.js';
import { SHEETS } from './config.js';

const TARGETS = [
  { sheet: SHEETS.broadcastLogs, column: 'sent_at',    key: 'retain_broadcast_logs_days', days: 45 },
  { sheet: SHEETS.broadcasts,    column: 'created_at', key: 'retain_broadcasts_days',     days: 365 },
  { sheet: 'Result Broadcast Logs', column: 'created_at', key: 'retain_result_logs_days',  days: 14 }
];

async function daysFor(t) {
  const raw = Number(String(await getSetting(t.key).catch(() => '')).trim());
  return Number.isFinite(raw) && raw >= 7 && raw <= 3650 ? raw : t.days;
}

export async function cleanupLogs(now = Date.now()) {
  const out = [];
  for (const t of TARGETS) {
    try {
      const days = await daysFor(t);
      const removed = await deleteOldRows(t.sheet, t.column, now - days * 86400000, { keepAtLeast: 50 });
      if (removed) out.push({ sheet: t.sheet, removed, days });
    } catch (e) {
      // Листа может не быть (например, журнал ленты результатов) — это не поломка.
      console.error(`очистка «${t.sheet}» пропущена:`, e.message);
    }
    await new Promise(r => setTimeout(r, 1500));   // не давим на лимит чтений Google
  }
  if (out.length) console.log('автоочистка журналов:', out.map(o => `${o.sheet}: −${o.removed} строк (старше ${o.days} дн.)`).join('; '));
  return out;
}

// Раз в сутки, около 04:00 по Пхукету (21:00 UTC): в это время ботом никто не
// пользуется. Проверяем раз в час и запускаем один раз за сутки.
let lastRunDay = '';
export function startLogCleanup() {
  const tick = async () => {
    const now = new Date();
    if (now.getUTCHours() !== 21) return;
    const day = now.toISOString().slice(0, 10);
    if (lastRunDay === day) return;
    lastRunDay = day;
    await cleanupLogs().catch(e => console.error('автоочистка журналов:', e.message));
  };
  setInterval(tick, 20 * 60 * 1000).unref?.();
}
