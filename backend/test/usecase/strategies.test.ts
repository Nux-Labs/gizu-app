import assert from "node:assert/strict";
import { test } from "node:test";
import { StrategyRegistryRejection } from "../../src/adapters/evm/strategy-registry.ts";
import type { SignalPaymentRequired, SignalPaywall } from "../../src/ports/strategies.port.ts";
import { SignalPaymentRejected } from "../../src/ports/strategies.port.ts";
import { StrategyQueries } from "../../src/usecase/strategies/strategy-queries.usecase.ts";
import { PurchaseSignalUseCase } from "../../src/usecase/strategies/purchase-signal.usecase.ts";
import {
  FakeRegistry,
  NOW,
  SALT,
  basketInput,
  commitInput,
  createInput,
  metadata,
  owner,
  setup,
  stranger,
} from "../fixtures/strategies.ts";

test("creating a strategy verifies the key's signature and is safe to retry", async () => {
  const { create, registry, store } = setup();
  await assert.rejects(create.execute(await createInput(stranger), NOW), { code: "STRATEGY_SIGNATURE_INVALID" });
  const first = await create.execute(await createInput(), NOW);
  assert.equal(first.id, 1);
  assert.equal((await create.execute(await createInput(), NOW)).id, 1);
  assert.equal(registry.chain.size, 1);
  await assert.rejects(create.execute(await createInput(owner, { ...metadata, seats: 3 }), NOW), { code: "STRATEGY_EXISTS" });

  // Created on chain by an attempt that never reached the database.
  store.strategies = [];
  assert.equal((await create.execute(await createInput(), NOW)).id, 1);
  assert.equal(registry.chain.size, 1);
});

test("a commitment is checked against the sealed basket, relayed, priced and queued for push", async () => {
  const { create, submit, store, registry, queries } = setup();
  const { id } = await create.execute(await createInput(), NOW);
  const good = await commitInput(id, 0);

  await assert.rejects(submit.execute(id, { ...good, weightsBps: [...good.weightsBps].reverse() }, NOW), { code: "STRATEGY_COMMIT_MISMATCH" });
  await assert.rejects(submit.execute(id, { ...good, salt: `0x${"08".repeat(32)}` }, NOW), { code: "STRATEGY_COMMIT_MISMATCH" });
  await assert.rejects(submit.execute(id, await commitInput(id, 0, stranger), NOW), { code: "STRATEGY_SIGNATURE_INVALID" });
  await assert.rejects(submit.execute(id, await commitInput(id, 1), NOW), { code: "STRATEGY_SEQ_STALE" });
  await assert.rejects(
    submit.execute(id, { ...good, assets: [{ ...basketInput[0]!, address: "0x000000000000000000000000000000000000dEaD" }, ...basketInput.slice(1)] }, NOW),
    { code: "STRATEGY_INVALID" },
  );

  assert.deepEqual(await submit.execute(id, good, NOW), { seq: 0, status: "committed", commitTx: `0x${"c2".repeat(32)}` });
  assert.equal(registry.commitCalls, 1);
  assert.deepEqual(store.pushes, [{ strategyId: id, seq: 0 }]);
  assert.deepEqual(store.snaps.map((s) => [s.seq, s.edge]), [[0, "start"]]);

  // The second update closes the first period with end prices.
  await submit.execute(id, await commitInput(id, 1), NOW);
  assert.deepEqual(store.snaps.map((s) => [s.seq, s.edge]), [[0, "start"], [1, "start"], [0, "end"]]);
  assert.equal((await queries.detail(id)).commits, 2);
});

