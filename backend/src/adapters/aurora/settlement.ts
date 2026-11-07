import { InfrastructureError } from "../../domain/errors/infrastructure-error.ts";
import {
  ConfidentialBalance,
  authenticateEarnRead,
  type PrivateBalanceDiagnostic,
  type ReadAuthentication,
} from "./confidential-balance.ts";
import {
  monadUsdcAssetId,
  ethereumUsdcAssetId,
  robinhoodUsdgAssetId,
} from "./assets.ts";
import { auroraApi } from "./http.ts";
import { EarnRecoveryEnvelope } from "../earn/recovery-envelope.ts";
export type SettlementExpectation = {
  operationId: string;
  revision: number;
  depositAddress: string;
  sourceOwner: string;
  confidentialAccount: string;
  originAsset: string;
  amountAtoms: string;
  minimumCreditAtoms: string;
  transactionHash: string;
  maximumCreditAtoms?: string;
  baselineEnvelope?: string;
  quoteEnvelope?: string;
  settlementEnvelope?: string;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid history");
  return value as Record<string, unknown>;
}
function same(a: unknown, b: string) {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}
function atoms(a: unknown): a is string {
  return (
    typeof a === "string" &&
    /^[1-9][0-9]{0,77}$/.test(a) &&
    BigInt(a) < 1n << 256n
  );
}
function decimalAtoms(value: unknown, decimals: number): bigint {
  if (
    typeof value !== "string" ||
    value.length > 100 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)
  )
    throw new Error("Invalid history quantity");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error("Unexpected precision");
  const result = BigInt(whole + fraction.padEnd(decimals, "0"));
  if (result >= 1n << 256n) throw new Error("History quantity too large");
  return result;
}
/** Native journals bind verified origin receipts, saved quotes and pre-spend snapshots.
 * Route SUCCESS alone is insufficient: a bounded authenticated balance delta is required.
 * Legacy journals without snapshots retain history reconciliation. */
/** Sanitized settlement observation: no amounts, addresses, tokens or signed data. */
export type SettlementDiagnostic = {
  event: "earn.settlement";
  route: string;
  credit: "routePending" | "negative" | "zero" | "below" | "met" | "aboveMax";
  entries: string[];
  entryFields?: string[];
  availableZero?: boolean;
  baselineZero?: boolean;
  baselineAtMs?: number;
};
export class ConfidentialSettlement {
  private occupied = new Set<string>();
  private recovery: EarnRecoveryEnvelope;
  private balances: ConfidentialBalance;
  constructor(
    private key?: string,
    private fetcher: typeof fetch = fetch,
    private now: () => number = Date.now,
    recoveryKey?: string,
    private diagnose?: (
      event: SettlementDiagnostic | PrivateBalanceDiagnostic,
    ) => void,
  ) {
    this.recovery = new EarnRecoveryEnvelope(recoveryKey);
    this.balances = new ConfidentialBalance(key, fetcher, now, diagnose);
  }
  async baseline(auth: ReadAuthentication) {
    if (!this.recovery.configured)
      throw new InfrastructureError(
        503,
        "EARN_RECOVERY_UNCONFIGURED",
        "Earn recovery is not configured.",
      );
    const balance = await this.balances.read(auth);
    return {
      ...balance,
      baselineEnvelope: this.recovery.seal("private-balance", balance),
    };
  }
  private binding(expected: SettlementExpectation) {
    const fields = [
      "operationId",
      "depositAddress",
      "sourceOwner",
      "confidentialAccount",
      "originAsset",
      "amountAtoms",
      "minimumCreditAtoms",
      "transactionHash",
      "maximumCreditAtoms",
      "baselineEnvelope",
      "quoteEnvelope",
    ] as const;
    return Object.fromEntries(
      fields
        .filter((k) => expected[k] !== undefined)
        .sort()
        .map((k) => [
          k,
          typeof expected[k] === "string" && expected[k]!.startsWith("0x")
            ? expected[k]!.toLowerCase()
            : expected[k],
        ]),
    );
  }

