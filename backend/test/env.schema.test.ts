import assert from "node:assert/strict";
import { test } from "node:test";
import { parseApiEnv } from "../src/env.schema.ts";

const databaseUrl =
  "postgres://private_investment:private_investment@localhost:54329/private_investment";

const apiEnv = {
  NODE_ENV: "local",
  PORT: "3000",
  DATABASE_URL: databaseUrl,
  ONEINCH_API_KEY: "oneinch-api-key",
  AURORA_API_KEY: "aurora-api-key",
  PIMLICO_API_KEY: "pimlico-api-key",
};

test("parses a complete api env", () => {
  assert.deepEqual(parseApiEnv(apiEnv), {
    NODE_ENV: "local",
    PORT: 3000,
    DATABASE_URL: databaseUrl,
    ONEINCH_API_KEY: "oneinch-api-key",
    AURORA_API_KEY: "aurora-api-key",
    PIMLICO_API_KEY: "pimlico-api-key",
  });
});

test("rejects missing swap provider keys", () => {
  const { AURORA_API_KEY: _aurora, ...withoutAurora } = apiEnv;
  assert.throws(() => parseApiEnv(withoutAurora), /AURORA_API_KEY/);
  const { PIMLICO_API_KEY: _pimlico, ...withoutPimlico } = apiEnv;
  assert.throws(() => parseApiEnv(withoutPimlico), /PIMLICO_API_KEY/);
});

test("rejects a missing 1inch key", () => {
  const { ONEINCH_API_KEY: _key, ...withoutKey } = apiEnv;
  assert.throws(() => parseApiEnv(withoutKey), /ONEINCH_API_KEY/);
});

test("rejects a missing database url", () => {
  const withoutDatabase = {
    NODE_ENV: apiEnv.NODE_ENV,
    PORT: apiEnv.PORT,
  };
  assert.throws(
    () => parseApiEnv(withoutDatabase),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes("DATABASE_URL") &&
      err.message.includes("invalid env"),
  );
});

test("rejects an empty database url", () => {
  assert.throws(
    () => parseApiEnv({ ...apiEnv, DATABASE_URL: "" }),
    (err: unknown) =>
      err instanceof Error && err.message.includes("DATABASE_URL"),
  );
});

test("rejects development as node env", () => {
  assert.throws(
    () => parseApiEnv({ ...apiEnv, NODE_ENV: "development" }),
    (err: unknown) => err instanceof Error && err.message.includes("NODE_ENV"),
  );
});

test("payout recovery key is optional but when supplied must be a durable 32-byte hex value", () => {
  assert.equal(
    parseApiEnv({ ...apiEnv, EARN_GATEWAY_RECOVERY_KEY: "11".repeat(32) })
      .EARN_GATEWAY_RECOVERY_KEY,
    "11".repeat(32),
  );
  assert.throws(
    () => parseApiEnv({ ...apiEnv, EARN_GATEWAY_RECOVERY_KEY: "too-short" }),
    /EARN_GATEWAY_RECOVERY_KEY/,
  );
});

test("catalog accepts environment-defined chains and an empty contract allowlist", () => {
  const chains = [
    { id: 4663, name: "Robinhood" },
    { id: 1, name: "Ethereum" },
    { id: 143, name: "Monad" },
  ];
  const env = parseApiEnv({
    ...apiEnv,
    CATALOG_CHAINS_JSON: JSON.stringify(chains),
    CATALOG_VAULTS_JSON: "[]",
  });
  assert.deepEqual(env.CATALOG_CHAINS_JSON, chains);
  assert.deepEqual(env.CATALOG_VAULTS_JSON, []);
});

test("configured vaults accept Ethereum, Robinhood and additional enabled chains together", () => {
  const chainIds = [1, 4663, 143, 8453];
  const env = parseApiEnv({
    ...apiEnv,
    CATALOG_CHAINS_JSON: JSON.stringify(
      chainIds.map((id) => ({ id, name: `Chain ${id}` })),
    ),
    CATALOG_VAULTS_JSON: JSON.stringify(
      chainIds.map((chainId) => ({
        chainId,
        address: "0x1111111111111111111111111111111111111111",
      })),
    ),
  });
  assert.deepEqual(
    env.CATALOG_VAULTS_JSON?.map((vault) => vault.chainId),
    chainIds,
  );
});

