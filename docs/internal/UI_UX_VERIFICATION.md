# UI/UX refinement verification

Review date: 2026-11-16. The existing dark, cyan/violet visual language is retained.
This record distinguishes browser checks, JavaScript checks and device validation.

## Presentation changes

- Landing: six process cards in an asymmetric bento, adapted from the local
  Wildjury site's Otari section. All stages remain available in normal document
  flow; scrolling does not select steps or pin a stage. Cards use one column on
  phones, two on tablets and three with alternating wide cards on desktop.
- Landing: restore the blurred privacy message with hover, keyboard and tap
  reveal. Remove the hero's decorative dots, capsule navigation and pill actions.
  Adapt the local Nux Labs header: centered links, rolling hover labels and a
  collapsible mobile menu. The header is transparent at the top and contracts
  into a rounded rectangle while scrolling. Remove its app CTA.
- Landing: replace generic feature tiles with an interactive vault-discovery
  illustration adapted from the local portfolio registry. Protocol filters and
  vault selection are previews; charts are illustrative, with no live rates or
  balances. App/docs/repository destinations lead to their real entry points.
- Landing: replace the split vault slogan and checklist with a full-width
  investment workspace. Filters select the protocol and update an adjacent
  asset/network detail panel. Remove marketing eyebrow labels throughout.
- Landing: alternate left/right entrance animations for section headings,
  process cards, product workspace, FAQ rows and footer content. Animate each
  grid item directly so responsive spans remain intact. Reduced motion renders
  all of this content immediately, without translated or transparent elements.
- Landing: add a 1.7-second chameleon intro on the first visit in each tab
  session, with a Skip intro button and Escape dismissal. Deep links and reduced
  motion bypass it. Background controls remain inert until the intro completes.
- Landing: rasterize the ASCII wave's glyph atlas once per resize, cache glyph
  rows and field geometry, and update only changed cells in a pixel buffer.
  Upload the buffer once per frame and advance waves by elapsed time. Stop the
  hero and footer canvas loops when off screen or in a background tab.
- Landing: use GSAP ScrollTrigger for the directional section/card entrances,
  with Lenis driven by the GSAP ticker and updating ScrollTrigger on scroll.
  Keep native touch scrolling, bypass smoothing and reveal motion for reduced
  motion, and refresh triggers when accordion/font changes move content.
- Landing: use a 7 px arrow-free scrollbar in Chromium/WebKit, a subtle dark
  thumb, and a native thin scrollbar in Firefox. Reserve the gutter to avoid
  width jumps. Pause Lenis during the intro and clean up its ticker on Vite HMR.
- Web entry: match the native primary button's gradient, foreground, 56 px minimum
  height and spacing. Allow short screens to scroll; respect safe areas and reduced
  motion. Keep dialog controls reachable, inputs at least 16 px and choices announced.
- Native actions: render gradient backgrounds and labels in separate layers; do
  not clip the parent button on Android. Use explicit semantic foreground colors,
  unique SVG gradient IDs and one shared implementation for passkey access.
- Native layouts: fluid bottom navigation, bounded screen widths, single-column
  catalog cards below 370 px, scrollable welcome content and consistent typography.
  Give large swap amounts their own text variant so label line heights cannot clip
  them. Keep disabled, loading, selection and focus states distinct.

## Browser checks

Local `landing` and `frontend` Vite apps were inspected with ego-browser.

| Viewport | Landing overflow | Process grid | Internal anchors |
| --- | --- | --- | --- |
| 320 x 568 | None | One column | All resolve |
| 390 x 844 | None | One column | All resolve |
| 768 x 1024 | None | Two columns | All resolve |
| 1280 x 720 | None | Three columns | All resolve |
| 1440 x 900 | None | Three columns | All resolve |

All six process cards remain in the document at every viewport. There is no
sticky process scene, decorative hero dot or em dash in the main page copy.
Mobile navigation opens, follows section links and closes. Illustrations play
when visible and respect reduced motion; larger illustration modules are split
into separate build chunks.

The revised header was checked for a fully transparent background and border at
scroll zero, its compact state below the hero, menu dismissal with Escape and
focus restoration. Protocol filtering, selected vault details and the FAQ
accordion were exercised. Left/right process-card transforms start at -48/+48 px
and settle to no transform; reduced motion leaves no hidden reveal content.

A fresh browser tab showed the chameleon intro with inert background content,
then dismissed it automatically; reload did not replay it. The intro also fit
320 x 568. Reduced motion bypassed it. The hero made no canvas uploads during
30 animation frames while the FAQ was visible. A short local instrumented sample
of hero draw callbacks measured a 1.6 ms median and 2.3 ms 95th percentile after
caching unchanged cells. These are local callback timings, not device FPS claims.

GSAP/Lenis checks: wheel input moved the document, internal links settled at the
88 px navigation offset, and card entrances cleared their transforms on completion.
Changing reduced motion at runtime removed Lenis and made every reveal visible;
restoring motion resumed scrolling. Mobile navigation, FAQ height changes and
320/390 px overflow were checked. Chromium reported a 7 px scrollbar with hidden
arrow buttons; desktop/mobile screenshots confirmed the minimal rail.

Source references: Nux Labs' `src/components/Nav.tsx` and `src/styles.css`;
Wildjury's `site/src/sections/Otari.tsx`, `site/src/styles.css`
and `site/src/illos/`; portfolio's
`registry/ui/widgets/confidential-vault-grid.tsx`. Illustration attribution and
license comments are preserved in the copied source. Donor projects are unchanged.

The web entry was visually inspected at 390 x 844 and 1440 x 900. At 320 x 568,
both access dialogs fit the viewport without horizontal overflow. Mobile-testing
inputs render at 16 px; Escape dismisses the dialog and restores focus to its
trigger. No invitation was submitted during verification.

## Automated checks

- `landing`: production TypeScript/Vite build passed.
- `frontend`: production TypeScript/Vite build and all four invitation-service
  tests passed.
- `mobile`: TypeScript, ESLint and Prettier passed for the changed source files.
- The full mobile run completed 114 suites / 1120 tests: 1118 passed and two
  failed. The sell-preview test timed out while waiting for the debounced estimate;
  its complete suite and the button regression suite then passed in a separate
  run (17 tests). The remaining development-preview failure is described below.
- Expo production export generated iOS and Android Hermes bundles successfully.
  This validates bundling, not native installation or device rendering.

## Native validation limits

The JavaScript test environment cannot reproduce Android text compositing, actual
font rasterization, native keyboard geometry or device safe areas. Expo exports
are production JavaScript/Hermes bundles, not installable APK/IPA artifacts.

No Android device or emulator was connected during this review; iOS native builds
require macOS/Xcode. Therefore device-level pixel-perfect parity remains unverified.
Before release, inspect Welcome, Home, Earn/catalog and vault detail, buy/sell and
token picker, deposits/withdrawals, activity, Settings and backup/recovery on both
platforms, including large text and an open keyboard. Specifically verify primary,
secondary, disabled and loading button labels on an installed build.

Pre-existing local changes to `mobile/src/development/PreviewDebugApp.tsx`, its
design previews and social videos are outside these commits. The development
preview test still expects the committed component gallery; a locally substituted
design preview can fail that expectation independently of production UI changes.
