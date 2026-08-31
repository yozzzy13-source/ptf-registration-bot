# Profile Button Existing Profile Fix

- The WebApp now checks `existingProfile/profileCompleted` on `/apply?mode=profile` as well as on `/apply?mode=event`.
- If a user clicks **Complete Profile / Заполнить анкету** but their profile is already found, the profile form is skipped.
- The user is sent directly to the event-selection step and shown a notice that the profile was found and does not need to be filled again.
- The event cards continue to use the same `/api/bootstrap` Events data source.
