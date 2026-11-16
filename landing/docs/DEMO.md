# Mobile interface demo

The hero phone contains a local, interactive browser implementation of the
mobile interface. It uses the native app's Helvetica fonts, colors, gradient
actions, balance card, portfolio actions, Earn cards and floating tabs. No native
wallet, passkey, API, blockchain transaction or real asset price is used.

Implemented journeys: welcome, portfolio, performance ranges, receive/send sample
funds, activity, protocol/search filtering, vault detail, investment amount,
review/confirmation, simulated buy/sell, balance privacy and restarting the demo.
Amounts are integer cents; overspending and invalid precision are rejected.
State stays in memory and resets on reload. Rate and balance examples are labeled.

The larger standalone demo is available at `/demo.html`. The main landing
intentionally has no extra caption or external demo link beneath the phone.

## Interface captures

`public/screens/portfolio.webp`, `discover.webp` and `confirm.webp` are captures
of this browser demo, adapted from the mobile source. They replace the missing
image placeholders in the app gallery. They are **not native device screenshots**.
When native release captures are supplied, replace these assets with the same
aspect ratio (390 x 845) after checking them visually.

Capture routes (dev or production):

- `/demo.html?screen=home&capture=1`
- `/demo.html?screen=earn&capture=1`
- `/demo.html?screen=review&capture=1`

Use a 390 x 845 viewport, wait for fonts and the canvas, take a browser screenshot,
then encode to WebP. The gallery uses the exact same interface as the live demo.

Generated process-card artwork, prompts and provenance are in `ARTWORK.md`.
The public art files are `funding.webp`, `investments.webp` and `shielding.webp`
under `public/art/`. They correspond to the funding, asset-choice and shielding
cards; all text stays in HTML.

## Checks

`npm test` covers signup contracts and demo balance rules. `npm run build` builds
both the landing and standalone demo. Browser checks should cover the complete
investment flow, swap, transfers, invalid amounts, filters and empty search,
privacy/reset, mobile scrolling inside the phone, all three gallery images,
early-access validation, keyboard dismissal and focus restoration.
