import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hashTypedData, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import {
  assertRegistrySignature,
  assetIdOf,
  basketCommitment,
  canonicalStrategyMetadata,
  commitSigner,
  commitStrategyTypes,
  createStrategySigner,
  createStrategyTypes,
  registryDomain,
  sealBasket,
  strategyMetadataHash,
  strategyPerformance,
  type StrategyAsset,
  type StrategyAssetKind,
  type StrategyAssetRef,
} from "../../src/domain/strategy.ts";

type VectorAsset = { chainId: number; kind: number; address: Address; assetId: Hex; weightBps: number };
const vectors = JSON.parse(
  readFileSync(new URL("../../../shared/strategy-commit-vectors.json", import.meta.url), "utf8"),
) as {
  mnemonic: string;
  signers: { chainId: number; index: number; path: string; address: Address }[];
  domain: { chainId: 8453; verifyingContract: Address };
  basket: { strategyId: number; seq: number; salt: Hex; assets: VectorAsset[]; commitment: Hex };
  create: { embargo: number; metadataHash: Hex; deadline: number; digest: Hex };
  commit: { deadline: number; digest: Hex };
};
const assets: StrategyAsset[] = vectors.basket.assets.map((asset) => ({
  chainId: asset.chainId,
  kind: asset.kind as StrategyAssetKind,
  address: asset.address,
  weightBps: asset.weightBps,
}));
const anyAsset = (_asset: StrategyAssetRef) => true;

test("asset ids, sorting and the commitment match the shared vectors", () => {
  for (const asset of vectors.basket.assets) assert.equal(assetIdOf({ ...asset, kind: asset.kind as StrategyAssetKind }), asset.assetId);
  const sealed = sealBasket([...assets].reverse(), anyAsset);
  assert.deepEqual(sealed.map((asset) => asset.assetId), vectors.basket.assets.map((asset) => asset.assetId));
  assert.equal(
    basketCommitment(BigInt(vectors.basket.strategyId), BigInt(vectors.basket.seq), sealed, vectors.basket.salt),
    vectors.basket.commitment,
  );
});

test("typed-data digests match the shared vectors and recover the strategy signer", async () => {
  const domain = registryDomain(vectors.domain.chainId, vectors.domain.verifyingContract);
  const createMessage = {
    embargo: vectors.create.embargo,
    metadataHash: vectors.create.metadataHash,
    deadline: BigInt(vectors.create.deadline),
  };
  const commitMessage = {
    strategyId: BigInt(vectors.basket.strategyId),
    seq: BigInt(vectors.basket.seq),
    commitment: vectors.basket.commitment,
    deadline: BigInt(vectors.commit.deadline),
  };
  assert.equal(
    hashTypedData({ domain, types: createStrategyTypes, primaryType: "CreateStrategy", message: createMessage }),
    vectors.create.digest,
  );
  assert.equal(
    hashTypedData({ domain, types: commitStrategyTypes, primaryType: "Commit", message: commitMessage }),
    vectors.commit.digest,
  );

  const signer = vectors.signers[0]!;
  const account = mnemonicToAccount(vectors.mnemonic, { path: signer.path as `m/44'/60'/${string}` });
  assert.equal(account.address, signer.address);
  const createSignature = await account.signTypedData({
    domain, types: createStrategyTypes, primaryType: "CreateStrategy", message: createMessage,
  });
  assert.equal(
    await createStrategySigner({
      chainId: 8453, registry: vectors.domain.verifyingContract, embargo: vectors.create.embargo,
      metadataHash: vectors.create.metadataHash, deadline: vectors.create.deadline, signature: createSignature,
    }),
    signer.address,
  );
  const commitSignature = await account.signTypedData({
    domain, types: commitStrategyTypes, primaryType: "Commit", message: commitMessage,
  });
  assert.equal(
    await commitSigner({
      chainId: 8453, registry: vectors.domain.verifyingContract, strategyId: 1n, seq: 0n,
      commitment: vectors.basket.commitment, deadline: vectors.commit.deadline, signature: commitSignature,
    }),
    signer.address,
  );
  // The same signature names a different signer on another registry chain.
  assert.notEqual(
    await createStrategySigner({
      chainId: 84532, registry: vectors.domain.verifyingContract, embargo: vectors.create.embargo,
      metadataHash: vectors.create.metadataHash, deadline: vectors.create.deadline, signature: createSignature,
    }),
    signer.address,
  );
});

test("baskets outside the rules are rejected", () => {
  const reject = (basket: StrategyAsset[], inUniverse = anyAsset) =>
    assert.throws(() => sealBasket(basket, inUniverse), { code: "STRATEGY_INVALID" });
  reject([]);
  reject(assets.map((asset, i) => (i === 0 ? { ...asset, weightBps: asset.weightBps + 100 } : i === 1 ? { ...asset, weightBps: asset.weightBps - 100 } : asset)));
  reject(assets.map((asset, i) => (i === 0 ? { ...asset, weightBps: asset.weightBps - 500 } : asset)));
  reject([assets[0]!, { ...assets[0]!, weightBps: 9000 }]);
  reject(Array.from({ length: 11 }, (_, i) => ({ ...assets[1]!, address: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address, weightBps: 500 })));
  reject(assets, (asset) => asset.kind === 0);
});

test("only low-s 65-byte signatures with v 27 or 28 pass", () => {
  const r = "11".repeat(32);
  assert.doesNotThrow(() => assertRegistrySignature(`0x${r}${"22".repeat(32)}1b`));
  assert.throws(() => assertRegistrySignature(`0x${r}${"ff".repeat(32)}1b`));
  assert.throws(() => assertRegistrySignature(`0x${r}${"22".repeat(32)}01`));
  assert.throws(() => assertRegistrySignature(`0x${r}`));
});

test("metadata hashes a canonical JSON string", () => {
  const metadata = { seats: 20, signalPriceAtoms: "500000", name: "Chips", monthlyPriceAtoms: "10000000" };
  assert.equal(
    canonicalStrategyMetadata(metadata),
    '{"v":1,"name":"Chips","monthlyPriceAtoms":"10000000","signalPriceAtoms":"500000","seats":20}',
  );
  assert.equal(strategyMetadataHash(metadata), strategyMetadataHash({ ...metadata }));
  assert.notEqual(strategyMetadataHash(metadata), strategyMetadataHash({ ...metadata, seats: 21 }));
});

test("performance compounds closed periods and skips periods with missing prices", () => {
  const a = "0xa1" as Hex;
  const b = "0xb2" as Hex;
  const basket = [{ assetId: a, weightBps: 5000 }, { assetId: b, weightBps: 5000 }];
  const result = strategyPerformance([
    // +10% then -20%, then an open period that does not count.
    { basket, start: { [a]: 100, [b]: 10 }, end: { [a]: 120, [b]: 10 } },
    { basket, start: { [a]: 120, [b]: 10 }, end: { [a]: 72, [b]: 10 } },
    { basket, start: { [a]: 72, [b]: 10 } },
  ]);
  assert.deepEqual(result, { cumulativeReturnBps: -1200, maxDrawdownBps: 2000, closedPeriods: 2, complete: true });
  const missing = strategyPerformance([{ basket, start: { [a]: 100, [b]: null }, end: { [a]: 110, [b]: 10 } }]);
  assert.deepEqual(missing, { cumulativeReturnBps: null, maxDrawdownBps: null, closedPeriods: 0, complete: false });
});