test("catalog rejects malformed JSON, duplicate chains, invalid addresses and disabled-chain vaults", () => {
  for (const value of [
    "not json",
    "{}",
    '[{"id":143,"name":"Monad"},{"id":143,"name":"Duplicate"}]',
  ]) {
    assert.throws(
      () => parseApiEnv({ ...apiEnv, CATALOG_CHAINS_JSON: value }),
      /CATALOG_CHAINS_JSON/,
    );
  }
  assert.throws(
    () =>
      parseApiEnv({
        ...apiEnv,
        CATALOG_VAULTS_JSON: '[{"chainId":143,"address":"invalid"}]',
      }),
    /CATALOG_VAULTS_JSON/,
  );
  assert.throws(
    () =>
      parseApiEnv({
        ...apiEnv,
        CATALOG_CHAINS_JSON: '[{"id":143,"name":"Monad"}]',
        CATALOG_VAULTS_JSON:
          '[{"chainId":1,"address":"0x1111111111111111111111111111111111111111"}]',
      }),
    /CATALOG_VAULTS_JSON/,
  );
});

test("VAULT_CHAINS parses an ordered Ethereum/Robinhood allowlist independently of legacy chain settings", () => {
  const env = parseApiEnv({
    ...apiEnv,
    VAULT_CHAINS: " 1, 4663 ",
    CATALOG_CHAINS_JSON: '[{"id":143,"name":"Monad"}]',
  });
  assert.deepEqual(env.VAULT_CHAINS, [1, 4663]);
});

test("VAULT_CHAINS rejects empty, duplicate, invalid and unknown chain IDs", () => {
  for (const VAULT_CHAINS of [
    "",
    "1,",
    "1,1",
    "0",
    "-1",
    "1.5",
    "ethereum",
    "1e3",
    "999999",
    "9007199254740992",
  ]) {
    assert.throws(
      () => parseApiEnv({ ...apiEnv, VAULT_CHAINS }),
      /VAULT_CHAINS/,
    );
  }
});

test("VAULT_CHAINS accepts custom chain metadata and retains inactive known-chain configurations", () => {
  const env = parseApiEnv({
    ...apiEnv,
    VAULT_CHAINS: "1,4663,8453",
    CATALOG_CHAINS_JSON: '[{"id":8453,"name":"Base"}]',
    CATALOG_VAULTS_JSON:
      '[{"chainId":143,"address":"0x1111111111111111111111111111111111111111"}]',
  });
  assert.deepEqual(env.VAULT_CHAINS, [1, 4663, 8453]);
});

test('recovery upload admission and global storage limits accept bounded configuration and reject invalid budgets',()=>{
  assert.equal(parseApiEnv({...apiEnv,RECOVERY_UPLOAD_CALLS_PER_MINUTE:'1024'}).RECOVERY_UPLOAD_CALLS_PER_MINUTE,1024);
  for(const name of ['RECOVERY_UPLOAD_CALLS_PER_MINUTE','RECOVERY_UPLOAD_BYTES_PER_MINUTE','RECOVERY_UPLOAD_BYTES_PER_DAY','RECOVERY_UPLOAD_MAX_CLIENTS','RECOVERY_STORAGE_MAX_BYTES','RECOVERY_STORAGE_MAX_OBJECTS'])assert.throws(()=>parseApiEnv({...apiEnv,[name]:'-1'}));
});

