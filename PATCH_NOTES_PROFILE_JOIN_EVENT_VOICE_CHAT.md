# PTF patch: profile-to-event prompt + voice/media in admin chat

## Changes

1. After a player saves only the PTF profile / waitlist application, the bot now prompts them to join an open event.
   - Telegram bot message includes a `Join Event / Участвовать в событии` WebApp button.
   - WebApp done screen also includes a `Join event / Участвовать в событии` button when no event was selected.

2. Contact chat media forwarding improved.
   - Player voice messages, audio, video, video notes, stickers, photos and documents are now copied into the player's admin topic instead of being shown only as `[media]`.
   - Admin replies with voice/media from the player topic continue to be copied back to the player.

3. Payment proof media handling improved.
   - Voice/audio/video/video notes/stickers sent as payment proof are copied into the player admin topic alongside the payment proof notification.

## Files changed

- `bot.js`
- `admin.js`
- `index.js`
- `public/apply.html`
