# PTF Registration Bot — Profile + Event Flow Patch

## What changed

1. Main menu now has two separate WebApp buttons:
   - Complete Profile / Заполнить анкету
   - Join Event / Участвовать в событии

2. Existing applicants can skip profile form and go directly to event selection if their profile is complete.

3. The bot now tries to match existing CRM rows by:
   - telegram_id first;
   - telegram_username second;
   - telegram link in the `telegram` column third.

   This allows older applicants from the table to be connected to their Telegram identity after they launch the bot/WebApp once.

4. If there is no active event, a user can still save/update their profile and stay in the waitlist.

5. Payment flow starts only when an active paid event is selected.

## Important limitation

Telegram bots cannot message users or know their Telegram ID until the user launches the bot at least once. For old SendPulse applicants without `telegram_id`, the system can only connect them automatically if their Telegram username/link in the table matches the Telegram account they use to launch the bot.
