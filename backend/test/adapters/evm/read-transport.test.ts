import assert from "node:assert/strict";
import test from "node:test";
import { createPublicClient, parseAbi } from "viem";
import { entryPoint08Address } from "viem/account-abstraction";
import { evmReadTransport } from "../../../src/adapters/evm/read-transport.ts";

test("the read deadline also preserves caller cancellation before any request", async () => {
  let requests = 0;
  const client = createPublicClient({
    transport: evmReadTransport("https://read-only.invalid", async () => {
      requests++;
      throw new Error("Cancelled read must not reach HTTP");
    }),
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.request({ method: "eth_chainId" }, { signal: controller.signal }),
  );
  assert.equal(requests, 0);
});

test("one read deadline cancels provider backoff instead of waiting an unbounded Retry-After", async (t) => {
  const deadlines: AbortController[] = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 12000);
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  let requests = 0;
  let observed!: () => void;
  const responseObserved = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const client = createPublicClient({
    transport: evmReadTransport(
      "https://read-only.invalid",
      async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests++;
        if (requests === 1)
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x1237" }),
            { headers: { "content-type": "application/json" } },
          );
        observed();
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "3600" },
        });
      },
    ),
  });
  assert.equal(await client.getChainId(), 4663);
  assert.equal(deadlines.length, 1);
  const pending = client.request({ method: "eth_chainId" });
  await responseObserved;
  deadlines[1]!.abort();
  await assert.rejects(pending);
  assert.equal(requests, 2);
});

test("the retrying read client blocks signing, submission and fork mutation before HTTP", async () => {
  let requests = 0;
  const client = createPublicClient({
    transport: evmReadTransport(
      "https://read-only.invalid",
      async (_url, init) => {
        requests++;
        const body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x1" }),
          { headers: { "content-type": "application/json" } },
        );
      },
    ),
  });
  for (const method of [
    "eth_sendRawTransaction",
    "eth_sendTransaction",
    "eth_sendUserOperation",
    "eth_sign",
    "personal_sign",
    "anvil_setStorageAt",
  ])
    await assert.rejects(
      client.request({ method, params: [] } as never),
      /method not supported/,
    );
  await assert.rejects(
    client.request(
      { method: "eth_sendRawTransaction", params: ["0xdead"] },
      { methods: { include: ["eth_sendRawTransaction"] } },
    ),
    /method not supported/,
  );
  assert.equal(requests, 0);
});

test("HTTP429 recovers without replacing the read parameters or successful nonce", async () => {
  const requests: unknown[] = [];
  const client = createPublicClient({
    cacheTime: 0,
    transport: evmReadTransport(
      "https://read-only.invalid",
      async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push({ method: body.method, params: body.params });
        return requests.length === 1
          ? new Response("rate limited", {
              status: 429,
              headers: { "retry-after": "0" },
            })
          : new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                result: "0x" + "0".repeat(63) + "9",
              }),
              { headers: { "content-type": "application/json" } },
            );
      },
    ),
  });
  const nonce = await client.readContract({
    address: entryPoint08Address,
    abi: parseAbi(["function getNonce(address,uint192) view returns(uint256)"]),
    functionName: "getNonce",
    args: ["0x1000000000000000000000000000000000000001", 0n],
  });
  assert.equal(nonce, 9n);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
});
