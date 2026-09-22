# Match media publishing pipeline

A confirmed league result produces one canonical 1080×1350 PNG. Telegram sends
that exact file and Google Drive stores it at:

    Season N/YYYY-MM/Publishing/Match Cards/

The lower card area accepts up to four transparent logo files from
assets/match-card-logos. Files are read for every render in alphabetical order,
so replacing a logo does not require a code edit or a new environment variable.

A matching JSON publication event is stored at:

    Season N/YYYY-MM/Publishing/Queue/

The event is provider-neutral. It contains the match identifiers, players,
score, Drive card id, carousel dimensions, and a reserved 9:16 poster job. A
later Instagram worker can consume the queue without changing match
confirmation, league result writing, Telegram delivery, or card rendering.

The future story poster contract is 1080×1920. Its input is the two original
player avatars plus the fixed versioned prompt ptf-match-poster-v1. GPT Image
generates the background and portrait treatment; deterministic code overlays
the same score, names, division rank, and form used by the canonical card.
Keeping text and score outside image generation prevents invented match data.

Planned publication states:

1. card_ready — canonical card and publication event are on Drive.
2. poster_ready — the 9:16 poster has been generated and composited.
3. carousel_published — the match card was added to an Instagram carousel.
4. story_published — the poster was published to Stories.
5. failed — the worker records an error and can retry with the same match id.

No Instagram or image-generation credentials are required by the current
release. Those integrations can be added behind the publication-event contract.