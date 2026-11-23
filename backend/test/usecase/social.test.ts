import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";
import { ownerLinkTypes, signInTypes, socialDomain, socialNickname } from "../../src/domain/social.ts";
import { registryDomain, updatePriceTypes } from "../../src/domain/strategy.ts";
import type { SignalPaywall } from "../../src/ports/strategies.port.ts";
import { PurchaseSignalUseCase } from "../../src/usecase/strategies/purchase-signal.usecase.ts";
import {
  NOW,
  NOW_S,
  REGISTRY,
  commitInput,
  createInput,
  mnemonic,
  owner,
  setup,
  stranger,
} from "../fixtures/strategies.ts";

type Setup = ReturnType<typeof setup>;
const socialKey = (index = 0) => mnemonicToAccount(mnemonic, { path: `m/44'/60'/147'/84532'/${index}` });
const DAY_MS = 86_400_000;

async function signedSignIn(t: Setup, account: HDAccount, link?: { strategyId: number; key: HDAccount }) {
  const { nonce, issuedAt } = await t.sessions.challenge();
  const signature = await account.signTypedData({
    domain: socialDomain(84532),
    types: signInTypes,
    primaryType: "SignIn",
    message: { account: account.address, nonce, issuedAt: BigInt(issuedAt) },
  });
  const ownerLink = link && {
    strategyId: link.strategyId,
    signature: await link.key.signTypedData({
      domain: socialDomain(84532),
      types: ownerLinkTypes,
      primaryType: "OwnerLink",
      message: { account: account.address, strategyId: BigInt(link.strategyId), nonce },
    }),
  };
  return { account: account.address, nonce, issuedAt, signature, ...(ownerLink ? { ownerLink } : {}) };
}

async function sessionFor(t: Setup, account = socialKey(), link?: { strategyId: number; key: HDAccount }) {
  const result = await t.sessions.signIn(await signedSignIn(t, account, link));
  return { ...result, session: (await t.sessions.authenticate(result.token))! };
}

/** A strategy with seq 0 revealed and seq 1 sealed. */
async function revealedStrategy(t: Setup) {
  const { id } = await t.create.execute(await createInput(), NOW);
  await t.submit.execute(id, await commitInput(id, 0), NOW);
  await t.relay.runOnce(new Date(NOW.getTime() + 60_000));
  await t.submit.execute(id, await commitInput(id, 1), NOW);
  return id;
}

async function priceInput(
  strategyId: number,
  version: number,
  monthlyPriceAtoms: string,
  signalPriceAtoms: string,
  options: { key?: HDAccount; deadline?: number } = {},
) {
  const deadline = options.deadline ?? NOW_S + 600;
  const signature = await (options.key ?? owner).signTypedData({
    domain: registryDomain(84532, REGISTRY),
    types: updatePriceTypes,
    primaryType: "UpdatePrice",
    message: {
      strategyId: BigInt(strategyId),
      version: BigInt(version),
      monthlyPriceAtoms: BigInt(monthlyPriceAtoms),
      signalPriceAtoms: BigInt(signalPriceAtoms),
      deadline: BigInt(deadline),
    },
  });
  return { version, monthlyPriceAtoms, signalPriceAtoms, deadline, signature };
}