  /** Actual operation history, not the quote's estimated output or an aggregate balance. */
  private async historyCredit(
    auth: ReadAuthentication,
    expected: SettlementExpectation,
    signer: string,
  ): Promise<string> {
    const session = await auroraApi(
      this.key!,
      this.fetcher,
      "auth/authenticate/{key}",
      { signedData: auth },
    );
    if (
      typeof session.accessToken !== "string" ||
      !session.accessToken ||
      session.accessToken.length > 8192
    )
      throw new Error("Invalid session");
    const query = new URLSearchParams({
      depositAddress: expected.depositAddress,
      status: "SUCCESS",
      depositType: "ORIGIN_CHAIN",
      recipientType: "CONFIDENTIAL_INTENTS",
      refundType: "ORIGIN_CHAIN",
      limit: "100",
    });
    const history = await auroraApi(
      this.key!,
      this.fetcher,
      `account/history/{key}?${query}`,
      undefined,
      session.accessToken,
    );
    if (!Array.isArray(history.items) || history.items.length > 100)
      throw new Error("Invalid settlement history");
    const matches = history.items
      .map(object)
      .filter((row) => same(row.depositAddress, expected.depositAddress));
    if (matches.length > 1) throw new Error("Ambiguous quote history");
    const row = matches[0];
    if (row?.status !== "SUCCESS") return "0";
    if (
      row.depositType !== "ORIGIN_CHAIN" ||
      row.recipientType !== "CONFIDENTIAL_INTENTS" ||
      row.refundType !== "ORIGIN_CHAIN" ||
      row.originAsset !== expected.originAsset ||
      row.destinationAsset !== monadUsdcAssetId ||
      !same(row.recipient, signer) ||
      !same(row.refundTo, expected.sourceOwner) ||
      row.depositMemo != null ||
      !Array.isArray(row.quoteTransactions) ||
      row.quoteTransactions.length !== 1
    )
      throw new Error("Settlement route changed");
    const created =
      typeof row.createdAt === "string" ? Date.parse(row.createdAt) : NaN;
    if (!Number.isSafeInteger(created) || created > this.now() + 5000)
      throw new Error("Invalid settlement timestamp");
    const tx = object(row.quoteTransactions[0]);
    if (
      !same(tx.sender, expected.sourceOwner) ||
      !same(tx.txHash, expected.transactionHash)
    )
      throw new Error("Origin settlement differs");
    if (
      decimalAtoms(
        row.amountInFormatted,
        expected.originAsset === "nep141:eth.omft.near" ? 18 : 6,
      ) !== BigInt(expected.amountAtoms)
    )
      throw new Error("Actual input changed");
    const credit = decimalAtoms(row.amountOutFormatted, 6);
    if (credit < BigInt(expected.minimumCreditAtoms))
      throw new Error("Confidential credit below reviewed minimum");
    return credit.toString();
  }

