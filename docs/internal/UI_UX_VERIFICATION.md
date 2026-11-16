# UI/UX refinement verification

Review date: 2026-11-16. The existing dark, cyan/violet visual language is retained.
This record distinguishes browser checks, JavaScript checks and device validation.

## Presentation changes

- Landing: larger two-column story, nine selectable steps, previous/next actions,
  visible progress and longer scroll dwell on tall desktop viewports. Phones,
  short screens and reduced-motion users get a self-paced section. The desktop
  scroll story starts at 1024 px wide and 820 px high.
- Landing: complete the Strategies anchor with product feature cards and a mobile
  access CTA. Replace placeholder app/docs/repository destinations and the inert
  footer email form. Keep the main promise readable on touchscreens.
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

| Viewport | Landing overflow | Story mode | Internal anchors |
| --- | --- | --- | --- |
| 320 x 568 | None | Self-paced | All resolve |
| 390 x 844 | None | Self-paced | All resolve |
| 768 x 1024 | None | Self-paced | All resolve |
| 1280 x 720 | None | Self-paced | All resolve |
| 1440 x 900 | None | Sticky scroll | All resolve |

All nine steps were selected at phone width without horizontal page overflow.
Step targets are at least 44 px wide; the phone step rail scrolls horizontally.
Desktop next-step navigation advances the text and visual together. Enabling
reduced motion switches the story to manual navigation and stops decorative motion.

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
