# Patch: NTRP (Raketo) required + missing rating broadcast

## What changed

- The profile field label is now `NTRP (Raketo)` in both Russian and English.
- A profile cannot be submitted with empty/unknown rating.
- If the player does not know the rating, they must complete the short rating test in the WebApp.
- Added rating-only WebApp mode: `/apply?mode=rating`.
  - This mode opens only the NTRP (Raketo) update/test screen.
  - The result updates the existing Applicants row instead of creating a new profile.
- Added backend endpoint: `POST /api/update-rating`.
- Added admin command: `/broadcast_missing_rating`.
  - Finds users in Applicants with Telegram ID and missing NTRP/Raketo rating.
  - Sends a fixed RU/EN message explaining that the rating must be added.
  - Adds a WebApp button to update NTRP (Raketo) or pass the short test.

## Notes

- The technical storage column remains `Applicants.ntrp`.
- No new Google Sheets columns are required.
- Payment proof logic was not changed in this patch.