  private async balanceCredit(
    auth: ReadAuthentication,
    expected: SettlementExpectation,
    signer: string,
    allowOperationHistory: boolean,
  ) {
    const base = {
      operationId: expected.operationId,
      revision: expected.revision,
      confidentialAddress: signer,
      assetId: monadUsdcAssetId,
      depositAddress: expected.depositAddress,
      transactionHash: expected.transactionHash,
      timestampMs: this.now(),
      authenticated: true as const,
      operationScoped: true as const,
    };
    if (expected.settlementEnvelope) {
      const saved = object(
        this.recovery.open("source-credit", expected.settlementEnvelope),
      );
      if (
        JSON.stringify(saved.binding) !== JSON.stringify(this.binding(expected))
      )
        throw new Error("Credit binding changed");
      const proof = object(saved.proof);
      const verification =
        proof.verification === undefined
          ? "balance-delta-v1"
          : proof.verification;
      if (
        proof.status !== "credited" ||
        !atoms(proof.creditedAtoms) ||
        BigInt(proof.creditedAtoms) < BigInt(expected.minimumCreditAtoms) ||
        (verification !== "balance-delta-v1" &&
          verification !== "operation-history-v1") ||
        (verification === "operation-history-v1" && !allowOperationHistory) ||
        (verification === "balance-delta-v1" &&
          expected.maximumCreditAtoms !== undefined &&
          BigInt(proof.creditedAtoms) > BigInt(expected.maximumCreditAtoms))
      )
        throw new Error("Invalid saved credit");
      return {
        ...base,
        creditedAtoms: proof.creditedAtoms,
        status: "credited" as const,
        verification,
        settlementEnvelope: expected.settlementEnvelope,
      };
    }
    if (!expected.baselineEnvelope || !expected.quoteEnvelope)
      throw new Error("Saved native baseline and quote required");
    const baseline = object(
      this.recovery.open("private-balance", expected.baselineEnvelope),
    );
    const saved = object(
        this.recovery.open("native-quote", expected.quoteEnvelope),
      ),
      quote = object(saved.settlement);
    if (
      !same(baseline.confidentialAddress, signer) ||
      baseline.assetId !== monadUsdcAssetId ||
      baseline.authenticated !== true ||
      baseline.operationScoped !== false ||
      typeof baseline.available !== "string" ||
      !/^(0|[1-9][0-9]{0,77})$/.test(baseline.available) ||
      BigInt(baseline.available) >= 1n << 256n ||
      typeof baseline.timestampMs !== "number" ||
      !Number.isSafeInteger(baseline.timestampMs) ||
      baseline.timestampMs > this.now() + 5000
    )
      throw new Error("Invalid baseline");
    for (const [field, value] of Object.entries({
      operationId: expected.operationId,
      recipient: expected.depositAddress,
      refundOwner: expected.sourceOwner,
      confidentialAccount: signer,
      originAsset: expected.originAsset,
      destinationAsset: monadUsdcAssetId,
      amountAtoms: expected.amountAtoms,
      minimumCreditAtoms: expected.minimumCreditAtoms,
    })) {
      if (
        typeof value === "string" && value.startsWith("0x")
          ? !same(quote[field], value)
          : quote[field] !== value
      )
        throw new Error("Saved route changed");
    }
    if (
      expected.maximumCreditAtoms !== undefined &&
      expected.maximumCreditAtoms !== quote.maximumCreditAtoms
    )
      throw new Error("Credit ceiling changed");
    if (
      typeof quote.quoteCreatedAt !== "number" ||
      typeof quote.expiresAt !== "number" ||
      baseline.timestampMs < quote.quoteCreatedAt * 1000 - 60000 ||
      baseline.timestampMs > quote.expiresAt * 1000
    )
      throw new Error("Baseline outside funding window");
    if (
      !atoms(quote.maximumCreditAtoms) ||
      BigInt(quote.maximumCreditAtoms) < BigInt(expected.minimumCreditAtoms)
    )
      throw new Error("Missing credit ceiling");
    const route = await auroraApi(
      this.key!,
      this.fetcher,
      `status/{key}?depositAddress=${encodeURIComponent(expected.depositAddress)}`,
    );
    const pending = {
      ...base,
      creditedAtoms: "0",
      status: "awaitingSettlement" as const,
      verification: "balance-delta-v1" as const,
    };
    const report = (
      credit: SettlementDiagnostic["credit"],
      entries: string[] = [],
      facts: Partial<SettlementDiagnostic> = {},
    ) => {
      try {
        this.diagnose?.({
          event: "earn.settlement",
          route: /^[A-Z_]{1,32}$/.test(String(route.status))
            ? String(route.status)
            : "OTHER",
          credit,
          entries,
          ...facts,
        });
      } catch {
        /* logging only */
      }
    };
    if (route.status !== "SUCCESS") {
      report("routePending");
      if (
        ![
          "KNOWN_DEPOSIT_TX",
          "PENDING_DEPOSIT",
          "INCOMPLETE_DEPOSIT",
          "PROCESSING",
        ].includes(String(route.status))
      )
        throw new Error("Funding route failed");
      return pending;
    }
    const balance = await this.balances.read(auth, this.diagnose !== undefined);
    const delta = BigInt(balance.available) - BigInt(baseline.available);
    report(
      delta < 0n
        ? "negative"
        : delta > BigInt(quote.maximumCreditAtoms)
          ? "aboveMax"
          : delta === 0n
            ? "zero"
            : delta < BigInt(expected.minimumCreditAtoms)
              ? "below"
              : "met",
      balance.entryKinds,
      {
        entryFields: balance.entryFields ?? [],
        availableZero: balance.available === "0",
        baselineZero: baseline.available === "0",
        baselineAtMs: baseline.timestampMs as number,
      },
    );
    if (delta < 0n) throw new Error("Ambiguous private credit");
    let verification: "balance-delta-v1" | "operation-history-v1" =
      "balance-delta-v1";
    if (delta > BigInt(quote.maximumCreditAtoms)) {
      if (!allowOperationHistory) throw new Error("Ambiguous private credit");
      try {
        // amountOut is an estimate. Better execution needs an exact operation record;
        // never enlarge a tolerance or attribute unrelated extra balance to this route.
        const actual = await this.historyCredit(auth, expected, signer);
        if (BigInt(actual) !== delta)
          throw new Error("History and private credit differ");
        verification = "operation-history-v1";
      } catch {
        throw new InfrastructureError(
          503,
          "EARN_SETTLEMENT_HISTORY_UNAVAILABLE",
          "The exact private return record could not be verified. Retry verification; do not withdraw again.",
        );
      }
    }
    if (delta < BigInt(expected.minimumCreditAtoms)) return pending;
    const verifiedAt = this.now();
    if (
      verifiedAt - balance.timestampMs < -5000 ||
      verifiedAt - balance.timestampMs > 60000
    )
      throw new Error("Private balance evidence expired during verification");
    const proof = {
      ...base,
      timestampMs: verifiedAt,
      creditedAtoms: delta.toString(),
      status: "credited" as const,
      verification,
    };
    return {
      ...proof,
      settlementEnvelope: this.recovery.seal("source-credit", {
        binding: this.binding(expected),
        proof,
      }),
    };
  }
  async read(
    auth: ReadAuthentication,
    expected: SettlementExpectation,
    allowOperationHistory = false,
  ) {
    if (!this.key)
      throw new InfrastructureError(
        503,
        "EARN_SETTLEMENT_UNCONFIGURED",
        "Authenticated settlement provider is not configured.",
      );
    let signer: string;
    try {
      const addr = (a: string) =>
        /^0x[0-9a-f]{40}$/i.test(a) && !/^0x0{40}$/i.test(a);
      if (
        !/^[-a-zA-Z0-9_]{1,128}$/.test(expected.operationId) ||
        !Number.isSafeInteger(expected.revision) ||
        expected.revision < 1 ||
        ![
          expected.sourceOwner,
          expected.confidentialAccount,
          expected.depositAddress,
        ].every(addr) ||
        new Set(
          [
            expected.sourceOwner,
            expected.confidentialAccount,
            expected.depositAddress,
          ].map((a) => a.toLowerCase()),
        ).size !== 3 ||
        !atoms(expected.amountAtoms) ||
        !atoms(expected.minimumCreditAtoms) ||
        !/^0x[0-9a-f]{64}$/i.test(expected.transactionHash) ||
        !new Set([
          monadUsdcAssetId,
          ethereumUsdcAssetId,
          robinhoodUsdgAssetId,
          "nep141:eth.omft.near",
        ]).has(expected.originAsset)
      )
        throw new Error("Invalid settlement expectation");
      signer = await authenticateEarnRead(auth, this.now);
      if (!same(signer, expected.confidentialAccount))
        throw new Error("Wrong confidential owner");
    } catch {
      throw new InfrastructureError(
        400,
        "INVALID_EARN_SETTLEMENT_AUTH",
        "A fresh native read authorization and saved origin operation are required.",
      );
    }
    const scope = signer + ":" + expected.depositAddress.toLowerCase();
    if (this.occupied.has(scope) || this.occupied.size >= 32)
      throw new InfrastructureError(
        429,
        "EARN_SETTLEMENT_BUSY",
        "Settlement reconciliation is already running.",
      );
    this.occupied.add(scope);
    try {
      if (
        expected.baselineEnvelope ||
        expected.quoteEnvelope ||
        expected.settlementEnvelope
      )
        return await this.balanceCredit(
          auth,
          expected,
          signer,
          allowOperationHistory,
        );
      const creditedAtoms = await this.historyCredit(auth, expected, signer);
      const status =
        creditedAtoms === "0"
          ? ("awaitingSettlement" as const)
          : ("credited" as const);
      return {
        operationId: expected.operationId,
        revision: expected.revision,
        confidentialAddress: signer,
        assetId: monadUsdcAssetId,
        depositAddress: expected.depositAddress,
        transactionHash: expected.transactionHash,
        creditedAtoms,
        timestampMs: this.now(),
        authenticated: true as const,
        operationScoped: true as const,
        status,
      };
    } catch (error) {
      if (
        error instanceof InfrastructureError &&
        error.code === "EARN_SETTLEMENT_HISTORY_UNAVAILABLE"
      )
        throw error;
      throw new InfrastructureError(
        502,
        "EARN_SETTLEMENT_UNAVAILABLE",
        "Could not verify operation-specific confidential credit. Reconcile before proceeding.",
      );
    } finally {
      this.occupied.delete(scope);
    }
  }
}
