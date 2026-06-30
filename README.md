# PTF Registration Bot — patched version

Telegram bot + WebApp for Phuket Tennis Family registration, payments, admin inbox, broadcasts, and match challenges.

## Main changes in this patch

- EN button text changed from Apply to Join.
- Website submenu added: Home, Matches, Divisions, Yearly Race, Players, Regulations.
- Contact Organizer now stays open until user closes chat or returns to main menu.
- WebApp event selection screen now renders active event cards with THB fee, start date, limited spots notice and application count.
- Form validation now shows specific missing fields and a separate event selection error.
- Payment flow updated: Bank Transfer / USDT / Pay Later / Contact Organizer. USDT network is chosen only after selecting USDT.
- Bank button text is Bank Transfer; Bangkok Bank details stay inside payment instructions.
- Rejected/refunded messages are not auto-sent; they should be handled manually.
- Waitlist and confirmed/active messages remain automatic.
- Match Challenge module added.

## Match Challenge logic

Website/player profile can open bot with:

```text
https://t.me/YOUR_BOT_USERNAME?start=challenge_TELEGRAM_ID
```

Only users with completed profile in Applicants can challenge players.

If challenger has a public Telegram username, accepted challenge opens direct Telegram contact.
If no username is available, bot opens temporary bot-mediated chat.

## Retirement match results

Put the winner first when using a bare `ret.` marker:

```text
Div A
Winner Name - Retired Name 6-4 2-1 ret.
```

The bot also accepts `retired`, `rtd.`, `ret. P1`, `ret. P2`, and a marker attached
to a player name such as `Player Name (ret.)`.

## Required Railway variables

```env
BOT_TOKEN=
PUBLIC_URL=https://your-railway-domain.up.railway.app
SPREADSHEET_ID=1KAVMKdT3Jn7kzZTCFaqTm2EGFxfG_5ou6n0PezeJSig
GOOGLE_CREDENTIALS={...full service account JSON...}
CLUB_CHAT_URL=https://t.me/+mEkZr6wcpko4NmUy
DEFAULT_USDT_AMOUNT=80
TIMEZONE=Asia/Bangkok
ADMIN_IDS=123456789
NODE_ENV=production
```

After deploy, run `/admin_init` in the admin Telegram group.
