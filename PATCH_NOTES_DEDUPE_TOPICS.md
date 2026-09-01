# Patch: dedupe admin topics and application notifications

What changed:

- Added a per-player topic lock around admin forum topic creation.
- If two requests for the same Telegram user arrive at nearly the same time, the bot now waits for the first topic creation to finish and reuses the saved topic instead of creating another one.
- Added an in-memory short-term guard against sending the same application notification twice.
- `submit-application` now sends the admin “New application” card only for a newly created `Applications` row. If the same user submits the same event again, the existing row is updated but the admin topic is not spammed again.
- No new Google Sheets columns or statuses were added.

Important:

- Existing duplicate topics in Telegram cannot be merged by the bot. They can be deleted manually in the admin supergroup if needed.
- New messages/applications should reuse the topic saved in `Applicants.admin_topic_id`.
