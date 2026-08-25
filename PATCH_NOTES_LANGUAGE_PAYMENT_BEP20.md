# Patch: language selection + payment network cleanup

## Added

- First-time `/start` now asks the player to choose a language manually: Russian or English.
- The selected language is saved in `Applicants.language`.
- All main menu callbacks now use the saved user language, not Telegram device language or the language of the button.
- Added `/language` command to change language later.
- Broadcast menu button now uses each recipient's saved language.
- USDT network list is now generated dynamically from `Payment Methods` active crypto rows.
- BEP20 appears automatically if `crypto_usdt_bep20` has `status = active` in `Payment Methods`.

## Updated

- WebApp `/api/bootstrap`, `/api/save-profile`, and `/api/submit-application` now use the saved CRM language when available.
- `upsertApplicant` no longer overwrites an existing saved language with an empty or guessed value.
- `setup:payments` now keeps BEP20 active in the default payment method rows.

## Notes

Payment amounts still come from `Events`:

- `price_thb` for bank transfer.
- `price_usdt` for all USDT networks.

Payment recipients still come from `Payment Methods.recipient`.
