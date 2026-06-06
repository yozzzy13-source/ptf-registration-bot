import { inlineKeyboard, webAppButton, urlButton } from './telegram.js';
import { t } from './i18n.js';

export function mainKeyboard(lang) {
  return inlineKeyboard([
    [webAppButton(t(lang, 'apply'))],
    [{ text: t(lang, 'about'), callback_data: 'text:about_ptf' }],
    [{ text: t(lang, 'how'), callback_data: 'text:how_league_works' }],
    [{ text: t(lang, 'rules'), callback_data: 'text:short_rules' }],
    [{ text: t(lang, 'yrp'), callback_data: 'text:yrp' }, { text: t(lang, 'pass'), callback_data: 'text:league_pass' }],
    [{ text: t(lang, 'contact'), callback_data: 'contact' }]
  ]);
}

export function textKeyboard(lang, key) {
  const rows = [[webAppButton(t(lang, 'apply'))]];
  if (key !== 'short_rules') rows.push([{ text: t(lang, 'rules'), callback_data: 'text:short_rules' }]);
  if (key !== 'yrp') rows.push([{ text: t(lang, 'yrp'), callback_data: 'text:yrp' }]);
  rows.push([{ text: t(lang, 'contact'), callback_data: 'contact' }, { text: t(lang, 'back'), callback_data: 'main' }]);
  return inlineKeyboard(rows);
}

export function paymentKeyboard(lang, applicationId) {
  return inlineKeyboard([
    [{ text: t(lang, 'bank'), callback_data: `pay:${applicationId}:thai_bank` }],
    [{ text: t(lang, 'crypto'), callback_data: `crypto:${applicationId}` }],
    [{ text: t(lang, 'pay_later'), callback_data: `paylater:${applicationId}` }],
    [{ text: t(lang, 'call_admin'), callback_data: 'contact' }]
  ]);
}

export function cryptoKeyboard(lang, applicationId) {
  return inlineKeyboard([
    [{ text: 'USDT BEP20', callback_data: `pay:${applicationId}:crypto_usdt_bep20` }],
    [{ text: 'USDT TRC20', callback_data: `pay:${applicationId}:crypto_usdt_trc20` }],
    [{ text: 'USDT ERC20', callback_data: `pay:${applicationId}:crypto_usdt_erc20` }],
    [{ text: t(lang, 'back'), callback_data: `payment_menu:${applicationId}` }]
  ]);
}

export function clubKeyboard(lang, url) {
  return inlineKeyboard([[urlButton(t(lang, 'join_chat'), url)]]);
}

export function adminApplicationKeyboard(applicationId, telegramId) {
  return inlineKeyboard([
    [
      { text: '✅ Active', callback_data: `admin_status:${applicationId}:active` },
      { text: '⏳ Waitlist', callback_data: `admin_status:${applicationId}:waitlist` }
    ],
    [
      { text: '❌ Rejected', callback_data: `admin_status:${applicationId}:rejected` },
      { text: '↩️ Refunded', callback_data: `admin_status:${applicationId}:refunded` }
    ],
    [{ text: '💬 Reply', callback_data: `admin_reply:${telegramId}` }]
  ]);
}

export function adminPaymentKeyboard(applicationId, paymentId, telegramId) {
  return inlineKeyboard([
    [
      { text: '✅ Approve payment', callback_data: `admin_payment:${applicationId}:${paymentId}:approved` },
      { text: '❌ Reject payment', callback_data: `admin_payment:${applicationId}:${paymentId}:rejected` }
    ],
    [
      { text: '🎾 Set Active', callback_data: `admin_status:${applicationId}:active` },
      { text: '⏳ Set Waitlist', callback_data: `admin_status:${applicationId}:waitlist` }
    ],
    [{ text: '💬 Reply', callback_data: `admin_reply:${telegramId}` }]
  ]);
}
