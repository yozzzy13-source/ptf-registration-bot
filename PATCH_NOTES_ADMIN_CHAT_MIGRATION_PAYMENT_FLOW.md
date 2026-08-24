# Admin chat migration + payment flow fix

Fixes Telegram error:

`Bad Request: group chat was upgraded to a supergroup chat`

## Changes

- Telegram API wrapper now detects `parameters.migrate_to_chat_id` and retries the request with the new supergroup chat ID.
- A broken/migrated admin inbox no longer blocks a player application from being submitted.
- If admin notification fails, the WebApp submit flow continues and payment buttons are still sent to the player.
- Payment proof admin notification is also protected so the player still receives confirmation after uploading proof.

## Recommended admin step

Run `/admin_init` inside the current admin supergroup after deploy, or update `Settings -> admin_chat_id` to the new ID reported by Telegram: `-1004380812420`.
