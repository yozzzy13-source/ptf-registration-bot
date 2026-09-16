# PTF Fantasy

Fantasy использует существующие Settings, Players_Master, сезонные составы и Fantasy-листы. Главный пользовательский маршрут — /fantasy; вход из League ведёт на него. Рейтинги и правила доступны отдельно.

## Доступ
- Участник обязательно должен находиться в Players_Master таблицы Match Log. Telegram связывается с игроком через Applicants; статус анкеты не заменяет проверку Players_Master.
- TEST дополнительно требует активную запись в Fantasy Testers либо совпадение с FANTASY_TEST_GROUP (ID, username или имя).
- Эти требования распространяются и на администратора.
- OFF / closed закрывает доступ. В LIVE достаточно Players_Master.
- League bootstrap не возвращает Fantasy-данные при отказе этой же проверки.

## Settings
Поддерживаются текущие FANTASY_* ключи и существующие legacy-имена как fallback:
- FANTASY_MODE: OFF, TEST, LIVE; при отсутствии значения — TEST.
- FANTASY_SEASON: сезон.
- FANTASY_BUDGET: бюджет, по умолчанию 88.
- FANTASY_TEAM_SIZE: текущий формат — 8.
- FANTASY_TRANSFERS: лимит платных замен, по умолчанию 2.
- FANTASY_OPEN_AT: дата открытия.
- FANTASY_DEADLINE: дедлайн.
- FANTASY_ENTRY_OPEN / FANTASY_TEST_ENTRY_OPEN: включение приёма для LIVE / TEST.
- FANTASY_TEST_GROUP: дополнительный список тестеров, разделители — запятая, точка с запятой или новая строка.
- Существующие fantasy_price_overrides / fantasy_test_price_overrides продолжают задавать ручные цены.

Переключатель приёма также управляет доступностью замен после дедлайна. До дедлайна доступны создание и обычное редактирование; после него — только разрешённые замены. Для отключения Fantasy целиком используется OFF.

## Состав и сохранение
До двух независимых команд (team_slot 1 и 2). Можно выбрать одних и тех же реальных игроков в обе команды.
Состав: 2 C, 2 W, 1 Prime, 1 A, 1 B, flex из Prime/A/B. В C и W при двух группах выбирается по одному игроку из каждой; не больше двух игроков из одной группы.
Капитан и вице-капитан различаются и входят в выбранный состав. Капитан получает ×1.5; вице заменяет его при официальном снятии до первого матча.

Черновик может быть неполным. Подтверждение требует корректных восьми слотов, бюджета и капитанов. До дедлайна подтверждённую команду можно редактировать без расходования замен. Сервер сохраняет статус locked и первое locked_at; неполные правки не заменяют подтверждённую команду.

После дедлайна платные замены расходуют отдельный лимит команды. Существующая проверка официального снятия до первого матча позволяет бесплатную замену. Матчевый скоринг и ценообразование сохранены.

## Листы
TEST пишет только в Fantasy Test Teams / Fantasy Test Transfers; LIVE — в Fantasy Teams / Fantasy Transfers.
Fantasy Testers: telegram_id, telegram_username, player_name, status, notes. off/inactive/no/0/disabled отключают запись.

Teams:
team_id, telegram_id, owner_name, team_name, season, status, picks_json, captain_key, vice_key, budget_spent, transfers_used, created_at, updated_at, locked_at, team_slot

Transfers:
transfer_id, team_id, telegram_id, season, player_out_key, player_out_name, player_in_key, player_in_name, price_out, price_in, forced, created_at

Миграция схемы для onboarding не требуется.

## API
- GET /api/fantasy/bootstrap — доступ, Settings, каталог, свои команды, очки, рейтинги и правила.
- POST /api/fantasy/validate — проверка состава.
- POST /api/fantasy/team — черновик / подтверждение.
- POST /api/fantasy/transfer — замена после дедлайна.

Bootstrap дополнительно возвращает transfers_open; свои teams — points и free_transfer_keys. Запись состава/замены повторно проверяется сервером. POST принимает lang=en/ru для языка сообщений без изменения профиля пользователя.

## Проверка
npm test. Подробности и ограничения: docs/FANTASY_ONBOARDING_QA.md.