test("sign-in verifies the social key, consumes the nonce once and stores only the token hash", async () => {
  const t = setup();
  const account = socialKey();
  const input = await signedSignIn(t, account);

  await assert.rejects(t.sessions.signIn({ ...input, account: socialKey(1).address }), { code: "SOCIAL_SIGNATURE_INVALID" });
  await assert.rejects(t.sessions.signIn({ ...input, issuedAt: input.issuedAt + 1 }), { code: "SOCIAL_SIGNATURE_INVALID" });
  // A wrong signature leaves the challenge usable.
  const result = await t.sessions.signIn(input);
  assert.match(result.token, /^0x[0-9a-f]{64}$/);
  assert.equal(result.name, socialNickname(account.address));
  assert.equal(result.ownerOf, null);
  assert.equal(result.expiresAt, new Date(NOW.getTime() + 30 * DAY_MS).toISOString());

  await assert.rejects(t.sessions.signIn(input), { code: "SOCIAL_CHALLENGE_INVALID" }, "a nonce is single use");
  const stored = [...t.social.sessions.keys()];
  assert.deepEqual(stored, [`0x${createHash("sha256").update(result.token).digest("hex")}`]);
  assert.ok(!JSON.stringify([...t.social.sessions]).includes(result.token.slice(2)));

  const session = await t.sessions.authenticate(result.token);
  assert.equal(session!.account, account.address);
  assert.equal(await t.sessions.authenticate(`0x${"00".repeat(32)}`), null);
  assert.equal(await t.sessions.authenticate("garbage"), null);
  t.clock.now = new Date(NOW.getTime() + 30 * DAY_MS + 1);
  assert.equal(await t.sessions.authenticate(result.token), null, "sessions last 30 days");
});

test("a challenge expires after five minutes and unknown nonces are refused", async () => {
  const t = setup();
  const input = await signedSignIn(t, socialKey());
  t.clock.now = new Date(NOW.getTime() + 5 * 60_000);
  await assert.rejects(t.sessions.signIn(input), { code: "SOCIAL_CHALLENGE_INVALID" });

  t.clock.now = NOW;
  const forged = await signedSignIn(t, socialKey());
  const other = `0x${"11".repeat(32)}` as const;
  const signature = await socialKey().signTypedData({
    domain: socialDomain(84532),
    types: signInTypes,
    primaryType: "SignIn",
    message: { account: socialKey().address, nonce: other, issuedAt: BigInt(forged.issuedAt) },
  });
  await assert.rejects(t.sessions.signIn({ ...forged, nonce: other, signature }), { code: "SOCIAL_CHALLENGE_INVALID" });
});

test("an owner link must be signed by the strategy's registered key", async () => {
  const t = setup();
  const { id } = await t.create.execute(await createInput(), NOW);
  const account = socialKey();

  await assert.rejects(
    t.sessions.signIn(await signedSignIn(t, account, { strategyId: id, key: stranger })),
    { code: "SOCIAL_OWNER_LINK_INVALID" },
  );
  await assert.rejects(
    t.sessions.signIn(await signedSignIn(t, account, { strategyId: 99, key: owner })),
    { code: "SOCIAL_OWNER_LINK_INVALID" },
  );
  const linked = await t.sessions.signIn(await signedSignIn(t, account, { strategyId: id, key: owner }));
  assert.equal(linked.ownerOf, id);
  assert.equal((await t.sessions.authenticate(linked.token))!.ownerOf, id);
});

test("likes target the strategy or a revealed update, idempotently", async () => {
  const t = setup();
  const id = await revealedStrategy(t);
  const alice = (await sessionFor(t, socialKey(0))).session;
  const bob = (await sessionFor(t, socialKey(1))).session;

  assert.deepEqual(await t.socialUse.like(alice, id, undefined, true), { liked: true, count: 1 });
  assert.deepEqual(await t.socialUse.like(alice, id, undefined, true), { liked: true, count: 1 });
  assert.deepEqual(await t.socialUse.like(bob, id, undefined, true), { liked: true, count: 2 });
  assert.deepEqual(await t.socialUse.like(alice, id, 0, true), { liked: true, count: 1 });
  await assert.rejects(t.socialUse.like(alice, id, 1, true), { code: "NOT_FOUND" }, "a sealed update cannot be liked");
  await assert.rejects(t.socialUse.like(alice, id, 7, true), { code: "NOT_FOUND" });
  await assert.rejects(t.socialUse.like(alice, 99, undefined, true), { code: "NOT_FOUND" });

  const [card] = await t.queries.list(undefined, alice.account);
  assert.deepEqual(card!.social, { likes: 2, comments: 0 });
  assert.equal(card!.liked, true);
  assert.equal((await t.queries.list())[0]!.liked, false, "no session, no liked flag");
  const detail = await t.queries.detail(id, alice.account);
  assert.deepEqual(detail.history.map((h) => [h.seq, h.likes, h.liked]), [[0, 1, true]]);

  assert.deepEqual(await t.socialUse.like(alice, id, undefined, false), { liked: false, count: 1 });
  assert.deepEqual(await t.socialUse.like(alice, id, undefined, false), { liked: false, count: 1 });
  assert.equal((await t.queries.detail(id, alice.account)).liked, false);
});

