# Payment proof General fallback label fix

- If payment proof media cannot be copied into the player's topic and falls back to General, the bot now sends a clear context label first.
- The fallback label includes application ID, payment ID when available, Telegram ID, player name, username, event, method, network, and amount.
- No new Google Sheets columns or statuses were added.
