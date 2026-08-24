# PTF Bot Patch — Payment methods + payment balance

## Payment methods

Current payment methods are:

- Thai bank transfer
- USDT TRC20
- USDT ERC20

BEP20 is disabled. It can remain in the `Payment Methods` sheet with `status = inactive`, but it will not be shown in the bot.

## Where to edit bank account

Open Google Sheets → `Payment Methods`.

Edit the `recipient` cell for `method_id = thai_bank`.

Example:

```text
Bangkok Bank 766-0-177366
```

No redeploy is required. The bot reads active payment methods from the sheet.

## Payment status tracking

The bot writes payment status in two places:

1. `Applications.payment_status`
2. `Payments.status`

Main statuses:

- `payment_required` — application requires payment, no invoice selected yet
- `waiting_payment` — player opened payment instructions / invoice
- `proof_received` — player uploaded screenshot
- `approved` — admin approved payment
- `rejected` — admin rejected payment
- `not_required` — no payment required for this application

## Payment balance

Admin panel dashboard now shows compact payment stats:

- Unpaid / waiting
- Proof received
- Paid approved
- Payment rejected
- Paid THB
- Paid USDT

The patch also includes a helper script:

```bash
npm run setup:payments
```

It creates/updates:

- `Payment Methods`
- `Payment Summary`

Use this once after deploying if the Google Sheet was not updated manually.
