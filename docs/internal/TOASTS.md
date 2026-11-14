# In-app feedback

Source reviewed 2026-11-14. Gizu uses `react-native-toast-message` behind a small app-owned API. Import
`showToast` and `dismissToast` from `@/services/toast`; feature code should not
import the package directly.

```tsx
showToast({ variant: "success", title: "Address copied." });
showToast({
  variant: "error",
  title: "Could not refresh",
  description: "Your previous balance is still shown.",
  action: { label: "Retry", onPress: refresh },
});
```

## Customization

- `src/services/toast.ts`: typed contract and default durations (5 seconds;
  errors 8 seconds). `duration: 0` stays until dismissed. Actions stay visible.
- `src/components/organisms/toast/ToastBanner.tsx`: layout, semantic icons and
  variants (`success`, `error`, `info`, `warning`). Uses shared typography,
  color tokens and NativeWind. Text wraps without a fixed card height.
- `src/components/organisms/toast/ToastHost.tsx`: renderer map, safe-area top
  spacing, reduced-motion animation and screen-reader behavior. Announcements
  do not move focus; screen-reader messages do not automatically expire.
- `AppRoot` mounts the host after navigation and remounts it when the session
  identity changes, clearing feedback from the previous account.

One message is visible at a time. New feedback replaces the previous message;
there is no queue, persistence, polling or server integration. Calling before a
host mounts is a no-op. Async callers must check they are still active before
showing feedback, as the account-address copy handler does.

## Usage boundaries

Address-copy success is the first adoption, across screens using `AccountAddress`.
Clipboard failures retain their inline retry guidance. The notification inbox is
separate and unchanged. Do not send a toast for every render or background poll.

Toasts must not be the only place a transaction failure, pending swap, approval
or recovery instruction is shown. Use confirmed operation state for completion
messages, not HTTP success alone. Native authorization remains unchanged.
Never pass raw exception objects, wallet secrets or signing payloads to a toast.

## Native overlays and verification

A root toast cannot cover a React Native `Modal` or a native modal screen.
The transaction modal already mounts its own host while focused, covering Receive.
If another modal triggers feedback, mount `ToastHost` last **inside that modal**
while it is open, or show feedback after dismissal. Do not leave invisible modal
hosts mounted; the package directs calls to the most recently mounted host.

Functional tests exercise the real library's content, replacement, lifetime,
actions, dismissal and host cleanup. Native-driver animation is not reproduced
by Jest; native modal layering, VoiceOver/TalkBack, large text, keyboard and
physical-device appearance require device checks. These checks were not rerun
for this documentation-only review.