test("comments show nicknames or the owner, never accounts, with one level of replies", async () => {
  const t = setup();
  const id = await revealedStrategy(t);
  const fan = await sessionFor(t, socialKey(0));
  const ownerSession = (await sessionFor(t, socialKey(1), { strategyId: id, key: owner })).session;

  const top = await t.socialUse.post(fan.session, id, { body: "  Love the chips tilt  " });
  assert.equal(top.body, "Love the chips tilt");
  assert.equal(top.authorName, fan.name);
  assert.equal(top.owner, false);
  assert.equal(top.mine, true);
  const reply = await t.socialUse.post(ownerSession, id, { body: "Thanks!", parentId: top.id });
  assert.equal(reply.authorName, "AI chips");
  assert.equal(reply.owner, true);
  await assert.rejects(t.socialUse.post(fan.session, id, { body: "deeper", parentId: reply.id }), { code: "COMMENT_PARENT_INVALID" });
  await assert.rejects(t.socialUse.post(fan.session, id, { body: "other thread", seq: 0, parentId: top.id }), { code: "COMMENT_PARENT_INVALID" });
  await assert.rejects(t.socialUse.post(fan.session, id, { body: "sealed", seq: 1 }), { code: "NOT_FOUND" });
  await assert.rejects(t.socialUse.post(fan.session, id, { body: "   " }), { code: "COMMENT_INVALID" });
  await assert.rejects(t.socialUse.post(fan.session, id, { body: "x".repeat(501) }), { code: "COMMENT_INVALID" });
  const onUpdate = await t.socialUse.post(fan.session, id, { body: "Nice reveal", seq: 0 });
  assert.equal(onUpdate.seq, 0);

  const wall = await t.socialUse.comments(id, { limit: 20 }, ownerSession);
  assert.equal(wall.list.length, 1);
  assert.equal(wall.list[0]!.mine, false);
  assert.deepEqual(wall.list[0]!.replies.map((r) => [r.body, r.owner, r.mine, r.replies.length]), [["Thanks!", true, true, 0]]);
  const anonymous = await t.socialUse.comments(id, { limit: 20 }, null);
  assert.equal(anonymous.list[0]!.mine, false);
  for (const page of [wall, anonymous])
    for (const key of [socialKey(0), socialKey(1)])
      assert.ok(!JSON.stringify(page).toLowerCase().includes(key.address.slice(2).toLowerCase()));
  assert.deepEqual((await t.socialUse.comments(id, { seq: 0, limit: 20 }, null)).list.map((c) => c.body), ["Nice reveal"]);

  const detail = await t.queries.detail(id);
  assert.deepEqual(detail.social, { likes: 0, comments: 2 });
  assert.deepEqual(detail.history.map((h) => [h.seq, h.comments]), [[0, 1]]);
});

test("comment pages run newest first with an opaque cursor", async () => {
  const t = setup();
  const id = await revealedStrategy(t);
  for (let i = 0; i < 5; i++) {
    const { session } = await sessionFor(t, socialKey(i));
    await t.socialUse.post(session, id, { body: `comment ${i}` });
  }
  const first = await t.socialUse.comments(id, { limit: 2 }, null);
  assert.deepEqual(first.list.map((c) => c.body), ["comment 4", "comment 3"]);
  const second = await t.socialUse.comments(id, { limit: 2, cursor: first.next! }, null);
  assert.deepEqual(second.list.map((c) => c.body), ["comment 2", "comment 1"]);
  const last = await t.socialUse.comments(id, { limit: 2, cursor: second.next! }, null);
  assert.deepEqual(last.list.map((c) => c.body), ["comment 0"]);
  assert.equal(last.next, null);
  await assert.rejects(t.socialUse.comments(id, { limit: 2, cursor: "not-a-cursor" }, null), { code: "CURSOR_INVALID" });
});

