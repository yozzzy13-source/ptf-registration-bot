# Payment Proof Topic Fix

Changes:
- Payment proof notifications now always send a review card to the player's admin topic and then copy the original proof message into the same topic.
- This preserves screenshots/photos exactly as sent by the player and also works for documents, voice notes, videos, video notes, audio, and stickers.
- The proof upload state now accepts more than only photo/document and stores `payment_proof_type` in Applications and `proof_type` in Payments logs.
- If copying the original message fails, the bot falls back to re-sending photo/document by file_id.

Expected flow:
1. Player chooses payment method.
2. Player sends proof screenshot/media.
3. Bot updates Applications/Payments to proof_received.
4. Admin topic receives:
   - payment proof review card with approve/reject buttons;
   - copied original screenshot/media below it.
