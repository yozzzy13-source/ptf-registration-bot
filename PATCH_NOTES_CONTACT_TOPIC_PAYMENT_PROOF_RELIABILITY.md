# Patch: Contact topic + payment proof reliability

## Fixed

- Open organizer chat messages now route to the player's admin topic before generic payment-proof recovery.
- Media sent during an open organizer chat is forwarded as chat media, not accidentally treated as a payment proof.
- Player chat notifications now retry stale/invalid saved topic IDs by clearing them and creating a fresh topic.
- If a player topic cannot be used, the bot posts a clear fallback label in General before the message/media.
- Payment proof screenshots now use the same robust topic/general fallback path and include player/application/payment context whenever they fall back to General.
- Removed duplicate const declarations that could break Node syntax checks after previous merges.

## No spreadsheet schema changes

- No new columns or statuses were added.