test("authors delete, three reporters hide, owners hide; hidden comments disappear", async () => {
  const t = setup();
  const id = await revealedStrategy(t);
  const author = (await sessionFor(t, socialKey(0))).session;
  const reporters = await Promise.all([1, 2, 3].map(async (i) => (await sessionFor(t, socialKey(i))).session));
  const ownerSession = (await sessionFor(t, socialKey(9), { strategyId: id, key: owner })).session;
  const plainOwnerKey = (await sessionFor(t, socialKey(8))).session;

  const doomed = await t.socialUse.post(author, id, { body: "delete me" });
  await assert.rejects(t.socialUse.remove(reporters[0]!, doomed.id), { code: "SOCIAL_FORBIDDEN", statusCode: 403 });
  await t.socialUse.remove(author, doomed.id);
  await t.socialUse.remove(author, doomed.id);
  await assert.rejects(t.socialUse.remove(author, 999), { code: "NOT_FOUND" });

  const reported = await t.socialUse.post(author, id, { body: "spam" });
  await t.socialUse.report(reporters[0]!, reported.id, "spam");
  await t.socialUse.report(reporters[0]!, reported.id, "again");
  await t.socialUse.report(reporters[1]!, reported.id, undefined);
  assert.equal((await t.socialUse.comments(id, { limit: 20 }, null)).list.length, 1, "two reporters are not enough");
  await t.socialUse.report(reporters[2]!, reported.id, undefined);

  const rude = await t.socialUse.post(author, id, { body: "rude" });
  await assert.rejects(t.socialUse.hide(plainOwnerKey, rude.id), { code: "SOCIAL_FORBIDDEN" });
  await t.socialUse.hide(ownerSession, rude.id);
  await assert.rejects(t.socialUse.report(reporters[0]!, doomed.id, undefined), { code: "NOT_FOUND" });

  assert.deepEqual((await t.socialUse.comments(id, { limit: 20 }, null)).list, []);
  assert.deepEqual((await t.queries.detail(id)).social, { likes: 0, comments: 0 });
});

test("each account may post five comments a minute and a hundred a day", async () => {
  const t = setup();
  const id = await revealedStrategy(t);
  const { session } = await sessionFor(t, socialKey());
  const other = (await sessionFor(t, socialKey(1))).session;
  for (let i = 0; i < 5; i++) await t.socialUse.post(session, id, { body: `burst ${i}` });
  await assert.rejects(t.socialUse.post(session, id, { body: "sixth" }), { code: "SOCIAL_RATE_LIMITED", statusCode: 429 });
  await t.socialUse.post(other, id, { body: "someone else" });
  // Deleting does not refund the limit.
  await t.socialUse.remove(session, 1);
  await assert.rejects(t.socialUse.post(session, id, { body: "sixth" }), { code: "SOCIAL_RATE_LIMITED" });

  let posted = 5;
  for (let minute = 1; posted < 100; minute++) {
    t.clock.now = new Date(NOW.getTime() + minute * 61_000);
    for (let i = 0; i < 5 && posted < 100; i++, posted++) await t.socialUse.post(session, id, { body: `post ${posted}` });
  }
  t.clock.now = new Date(t.clock.now.getTime() + 61_000);
  await assert.rejects(t.socialUse.post(session, id, { body: "101st" }), { code: "SOCIAL_RATE_LIMITED" });
  t.clock.now = new Date(NOW.getTime() + DAY_MS + 1);
  await t.socialUse.post(session, id, { body: "next day" });
});

