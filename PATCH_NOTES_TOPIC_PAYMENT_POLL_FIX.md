# PTF Bot patch — admin topics, payment text, poll test

## Included

1. Admin chat topics
- Contact messages from players are sent to a per-player forum topic in the admin supergroup.
- New application notifications and payment proof notifications also go to the same player topic.
- The topic id is stored in Applicants columns `admin_topic_id`, `admin_topic_name`, `admin_topic_created_at`.
- If a topic cannot be created, the bot falls back to General instead of breaking the flow.
- Admins can reply directly in the player's topic; the message is forwarded to the player without extra confirmation spam.

2. Payment text restored
- Restored old League Pass / participation payment structure.
- Removed only the loyalty-system line.
- Changed trophies line to trophies, prizes and gifts.
- Payment method buttons are attached to the same payment information message.

3. Poll test command
- `/broadcast_poll_test` sends a native anonymous poll only to the admin who started it.
- `/broadcast_poll` remains the real mass poll broadcast.

4. Wider Google Sheets range
- Internal reads/writes now use A:BZ instead of A:AZ so added CRM columns are not silently ignored.

## Required Telegram setup
- The admin chat must be a supergroup with Topics enabled.
- Run `/admin_init` in the admin supergroup after deploy if needed.

