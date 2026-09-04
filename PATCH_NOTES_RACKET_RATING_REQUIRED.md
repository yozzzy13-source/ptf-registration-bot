# PTF Bot patch — required Racket Rating

- Renamed the visible profile field from NTRP to Racket Rating in RU/EN WebApp UI.
- The profile cannot be submitted without a rating.
- If a player does not know their Racket Rating, they must complete a short 5-question level test in the WebApp.
- The test calculates an approximate Racket Rating and writes it to the existing `ntrp` field, so no new spreadsheet column is required.
- Backend validation now rejects new profile/event submissions with missing or `unknown` rating.
- Existing profiles with empty/unknown rating are no longer treated as completed; they will be asked to complete/update the profile.
- Payment proof handling was not changed in this patch.