test("a delayed commitment waits for the worker and blocks a second update meanwhile", async () => {
  const { create, submit, relay, registry } = setup(300);
  const { id } = await create.execute(await createInput(), NOW);
  assert.deepEqual(await submit.execute(id, await commitInput(id, 0), NOW), { seq: 0, status: "pending", commitTx: null });
  assert.equal(registry.commitCalls, 0);
  await assert.rejects(submit.execute(id, await commitInput(id, 0), NOW), { code: "STRATEGY_COMMIT_PENDING" });
  await relay.runOnce(new Date(NOW.getTime() + 149_000));
  assert.equal(registry.commitCalls, 0);
  await relay.runOnce(new Date(NOW.getTime() + 151_000));
  assert.equal(registry.commitCalls, 1);
});

test("a lost receipt is reconciled from the chain instead of being marked failed", async () => {
  const { create, submit, relay, store, registry } = setup();
  const { id } = await create.execute(await createInput(), NOW);
  registry.loseNextReceipt = true;
  assert.equal((await submit.execute(id, await commitInput(id, 0), NOW)).status, "pending");
  await relay.runOnce(NOW);
  assert.equal(registry.commitCalls, 1, "the landed commitment is not sent again");
  const [row] = await store.commits([id]);
  assert.equal(row!.status, "committed");
  assert.equal(row!.commitTx, null);
  assert.deepEqual(store.pushes, [{ strategyId: id, seq: 0 }]);
});

test("a registry rejection fails the commitment and frees its sequence number", async () => {
  const { create, submit, store, registry } = setup();
  const { id } = await create.execute(await createInput(), NOW);
  registry.commit = async () => { throw new StrategyRegistryRejection("Expired"); };
  await assert.rejects(submit.execute(id, await commitInput(id, 0), NOW), { code: "STRATEGY_COMMIT_REJECTED" });
  assert.equal((await store.commits([id]))[0]!.status, "failed");
  registry.commit = FakeRegistry.prototype.commit.bind(registry);
  assert.equal((await submit.execute(id, await commitInput(id, 0), NOW)).status, "committed");
});

test("public reads show only revealed baskets; the signal needs a subscriber key", async () => {
  const { create, submit, relay, queries } = setup();
  const { id } = await create.execute(await createInput(), NOW);
  await submit.execute(id, await commitInput(id, 0), NOW);

  const [card] = await queries.list();
  assert.equal(card!.commits, 1);
  assert.equal(card!.revealed, 0);
  const detail = await queries.detail(id);
  assert.deepEqual(detail.history, []);
  assert.ok(!JSON.stringify(await queries.list()).includes(basketInput[0]!.address.toLowerCase().slice(2)));

  await assert.rejects(queries.signal(id, undefined), { code: "PAYMENT_REQUIRED" });
  await assert.rejects(queries.signal(id, `0x${"ab".repeat(32)}`), { code: "PAYMENT_REQUIRED" });
  const { subscriberKey } = await queries.subscribe(id);
  const signal = await queries.signal(id, subscriberKey);
  assert.equal(signal.signal!.seq, 0);
  assert.deepEqual(signal.signal!.assets.map((a) => a.weightBps).sort(), [1000, 3000, 6000]);
  await queries.subscribe(id);
  await assert.rejects(queries.subscribe(id), { code: "STRATEGY_FULL" });

  // After the embargo the worker reveals it and it joins the public history.
  await relay.runOnce(new Date(NOW.getTime() + 60_000));
  const revealed = await queries.detail(id);
  assert.equal(revealed.revealed, 1);
  assert.equal(revealed.history[0]!.assets.length, 3);
  assert.equal(revealed.broken, false);
});

test("a rejection after the commitment landed is reconciled as committed, not failed", async () => {
  const { create, submit, store, registry } = setup();
  const { id } = await create.execute(await createInput(), NOW);
  // The transaction mines, but this attempt sees a revert (the signed seq is already used).
  registry.commit = async (input) => {
    registry.chain.get(input.strategyId)!.commits.push({ commitment: input.commitment, committedAt: NOW });
    throw new StrategyRegistryRejection("InvalidSignature");
  };
  assert.equal((await submit.execute(id, await commitInput(id, 0), NOW)).status, "committed");
  assert.equal((await store.commits([id]))[0]!.status, "committed");
  assert.deepEqual(store.pushes, [{ strategyId: id, seq: 0 }]);
});

