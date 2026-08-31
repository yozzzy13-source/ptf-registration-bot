# Payment proof restore + Payment menu logic

This patch intentionally restores the payment-proof media handling order to the last confirmed working version.

## Payment proof
- Payment proof media recovery now runs before contact/chat fallback again.
- The payment proof branch should not be refactored without a separate end-to-end test.
- Existing logic remains: update Applications and Payments, notify admin, and confirm proof receipt to the player.

## Main menu Payment button
- No profile: show payment explanation only and offer Complete Profile.
- Profile but no event application: show explanation only and offer Join Event.
- Unpaid event application: show payment explanation, THB/USDT amounts, and payment method buttons immediately.
- Proof already received: show that the screenshot is awaiting manual review.
- Payment approved/active: show confirmed status.
