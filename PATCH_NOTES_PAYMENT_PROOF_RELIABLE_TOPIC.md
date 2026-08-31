# Payment proof reliable topic fix

- Payment proof screenshots/media are now always sent to the player's admin topic after the review card.
- The bot first uses Telegram `copyMessage` to preserve the original screenshot/media.
- If `copyMessage` fails, it falls back to sending the media by `file_id`.
- Recovery added: if the bot restarts and loses the in-memory `awaiting_payment_proof` state, a media message from a player with a payable application is still treated as payment proof.
- No extra Google Sheets status columns were added.
