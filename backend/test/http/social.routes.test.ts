import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";
import { ownerLinkTypes, signInTypes, socialDomain } from "../../src/domain/social.ts";
import { registryDomain, updatePriceTypes } from "../../src/domain/strategy.ts";
import { mapRequestError } from "../../src/http/map-request-error.ts";
import { privateHttpOptions, registerPrivateHttp } from "../../src/http/private-http.ts";
import { registerSocialRoutes } from "../../src/http/routes/social.routes.ts";
import { registerStrategyRoutes } from "../../src/http/routes/strategies.routes.ts";
import { PurchaseSignalUseCase } from "../../src/usecase/strategies/purchase-signal.usecase.ts";
import { NOW, REGISTRY, commitInput, createInput, mnemonic, owner, setup, stranger } from "../fixtures/strategies.ts";

const socialKey = (index = 0) => mnemonicToAccount(mnemonic, { path: `m/44'/60'/147'/84532'/${index}` });

/** The real use cases over in-memory stores, so signatures are verified end to end. */
async function build() {
  const t = setup();
  const app = Fastify(privateHttpOptions);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerPrivateHttp(app);
  registerStrategyRoutes(app, {
    create: t.create,
    submit: t.submit,
    queries: t.queries,
    purchase: new PurchaseSignalUseCase(t.store, t.queries, null),
    prices: t.prices,
    sessions: t.sessions,
  });
  registerSocialRoutes(app, { sessions: t.sessions, social: t.socialUse, queries: t.queries });
  app.setErrorHandler(mapRequestError);
  // Strategy 1 with seq 0 revealed and seq 1 sealed.
  const { id } = await t.create.execute(await createInput(), NOW);
  await t.submit.execute(id, await commitInput(id, 0), NOW);
  await t.relay.runOnce(new Date(NOW.getTime() + 60_000));
  await t.submit.execute(id, await commitInput(id, 1), NOW);
  return { app, t, id };
}

