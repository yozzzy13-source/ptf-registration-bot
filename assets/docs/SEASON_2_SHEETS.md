# Настройка таблиц сезона 2

## Лист Divisions в MatchLog

Одна строка соответствует одному файлу группы. Сохраняются существующие колонки и добавляются справа:

- `group` — пусто для одиночного дивизиона, `1` или `2` для двух групп;
- `group_title` — русское название, например `Группа 1`;
- `group_title_en` — английское название, например `Group 1`.

Для второй группы добавляется ещё одна строка с теми же `season`, `letter`, `title`, `title_en`, но с другим `group` и `sheet_url`. Код не привязан к C или W: эта схема работает для любого дивизиона с двумя строками и группами 1/2.

## PRIME с девятью игроками

В `Division_Tracker` добавляется девятый игрок. В `Match_Log` регулярная часть должна содержать 36 уникальных пар: `9 × 8 / 2`. Номер матча используется только для отделения регулярки от плей-офф.

Если PRIME продолжает хранить плей-офф в этом же `Match_Log`, после регулярки используются:

- 37 — полуфинал 1;
- 38 — полуфинал 2;
- 39 — финал;
- 40 — матч за третье место.

Код вычисляет эти номера по фактическому числу игроков, поэтому переход с 8 на 9 не требует правки JavaScript.

## Cross_Group_Match_Log

Лист создаётся автоматически в основной таблице MatchLog при первой подтверждённой межгрупповой игре. Чтобы пары были видны до матча, их можно внести заранее.

Заголовки:

`match_id, season, division, player_1_group, player_1, player_2_group, player_2, result_kind, score, winner, player_1_points, player_2_points, comment, status, date`

Для заранее назначенной пары достаточно заполнить `season`, `division`, обе группы и оба имени; `status` можно поставить `scheduled`. После подтверждения результата бот найдёт эту пару, обновит ту же строку и поставит `confirmed`.

Обе групповые таблицы фронтенда читают один журнал. Межгрупповой результат добавляется к матчам и очкам игрока в его собственной группе. Место посева считается внутри группы, но с учётом всех матчей, включая межгрупповые.

## Playoff

Для двухгрупповых дивизионов результаты сетки хранятся в отдельном листе `Playoff`, который бот создаёт при первой записи результата плей-офф.

Заголовки:

`match_id, season, division, stage, slot, player_1, player_2, player_1_group, player_2_group, result_kind, score, winner, player_1_points, player_2_points, comment, status, date`

Значения `stage`: `QF`, `SF`, `Final`, `3rd`. `slot` задаёт порядок пар внутри этапа. Предварительные пары можно внести со статусом `scheduled`, затем заменить участника вручную до публикации. Администратор выбирает этап при внесении результата в мини-приложении.

Рекомендуемый посев QF для двух групп:

- A1 — B4;
- A2 — B3;
- B1 — A4;
- B2 — A3.

Победители переходят в SF, затем в финал; проигравшие полуфиналов играют матч за третье место.

## Технические результаты

В общем `Cross_Division_Match_Log` бот записывает:

- AB — `W/L`, `L/W`, `L/L` или `RET`;
- AN:AO — очки первого и второго игрока, выбранные администратором;
- K:V — сыгранный счёт для обычного матча и RET;
- W:X — режим третьего сета и отметку завершения.

Обычный W/L не добавляет сеты и геймы. RET сохраняет фактически сыгранный счёт. Комментарий хранится в матче бота и публикуется вместе с результатом.

## Fixed W1–W2 schedule

The bot seeds the following rows as `scheduled` in `Cross_Group_Match_Log` before the first cross-group result is recorded. The result updates that same row; regular `Match_Log` rows and both group trackers are untouched.

1. Olga Sauer — Masha Geveling
2. Olga Sauer — Yana D
3. Marina Banatskaia — Elena Ian
4. Marina Banatskaia — Irina Strembitska
5. Daria Kozitskaya — Tatiana Sokolova
6. Daria Kozitskaya — Xenia Hors
7. Hyunjung Moon — Masha Geveling
8. Hyunjung Moon — Irina Strembitska
9. Anna Ermolina — Elena Ian
10. Anna Ermolina — Yana D
11. Maria Evangelista — Tatiana Sokolova
12. Maria Evangelista — Xenia Hors

Only these W1–W2 opponents are offered by matchmaking. Playoff rows stay manual in `Playoff`.
