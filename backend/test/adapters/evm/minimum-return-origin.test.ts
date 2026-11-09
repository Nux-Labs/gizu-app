import assert from "node:assert/strict";
import test from "node:test";
import { MinimumReturnOriginReceipts } from "../../../src/adapters/evm/minimum-return-origin.ts";
import {
  ethereumUsdcAssetId,
  robinhoodUsdgAssetId,
} from "../../../src/adapters/aurora/assets.ts";
const owner = "0x" + "2".repeat(40),
  deposit = "0x" + "3".repeat(40),
  hash = "0x" + "a".repeat(64),
  blockHash = "0x" + "b".repeat(64),
  other = "0x" + "c".repeat(64);
const topic =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const now = 1794218400;
function setup(asset = robinhoodUsdgAssetId) {
  const native = asset === "nep141:eth.omft.near",
    hood = asset === robinhoodUsdgAssetId;
  const token = hood
    ? "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
    : "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const expected = {
    operationId: "return_1",
    revision: 3,
    depositAddress: deposit,
    sourceOwner: owner,
    confidentialAccount: "0x" + "4".repeat(40),
    originAsset: asset,
    amountAtoms: "1000000",
    minimumCreditAtoms: "990000",
    transactionHash: hash,
  };
  const log = {
    address: token,
    topics: [
      topic,
      "0x" + "0".repeat(24) + owner.slice(2),
      "0x" + "0".repeat(24) + deposit.slice(2),
    ],
    data: "0x" + 1000000n.toString(16).padStart(64, "0"),
    removed: false,
    transactionHash: hash,
    blockHash,
    blockNumber: "0x10",
    logIndex: "0x0",
    transactionIndex: "0x0",
  };
  const receipt = {
    transactionHash: hash,
    blockHash,
    blockNumber: "0x10",
    status: "0x1",
    from: owner,
    to: native ? deposit : token,
    logs: native ? [] : [log],
  };
  const transaction = {
    hash,
    blockHash,
    blockNumber: "0x10",
    from: owner,
    to: native ? deposit : token,
    value: native ? "0xf4240" : "0x0",
  };
  const block = {
    hash: blockHash,
    number: "0x10",
    timestamp: "0x" + now.toString(16),
    transactions: [hash],
  };
  let chain = hood ? "0x1237" : "0x1",
    finalized = "0x10",
    canonicalReads = 0,
    changeCanonical = false;
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), hood ? "https://hood.test" : "https://eth.test");
    const rpc = JSON.parse(String(init?.body));
    calls.push(rpc.method + ":" + (rpc.params[0] ?? ""));
    const result =
      rpc.method === "eth_chainId"
        ? chain
        : rpc.method === "eth_getTransactionReceipt"
          ? receipt
          : rpc.method === "eth_getTransactionByHash"
            ? transaction
            : rpc.method === "eth_getBlockByNumber" &&
                rpc.params[0] === "finalized"
              ? { ...block, number: finalized }
              : rpc.method === "eth_getBlockByNumber"
                ? {
                    ...block,
                    hash:
                      changeCanonical && canonicalReads++ > 0
                        ? other
                        : block.hash,
                  }
                : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  };
  const service = new MinimumReturnOriginReceipts({
    ethereumRpcUrl: "https://eth.test",
    robinhoodRpcUrl: "https://hood.test",
    fetcher,
  });
  return {
    expected,
    receipt,
    transaction,
    block,
    log,
    calls,
    setChain(v: string) {
      chain = v;
    },
    setFinalized(v: string) {
      finalized = v;
    },
    changeCanonical() {
      changeCanonical = true;
    },
    confirm: () =>
      service.confirm(expected, {
        quoteCreatedAt: now,
        expiresAt: now + 600,
        baselineTimestampMs: now * 1000,
      }),
  };
}
test("all return assets require exact canonical source transfer; only Ethereum waits for finality", async () => {
  for (const asset of [
    robinhoodUsdgAssetId,
    ethereumUsdcAssetId,
    "nep141:eth.omft.near",
  ]) {
    const f = setup(asset);
    f.setFinalized("0x0");
    if (asset === robinhoodUsdgAssetId) {
      await f.confirm();
      assert.equal(
        f.calls.some((v) => v.endsWith(":finalized")),
        false,
      );
    } else {
      await assert.rejects(f.confirm());
      f.setFinalized("0x10");
      await f.confirm();
    }
  }
});
test("wrong chain, transaction, event, recipient, value, quote window and reorg cannot confirm funding", async () => {
  const changes: ((f: ReturnType<typeof setup>) => void)[] = [
    (f) => f.setChain("0x1"),
    (f) => {
      f.receipt.status = "0x0";
    },
    (f) => {
      f.receipt.transactionHash = other;
    },
    (f) => {
      f.transaction.hash = other;
    },
    (f) => {
      f.transaction.blockHash = other;
    },
    (f) => {
      f.block.hash = other;
    },
    (f) => {
      f.block.transactions = [];
    },
    (f) => {
      f.log.address = owner;
    },
    (f) => {
      f.log.topics[1] = "0x" + "0".repeat(24) + deposit.slice(2);
    },
    (f) => {
      f.log.topics[2] = "0x" + "0".repeat(24) + owner.slice(2);
    },
    (f) => {
      f.log.data = "0x" + "0".repeat(63) + "1";
    },
    (f) => {
      f.log.removed = true;
    },
    (f) => {
      f.receipt.logs.push({ ...f.log });
    },
    (f) => {
      f.block.timestamp = "0x" + (now - 61).toString(16);
    },
    (f) => {
      f.block.timestamp = "0x" + (now + 601).toString(16);
    },
    (f) => f.changeCanonical(),
  ];
  for (const change of changes) {
    const f = setup();
    change(f);
    await assert.rejects(f.confirm());
  }
  for (const change of [
    (f: ReturnType<typeof setup>) => {
      f.transaction.to = owner;
    },
    (f: ReturnType<typeof setup>) => {
      f.transaction.from = deposit;
    },
    (f: ReturnType<typeof setup>) => {
      f.transaction.value = "0x1";
    },
  ]) {
    const f = setup("nep141:eth.omft.near");
    change(f);
    await assert.rejects(f.confirm());
  }
});