async function signIn(app: Awaited<ReturnType<typeof build>>["app"], account: HDAccount, link?: { strategyId: number; key: HDAccount }) {
  const challenge = await app.inject({ method: "POST", url: "/v1/social/challenge" });
  assert.equal(challenge.statusCode, 201);
  const { nonce, issuedAt } = challenge.json() as { nonce: `0x${string}`; issuedAt: number };
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

async function tokenFor(app: Awaited<ReturnType<typeof build>>["app"], account: HDAccount, link?: { strategyId: number; key: HDAccount }) {
  const response = await app.inject({ method: "POST", url: "/v1/social/sessions", payload: await signIn(app, account, link) });
  assert.equal(response.statusCode, 201);
  return { authorization: `Bearer ${response.json().token}` };
}

test("social sign-in issues a session for a signed challenge, once, without caching", async () => {
  const { app, id } = await build();
  const challenge = await app.inject({ method: "POST", url: "/v1/social/challenge" });
  assert.equal(challenge.headers["cache-control"], "no-store");
  assert.match(challenge.json().nonce, /^0x[0-9a-f]{64}$/);
  assert.equal(typeof challenge.json().issuedAt, "number");

  const body = await signIn(app, socialKey());
  const wrong = await app.inject({ method: "POST", url: "/v1/social/sessions", payload: { ...body, account: socialKey(1).address } });
  assert.equal(wrong.statusCode, 400);
  assert.equal(wrong.json().code, "SOCIAL_SIGNATURE_INVALID");

  const session = await app.inject({ method: "POST", url: "/v1/social/sessions", payload: body });
  assert.equal(session.statusCode, 201);
  assert.equal(session.headers["cache-control"], "no-store");
  const json = session.json();
  assert.deepEqual(Object.keys(json).sort(), ["expiresAt", "name", "ownerOf", "token"]);
  assert.match(json.token, /^0x[0-9a-f]{64}$/);
  assert.match(json.name, / #[0-9a-f]{4}$/);
  assert.equal(json.ownerOf, null);

  const reused = await app.inject({ method: "POST", url: "/v1/social/sessions", payload: body });
  assert.equal(reused.statusCode, 400);
  assert.equal(reused.json().code, "SOCIAL_CHALLENGE_INVALID");

  const badLink = await app.inject({
    method: "POST",
    url: "/v1/social/sessions",
    payload: await signIn(app, socialKey(), { strategyId: id, key: stranger }),
  });
  assert.equal(badLink.statusCode, 400);
  assert.equal(badLink.json().code, "SOCIAL_OWNER_LINK_INVALID");
  const linked = await app.inject({
    method: "POST",
    url: "/v1/social/sessions",
    payload: await signIn(app, socialKey(), { strategyId: id, key: owner }),
  });
  assert.equal(linked.json().ownerOf, id);

  for (const payload of [{ ...body, extra: 1 }, { ...body, nonce: "0x12" }, { ...body, signature: "0x00" }])
    assert.equal((await app.inject({ method: "POST", url: "/v1/social/sessions", payload })).statusCode, 400);
  await app.close();
});

test("likes and comments need a session; reads take one optionally", async () => {
  const { app, id } = await build();
  const fan = await tokenFor(app, socialKey(0));
  const other = await tokenFor(app, socialKey(1));
  const ownerAuth = await tokenFor(app, socialKey(2), { strategyId: id, key: owner });

  const anonymous = await app.inject({ method: "PUT", url: `/v1/strategies/${id}/likes`, payload: {} });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().code, "SOCIAL_AUTH_REQUIRED");
  const expired = await app.inject({ method: "PUT", url: `/v1/strategies/${id}/likes`, headers: { authorization: `Bearer 0x${"ab".repeat(32)}` } });
  assert.equal(expired.statusCode, 401);

  const like = await app.inject({ method: "PUT", url: `/v1/strategies/${id}/likes`, headers: fan });
  assert.deepEqual(like.json(), { liked: true, count: 1 });
  assert.deepEqual((await app.inject({ method: "PUT", url: `/v1/strategies/${id}/likes`, headers: fan, payload: { seq: 0 } })).json(), { liked: true, count: 1 });
  assert.equal((await app.inject({ method: "PUT", url: `/v1/strategies/${id}/likes`, headers: fan, payload: { seq: 1 } })).statusCode, 404);
  assert.equal((await app.inject({ method: "PUT", url: "/v1/strategies/9/likes", headers: fan })).statusCode, 404);

  const card = (await app.inject({ url: "/v1/strategies", headers: fan })).json().list[0];
  assert.equal(card.liked, true);
  assert.deepEqual(card.social, { likes: 1, comments: 0 });
  assert.equal((await app.inject("/v1/strategies")).json().list[0].liked, false);
  const listed = await app.inject({ url: "/v1/strategies", headers: { authorization: "Bearer junk" } });
  assert.equal(listed.statusCode, 200, "a bad token on a read reads as signed out");
  assert.equal(listed.headers.vary, "Authorization");
  const detail = (await app.inject({ url: `/v1/strategies/${id}`, headers: fan })).json();
  assert.deepEqual(detail.history.map((h: { seq: number; likes: number; liked: boolean }) => [h.seq, h.likes, h.liked]), [[0, 1, true]]);
  assert.equal(detail.latestAssets.length, 3);
  assert.equal(detail.priceVersion, 0);
  assert.equal(detail.priceChangeAllowedAt, null);

  assert.deepEqual((await app.inject({ method: "DELETE", url: `/v1/strategies/${id}/likes?seq=0`, headers: fan })).json(), { liked: false, count: 0 });
  assert.deepEqual((await app.inject({ method: "DELETE", url: `/v1/strategies/${id}/likes`, headers: fan })).json(), { liked: false, count: 0 });

  const posted = await app.inject({ method: "POST", url: `/v1/strategies/${id}/comments`, headers: fan, payload: { body: " hello " } });
  assert.equal(posted.statusCode, 201);
  const comment = posted.json();
  assert.deepEqual(Object.keys(comment).sort(), ["authorName", "body", "createdAt", "id", "mine", "owner", "parentId", "replies", "seq"]);
  assert.equal(comment.body, "hello");
  const reply = await app.inject({ method: "POST", url: `/v1/strategies/${id}/comments`, headers: ownerAuth, payload: { body: "welcome", parentId: comment.id } });
  assert.equal(reply.json().authorName, "AI chips");
  for (const payload of [{ body: "" }, { body: "   " }, { body: "x".repeat(501) }, { body: "hi", extra: true }])
    assert.equal((await app.inject({ method: "POST", url: `/v1/strategies/${id}/comments`, headers: fan, payload })).statusCode, 400);

  const page = await app.inject({ url: `/v1/strategies/${id}/comments`, headers: other });
  assert.equal(page.statusCode, 200);
  assert.equal(page.json().list[0].mine, false);
  assert.equal(page.json().list[0].replies[0].owner, true);
  assert.equal(page.json().next, null);
  for (const key of [socialKey(0), socialKey(1), socialKey(2)])
    assert.ok(!page.body.toLowerCase().includes(key.address.slice(2).toLowerCase()));
  assert.equal((await app.inject(`/v1/strategies/${id}/comments?seq=1`)).statusCode, 404);
  assert.equal((await app.inject(`/v1/strategies/${id}/comments?limit=51`)).statusCode, 400);

  assert.equal((await app.inject({ method: "DELETE", url: `/v1/comments/${comment.id}`, headers: other })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: `/v1/comments/${reply.json().id}/hide`, headers: other })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: `/v1/comments/${reply.json().id}/report`, headers: other, payload: { reason: "x".repeat(201) } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: `/v1/comments/${reply.json().id}/report`, headers: other, payload: { reason: "off topic" } })).statusCode, 204);
  assert.equal((await app.inject({ method: "POST", url: `/v1/comments/${reply.json().id}/report`, headers: other })).statusCode, 204);
  assert.equal((await app.inject({ method: "POST", url: `/v1/comments/${comment.id}/hide`, headers: ownerAuth })).statusCode, 204);
  assert.equal((await app.inject({ method: "DELETE", url: `/v1/comments/${comment.id}`, headers: fan })).statusCode, 204);
  assert.deepEqual((await app.inject(`/v1/strategies/${id}/comments`)).json(), { list: [], next: null });
  await app.close();
});

