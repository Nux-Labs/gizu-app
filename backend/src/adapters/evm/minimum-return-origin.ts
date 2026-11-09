import { ethereumUsdcAssetId, robinhoodUsdgAssetId } from "../aurora/assets.ts";
import type { MinimumReturnOrigin } from "../aurora/minimum-return.ts";
import type { SettlementExpectation } from "../aurora/settlement.ts";
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid chain evidence");
  return value as Record<string, unknown>;
}
function same(a: unknown, b: string) {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}
function quantity(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^0x(0|[1-9a-f][0-9a-f]{0,63})$/i.test(value)
  )
    throw Error("Invalid chain quantity");
  return BigInt(value);
}
const transferTopic =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** Independent source-chain receipt verification, including canonical execution on
 * Robinhood without waiting for the rollup's delayed L1 finality. */
export class MinimumReturnOriginReceipts implements MinimumReturnOrigin {
  private readonly fetcher: typeof fetch;
  constructor(
    private options: {
      ethereumRpcUrl: string;
      robinhoodRpcUrl: string;
      fetcher?: typeof fetch;
    },
  ) {
    this.fetcher = options.fetcher ?? fetch;
  }
  private async rpc(url: string, method: string, params: unknown[]) {
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("Origin provider unavailable");
    const body = record(await response.json());
    if (
      body.jsonrpc !== "2.0" ||
      body.id !== 1 ||
      body.error ||
      body.result == null
    )
      throw Error("Missing origin evidence");
    return body.result;
  }
  async confirm(
    expected: SettlementExpectation,
    window: {
      quoteCreatedAt: number;
      expiresAt: number;
      baselineTimestampMs: number;
    },
  ): Promise<void> {
    const hood = expected.originAsset === robinhoodUsdgAssetId,
      native = expected.originAsset === "nep141:eth.omft.near";
    if (!hood && !native && expected.originAsset !== ethereumUsdcAssetId)
      throw Error("Unsupported return origin");
    const chainId = hood ? 4663n : 1n,
      url = hood ? this.options.robinhoodRpcUrl : this.options.ethereumRpcUrl;
    if (quantity(await this.rpc(url, "eth_chainId", [])) !== chainId)
      throw Error("Wrong origin chain");
    const receipt = record(
      await this.rpc(url, "eth_getTransactionReceipt", [
        expected.transactionHash,
      ]),
    );
    if (
      !same(receipt.transactionHash, expected.transactionHash) ||
      receipt.status !== "0x1" ||
      typeof receipt.blockHash !== "string" ||
      !/^0x[0-9a-f]{64}$/i.test(receipt.blockHash) ||
      quantity(receipt.blockNumber) === 0n
    )
      throw Error("Unconfirmed origin");
    const transaction = record(
      await this.rpc(url, "eth_getTransactionByHash", [
        expected.transactionHash,
      ]),
    );
    if (
      !same(transaction.hash, expected.transactionHash) ||
      !same(transaction.blockHash, receipt.blockHash) ||
      quantity(transaction.blockNumber) !== quantity(receipt.blockNumber)
    )
      throw Error("Changed origin transaction");
    const block = record(
      await this.rpc(url, "eth_getBlockByNumber", [receipt.blockNumber, false]),
    );
    const timestamp = quantity(block.timestamp);
    if (
      !same(block.hash, receipt.blockHash) ||
      quantity(block.number) !== quantity(receipt.blockNumber) ||
      !Array.isArray(block.transactions) ||
      !block.transactions.some((v) => same(v, expected.transactionHash)) ||
      timestamp < BigInt(window.quoteCreatedAt - 5) ||
      timestamp < BigInt(Math.floor(window.baselineTimestampMs / 1000) - 5) ||
      timestamp > BigInt(window.expiresAt)
    )
      throw Error("Noncanonical origin or funding window");
    if (!hood) {
      const finalized = record(
        await this.rpc(url, "eth_getBlockByNumber", ["finalized", false]),
      );
      if (quantity(finalized.number) < quantity(receipt.blockNumber))
        throw Error("Origin not finalized");
    }
    if (native) {
      if (
        !same(transaction.from, expected.sourceOwner) ||
        !same(transaction.to, expected.depositAddress) ||
        quantity(transaction.value) !== BigInt(expected.amountAtoms)
      )
        throw Error("Wrong native funding transfer");
    } else {
      const token = hood
        ? "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
        : "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
      if (!Array.isArray(receipt.logs) || receipt.logs.length > 512)
        throw Error("Missing funding events");
      const transfers = receipt.logs
        .map(record)
        .filter(
          (log) =>
            same(log.address, token) &&
            Array.isArray(log.topics) &&
            log.topics.length === 3 &&
            same(log.topics[0], transferTopic) &&
            same(
              log.topics[1],
              "0x" + "0".repeat(24) + expected.sourceOwner.slice(2),
            ) &&
            same(
              log.topics[2],
              "0x" + "0".repeat(24) + expected.depositAddress.slice(2),
            ),
        );
      if (transfers.length !== 1) throw Error("Exact funding event missing");
      const log = transfers[0]!;
      if (
        log.removed === true ||
        !same(log.transactionHash, expected.transactionHash) ||
        !same(log.blockHash, receipt.blockHash) ||
        quantity(log.blockNumber) !== quantity(receipt.blockNumber) ||
        typeof log.data !== "string" ||
        !/^0x[0-9a-f]{64}$/i.test(log.data) ||
        BigInt(log.data) !== BigInt(expected.amountAtoms)
      )
        throw Error("Wrong funding event");
    }
    const canonical = record(
      await this.rpc(url, "eth_getBlockByNumber", [receipt.blockNumber, false]),
    );
    if (!same(canonical.hash, receipt.blockHash))
      throw Error("Origin changed during verification");
  }
}
