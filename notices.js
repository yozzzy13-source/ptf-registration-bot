// Объявления игрокам лиги через общую очередь рассылок (broadcast.js): с
// паузой между сообщениями, ночью — ждут утра, после перезапуска продолжаются.
//
// Текст — общий (ru/en) плюс абзац для дивизиона игрока (divText) и кнопка
// на таблицу его дивизиона.
import { registerBroadcastKind, enqueueBroadcast } from './broadcast.js';
import { sendMessage } from './telegram.js';
import { PUBLIC_URL, ADMIN_IDS } from './config.js';

const txt = v => String(v ?? '').trim();
const letterOf = d => { const k = txt(d).replace(/^(division|дивизион)\s*/i, '').toUpperCase(); return ({ P: 'PRIME', WOMEN: 'W', WOMAN: 'W' })[k] || k; };

registerBroadcastKind('league_notice', {
  async make(params) {
    return async (c) => {
      const ru = /^ru/i.test(txt(c.language));
      const L = txt(params.divOf?.[c.telegram_id]);
      const extra = params.divText?.[L]?.[ru ? 'ru' : 'en'] || '';
      const text = (ru ? params.ru : params.en) + (extra ? '\n\n' + extra : '');
      const url = PUBLIC_URL ? `${PUBLIC_URL}/league?tab=div${L ? '&division=' + encodeURIComponent(L) : ''}` : '';
      const markup = url ? { reply_markup: { inline_keyboard: [[{ text: ru ? params.btn_ru : params.btn_en, web_app: { url } }]] } } : {};
      await sendMessage(c.telegram_id, text, markup);
    };
  }
});

// recipients: [{ telegram_id, name, language, division }]
export async function queueLeagueNotice({ recipients = [], ru, en, divText = {}, btn_ru = '📊 Таблицы и сетка', btn_en = '📊 Tables and bracket', label = '', admin = null }) {
  const divOf = {};
  for (const r of recipients) divOf[String(r.telegram_id)] = letterOf(r.division);
  const to = admin || { id: ADMIN_IDS[0] || '', name: 'бот', chatId: ADMIN_IDS[0] || '' };
  return enqueueBroadcast({ kind: 'league_notice', params: { ru, en, divText, btn_ru, btn_en, divOf },
    recipients, segment: label, messageText: ru, admin: to });
}
