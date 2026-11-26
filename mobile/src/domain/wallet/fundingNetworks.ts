import type { FundingChainId, FundingSourceKey } from "./storedSigner";

export const fundingTokens: Readonly<Record<FundingChainId, string>> = {
  143: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
  8453: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  42161: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
};
export function isFundingChain(value: unknown): value is FundingChainId {
  return value === 143 || value === 8453 || value === 42161;
}
export function fundingSourceIdentity(source: FundingSourceKey): string {
  if (
    !isFundingChain(source.sourceChainId) ||
    source.token.toLowerCase() !== fundingTokens[source.sourceChainId] ||
    !Number.isSafeInteger(source.accountIndex) ||
    source.accountIndex < 1 ||
    source.accountIndex === 2 ||
    (source.sourceChainId !== 143 && source.accountIndex !== 1) ||
    !/^0x[0-9a-f]{40}$/i.test(source.owner)
  )
    throw new Error("Invalid funding source");
  return `${source.sourceChainId}:${source.token.toLowerCase()}:${source.owner.toLowerCase()}`;
}
