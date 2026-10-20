# Phuket Tennis Family — бот и сайт лиги

Telegram-бот, мини-приложения и сайт phukettennis.com в одном сервисе:
анкеты и оплаты, события, матчи лиги (окна, вызовы, корты, счёт), таблицы
дивизионов, плей-офф, Fantasy, турниры, рассылки, карточки и постеры.

Сервер — Node.js (Express), данные — Google Таблицы (сервисный аккаунт),
хостинг — Railway. Сборки нет: Railway ставит зависимости и запускает
`npm start` (`node index.js`).

## Развернуть с нуля

1. Node.js 20.9 или новее.
2. В Railway → Variables задать переменные из `.env.example` (обязательные —
   в первом блоке). Сервисному аккаунту из `GOOGLE_CREDENTIALS` нужен доступ
   на редактирование ко всем таблицам лиги.
3. Задеплоить. Вебхук Telegram бот ставит сам на `PUBLIC_URL`.
4. Один раз в админской группе — `/admin_init`, в теме ленты результатов —
   `/results_here`.
5. Только для новой пустой таблицы: `npm run setup:courts`,
   `npm run setup:payments`, `npm run setup:events` создают служебные листы.

## Где что лежит

- `index.js` — сервер: страницы, API мини-приложений, фоновые проходы.
- `bot.js`, `telegram.js` — бот: команды, кнопки, `/help` и список команд.
- `sheets.js`, `google.js` — чтение и запись Google Таблиц (через очередь).
- `matches.js`, `matchesdb.js`, `assignmatch.js` — матчи лиги: окна, вызовы,
  корты, напоминания, матчи, назначенные организатором.
- `results.js`, `division.js`, `standings.js`, `leaguemodel.js` — счёт,
  таблицы дивизионов, подписи, витрина лиги.
- `playoff.js`, `playoffmedia.js` — плей-офф: черновик, сетка, постеры.
- `matchcard.js`, `matchposter.js`, `sponsors.js` — карточки и постеры.
- `public/` — страницы: сайт и лига (`league.html`), матчи (`match.html`),
  анкета, Fantasy, турниры, админка; `public/img` — картинки сайта.
- `assets/` — шрифты карточек (все .ttf отсюда подхватываются сами), логотип
  в `match-card-logos/`, полоса спонсоров `sponsors.png`.
- `scripts/` — разовая подготовка листов в новой таблице.
- `tests/` — проверки; Google и Telegram в них подменены.

## Проверки

```bash
npm install
npm test
```

Тесты ничего не пишут в настоящие таблицы и ничего не отправляют в Telegram.