test("a sixth comment within a minute is refused with SOCIAL_RATE_LIMITED", async () => {
  const { app, id } = await build();
  const fan = await tokenFor(app, socialKey(0));
  for (let i = 0; i < 5; i++)
    assert.equal((await app.inject({ method: "POST", url: `/v1/strategies/${id}/comments`, headers: fan, payload: { body: `c${i}` } })).statusCode, 201);
  const limited = await app.inject({ method: "POST", url: `/v1/strategies/${id}/comments`, headers: fan, payload: { body: "c5", seq: 0 } });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().code, "SOCIAL_RATE_LIMITED");
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  await app.close();
});

test("the feed pages newest first and keeps sealed events free of weights", async () => {
  const { app, id } = await build();
  const all = await app.inject("/v1/feed");
  assert.equal(all.statusCode, 200);
  const events = all.json().list as { kind: string; assets?: unknown }[];
  assert.deepEqual(events.map((e) => e.kind), ["revealed", "sealed", "sealed"]);
  for (const event of events.filter((e) => e.kind === "sealed")) assert.equal(event.assets, undefined);
  const first = (await app.inject(`/v1/feed?strategies=${id}&limit=2`)).json();
  assert.equal(first.list.length, 2);
  const rest = (await app.inject(`/v1/feed?strategies=${id}&limit=2&cursor=${first.next}`)).json();
  assert.deepEqual(rest, { list: [events[2]], next: null });
  assert.deepEqual((await app.inject("/v1/feed?strategies=2")).json(), { list: [], next: null });
  for (const query of ["limit=0", "limit=51", "strategies=abc", "strategies=0"])
    assert.equal((await app.inject(`/v1/feed?${query}`)).statusCode, 400);
  const badCursor = await app.inject("/v1/feed?cursor=xyz");
  assert.equal(badCursor.statusCode, 400);
  assert.equal(badCursor.json().code, "CURSOR_INVALID");
  await app.close();
});

test("a signed price change returns the updated detail; a second within a week answers 409", async () => {
  const { app, id } = await build();
  // The route reads the real clock.
  const deadline = () => Math.floor(Date.now() / 1000) + 600;
  const body = async (version: number, monthly: string, signal: string, key: HDAccount = owner) => {
    const d = deadline();
    const signature = await key.signTypedData({
      domain: registryDomain(84532, REGISTRY),
      types: updatePriceTypes,
      primaryType: "UpdatePrice",
      message: { strategyId: BigInt(id), version: BigInt(version), monthlyPriceAtoms: BigInt(monthly), signalPriceAtoms: BigInt(signal), deadline: BigInt(d) },
    });
    return { version, monthlyPriceAtoms: monthly, signalPriceAtoms: signal, deadline: d, signature };
  };
  const post = async (payload: unknown) => app.inject({ method: "POST", url: `/v1/strategies/${id}/prices`, payload: payload as object });

  const wrongKey = await post(await body(1, "20000000", "750000", stranger));
  assert.equal(wrongKey.statusCode, 400);
  assert.equal(wrongKey.json().code, "STRATEGY_SIGNATURE_INVALID");
  assert.equal((await post(await body(2, "20000000", "750000"))).json().code, "STRATEGY_PRICE_VERSION_STALE");
  for (const payload of [
    { ...(await body(1, "20000000", "750000")), monthlyPriceAtoms: "01" },
    { ...(await body(1, "20000000", "750000")), signalPriceAtoms: "1000000000000" },
    { ...(await body(1, "20000000", "750000")), extra: true },
  ])
    assert.equal((await post(payload)).statusCode, 400);

  const changed = await post(await body(1, "20000000", "750000"));
  assert.equal(changed.statusCode, 201);
  const detail = changed.json();
  assert.equal(detail.monthlyPriceAtoms, "20000000");
  assert.equal(detail.signalPriceAtoms, "750000");
  assert.equal(detail.priceVersion, 1);
  assert.deepEqual(detail.priceHistory.map((p: { version: number }) => p.version), [0, 1]);
  assert.ok(detail.priceChangeAllowedAt);

  const tooSoon = await post(await body(2, "30000000", "750000"));
  assert.equal(tooSoon.statusCode, 409);
  assert.equal(tooSoon.json().code, "PRICE_CHANGE_TOO_SOON");
  assert.match(tooSoon.json().message, /\d{4}-\d{2}-\d{2}T/);

  const feed = (await app.inject(`/v1/feed?strategies=${id}&limit=1`)).json();
  assert.equal(feed.list[0].kind, "price");
  await app.close();
});
