import { fundingSourceIdentity, fundingTokens, isFundingChain } from "./fundingNetworks";
import type { MainnetPortfolioSnapshot } from "./storedSigner";

export function validateFundingPortfolio(value: MainnetPortfolioSnapshot): void {
  if (value.fundingSources === undefined && value.fundingCash === undefined) return;
  const sources = value.fundingSources,
    cash = value.fundingCash;
  if (!Array.isArray(sources) || !cash || sources.length > 8194)
    throw new Error("Invalid funding observations");
  const amount = (value: string) => {
    if (
      typeof value !== "string" ||
      !/^(0|[1-9][0-9]{0,77})$/.test(value) ||
      BigInt(value) >= 1n << 256n
    )
      throw new Error("Invalid funding amount");
    return BigInt(value);
  };
  const seen = new Set<string>();
  let observed = 0n,
    available = 0n;
  for (const source of sources) {
    const key = fundingSourceIdentity(source);
    if (
      seen.has(key) ||
      (source.sourceId !== undefined && source.sourceId !== key) ||
      source.decimals !== 6 ||
      !Number.isSafeInteger(source.checkedAt) ||
      source.checkedAt < 0 ||
      [source.complete, source.stale, source.syncPending].some(
        (flag) => typeof flag !== "boolean",
      ) ||
      (source.accountIndex === 1 &&
        source.owner.toLowerCase() !== value.fundingAddress.toLowerCase())
    )
      throw new Error("Invalid funding observation");
    seen.add(key);
    const balance = source.balanceAtoms === null ? null : amount(source.balanceAtoms);
    const observation = source.observedAtoms === null ? null : amount(source.observedAtoms);
    const reserved = source.reservedAtoms === null ? null : amount(source.reservedAtoms);
    const spendable = source.availableAtoms === null ? null : amount(source.availableAtoms);
    if (
      (balance !== null && balance !== observation) ||
      (source.complete &&
        (source.stale ||
          source.syncPending ||
          balance === null ||
          reserved === null ||
          spendable === null)) ||
      (spendable !== null &&
        (source.stale ||
          source.syncPending ||
          balance === null ||
          reserved === null ||
          spendable !== (balance > reserved ? balance - reserved : 0n)))
    )
      throw new Error("Invalid funding availability");
    observed += observation ?? 0n;
    available += spendable ?? 0n;
  }
  const complete =
    [143, 8453, 42161].every((chain) =>
      sources.some((source) => source.sourceChainId === chain && source.accountIndex === 1),
    ) && sources.every((source) => source.complete && !source.stale && !source.syncPending);
  if (
    [cash.complete, cash.stale, cash.syncPending].some((flag) => typeof flag !== "boolean") ||
    amount(cash.observedAtoms) !== observed ||
    cash.complete !== complete ||
    (complete
      ? cash.stale ||
        cash.syncPending ||
        cash.availableAtoms === null ||
        amount(cash.availableAtoms) !== available
      : cash.availableAtoms !== null || !cash.syncPending)
  )
    throw new Error("Inconsistent funding cash");
  for (const row of value.ownedAssets ?? [])
    if (row.fundingIncludedAtoms !== undefined) {
      if (
        !isFundingChain(row.chainId) ||
        row.token.toLowerCase() !== fundingTokens[row.chainId] ||
        row.decimals !== 6 ||
        amount(row.fundingIncludedAtoms) > amount(row.observedAtoms)
      )
        throw new Error("Invalid funding overlap");
    }
}
