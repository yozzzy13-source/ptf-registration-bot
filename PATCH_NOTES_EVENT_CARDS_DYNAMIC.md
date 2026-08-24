# Event cards from Google Sheets

This patch connects the WebApp event selection screen to the `Events` sheet.

## Editable fields

Existing fields used by the WebApp:

- `event_name_ru` / `event_name_en` — event title
- `status` — visible if `active`, `open`, or `registration_open`
- `start_date` / `end_date` — fallback date badges if custom labels are empty
- `price_thb` / `currency` — visible price and payment trigger
- `description_ru` / `description_en` — event card description
- `registration_deadline` — optional badge
- `sort_order` — card order

Optional new fields added by `npm run setup:events`:

- `card_badges_ru` / `card_badges_en` — pipe-separated badges shown exactly as written, e.g. `Открыта регистрация | Limited spots | Старт: середина–конец августа | 2 месяца`
- `status_label_ru` / `status_label_en` — fallback status badge label
- `start_label_ru` / `start_label_en` — fallback start badge text
- `end_label_ru` / `end_label_en` — fallback end badge text
- `duration_label_ru` / `duration_label_en` — optional duration badge
- `venue_ru` / `venue_en` — optional venue badge
- `show_price` — `yes`/`no`, controls whether the price is shown in the WebApp
- `payment_enabled` — `yes`/`no`, controls whether payment starts after application submission
- `selectable` — `yes`/`no`, controls whether players can select the event

## Payment logic

Payment starts only if:

- the event is selected;
- `price_thb` is greater than 0;
- `payment_enabled` is not `no`.

