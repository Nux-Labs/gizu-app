import { createHmac } from "node:crypto";
import { InfrastructureError } from "../../domain/errors/infrastructure-error.ts";
import type {
  MinimumReturnReceipt,
  MinimumReturnStore,
} from "../../ports/minimum-return.port.ts";
import { EarnRecoveryEnvelope } from "../earn/recovery-envelope.ts";
import {
  ConfidentialBalance,
  authenticateEarnRead,
  type ReadAuthentication,
} from "./confidential-balance.ts";
import {
  monadUsdcAssetId,
  ethereumUsdcAssetId,
  robinhoodUsdgAssetId,
} from "./assets.ts";
import { auroraApi } from "./http.ts";
import type { SettlementExpectation } from "./settlement.ts";

export type MinimumReturnOrigin = {
  confirm(
    expected: SettlementExpectation,
    window: {
      quoteCreatedAt: number;
      expiresAt: number;
      baselineTimestampMs: number;
    },
  ): Promise<void>;
};
type Options = {
  key?: string;
  recoveryKey?: string;
  store?: MinimumReturnStore;
  origin?: MinimumReturnOrigin;
  fetcher?: typeof fetch;
  now?: () => number;
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid proof");
  return value as Record<string, unknown>;
}
function same(a: unknown, b: string) {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}
function quantity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]{0,77})$/.test(value) &&
    BigInt(value) < 1n << 256n
  );
}
function positive(value: unknown): value is string {
  return quantity(value) && value !== "0";
}
function sequence(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value);
}
function conflict(): never {
  throw new InfrastructureError(
    409,
    "EARN_MINIMUM_RETURN_CONFLICT",
    "The private observation overlaps an earlier confirmation. Reconcile the saved return; do not withdraw again.",
  );
}
/** Provider-backed lower-bound confirmation. This evidence never authorizes spending
 * and intentionally makes no exact-output claim. Durable sequence and route records
 * prevent an observation from being counted twice across replicas and restores. */
