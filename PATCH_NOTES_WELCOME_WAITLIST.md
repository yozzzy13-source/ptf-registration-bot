# PTF Registration Bot — Welcome + Waitlist Patch

This patch keeps the quick registration flow and adds support for the updated welcome positioning:

- The bot explains that it is the main PTF information channel.
- Users are encouraged not to block the bot.
- The first message motivates users to complete the player form and join the waitlist.
- The waitlist priority logic is explained: earlier profile submission gives priority among new players; players with previous PTF experience have first priority for league/events.
- The registration WebApp allows users to submit a profile even when there are no active events.
- If no active event is selected, the application is saved as a PTF Player Profile / Waitlist entry.
- Payment is not triggered for profile-only waitlist submissions.
- The WebApp uses grey/orange styling.

Important: the welcome text itself is stored in Google Sheets → Bot Texts → welcome_main (RU/EN). It has already been updated in the spreadsheet.
