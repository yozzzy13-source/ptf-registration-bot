# Payment buttons + USDT amount fix

Date: 2026-08-24

## Fixed

- The Payment menu no longer shows an intermediate `Pay` button when a payable application exists.
- The first payment information message now immediately includes payment method buttons:
  - Bank Transfer
  - USDT
  - Pay later
  - Contact organizer
- The payment method selection step no longer requires re-showing the participation description first.
- USDT amount is now resolved from the current `Events.price_usdt` value whenever payment is displayed or payment instructions are generated.
- Existing/stale application rows are automatically synchronized with the current event payment amounts:
  - `payment_amount_thb`
  - `payment_amount_usdt`
  - `price_thb`
  - `price_usdt`
- If an old application still has `3390` in `payment_amount_usdt`, the bot refreshes it from `Events.price_usdt` before showing the amount or creating a payment record.

## Sheet fields used

In `Events`, for `event_id = league_s2`:

- `price_thb` is used for Bank Transfer.
- `price_usdt` is used for USDT TRC20 / ERC20.
- `payment_enabled = yes` enables payment flow.

## Notes

If an old inline keyboard was already sent before this patch, the visible text in that old message will not change. However, after deploy, clicking USDT should still create the payment with the refreshed amount from `Events.price_usdt`.
