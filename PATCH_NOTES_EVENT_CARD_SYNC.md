# Event card sync fix

- WebApp event cards in both flows (profile form step 3 and Join Event) now render from the same `/api/bootstrap` events payload.
- Removed old frontend-only fallback presentation for Season 2 from the profile flow.
- Event card visible fields now come from the Events sheet: names, descriptions, status, start/end dates, registration deadline, price_thb, price_usdt, currency, optional card_badges/start_label/end_label/duration_label/venue.
- `/apply` is served with no-cache headers to reduce Telegram WebApp showing an older event-card script.

Recommended Events columns for League Season 2:

```
event_id = league_s2
status = active
start_date = 2026-09-07
end_date = 2026-11-01
price_thb = 3390
price_usdt = 107
currency = THB
description_ru = ...
description_en = ...
payment_enabled = yes
```

If `card_badges_ru/en` is empty, badges are built automatically from status, start_date, end_date, registration_deadline, venue, and price.