test("enables Sealed Strategies only with registry, chain and relayer key together", () => {
  const strategy = {
    STRATEGY_REGISTRY_ADDRESS: "0x6db1131C8d833CA0F167f7B8DBd24a93cA22Abf7",
    STRATEGY_CHAIN_ID: "84532",
    STRATEGY_RELAYER_KEY: "11".repeat(32),
    STRATEGY_COMMIT_JITTER_MAX_SECONDS: "120",
  };
  const parsed = parseApiEnv({ ...apiEnv, ...strategy });
  assert.equal(parsed.STRATEGY_CHAIN_ID, 84532);
  assert.equal(parsed.STRATEGY_RELAYER_KEY, `0x${"11".repeat(32)}`);
  assert.equal(parsed.STRATEGY_COMMIT_JITTER_MAX_SECONDS, 120);
  const { STRATEGY_RELAYER_KEY: _key, ...withoutKey } = strategy;
  assert.throws(() => parseApiEnv({ ...apiEnv, ...withoutKey }), /set together/);
  assert.throws(() => parseApiEnv({ ...apiEnv, ...strategy, STRATEGY_CHAIN_ID: "1" }), /STRATEGY_CHAIN_ID/);
  assert.throws(() => parseApiEnv({ ...apiEnv, ...strategy, STRATEGY_COMMIT_JITTER_MAX_SECONDS: "601" }), /JITTER/);
});

test("x402 signal payments need a payee and the Sealed Strategies settings", () => {
  const strategy = {
    STRATEGY_REGISTRY_ADDRESS: "0x6db1131C8d833CA0F167f7B8DBd24a93cA22Abf7",
    STRATEGY_CHAIN_ID: "84532",
    STRATEGY_RELAYER_KEY: "11".repeat(32),
  };
  const payee = { X402_PAY_TO: "0x7a09de3500b242d260c4c621E92Ac1cE81b5535A" };
  assert.equal(parseApiEnv({ ...apiEnv, ...strategy, ...payee }).X402_PAY_TO, payee.X402_PAY_TO);
  assert.throws(() => parseApiEnv({ ...apiEnv, ...payee }), /Sealed Strategies settings/);
  assert.throws(() => parseApiEnv({ ...apiEnv, ...strategy, X402_PAY_TO: "0x1234" }), /X402_PAY_TO/);
  assert.throws(
    () => parseApiEnv({ ...apiEnv, ...strategy, ...payee, X402_FACILITATOR_URL: "http://insecure.example" }),
    /X402_FACILITATOR_URL/,
  );
  // The default facilitator is testnet-only, so mainnet must name one.
  const mainnet = { ...strategy, STRATEGY_CHAIN_ID: "8453" };
  assert.throws(() => parseApiEnv({ ...apiEnv, ...mainnet, ...payee }), /mainnet facilitator/);
  const facilitator = { X402_FACILITATOR_URL: "https://facilitator.example" };
  assert.equal(parseApiEnv({ ...apiEnv, ...mainnet, ...payee, ...facilitator }).X402_FACILITATOR_URL, facilitator.X402_FACILITATOR_URL);
});

test("strategy notifications take a Firebase service account key file", () => {
  const strategy = {
    STRATEGY_REGISTRY_ADDRESS: "0x6db1131C8d833CA0F167f7B8DBd24a93cA22Abf7",
    STRATEGY_CHAIN_ID: "84532",
    STRATEGY_RELAYER_KEY: "11".repeat(32),
  };
  const key = {
    type: "service_account",
    project_id: "gizu-test",
    client_email: "push@gizu-test.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
  };
  const parsed = parseApiEnv({ ...apiEnv, ...strategy, FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(key) });
  assert.deepEqual(parsed.FCM_SERVICE_ACCOUNT_JSON, {
    project_id: key.project_id,
    client_email: key.client_email,
    private_key: key.private_key,
  });
  assert.throws(() => parseApiEnv({ ...apiEnv, FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(key) }), /Sealed Strategies settings/);
  for (const bad of ["not json", JSON.stringify({ ...key, private_key: "secret" })])
    assert.throws(
      () => parseApiEnv({ ...apiEnv, ...strategy, FCM_SERVICE_ACCOUNT_JSON: bad }),
      (error: Error) => /service account/.test(error.message) && !error.message.includes("secret"),
    );
});
