# Unified PTF Bot Deploy

This repo keeps the registration bot as the main app and adds match results parsing inside the same Telegram webhook.

## Routing

- Private chat messages go to the existing registration flow.
- Callback data starting with `PTF|` goes to the match results flow.
- Messages in `RESULTS_CHAT_ID` + `RESULTS_TOPIC_ID` go to the match results parser.
- Other updates keep using the existing registration bot logic.

## Keep Existing Registration Variables

Keep the variables already used by the registration bot:

```text
BOT_TOKEN
PUBLIC_URL
SPREADSHEET_ID
GOOGLE_CREDENTIALS
CLUB_CHAT_URL
DEFAULT_USDT_AMOUNT
TIMEZONE
ADMIN_IDS
```

## Add Results Variables

```text
RESULTS_SHEET_ID=1tisUxFOJZgaD95o8cQKSvWpH8ySY-ht3H4wdHCeCI0Q
RESULTS_TIMEZONE=Asia/Bangkok
RESULTS_CHAT_ID=-1003636628710
RESULTS_TOPIC_ID=5
RESULTS_CONFIRM_IN_TOPIC=true
RESULTS_DIVISION_A_SPREADSHEET_ID=1nmiBnyqHiZ-EuLUNCqv7ANl34yWfAWdkSZyw7h8o6bU
RESULTS_DIVISION_B_SPREADSHEET_ID=1d-yhcCTE2sZQanog-BK3EV-1yAz6DOb0X6N5c_Fnutc
RESULTS_DIVISION_C_SPREADSHEET_ID=1GFGtFx_Cvt5YyoPZtT4zA6qTFduM5_GsHqr0eUT1a_s
RESULTS_DIVISION_D_SPREADSHEET_ID=1XcEqirrUf8sNffLhz2gTkhhqcDigdqKFOt7kpP0ZQkM
```

The same `GOOGLE_CREDENTIALS` service account must have Editor access to:

- registration spreadsheet from `SPREADSHEET_ID`
- main results spreadsheet from `RESULTS_SHEET_ID`
- all four division spreadsheets

## Webhook

Use only this unified Railway service for the bot token. Do not run the old separate results Railway with the same `BOT_TOKEN`.

The existing registration startup calls `setWebhook()` and points Telegram to:

```text
PUBLIC_URL/webhook
```
