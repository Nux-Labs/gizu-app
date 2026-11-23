import assert from "node:assert/strict";
import { test } from "node:test";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import {
  ownerLinkSigner,
  ownerLinkTypes,
  signInSigner,
  signInTypes,
  socialDomain,
  socialNickname,
  socialWordLists,
} from "../../src/domain/social.ts";
import { mnemonic } from "../fixtures/strategies.ts";

const social = mnemonicToAccount(mnemonic, { path: "m/44'/60'/147'/84532'/0" });
const strategyKey = mnemonicToAccount(mnemonic, { path: "m/44'/60'/146'/84532'/0" });
const nonce = `0x${"5a".repeat(32)}` as const;

test("nicknames are deterministic, friendly and end in the account's last four hex digits", () => {
  const name = socialNickname(social.address);
  assert.equal(name, socialNickname(social.address.toLowerCase() as `0x${string}`));
  assert.match(name, /^[A-Z][a-z]+ [A-Z][a-z]+ #[0-9a-f]{4}$/);
  assert.ok(name.endsWith(`#${social.address.slice(-4).toLowerCase()}`));
  for (const list of [socialWordLists.adjectives, socialWordLists.animals]) {
    assert.equal(list.length, 64);
    assert.equal(new Set(list).size, 64);
  }
  // Different accounts spread over the lists.
  const names = new Set(
    Array.from({ length: 40 }, (_, i) =>
      socialNickname(privateKeyToAccount(`0x${(i + 1).toString(16).padStart(64, "0")}`).address).split(" #")[0],
    ),
  );
  assert.ok(names.size > 30);
});

test("SignIn and OwnerLink recover their signers under the GizuSocial domain", async () => {
  const issuedAt = 1_795_000_000;
  const signature = await social.signTypedData({
    domain: socialDomain(84532),
    types: signInTypes,
    primaryType: "SignIn",
    message: { account: social.address, nonce, issuedAt: BigInt(issuedAt) },
  });
  assert.equal(await signInSigner({ chainId: 84532, account: social.address, nonce, issuedAt, signature }), social.address);
  // Any other field, or another chain, recovers someone else.
  assert.notEqual(await signInSigner({ chainId: 84532, account: social.address, nonce, issuedAt: issuedAt + 1, signature }), social.address);
  assert.notEqual(await signInSigner({ chainId: 8453, account: social.address, nonce, issuedAt, signature }), social.address);
  await assert.rejects(
    signInSigner({ chainId: 84532, account: social.address, nonce, issuedAt, signature: `0x${"00".repeat(65)}` }),
    { code: "SOCIAL_SIGNATURE_INVALID" },
  );

  const link = await strategyKey.signTypedData({
    domain: socialDomain(84532),
    types: ownerLinkTypes,
    primaryType: "OwnerLink",
    message: { account: social.address, strategyId: 7n, nonce },
  });
  assert.equal(
    await ownerLinkSigner({ chainId: 84532, account: social.address, strategyId: 7, nonce, signature: link }),
    strategyKey.address,
  );
  assert.notEqual(
    await ownerLinkSigner({ chainId: 84532, account: social.address, strategyId: 8, nonce, signature: link }),
    strategyKey.address,
  );
});
