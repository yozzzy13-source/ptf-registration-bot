# PTF Bot Patch — Event application to payment flow

## What changed

- After a player submits an event application for a paid event, the bot immediately sends payment method buttons.
- The player is warned that an unpaid application is not an active season entry.
- The player is told that paid applications will be processed first.
- Existing waitlist/profile players can use **Join Event / Участвовать в событии** without filling the profile again.
- If a player already has an unfinished application for the same event, the bot updates that application instead of forcing the user into a dead-end waitlist flow.
- Payment is triggered only when the selected event has `price_thb > 0` and `payment_enabled` is not `no`.

## How to bring old waitlist players to payment

Send a broadcast with the menu button or ask them to press:

`Участвовать в событии / Join Event` → `League Season 2` → `Submit`

Their existing profile is reused. After submitting the event application, payment starts immediately.

## Event card fields in Google Sheets → Events

The WebApp reads the event card from `Events`:

- `event_name_ru`, `event_name_en` — title
- `description_ru`, `description_en` — description
- `status` — visible if `active`, `open`, or `registration_open`
- `price_thb`, `currency` — price and payment trigger
- `start_date`, `end_date`, `registration_deadline` — optional dates
- `card_badges_ru`, `card_badges_en` — manual badge list separated by `|`
- `status_label_ru`, `status_label_en` — custom status badge
- `start_label_ru`, `start_label_en` — custom start badge
- `end_label_ru`, `end_label_en` — custom end badge
- `duration_label_ru`, `duration_label_en` — duration badge
- `venue_ru`, `venue_en` — venue badge
- `show_price` — `yes`/`no`
- `payment_enabled` — `yes`/`no`
- `selectable` — `yes`/`no`

Run once after deploy if these extra columns are missing:

```bash
npm run setup:events
```

## Payment methods

Payment details are read from `Payment Methods`. Change bank account or wallet addresses there; no redeploy required.
