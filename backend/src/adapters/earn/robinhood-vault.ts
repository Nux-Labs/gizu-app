import {
  defineChain,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
} from "viem";
import type { Address, PublicClient } from "viem";
import { vaultV2Deposit, vaultV2Redeem } from "@morpho-org/morpho-sdk";
import { ceilDiv } from "./policy.ts";
import type { ExactCall } from "./vault.ts";
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
});
export const ROBINHOOD_PROFILE = {
  chainId: 4663,
  token: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
  vault: getAddress("0xBeEff033F34C046626B8D0A041844C5d1A5409dd"),
  router: getAddress("0xcC108538f36242D6E0d6B9255f6D9Ccd137D70Fe"),
  wrappedNative: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  paymaster: getAddress("0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402"),
} as const;
export const robinhoodVaultAbi = parseAbi([
  "function asset() view returns(address)",
  "function previewDeposit(uint256) view returns(uint256)",
  "function previewWithdraw(uint256) view returns(uint256)",
  "function previewRedeem(uint256) view returns(uint256)",
]);
export async function robinhoodCalls(
  client: PublicClient,
  owner: Address,
  kind: "deposit" | "withdraw",
  amount: bigint,
  deadline: bigint,
) {
  if (amount <= 0n) throw new Error("Invalid USDG amount");
  let previewShares = 0n,
    maxSharePrice = 0n;
  if (kind === "deposit") {
    previewShares = await client.readContract({
      address: ROBINHOOD_PROFILE.vault,
      abi: robinhoodVaultAbi,
      functionName: "previewDeposit",
      args: [amount],
    });
    if (previewShares <= 0n) throw new Error("No USDG deposit shares");
    maxSharePrice = ceilDiv(
      amount * 10n ** 27n * 10010n,
      previewShares * 10000n,
    );
  }
  const tx =
    kind === "deposit"
      ? vaultV2Deposit({
          vault: {
            chainId: 4663,
            address: ROBINHOOD_PROFILE.vault,
            asset: ROBINHOOD_PROFILE.token,
          },
          args: { amount, userAddress: owner, maxSharePrice, deadline },
        })
      : vaultV2Redeem({
          vault: { chainId: 4663, address: ROBINHOOD_PROFILE.vault },
          args: { shares: amount, userAddress: owner, deadline },
        });
  if (
    tx.to.toLowerCase() !== ROBINHOOD_PROFILE.router.toLowerCase() ||
    (tx.value ?? 0n) !== 0n
  )
    throw new Error("USDG router changed");
  const token =
    kind === "deposit" ? ROBINHOOD_PROFILE.token : ROBINHOOD_PROFILE.vault;
  const calls: ExactCall[] = [
    {
      to: token,
      value: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [tx.to, amount],
      }),
    },
    { to: tx.to, data: tx.data, value: 0n },
  ];
  return { calls, previewShares, maxSharePrice };
}
