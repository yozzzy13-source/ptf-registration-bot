# PTF Bot Patch — Events registration + payment open

Changes:

- Event list now shows only selectable registration events (`active`, `open`, `registration_open`). Informational `live` events such as Season 1 are no longer shown in the Join Event WebApp.
- Event application no longer uses event-waitlist wording. Event applications are saved as `application_received` or `waiting_payment`.
- Profile-only flow can still save a general PTF profile without choosing an event.
- Payment flow is re-enabled for events with `price_thb > 0`.
- When a paid event application is submitted:
  - `Applications.application_status = waiting_payment`
  - `Applications.payment_status = payment_required`
  - `Applications.payment_amount_thb` and `price_thb` are filled from `Events.price_thb`
  - the player receives payment method buttons in Telegram.
- Payment proof screenshot updates:
  - `Applications.application_status = proof_received`
  - `Applications.payment_status = proof_received`
  - `Applications.payment_proof_status = proof_received`
  - `Payments.status = proof_received`
- Admin payment approval now updates:
  - `Payments.status = approved/rejected`
  - `Applications.payment_status = approved/rejected`
  - `Applications.payment_proof_status = approved/rejected`
  - `Applications.application_status = payment_approved` after approval.
- Added `/broadcast_menu` for admins: sends a text broadcast to all bot contacts with an inline button that opens the main menu.
- Admin access is closed if `ADMIN_IDS` is empty.

Manual Google Sheets setup needed:

- In `Events`, hide/remove Season 1 from Join Event by setting `status = closed` or leaving it as `live` with this patch.
- For Season 2 set:
  - `status = active`
  - `price_thb = <actual THB price>`
  - `start_date = <actual start date>`
  - `end_date = <actual end date>`
- Keep payment methods in `Payment Methods` active.
