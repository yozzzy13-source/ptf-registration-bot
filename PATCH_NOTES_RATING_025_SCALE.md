# Patch: NTRP (Raketo) test 0.25 scale

## What changed

- Replaced the short 5-question rating test with the expanded 12-question test.
- Added competitive experience questions: match experience, tournament/league participation, highest competitive background, and performance against intermediate amateurs.
- Added weighted scoring: competitive block questions have weight 1.5; general experience and technical/match skill questions have weight 1.
- Rating now calculates in 0.25 steps from 2.0 to 4.5 instead of 0.5 steps.
- Updated test intro copy in RU and EN.
- Updated placeholder from `3.5 / 4.0` to `3.0 / 4.25`.

## Preserved

- Existing `Applicants.ntrp` column is still used.
- Existing rating-only mode `/apply?mode=rating` is preserved.
- Existing missing-rating broadcast command is preserved.
- Payment proof logic was not changed.
- No new Google Sheets columns or statuses were added.