export class MinimumReturnVerifier {
  private readonly recovery: EarnRecoveryEnvelope;
  private readonly balances: ConfidentialBalance;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(private options: Options) {
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? fetch;
    this.recovery = new EarnRecoveryEnvelope(options.recoveryKey);
    this.balances = new ConfidentialBalance(
      options.key,
      this.fetcher,
      this.now,
    );
  }
  private configured() {
    if (!this.options.key || !this.recovery.configured || !this.options.store)
      throw new InfrastructureError(
        503,
        "EARN_MINIMUM_RETURN_UNAVAILABLE",
        "Durable private return verification is unavailable.",
      );
  }
  private digest(purpose: string, value: unknown) {
    this.configured();
    return createHmac("sha256", Buffer.from(this.options.recoveryKey!, "hex"))
      .update(`gizu-minimum-return:v1\0${purpose}\0`)
      .update(JSON.stringify(value))
      .digest("hex");
  }
  private accountKey(signer: string) {
    return this.digest("account", [signer.toLowerCase(), monadUsdcAssetId]);
  }
  private async durable<T>(
    work: (store: MinimumReturnStore) => Promise<T>,
  ): Promise<T> {
    this.configured();
    try {
      return await work(this.options.store!);
    } catch {
      throw new InfrastructureError(
        503,
        "EARN_MINIMUM_RETURN_UNAVAILABLE",
        "Durable private return verification is unavailable.",
      );
    }
  }
  private async current(accountKey: string) {
    const value = await this.durable((store) => store.sequence(accountKey));
    if (!sequence(value)) throw Error("Invalid durable sequence");
    return value;
  }
  async baseline(auth: ReadAuthentication) {
    this.configured();
    try {
      const signer = await authenticateEarnRead(auth, this.now),
        accountKey = this.accountKey(signer);
      const before = await this.current(accountKey);
      const balance = await this.balances.read(auth);
      if (before !== (await this.current(accountKey))) conflict();
      const fenced = { ...balance, observationSequence: before };
      return {
        ...fenced,
        baselineEnvelope: this.recovery.seal("private-balance", fenced),
      };
    } catch (error) {
      if (error instanceof InfrastructureError) throw error;
      throw new InfrastructureError(
        400,
        "INVALID_EARN_SETTLEMENT_AUTH",
        "A fresh native read authorization is required.",
      );
    }
  }
  private binding(expected: SettlementExpectation) {
    // Revision changes as a journal progresses; all financial bindings are immutable.
    const {
      revision: _revision,
      settlementEnvelope: _settlement,
      ...binding
    } = expected;
    return Object.fromEntries(
      Object.entries(binding)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [
          k,
          typeof v === "string" && v.startsWith("0x") ? v.toLowerCase() : v,
        ]),
    );
  }
  private validate(expected: SettlementExpectation) {
    const addr = (value: string) =>
      /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
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
        ].map((v) => v.toLowerCase()),
      ).size !== 3 ||
      !positive(expected.amountAtoms) ||
      !positive(expected.minimumCreditAtoms) ||
      !/^0x[0-9a-f]{64}$/i.test(expected.transactionHash) ||
      ![
        robinhoodUsdgAssetId,
        ethereumUsdcAssetId,
        "nep141:eth.omft.near",
      ].includes(expected.originAsset) ||
      expected.settlementEnvelope !== undefined
    )
      throw Error("Invalid return expectation");
  }
  private saved(expected: SettlementExpectation, signer: string) {
    if (!expected.baselineEnvelope || !expected.quoteEnvelope)
      throw Error("Saved native baseline and quote required");
    const baseline = record(
      this.recovery.open("private-balance", expected.baselineEnvelope),
    );
    const quote = record(
      record(this.recovery.open("native-quote", expected.quoteEnvelope))
        .settlement,
    );
    if (
      !same(baseline.confidentialAddress, signer) ||
      baseline.assetId !== monadUsdcAssetId ||
      baseline.authenticated !== true ||
      baseline.operationScoped !== false ||
      !quantity(baseline.available) ||
      !Number.isSafeInteger(baseline.timestampMs) ||
      (baseline.timestampMs as number) > this.now() + 5000 ||
      (baseline.observationSequence !== undefined &&
        !sequence(baseline.observationSequence))
    )
      throw Error("Invalid baseline");
    const chainId = expected.originAsset === robinhoodUsdgAssetId ? 4663 : 1;
    const token =
      chainId === 4663
        ? "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
        : expected.originAsset === ethereumUsdcAssetId
          ? "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
          : "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    for (const [field, value] of Object.entries({
      operationId: expected.operationId,
      recipient: expected.depositAddress,
      refundOwner: expected.sourceOwner,
      confidentialAccount: signer,
      originAsset: expected.originAsset,
      destinationAsset: monadUsdcAssetId,
      amountAtoms: expected.amountAtoms,
      minimumCreditAtoms: expected.minimumCreditAtoms,
      chainId,
      token,
    })) {
      if (
        typeof value === "string" && value.startsWith("0x")
          ? !same(quote[field], value)
          : quote[field] !== value
      )
        throw Error("Saved route changed");
    }
    if (
      expected.maximumCreditAtoms !== undefined &&
      expected.maximumCreditAtoms !== quote.maximumCreditAtoms
    )
      throw Error("Credit ceiling changed");
    if (
      !positive(quote.maximumCreditAtoms) ||
      BigInt(quote.maximumCreditAtoms) < BigInt(expected.minimumCreditAtoms) ||
      !Number.isSafeInteger(quote.quoteCreatedAt) ||
      !Number.isSafeInteger(quote.expiresAt) ||
      (quote.quoteCreatedAt as number) <= 0 ||
      (quote.expiresAt as number) < (quote.quoteCreatedAt as number) ||
      (baseline.timestampMs as number) <
        (quote.quoteCreatedAt as number) * 1000 - 60000 ||
      (baseline.timestampMs as number) > (quote.expiresAt as number) * 1000
    )
      throw Error("Baseline outside funding window");
    return { baseline, quote };
  }
  private proof(
    expected: SettlementExpectation,
    signer: string,
    receipt?: MinimumReturnReceipt,
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
      verification: "minimum-return-v1" as const,
      spendingAuthorized: false as const,
      exactAmountKnown: false as const,
    };
    if (!receipt)
      return {
        ...base,
        status: "awaitingSettlement" as const,
        verifiedMinimumAtoms: "0",
        observedAtMs: this.now(),
        minimumReturnEnvelope: undefined,
      };
    return {
      ...base,
      status: "minimumReceived" as const,
      verifiedMinimumAtoms: receipt.minimumAtoms,
      observedAtMs: receipt.observedAtMs,
      minimumReturnEnvelope: this.recovery.seal("minimum-return", {
        binding: this.binding(expected),
        verifiedMinimumAtoms: receipt.minimumAtoms,
        observedAtMs: receipt.observedAtMs,
        verification: "minimum-return-v1",
        spendingAuthorized: false,
        exactAmountKnown: false,
      }),
    };
  }
  private checkReceipt(
    receipt: MinimumReturnReceipt,
    identity: { accountKey: string; routeKey: string; commitment: string },
    minimum: string,
  ) {
    if (
      receipt.accountKey !== identity.accountKey ||
      receipt.routeKey !== identity.routeKey ||
      receipt.commitment !== identity.commitment ||
      receipt.minimumAtoms !== minimum ||
      !sequence(receipt.sequence) ||
      !Number.isSafeInteger(receipt.observedAtMs) ||
      receipt.observedAtMs > this.now() + 5000
    )
      conflict();
  }
  async minimumReturn(
    auth: ReadAuthentication,
    expected: SettlementExpectation,
  ) {
    this.configured();
    let signer: string;
    try {
      this.validate(expected);
      signer = await authenticateEarnRead(auth, this.now);
      if (!same(signer, expected.confidentialAccount))
        throw Error("Wrong owner");
    } catch {
      throw new InfrastructureError(
        400,
        "INVALID_EARN_SETTLEMENT_AUTH",
        "A fresh native read authorization and saved return are required.",
      );
    }
    try {
      const identity = {
        accountKey: this.accountKey(signer),
        routeKey: this.digest("route", [
          expected.originAsset,
          expected.depositAddress.toLowerCase(),
        ]),
        commitment: this.digest("binding", this.binding(expected)),
      };
      const existing = await this.durable((store) =>
        store.receipt(identity.routeKey),
      );
      if (existing) {
        this.checkReceipt(existing, identity, expected.minimumCreditAtoms);
        return this.proof(expected, signer, existing);
      }
      const { baseline, quote } = this.saved(expected, signer);
      const expectedSequence = baseline.observationSequence ?? "0";
      if ((await this.current(identity.accountKey)) !== expectedSequence)
        conflict();
      if (!this.options.origin)
        throw new InfrastructureError(
          503,
          "EARN_MINIMUM_RETURN_UNAVAILABLE",
          "Origin verification is unavailable.",
        );
      await this.options.origin.confirm(expected, {
        quoteCreatedAt: quote.quoteCreatedAt as number,
        expiresAt: quote.expiresAt as number,
        baselineTimestampMs: baseline.timestampMs as number,
      });
      const route = await auroraApi(
        this.options.key!,
        this.fetcher,
        `status/{key}?depositAddress=${encodeURIComponent(expected.depositAddress)}`,
      );
      if (route.status !== "SUCCESS") {
        if (
          ![
            "KNOWN_DEPOSIT_TX",
            "PENDING_DEPOSIT",
            "INCOMPLETE_DEPOSIT",
            "PROCESSING",
          ].includes(String(route.status))
        )
          throw Error("Return route failed");
        return this.proof(expected, signer);
      }
      const balance = await this.balances.read(auth);
      const delta =
        BigInt(balance.available) - BigInt(baseline.available as string);
      if (delta < 0n) conflict();
      if (delta < BigInt(expected.minimumCreditAtoms))
        return this.proof(expected, signer);
      if (
        this.now() - balance.timestampMs < -5000 ||
        this.now() - balance.timestampMs > 60000
      )
        throw Error("Stale observation");
      const finished = await this.durable((store) =>
        store.finish({
          ...identity,
          sequence: expectedSequence as string,
          minimumAtoms: expected.minimumCreditAtoms,
          observedAtMs: balance.timestampMs,
        }),
      );
      if (!finished) conflict();
      this.checkReceipt(finished, identity, expected.minimumCreditAtoms);
      return this.proof(expected, signer, finished);
    } catch (error) {
      if (error instanceof InfrastructureError) throw error;
      throw new InfrastructureError(
        502,
        "EARN_MINIMUM_RETURN_UNAVAILABLE",
        "Could not verify the saved minimum private return. Retry verification; do not withdraw again.",
      );
    }
  }
}
