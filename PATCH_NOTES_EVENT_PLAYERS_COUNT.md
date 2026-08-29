# Patch: event applications count and player list

## What changed

- The WebApp event cards now show only total applications count: `Заявок / Applications`.
- Added a `Посмотреть игроков / View players` button on each event card.
- The player list is plain text only: numbered names, no avatars.
- The count and list are calculated automatically from Google Sheets:
  - `Applications` rows matching the event;
  - `Applicants` rows that already contain the event in `last_application_event` or `crm_tags`.
- Players are deduplicated by `telegram_id`, then `telegram_username`, then name.
- `Applications` upsert logic now avoids creating duplicate rows for the same `telegram_id + event_id`; it updates the existing row instead.

## Source of truth

- `Events` controls which event is shown.
- `Applications` controls event applications.
- `Applicants` controls player names and profile data.

No manual transfer to a separate player list is needed.
