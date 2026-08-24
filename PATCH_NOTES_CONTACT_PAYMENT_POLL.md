# Patch: contact chat, payment entry, USDT amount, anonymous poll broadcast

## Added

### Anonymous Telegram poll broadcast

Admin command:

```text
/broadcast_poll
```

Flow:

1. Admin sends `/broadcast_poll`.
2. Bot asks for poll text in this format:

```text
Question text
Option 1
Option 2
Option 3
```

3. Bot sends an anonymous native Telegram poll to all contacts with `telegram_id`.
4. Telegram poll updates are saved to a new/auto-created sheet: `Poll Results`.
5. Admin can request summary:

```text
/poll_stats poll_xxxxx
```

The poll stays anonymous; the sheet stores poll copy IDs and vote counts, not voter identity.

### Main menu Payment entry

The main menu now replaces `League Pass` with:

```text
💳 Оплата / 💳 Payment
```

Payment entry logic:

- No completed profile → show payment explanation + Complete Profile button.
- Completed profile but no event application → show payment explanation + Join Event button.
- Existing unpaid application → show Pay button and payment method menu.
- Proof already received / payment approved / active → show the relevant status.

### Contact chat mode

The Contact button now opens a 2-hour chat session.

- No “message sent” spam after every player message.
- Admin replies are forwarded without extra “reply sent” confirmation.
- After 2 hours, the player receives a chat-closed notification.

### Separate USDT amount

Events can now use a separate USDT amount:

```text
price_thb = 3390
price_usdt = 95
```

- Bank transfer uses `price_thb`.
- USDT TRC20/ERC20 uses `price_usdt`.
- If `price_usdt` is empty, the bot falls back to `DEFAULT_USDT_AMOUNT`.

## Sheet notes

Run once after deploy if the Events sheet does not yet have `price_usdt`:

```bash
npm run setup:events
```

The setup script now preserves existing Season 2 values and only fills blank columns with defaults.
