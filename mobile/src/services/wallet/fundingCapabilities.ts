import {
  defaultDepositNetwork,
  depositNetworks,
  type DepositNetwork,
} from "@/domain/wallet/depositNetworks";
import { isFundingChain } from "@/domain/wallet/fundingNetworks";
import { getSignerCapabilities } from "./nativeBridge";

export function supportedFundingNetworks(
  native: unknown,
  backend: unknown,
): readonly DepositNetwork[] {
  const chains = (raw: unknown): readonly number[] => {
    if (
      raw === null ||
      typeof raw !== "object" ||
      !("fundingContractVersion" in raw) ||
      raw.fundingContractVersion !== 2
    )
      return [143];
    if (
      !("fundingChainIds" in raw) ||
      !Array.isArray(raw.fundingChainIds) ||
      !raw.fundingChainIds.every(isFundingChain) ||
      new Set(raw.fundingChainIds).size !== raw.fundingChainIds.length
    )
      return [];
    return raw.fundingChainIds;
  };
  const local = chains(native),
    remote = chains(backend);
  return depositNetworks.filter(
    (network) => local.includes(network.chainId) && remote.includes(network.chainId),
  );
}
let cached: { url: string; observedAt: number; value: unknown } | undefined;
let inFlight: { url: string; task: Promise<unknown> } | undefined;

async function backendCapabilities(): Promise<unknown> {
  const baseUrl = process.env.EXPO_PUBLIC_API_URL ?? (__DEV__ ? "http://127.0.0.1:3000" : "");
  if (!baseUrl) throw new Error("Funding availability is not configured");
  const url = baseUrl.replace(/\/$/, "") + "/v1/funding/capabilities";
  const now = Date.now();
  if (cached?.url === url && now >= cached.observedAt && now - cached.observedAt < 30_000)
    return cached.value;
  if (inFlight?.url === url) return inFlight.task;
  const task = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status === 404) {
        cached = { url, observedAt: Date.now(), value: undefined };
        return undefined;
      }
      if (!response.ok) throw new Error("Funding availability is unavailable");
      const raw: unknown = await response.json();
      if (
        !raw ||
        typeof raw !== "object" ||
        !("fundingContractVersion" in raw) ||
        raw.fundingContractVersion !== 2 ||
        !("fundingChainIds" in raw) ||
        !Array.isArray(raw.fundingChainIds) ||
        raw.fundingChainIds.length === 0 ||
        !raw.fundingChainIds.every(isFundingChain) ||
        new Set(raw.fundingChainIds).size !== raw.fundingChainIds.length
      )
        throw new Error("Invalid funding availability");
      cached = { url, observedAt: Date.now(), value: raw };
      return raw;
    } finally {
      clearTimeout(timeout);
    }
  })();
  inFlight = { url, task };
  try {
    return await task;
  } finally {
    if (inFlight?.task === task) inFlight = undefined;
  }
}

export const fundingCapabilityService = {
  async networks(): Promise<readonly DepositNetwork[]> {
    const native = await getSignerCapabilities();
    if (native.fundingContractVersion !== 2) return [defaultDepositNetwork];
    return supportedFundingNetworks(native, await backendCapabilities());
  },
  async ethereumPrivateFundingAvailable(): Promise<boolean> {
    const raw = await backendCapabilities();
    if (
      !raw ||
      typeof raw !== "object" ||
      !("earnPrivateFundingVersion" in raw) ||
      raw.earnPrivateFundingVersion !== 2 ||
      !("earnPrivateFundingProfileChainIds" in raw)
    )
      return false;
    const profiles = raw.earnPrivateFundingProfileChainIds;
    return Array.isArray(profiles) && profiles.length === 1 && profiles[0] === 1;
  },
};