test("reveals catch up when the chain still expects an earlier commitment", async () => {
  const { create, submit, relay, store, registry } = setup();
  const { id } = await create.execute(await createInput(), NOW);
  await submit.execute(id, await commitInput(id, 0), NOW);
  await submit.execute(id, await commitInput(id, 1), NOW);
  // Simulate the earlier bug: seq 0 landed but was recorded as failed.
  store.rows.find((c) => c.seq === 0)!.status = "failed";
  const later = new Date(NOW.getTime() + 61_000);
  await relay.runOnce(later);
  assert.deepEqual(
    (await store.commits([id])).map((c) => [c.seq, c.status]),
    [[0, "revealed"], [1, "committed"]],
  );
  assert.equal(registry.chain.get(id)!.nextRevealSeq, 1);
  await relay.runOnce(later);
  assert.equal((await store.commits([id]))[1]!.status, "revealed");
});

class FakePaywall implements SignalPaywall {
  required = async (input: { priceAtoms: string; error?: string }) => {
    this.offers.push(input);
    if (this.down) throw new Error("facilitator unreachable");
    return { header: `offer:${input.priceAtoms}:${input.error ?? ""}`, body: { x402Version: 2 }, requirements: [input.priceAtoms] };
  };
  settle = async (input: { paymentHeader: string; required: SignalPaymentRequired }) => {
    this.settled.push(input);
    await this.whileSettling?.();
    if (input.paymentHeader === "bad") throw new SignalPaymentRejected("insufficient_funds");
    return { payer: "0xagent", transaction: `0x${"ab".repeat(32)}`, amountAtoms: (input.required.requirements as string[])[0]!, responseHeader: "receipt" };
  };
  offers: { priceAtoms: string; error?: string }[] = [];
  settled: { paymentHeader: string; required: SignalPaymentRequired }[] = [];
  down = false;
  whileSettling?: () => Promise<unknown>;
}

test("agents buy the current signal with x402 and revenue is booked once per settlement", async () => {
  const { create, submit, store, queries } = setup();
  const paywall = new FakePaywall();
  const purchase = new PurchaseSignalUseCase(store, queries, paywall);
  const { id } = await create.execute(await createInput(), NOW);
  const url = "https://api.example/v1/strategies/1/signal";

  // Nothing is sold before the first basket is sealed.
  await assert.rejects(purchase.execute({ strategyId: id, resourceUrl: url }), { code: "STRATEGY_NO_SIGNAL" });
  assert.equal(paywall.offers.length, 0);
  await submit.execute(id, await commitInput(id, 0), NOW);

  const offer = await purchase.execute({ strategyId: id, resourceUrl: url });
  assert.deepEqual(offer, { kind: "payment-required", header: "offer:500000:", body: { x402Version: 2 } });

  const bought = await purchase.execute({ strategyId: id, resourceUrl: url, paymentHeader: "signed" });
  assert.equal(bought.kind, "signal");
  if (bought.kind !== "signal") return;
  assert.equal(bought.paymentResponse, "receipt");
  assert.equal(bought.signal.signal!.salt, SALT);
  assert.equal(bought.signal.signal!.assets.length, 3);
  assert.equal((await queries.detail(id)).earnedAtoms, "500000");

  // The same settlement is never booked twice.
  await purchase.execute({ strategyId: id, resourceUrl: url, paymentHeader: "signed" });
  assert.equal((await queries.detail(id)).earnedAtoms, "500000");

  // A rejected payment gets a fresh offer with the reason, and books nothing.
  const rejected = await purchase.execute({ strategyId: id, resourceUrl: url, paymentHeader: "bad" });
  assert.deepEqual(rejected, { kind: "payment-required", header: "offer:500000:insufficient_funds", body: { x402Version: 2 } });
  assert.equal(store.payments.length, 1);

  paywall.down = true;
  await assert.rejects(purchase.execute({ strategyId: id, resourceUrl: url }), { code: "PAYMENT_UNAVAILABLE", statusCode: 502 });
});

