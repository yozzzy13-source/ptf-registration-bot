import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const [db,index,matches,html,card,poster,bot]=await Promise.all([
  fs.readFile(new URL('../matchesdb.js',import.meta.url),'utf8'),
  fs.readFile(new URL('../index.js',import.meta.url),'utf8'),
  fs.readFile(new URL('../matches.js',import.meta.url),'utf8'),
  fs.readFile(new URL('../public/match.html',import.meta.url),'utf8'),
  fs.readFile(new URL('../matchcard.js',import.meta.url),'utf8'),
  fs.readFile(new URL('../matchposter.js',import.meta.url),'utf8'),
  fs.readFile(new URL('../bot.js',import.meta.url),'utf8')
]);

assert.match(db,/export async function confirmResultByAdmin/);
assert.match(db,/export async function deleteMatchByAdmin/);
assert.match(db,/already_confirmed/);
assert.match(db,/status:'cancelled'/);
assert.match(index,/\/api\/match\/result\/confirm/);
assert.match(index,/\/api\/match\/result\/remind/);
assert.match(index,/finishConfirmedWebResult/);
assert.match(index,/writeConfirmedResult/);
assert.match(index,/\/api\/match\/delete/);
assert.match(index,/confirmation_delivered/);
assert.doesNotMatch(matches,/sendMessage\(to\.id, text, \{ reply_markup: kb \}\)\.catch/);
assert.match(html,/function confirmPendingResult/);
assert.match(html,/function resendResultConfirmation/);
assert.match(html,/function deleteAdminMatch/);
assert.match(html,/confirmResult:'✅ Подтвердить результат'/);
assert.match(html,/confirmResult:'✅ Confirm result'/);
assert.match(html,/pendingApproval:'Нужно ваше подтверждение'/);
assert.match(html,/pendingApproval:'Your confirmation is required'/);
assert.match(card,/CARD_LOGOS_DIR/);
assert.match(card,/cardLogoComposites/);
assert.match(matches,/poster:prepare:/);
assert.match(matches,/poster:comment:/);
assert.match(bot,/poster_comment/);
assert.match(bot,/generatePosterBackgrounds/);
assert.match(bot,/sendPhotoBuffer/);
assert.doesNotMatch(bot,/archivePosterJob/);
assert.match(poster,/MATCH_POSTER_PROMPT/);
assert.match(poster,/blocked_consent/);
assert.match(poster,/OPENAI_API_KEY/);
assert.match(poster,/images:imageReferences/);
assert.match(poster,/posterConsentAllowed/);
assert.doesNotMatch(poster,/input_fidelity/);
assert.doesNotMatch(matches,/matcharchive/);

const inline=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(m=>m[1]).filter(code=>code.trim());
for(const code of inline)new vm.Script(code);

console.log('PASS: manual result confirmation, admin recovery controls, bilingual UI, and poster generation.');