test("cards carry social counts, the newest revealed basket and the price schedule", async () => {
  const t = setup();
  const { id } = await t.create.execute(await createInput(), NOW);
  let [card] = await t.queries.list();
  assert.deepEqual(card!.latestAssets, []);
  assert.equal(card!.priceVersion, 0);
  assert.equal(card!.priceChangeAllowedAt, null);
  assert.deepEqual((await t.queries.detail(id)).priceHistory, [
    { version: 0, monthlyPriceAtoms: "10000000", signalPriceAtoms: "500000", at: NOW.toISOString() },
  ]);

  await t.submit.execute(id, await commitInput(id, 0), NOW);
  assert.deepEqual((await t.queries.list())[0]!.latestAssets, [], "a sealed basket stays hidden");
  await t.relay.runOnce(new Date(NOW.getTime() + 60_000));
  [card] = await t.queries.list();
  assert.equal(card!.latestAssets.length, 3);
  assert.deepEqual(card!.latestAssets, (await t.queries.detail(id)).history[0]!.assets);
});

test("the feed lists seals without weights, reveals with the previous basket, and price changes", async () => {
  const t = setup();
  const id = await revealedStrategy(t);
  const { session } = await sessionFor(t, socialKey());
  await t.socialUse.like(session, id, 0, true);
  await t.prices.execute(id, await priceInput(id, 1, "20000000", "750000"), new Date(NOW.getTime() + 120_000));

  const feed = await t.queries.feed({ limit: 20 }, session.account);
  // The fake registry stamps every commit and reveal with NOW; equal times order reveals before seals.
  assert.deepEqual(feed.list.map((e) => [e.kind, "seq" in e ? e.seq : e.version]), [["price", 1], ["revealed", 0], ["sealed", 1], ["sealed", 0]]);
  const sealed = feed.list.filter((e) => e.kind === "sealed");
  for (const event of sealed) assert.deepEqual(Object.keys(event).sort(), ["at", "kind", "seq", "strategyId", "strategyName"]);
  const revealed = feed.list.find((e) => e.kind === "revealed")!;
  assert.ok(revealed.kind === "revealed");
  assert.equal(revealed.assets.length, 3);
  assert.equal(revealed.previousAssets, null);
  assert.equal(revealed.likes, 1);
  assert.equal(revealed.liked, true);
  const price = feed.list[0]!;
  assert.ok(price.kind === "price");
  assert.deepEqual(
    { version: price.version, monthly: price.monthlyPriceAtoms, signal: price.signalPriceAtoms, previous: price.previous },
    { version: 1, monthly: "20000000", signal: "750000", previous: { monthlyPriceAtoms: "10000000", signalPriceAtoms: "500000" } },
  );
  const anonymous = (await t.queries.feed({ limit: 20 }, null)).list.find((e) => e.kind === "revealed");
  assert.equal(anonymous?.kind === "revealed" && anonymous.liked, false);

  // Pages walk the same order without gaps or repeats.
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await t.queries.feed({ limit: 1, ...(cursor ? { cursor } : {}) });
    seen.push(...page.list.map((e) => e.kind));
    cursor = page.next ?? undefined;
  } while (cursor);
  assert.deepEqual(seen, ["price", "revealed", "sealed", "sealed"]);

  assert.deepEqual((await t.queries.feed({ strategyIds: [99], limit: 20 })).list, []);
  assert.equal((await t.queries.feed({ strategyIds: [id], limit: 20 })).list.length, 4);
  await assert.rejects(t.queries.feed({ limit: 20, cursor: "bm9wZQ" }), { code: "CURSOR_INVALID" });
});

