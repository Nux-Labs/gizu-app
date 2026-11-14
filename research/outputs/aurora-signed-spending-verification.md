# Aurora signed-spending endpoint verification

Endpoint evidence recorded 22 September 2026; wallet integration wording updated 25 September 2026 without rerunning the probes. Scope: determine whether the app must call 1Click directly to generate and submit an authorization spending a confidential balance.

## Result

The previously reported missing-endpoint gap is closed. Aurora has both production endpoint handlers, its official widget calls them, and the published widget package includes those calls. The application can use Aurora-hosted APIs for the quote/generate/submit path rather than adding direct 1Click calls solely for these operations.

This is not an authenticated funded end-to-end settlement test. No private keys, genuine signatures, valid partner API credentials or funds were used. Availability of handlers does not establish a particular project's permissions, route liquidity, or successful confidential settlement.

## Source and package evidence

Official repository commit inspected: `efce388a8078f912d5f80dff25163d37b2f578c1`.

- [oneClickIntentApi.ts](https://github.com/aurora-is-near/intents-swap-widget/blob/efce388a8078f912d5f80dff25163d37b2f578c1/packages/intents-swap-widget/src/utils/intents/oneClickIntentApi.ts): `requestIntentForSigning` posts to `/api/generate-intent/${apiKey}`; `submitSignedIntent` posts to `/api/submit-intent/${apiKey}`.
- [network.ts](https://github.com/aurora-is-near/intents-swap-widget/blob/efce388a8078f912d5f80dff25163d37b2f578c1/packages/intents-swap-widget/src/network.ts): production base URL is `https://intents-api.aurora.dev`.
- [useMakeIntentsTransfer.ts](https://github.com/aurora-is-near/intents-swap-widget/blob/efce388a8078f912d5f80dff25163d37b2f578c1/packages/intents-swap-widget/src/hooks/useMakeIntentsTransfer.ts): takes `depositAddress` from the quote, generates an intent, signs the returned payload and submits through the same configured Aurora client/API key.
- [types/intents.ts](https://github.com/aurora-is-near/intents-swap-widget/blob/efce388a8078f912d5f80dff25163d37b2f578c1/packages/intents-swap-widget/src/types/intents.ts): declares `erc191`, generation request and submission response types.
- Published `@aurora-is-near/intents-swap-widget` version `7.24.0`: downloaded from the [official npm tarball](https://registry.npmjs.org/@aurora-is-near/intents-swap-widget/-/intents-swap-widget-7.24.0.tgz), inspected without installing or executing it. Both source and compiled `dist/network-CXnyvi-l.js` contain the endpoint calls.

Function names and log messages mention 1Click, but the actual HTTP client targets Aurora. The underlying service/protocol remains a separate question from which host the application calls.

## Live handler validation

Each request used `Content-Type: application/json`, body `{}`, and the deliberately invalid literal API key `verification-invalid-key`. These requests cannot authorize a transfer.

| Request path on intents-api.aurora.dev                              | Result                                         |
| ------------------------------------------------------------------- | ---------------------------------------------- |
| `POST /api/generate-intent/verification-invalid-key`                | HTTP 400, operation-specific schema validation |
| `POST /api/submit-intent/verification-invalid-key`                  | HTTP 400, operation-specific schema validation |
| `POST /api/verification-nonexistent-route/verification-invalid-key` | HTTP 404, route not found                      |

Generation validation reported missing `type: swap_transfer`, `standard`, `signerId` and `depositAddress`. Its allowed standards included `erc191` alongside the other wallet standards.

Submission validation reported missing `type: swap_transfer` and invalid/missing `signedData`.

The distinct nonexistent-route result controls for a generic front-door error. These results establish that production POST handlers with the expected schemas exist; they do not prove authorization or settlement succeeded.

## Historical prototype integration proposal

This proposal targeted the fixed-transfer combined Android prototype; that
standalone module still has no ERC-191 integration. The active app now uses a
separate stored signer and backend REST adapters. See
[current native signer](../../docs/internal/NATIVE_SIGNER.md) and
[Confidential Earn](../../docs/internal/CONFIDENTIAL_EARN.md). The endpoint evidence
above is preserved as recorded and does not qualify today's provider access.

1. Quote through Aurora with `depositType: CONFIDENTIAL_INTENTS`, `recipientType: DESTINATION_CHAIN`, recipient Ai, and refund recipient C in `CONFIDENTIAL_INTENTS`; explicitly select non-public confidentiality.
2. Generate through Aurora using `type: swap_transfer`, `standard: erc191`, `signerId: C`, and the quote's `depositAddress`.
3. Validate and sign the returned payload inside our combined wallet's native engine using C's wallet-derived key and a bounded passkey-authorized operation. The proposal required extending the prototype's fixed EVM-transfer signer with an ERC-191 adapter and the supported MultiPayload encoding; that prototype adapter was not implemented. This is not an outstanding implementation claim about the active mobile module. See the [revised integration spec](confidential-balance-distribution-spec.md).
4. Submit `{ type: swap_transfer, signedData }` through Aurora; persist returned intent identity.
5. Reconcile through Aurora status and authenticated account reads plus destination-chain receipt verification. Do not copy a public-ledger settlement watcher into the confidential flow without validating it.

The [Aurora quote schema](https://docs.intents.aurora.dev/api-reference/swap-api-reference/request-a-quote) explicitly includes confidential input and recipient channels. The widget source establishes the authorization transport; it does not by itself prove its entire UI supports embedded confidential accounts. Our custom app uses the REST APIs rather than requiring the full widget.

## Remaining release test

A subsequent standalone mainnet run on 25 September 2026 used a project Aurora API key, funded a confidential balance from Monad, and settled three signed payouts to Ethereum. A corrected timestamped ownership proof later authenticated through Aurora and returned a 0.098009 USDC private balance that matched quote accounting. Private history is invite-only, and refundable failures remain untested. The combined Android wallet was not involved. The [consolidated specification](confidential-balance-distribution-spec.md) records transaction links, amounts, mode selection and the remaining release gates. The endpoint discovery recorded above remains historical evidence from 22 September.
