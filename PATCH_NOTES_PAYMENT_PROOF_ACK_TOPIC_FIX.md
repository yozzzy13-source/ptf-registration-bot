# Payment proof acknowledgement and topic delivery fix

Changes:

- Player-side proof submission now always sends the confirmation message after the screenshot is saved, even if Telegram fails to notify/copy the proof to the admin topic.
- Payment proof notification is more robust:
  - first sends the review card to the player's admin topic;
  - copies the original media to the same topic;
  - if topic delivery fails, falls back to General;
  - failures are logged but do not break the player flow.
- Added a recovery fallback for media proof when the in-memory `awaiting_payment_proof` state was lost: the bot can attach the screenshot to the player's latest event application if it is not already approved/rejected/refunded.
- No new Google Sheets status columns were added.