test("subscriber keys bypass payment, free signals need none, and without a payee only keys work", async () => {
  const { create, submit, store, queries } = setup();
  const freeTerms = { ...metadata, signalPriceAtoms: "0" };
  const { id } = await create.execute(await createInput(owner, freeTerms), NOW);
  await submit.execute(id, await commitInput(id, 0), NOW);
  const url = "https://api.example/v1/strategies/1/signal";

  const paywall = new FakePaywall();
  const free = await new PurchaseSignalUseCase(store, queries, paywall).execute({ strategyId: id, resourceUrl: url });
  assert.equal(free.kind, "signal");
  assert.equal(paywall.offers.length, 0);

  // A free signal needs no payee either; a paid one does, or a key.
  assert.equal((await new PurchaseSignalUseCase(store, queries, null).execute({ strategyId: id, resourceUrl: url })).kind, "signal");

  const sold = setup();
  const { id: paid } = await sold.create.execute(await createInput(), NOW);
  await sold.submit.execute(paid, await commitInput(paid, 0), NOW);
  const unpaid = new PurchaseSignalUseCase(sold.store, sold.queries, null);
  await assert.rejects(unpaid.execute({ strategyId: paid, resourceUrl: url }), { code: "PAYMENT_REQUIRED" });
  const { subscriberKey } = await sold.queries.subscribe(paid);
  const keyed = await unpaid.execute({ strategyId: paid, resourceUrl: url, subscriberKey });
  assert.equal(keyed.kind === "signal" && keyed.signal.signal!.seq, 0);
  await assert.rejects(unpaid.execute({ strategyId: 99, resourceUrl: url }), { code: "NOT_FOUND" });

  // An expired or unknown key falls back to the x402 offer instead of a dead end.
  const selling = new PurchaseSignalUseCase(sold.store, sold.queries, paywall);
  const unknown = await selling.execute({ strategyId: paid, resourceUrl: url, subscriberKey: `0x${"99".repeat(32)}` });
  assert.equal(unknown.kind, "payment-required");
  const expired = new StrategyQueries(sold.store, sold.registry, sold.social, () => new Date(NOW.getTime() + 31 * 86_400_000));
  const later = await new PurchaseSignalUseCase(sold.store, expired, paywall).execute({ strategyId: paid, resourceUrl: url, subscriberKey });
  assert.equal(later.kind, "payment-required");
});

test("a settled payment always returns the newest basket, even when the ledger fails", async () => {
  const { create, submit, store, queries } = setup();
  const { id } = await create.execute(await createInput(), NOW);
  await submit.execute(id, await commitInput(id, 0), NOW);
  const url = "https://api.example/v1/strategies/1/signal";
  const paywall = new FakePaywall();
  // The owner seals seq 1 while the facilitator is settling the agent's payment.
  paywall.whileSettling = async () => submit.execute(id, await commitInput(id, 1), NOW);
  store.recordPayment = async () => {
    throw new Error("connection reset");
  };
  const logged: unknown[] = [];
  const purchase = new PurchaseSignalUseCase(store, queries, paywall, (event) => logged.push(event));
  const bought = await purchase.execute({ strategyId: id, resourceUrl: url, paymentHeader: "signed" });
  assert.equal(bought.kind, "signal");
  if (bought.kind !== "signal") return;
  assert.equal(bought.paymentResponse, "receipt");
  assert.equal(bought.signal.signal!.seq, 1);
  assert.deepEqual(logged, [
    { code: "STRATEGY_PAYMENT_NOT_BOOKED", strategyId: id, amountAtoms: "500000", transaction: `0x${"ab".repeat(32)}` },
  ]);
});
