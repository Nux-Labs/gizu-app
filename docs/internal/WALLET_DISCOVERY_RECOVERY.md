# Wallet discovery and recovery

This feature is implemented on Android. The Account screen exposes native
capability-gated sync, restore and read-only discovery controls. Older native
builds and iOS do not advertise these capabilities. Rebuild the native app after
updating the Rust bindings and Kotlin implementation.

## Ownership and privacy

The device owns the encrypted wallet catalogue, derivation metadata, discovery
cursors and execution journals. Addresses are derived when needed; the backend
has no readable wallet catalogue or user-to-wallet mapping. Addresses may still
be processed transiently by quote, sponsorship, settlement and RPC providers.
This does not provide transaction unlinkability on public chains or hide addresses
from the providers serving those reads.

Native code derives independent recovery locator, bearer and encryption material
from the root entropy using domain-separated HKDF-SHA256. The encryption key,
credentials, portable journals and decrypted recovery metadata do not cross the
JavaScript bridge. The remote store receives opaque identifiers and authenticated
ciphertext. Objects sharing a bearer digest are linkable as one unknown recovery
credential, without revealing their addresses or plaintext.

The original exported backup and its original passkey remain necessary. Recovery
sync does not upload the root entropy or replace that backup. An older exported
backup can derive the same recovery material and retrieve subsequently synced
metadata. Loss of both the local wallet and its usable exported backup remains
unrecoverable through the backend alone.

## Persistence and execution

Encrypted local catalogue and journal files use immutable pages with an atomic
root. Migration preserves released storage and backup formats. Allocation checks
count pending operations rather than lifetime history. Signed or uncertain work
is preserved; settled transfer overflow is archived under its existing native
format.

Recovery sync uploads immutable encrypted pages before publishing a root with
compare-and-swap. Page allocation and cleanup intentions are journaled before
network mutations. Current and two previous root page sets are retained; cleanup
failures survive restart and eventually block further allocation at a bounded
backlog. The current native snapshot bound is 16 MiB, divided into 64 KiB chunks.
Exceeding a bound fails safely rather than discarding history.

Fresh funding requires acknowledged metadata sync. Submission requires the exact
signed journals to be synced before broadcast. Backend/storage outages therefore
block new spending; read-only portfolio and reconciliation remain available.
Restoration merges allocation high-water marks monotonically, imports exact signed
history into the current native generation and reconciles it read-only. Existing
native resume controls require fresh authorization where applicable; restore and
discovery never broadcast transactions.

## Discovery and older backups

Discovery checks Ethereum (1) and Robinhood (4663), cycles and legacy plus
distribution-v1 derivation namespaces. Candidates include historical
hold/invest/confidential roles and five distribution investment slots. Shared
cycles use main-list Account 2 for private cash; their normal owned-portfolio reads
do not add unused legacy private identities. The bounded recovery scanner still
checks historical candidates explicitly, with signing/read validation for the
actual owned address. Conflicting private identity markers
fail recovery rather than changing an existing cycle. Native consent covers one bounded
foreground session; pause, background, lock and destruction revoke it. Durable
per-chain/per-candidate cursors allow interrupted scans to resume.

Only descriptors with observed activity and compact cursors are retained. Public
token/native balances, supported vault shares and authenticated confidential
balances are checked. Portfolio readers include discovered owners. A scan through
an explicit inclusive bound cannot prove there are no later wallets, historical
activity at now-empty addresses, unsupported assets or unsupported vaults.

Discovery advances the allocation high-water mark and blocks unsafe new allocation
for untracked cycles. It does not invent allocation weights or pending-operation
state. Restoring authenticated catalogue/history can clear that gate once all
discovered identities are covered and reconciliation is safe; unresolved metadata
continues to require recovery. A fresh device cannot prove server freshness from
that server alone, so exported backups and bounded fallback discovery remain
independent recovery paths.

## Backend rollout

Deploy the backend changes with PostgreSQL available and the same stable
`EARN_GATEWAY_RECOVERY_KEY` on every replica. New tables initialize lazily under
database locks. Do not rotate the key while signed authority remains valid without
a coordinated migration. Recovery upload admission, storage quotas, private log
rules and temporary shared replay guards are described in
[the backend protocol](../../backend/docs/wallet-recovery.md).

Build and distribute the updated Android app only after the backend recovery
routes are available. The current Android implementation combines recovery support with
algorithm-selected deposits. Recovery preserves each saved distribution plan and
wallet slot, and discovery recognizes owners already covered by that plan.
Restored withdrawals retain the selected investment slot and its receiver indices.
This source review does not deploy the backend, modify production data or
establish device/provider acceptance. Terminal minimum-return/refund observations
are validated under their original generation before recovery rebinding; no
restored lifecycle decision creates private-credit evidence or spending authority.
