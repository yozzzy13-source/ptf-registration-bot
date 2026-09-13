// Only interface responses are translated here. Broadcast bodies and entered
// event descriptions are never passed through this function.
const pairs = [
  ['league_access_denied','Для доступа к лиге организатор должен добавить вас в список игроков.','Ask the organiser to add you to the league player list for access.'],
  ['division_required','Матчи станут доступны после включения в дивизион и группу.','Matches become available once you are assigned to a division and group.'],
  ['different_group','Матч доступен только игрокам одной группы дивизиона.','This match is only available to players in the same division group.'],
  ['not_a_player','Вы не участник этого матча.','You are not a player in this match.'],
  ['Invalid Telegram initData','Откройте приложение заново из бота.','Reopen the app from the bot.'],
  ['Telegram WebApp user not found','Откройте приложение из личного чата с ботом.','Open the app from your private chat with the bot.'],
  ['Access denied','Нет доступа.','Access denied.'],
  ['You are not assigned to a division yet.','Матчи станут доступны после включения в дивизион и группу.','Matches become available once you are assigned to a division and group.'],
  ['Pick at least one date','Выберите хотя бы одну дату.','Pick at least one date.'],
  ['Time is required','Укажите время.','Select a time.'],
  ['Date is required','Укажите дату.','Select a date.'],
  ['Pick at least one court','Выберите хотя бы один корт.','Pick at least one court.'],
  ['Opponent not found in your division','Соперник не найден в вашей группе дивизиона.','Opponent not found in your division group.'],
  ['Slot not found','Заявка не найдена.','Slot not found.'],
  ['This slot has just been taken.','Это окно уже занято.','This slot has just been taken.'],
  ['This is your own slot.','Это ваше собственное окно.','This is your own slot.'],
  ['This slot is closed.','Это окно закрыто.','This slot is closed.'],
  ['This challenge is addressed to another player.','Вызов адресован другому игроку.','This challenge is addressed to another player.'],
  ['You have already taken this slot.','Вы уже откликнулись на это окно.','You have already taken this slot.'],
  ['Pick one of the offered dates.','Выберите предложенную дату.','Pick one of the offered dates.'],
  ['Pick one of the offered courts.','Выберите предложенный корт.','Pick one of the offered courts.'],
  ['Pick a time inside the offered window.','Выберите время внутри предложенного интервала.','Pick a time inside the offered window.'],
  ['This slot is not awaiting an answer.','Заявка больше не ожидает ответа.','This slot is not awaiting an answer.'],
  ['It is the other player\'s turn to answer.','Сейчас очередь соперника отвечать.','It is the other player\'s turn to answer.'],
  ['Too many rounds — agree in chat instead.','Достигнут предел встречных предложений. Договоритесь в чате.','Too many rounds — agree in chat instead.'],
  ['Not your match','Это не ваш матч.','This is not your match.'],
  ['Not your slot','Это не ваше окно.','This is not your slot.'],
  ['Court booking is not open yet.','Бронирование кортов пока недоступно.','Court booking is not open yet.'],
  ['Фото не распознано — счёт сохранён без него.','Фото не распознано — счёт сохранён без него.','Photo was not recognised; the score was saved without it.'],
  ['Фото не загрузилось — счёт сохранён без него.','Фото не загрузилось — счёт сохранён без него.','Photo upload failed; the score was saved without it.'],
  ['Фото больше 8 МБ — уменьшите размер','Фото больше 8 МБ — уменьшите размер.','Photo exceeds 8 MB; reduce its size.'],
  ['Фото больше 8 МБ — сожми его или сними заново','Фото больше 8 МБ — сожмите его или снимите заново.','Photo exceeds 8 MB; compress it or take another one.'],
  ['Ожидается изображение','Выберите изображение.','Select an image.'],
  ['Пустой файл','Файл пустой.','The file is empty.'],
  ['Выберите победителя','Выберите победителя.','Select the winner.'],
  ['Матч не найден.','Матч не найден.','Match not found.'],
  ['Матч ещё не согласован.','Матч ещё не согласован.','The match is not agreed yet.'],
  ['Это не ваш матч.','Это не ваш матч.','This is not your match.'],
  ['Время меняет тот, кто бронировал корт.','Время меняет тот, кто бронировал корт.','Only the player who booked the court can change the time.'],
  ['Это и есть текущее время.','Это и есть текущее время.','This is already the current time.'],
  ['Некорректное время.','Некорректное время.','Invalid time.'],
  ['Результат уже засчитан — матч не отменить.','Результат уже засчитан — матч не отменить.','The result is confirmed; the match cannot be cancelled.'],
  ['Событие не найдено','Событие не найдено.','Event not found.'],
  ['Неизвестное действие','Неизвестное действие.','Unknown action.'],
  ['Игрок не найден в анкетах','Игрок не найден в анкетах.','Player not found in Applicants.']
];
const scorePairs = [
 ['Счёт тай-брейка неполный.','Incomplete tie-break score.'],
 ['Счёт тай-брейка не число.','Tie-break scores must be numbers.'],
 ['Тай-брейк не может закончиться вничью.','A tie-break cannot end in a draw.'],
 ['Победитель тай-брейка не совпадает с победителем сета.','The tie-break winner must also win the set.'],
 ['Слишком мало очков у победителя тай-брейка.','The tie-break winner needs more points.'],
 ['Тай-брейк выигрывается с разницей в 2 очка.','A tie-break must be won by two points.'],
 ['Счёт сета не число.','Set scores must be numbers.'],
 ['Сет не может закончиться вничью.','A set cannot end in a draw.'],
 ['Чемпионский тай-брейк не может закончиться вничью.','A match tie-break cannot end in a draw.'],
 ['В чемпионском тай-брейке победителю нужно минимум 10 очков.','The match tie-break winner needs at least 10 points.'],
 ['Чемпионский тай-брейк выигрывается с разницей в 2 очка.','A match tie-break must be won by two points.'],
 ['Слишком большой счёт для тай-брейка — проверьте.','The tie-break score is too high; please check it.'],
 ['В завершённом матче должно быть минимум два сета.','A completed match must have at least two sets.'],
 ['В матче не может быть больше трёх сетов.','A match cannot have more than three sets.'],
 ['Матч уже закончен после двух сетов, но указан третий.','The match ended in two sets, but a third set was entered.'],
 ['После двух сетов 1:1 — укажите третий сет или чемпионский тай-брейк.','At one set each, enter the deciding set or match tie-break.'],
 ['Счёт матча неполный.','Incomplete match score.']
];
for (const [ru,en] of scorePairs) pairs.push([ru,ru,en]);
export function uiError(value, lang = 'en') {
  const raw = String(value || '');
  const found = pairs.find(p => p.includes(raw));
  if (found) return found[lang === 'ru' ? 1 : 2];
  const set = /^Сет ([123]): (.+)$/.exec(raw);
  if (set) return `${lang === 'ru' ? 'Сет' : 'Set'} ${set[1]}: ${uiError(set[2],lang)}`;
  const invalid = /^Недопустимый счёт сета (.+)\. Допустимо, например: 6:4, 7:5, 7:6\.$/.exec(raw);
  if (invalid) return lang === 'ru' ? raw : `Invalid set score ${invalid[1]}. Examples: 6:4, 7:5, 7:6.`;
  const window = /^Time window must be at least (.+)h long$/.exec(raw);
  if (window) return lang === 'ru' ? `Интервал должен быть не короче ${window[1]} ч.` : raw;
  const clash = /^У вас уже назначен матч на это время \((.+)\)\. Выберите другой слот\.$/.exec(raw);
  if (clash) return lang === 'ru' ? raw : `You already have a match at this time (${clash[1]}). Choose another slot.`;
  return lang === 'ru' ? 'Не удалось выполнить действие. Обновите экран или обратитесь к организатору.' : 'Unable to complete the action. Refresh the page or contact the organiser.';
}