test("a signed price change applies at the next version, at most once a week", async () => {
  const t = setup();
  const { id } = await t.create.execute(await createInput(), NOW);
  const at = (ms: number) => new Date(NOW.getTime() + ms);

  await assert.rejects(t.prices.execute(id, await priceInput(id, 1, "20000000", "750000", { key: stranger }), NOW), { code: "STRATEGY_SIGNATURE_INVALID" });
  await assert.rejects(t.prices.execute(id, await priceInput(id, 2, "20000000", "750000"), NOW), { code: "STRATEGY_PRICE_VERSION_STALE" });
  await assert.rejects(t.prices.execute(id, await priceInput(id, 1, "10000000", "500000"), NOW), { code: "STRATEGY_PRICE_UNCHANGED" });
  await assert.rejects(
    t.prices.execute(id, await priceInput(id, 1, "20000000", "750000", { deadline: NOW_S - 1 }), NOW),
    { code: "STRATEGY_SIGNATURE_EXPIRED" },
  );
  await assert.rejects(
    t.prices.execute(id, await priceInput(id, 1, "20000000", "750000", { deadline: NOW_S + 7200 }), NOW),
    { code: "STRATEGY_DEADLINE_TOO_FAR" },
  );
  await assert.rejects(t.prices.execute(99, await priceInput(99, 1, "1", "1"), NOW), { code: "NOT_FOUND" });
  // A signature for one strategy does not move another's price.
  const other = await priceInput(id + 1, 1, "20000000", "750000");
  await assert.rejects(t.prices.execute(id, other, NOW), { code: "STRATEGY_SIGNATURE_INVALID" });

  // The first change may come right after creation: the week counts from the previous change.
  await t.prices.execute(id, await priceInput(id, 1, "20000000", "750000"), NOW);
  assert.deepEqual(t.store.pushes, [{ strategyId: id, seq: -1 }], "followers get the neutral notification");
  let detail = await t.queries.detail(id);
  assert.equal(detail.monthlyPriceAtoms, "20000000");
  assert.equal(detail.signalPriceAtoms, "750000");
  assert.equal(detail.priceVersion, 1);
  assert.equal(detail.priceChangeAllowedAt, at(7 * DAY_MS).toISOString());
  assert.deepEqual(detail.priceHistory.map((p) => [p.version, p.monthlyPriceAtoms, p.at]), [
    [0, "10000000", NOW.toISOString()],
    [1, "20000000", NOW.toISOString()],
  ]);
  assert.equal(t.store.strategies[0]!.metadata.monthlyPriceAtoms, "10000000", "creation terms stay untouched");

  // The same signature cannot be replayed: its version is spent.
  await assert.rejects(t.prices.execute(id, await priceInput(id, 1, "20000000", "750000"), at(60_000)), { code: "STRATEGY_PRICE_VERSION_STALE" });
  const soon = t.prices.execute(id, await priceInput(id, 2, "5000000", "0", { deadline: NOW_S + 6 * DAY_MS / 1000 + 600 }), at(6 * DAY_MS));
  await assert.rejects(soon, (error: Error & { code?: string; statusCode?: number }) => {
    assert.equal(error.code, "PRICE_CHANGE_TOO_SOON");
    assert.equal(error.statusCode, 409);
    assert.ok(error.message.includes(at(7 * DAY_MS).toISOString()));
    return true;
  });
  t.clock.now = at(7 * DAY_MS);
  await t.prices.execute(id, await priceInput(id, 2, "5000000", "0", { deadline: NOW_S + 7 * 86_400 + 600 }), at(7 * DAY_MS));
  detail = await t.queries.detail(id);
  assert.equal(detail.priceVersion, 2);
  assert.equal(detail.priceChangeAllowedAt, at(14 * DAY_MS).toISOString());
});

test("agent signal purchases charge the current price", async () => {
  const t = setup();
  const { id } = await t.create.execute(await createInput(), NOW);
  await t.submit.execute(id, await commitInput(id, 0), NOW);
  const offers: string[] = [];
  const paywall: SignalPaywall = {
    required: async (input) => {
      offers.push(input.priceAtoms);
      return { header: "offer", body: {}, requirements: null };
    },
    settle: async () => { throw new Error("not used"); },
  };
  const purchase = new PurchaseSignalUseCase(t.store, t.queries, paywall);
  await purchase.execute({ strategyId: id, resourceUrl: "https://api.example/signal" });
  await t.prices.execute(id, await priceInput(id, 1, "10000000", "900000"), NOW);
  await purchase.execute({ strategyId: id, resourceUrl: "https://api.example/signal" });
  assert.deepEqual(offers, ["500000", "900000"]);
  // A change to a free signal serves it without payment.
  await t.prices.execute(id, await priceInput(id, 2, "10000000", "0", { deadline: NOW_S + 7 * 86_400 + 600 }), new Date(NOW.getTime() + 7 * DAY_MS));
  assert.equal((await purchase.execute({ strategyId: id, resourceUrl: "https://api.example/signal" })).kind, "signal");
});
