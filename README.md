# PTF Registration Bot

Telegram bot + Telegram WebApp for Phuket Tennis Family league/tournament registration.

## What this bot does

- Keeps the existing Telegram bot, but moves logic from SendPulse to GitHub + Railway.
- Shows RU/EN welcome menu.
- Reads bot texts from Google Sheets tab `Bot Texts`.
- Reads active events from `Events`.
- Collects player profile through Telegram WebApp.
- Writes/updates player CRM in `Applicants`.
- Writes every event application to `Applications`.
- Starts payment flow automatically after application.
- Supports Thai bank transfer and USDT BEP20/TRC20/ERC20.
- Receives payment screenshot in Telegram chat.
- Sends payment proof to PTF Admin Inbox.
- Stores payment records in `Payments`.
- Handles Contact Organizer through the bot and stores chat history in `Messages`.
- Supports admin commands and simple segmented broadcasts.
- Sends confirmed player message with club chat button when admin sets status to `active`/`confirmed`.

## Required Railway variables

Set these in Railway → Project → Variables:

```bash
BOT_TOKEN=123456:telegram-bot-token
PUBLIC_URL=https://your-railway-domain.up.railway.app
SPREADSHEET_ID=1KAVMKdT3Jn7kzZTCFaqTm2EGFxfG_5ou6n0PezeJSig
GOOGLE_CREDENTIALS={"type":"service_account",...}
CLUB_CHAT_URL=https://t.me/+mEkZr6wcpko4NmUy
DEFAULT_USDT_AMOUNT=80
TIMEZONE=Asia/Bangkok
ADMIN_IDS=123456789,987654321
NODE_ENV=production
```

`ADMIN_IDS` is optional for first launch, but strongly recommended. It is a comma-separated list of Telegram user IDs allowed to use admin commands.

## Google service account

1. Create / use a Google Cloud service account.
2. Enable Google Sheets API.
3. Create service account JSON key.
4. Share the Google Sheet with the service account email as Editor.
5. Put the whole JSON into `GOOGLE_CREDENTIALS` Railway variable.

## First launch

1. Upload this project to GitHub.
2. Create a new Railway project from the GitHub repository.
3. Add Railway variables.
4. Deploy.
5. The app sets the webhook automatically on startup:
   `PUBLIC_URL/webhook`
6. Open Telegram and send `/start` to the bot.

## Admin Inbox setup

1. Create a Telegram group, for example: `PTF Admin Inbox`.
2. Add the bot to the group.
3. Make the bot admin in the group.
4. Send in the group:
   `/admin_init`
5. The bot writes this group chat ID to the `Settings` tab as `admin_chat_id`.

After that:
- new applications go to the admin group;
- contact messages go to the admin group;
- payment screenshots go to the admin group.

## Admin commands

```text
/help          show admin help
/admin_init    connect current group as admin inbox
/stats         show stats
/events        show events
/pending       show pending applications
/messages      show open incoming messages
/profile ...   find player by @username, telegram_id, or name
/broadcast     create segmented broadcast
/segments      show available segments
/cancel        cancel current admin action
```

## Broadcast flow

1. Send `/broadcast` in admin chat.
2. Choose segment.
3. Send text/photo/document/video.
4. Confirm sending.
5. Bot logs results in `Broadcasts` and `Broadcast Logs`.

Available built-in segments:

- `all`
- `season2`
- `active`
- `waitlist`
- `payment`
- `ru`
- `en`

## Payment flow

After a player submits application:

1. Bot sends payment options.
2. Player chooses Thai bank or USDT network.
3. Bot shows payment instructions.
4. Player sends payment screenshot into the bot chat.
5. Bot stores proof file ID and notifies Admin Inbox.
6. Admin can approve/reject payment using buttons.
7. Participation status is still separate: admin sets `active`, `waitlist`, `rejected`, or `refunded`.

## Important logic

Payment and participation are separate:

- If places are available, admin can set `active` after checking payment.
- If places are not defined yet, admin can set `waitlist` after payment.
- If a player does not get into the season, refund is manual and full refund notice is sent by status `rejected`/`refunded`.

## Current Google Sheets tabs expected

- `Applicants`
- `Events`
- `Applications`
- `Messages`
- `Broadcasts`
- `Broadcast Logs`
- `Settings`
- `Bot Texts`
- `Payments`
- `Payment Methods`

## Notes

- For crypto payments, this version uses wallet addresses only, no QR.
- Thai bank transfer uses Bangkok Bank account from `Payment Methods`.
- Telegram WebApp file upload is not used for payment screenshots; the bot asks the player to send screenshot directly in chat, so Telegram file_id is preserved.
