import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import * as recovery from "../../src/http/routes/wallet-recovery.routes.ts";
import type { WalletRecoveryStore } from "../../src/ports/wallet-recovery.port.ts";
const id = "ab".repeat(32),
  token = "cd".repeat(32);
const ciphertext = Buffer.from("authenticated opaque ciphertext").toString(
  "base64url",
);
function fixture() {
  const rows = new Map<
    string,
    { digest: string; revision: number; ciphertext: string }
  >();
  const store: WalletRecoveryStore = {
    async remove(key: string, digest: string) {
      if (rows.get(key)?.digest === digest) rows.delete(key);
    },
    async read(key: string, digest: string) {
      const row = rows.get(key);
      return row?.digest === digest
        ? { version: 1, revision: row.revision, ciphertext: row.ciphertext }
        : null;
    },
    async write(key: string, digest: string, expected: number, data: string) {
      const row = rows.get(key);
      if (row && row.digest !== digest) return { status: "missing" };
      if (!row && expected !== 0) return { status: "missing" };
      if ((row?.revision ?? 0) !== expected) return { status: "conflict" };
      const next = { digest, revision: expected + 1, ciphertext: data };
      rows.set(key, next);
      return {
        status: "ok",
        snapshot: { version: 1, revision: next.revision, ciphertext: data },
      };
    },
  };
  const app = Fastify();
  recovery?.registerWalletRecoveryRoutes(app, store);
  const request = (
    method: "GET" | "PUT",
    payload?: Record<string, unknown>,
    bearer = token,
    url = `/wallet-recovery/v1/${id}`,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${bearer}` },
      ...(payload === undefined ? {} : { payload }),
    });
  return { app, rows, request };
}
test("opaque backup creates and atomically replaces only the expected revision", async () => {
  const { app, rows, request } = fixture();
  try {
    assert.ok(recovery, "recovery API must be registered");
    const created = await request("PUT", { expectedRevision: 0, ciphertext });
    assert.equal(created.statusCode, 200);
    assert.deepEqual(created.json(), { version: 1, revision: 1, ciphertext });
    assert.equal(created.headers["cache-control"], "no-store");
    assert.equal(rows.get(id)?.digest.includes(token), false);
    const competing = await Promise.all([
      request("PUT", { expectedRevision: 1, ciphertext }),
      request("PUT", { expectedRevision: 1, ciphertext }),
    ]);
    assert.deepEqual(competing.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal((await request("GET")).json().revision, 2);
  } finally {
    await app.close();
  }
});
test("missing and wrong credentials have identical responses and cannot replace the owner", async () => {
  const { app, request } = fixture();
  try {
    assert.ok(recovery, "recovery API must be registered");
    const missing = await request("GET");
    await request("PUT", { expectedRevision: 0, ciphertext });
    const denied = await request("GET", undefined, "ef".repeat(32));
    assert.equal(denied.statusCode, 404);
    assert.deepEqual(denied.json(), missing.json());
    assert.equal(
      (
        await request(
          "PUT",
          { expectedRevision: 0, ciphertext },
          "ef".repeat(32),
        )
      ).statusCode,
      404,
    );
    assert.equal((await request("GET", undefined, "bad")).statusCode, 404);
  } finally {
    await app.close();
  }
});
test("recovery rejects unknown fields, noncanonical encoding and oversized bodies with no-store", async () => {
  const { app, request } = fixture();
  try {
    assert.ok(recovery, "recovery API must be registered");
    for (const payload of [
      { expectedRevision: -1, ciphertext },
      { expectedRevision: 0, ciphertext, address: "private" },
      { expectedRevision: 0, ciphertext: "a" },
      { expectedRevision: 0, ciphertext: "YWJj=" },
    ]) {
      const r = await request("PUT", payload);
      assert.equal(r.statusCode, 400);
      assert.equal(r.headers["cache-control"], "no-store");
    }
    const big = await request("PUT", {
      expectedRevision: 0,
      ciphertext: "a".repeat(1500000),
    });
    assert.equal(big.statusCode, 413);
    assert.equal(big.headers["cache-control"], "no-store");
  } finally {
    await app.close();
  }
});
test("private recovery database failures have a fixed safe response", async () => {
  const app = Fastify();
  recovery?.registerWalletRecoveryRoutes(app, {
    remove: async () => {
      throw new Error("private");
    },
    read: async () => {
      throw new Error("bearer/address/provider details");
    },
    write: async () => {
      throw new Error("private");
    },
  });
  try {
    assert.ok(recovery, "recovery API must be registered");
    const r = await app.inject({
      url: `/wallet-recovery/v1/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(r.statusCode, 503);
    assert.equal(JSON.stringify(r.json()).includes("provider"), false);
  } finally {
    await app.close();
  }
});

test("authenticated page cleanup deletes all versions without exposing object existence", async () => {
  const { app, request } = fixture();
  try {
    await request("PUT", { expectedRevision: 0, ciphertext });
    const remove = (bearer = token) =>
      app.inject({
        method: "DELETE",
        url: `/wallet-recovery/v1/${id}`,
        headers: { authorization: `Bearer ${bearer}` },
      });
    assert.equal((await remove("ef".repeat(32))).statusCode, 204);
    assert.equal((await request("GET")).statusCode, 200);
    const removed = await remove();
    assert.equal(removed.statusCode, 204);
    assert.equal(removed.headers["cache-control"], "no-store");
    assert.equal((await request("GET")).statusCode, 404);
    assert.equal((await remove()).statusCode, 204);
  } finally {
    await app.close();
  }
});

test("quota failure has an explicit safe no-store response", async () => {
  const app = Fastify();
  recovery.registerWalletRecoveryRoutes(app, {
    read: async () => null,
    remove: async () => {},
    write: async () => ({ status: "quota" }),
  });
  try {
    const r = await app.inject({
      method: "PUT",
      url: `/wallet-recovery/v1/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { expectedRevision: 0, ciphertext },
    });
    assert.equal(r.statusCode, 507);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.deepEqual(r.json(), { code: "RECOVERY_QUOTA_EXCEEDED" });
  } finally {
    await app.close();
  }
});

test("all page locators use one opaque credential digest for aggregate quota enforcement", async () => {
  const { app, rows, request } = fixture();
  const page = "ef".repeat(32);
  try {
    await request("PUT", { expectedRevision: 0, ciphertext });
    await request(
      "PUT",
      { expectedRevision: 0, ciphertext },
      token,
      `/wallet-recovery/v1/${page}`,
    );
    assert.equal(rows.get(id)?.digest, rows.get(page)?.digest);
    assert.equal(rows.get(id)?.digest.includes(token), false);
  } finally {
    await app.close();
  }
});

test("rotating locators and credentials share client admission; exhausted writes do not block reads or deletes", async () => {
  let remaining = 2,
    writes = 0;
  const clients: string[] = [];
  const app = Fastify();
  recovery.registerWalletRecoveryRoutes(
    app,
    {
      read: async () => ({ version: 1, revision: 1, ciphertext }),
      remove: async () => {},
      write: async () => {
        writes++;
        return {
          status: "ok",
          snapshot: { version: 1, revision: 1, ciphertext },
        };
      },
    },
    {
      async admit(client: string, bytes: number) {
        clients.push(client);
        assert.equal(bytes, Buffer.from(ciphertext, "base64url").length);
        return remaining-- > 0;
      },
    },
  );
  try {
    for (let i = 1; i <= 4; i++) {
      const r = await app.inject({
        method: "PUT",
        url: `/wallet-recovery/v1/${String(i).padStart(64, "0")}`,
        headers: {
          authorization: `Bearer ${String(i + 10).padStart(64, "0")}`,
        },
        payload: { expectedRevision: 0, ciphertext },
      });
      assert.equal(r.statusCode, i <= 2 ? 200 : 429);
    }
    assert.equal(new Set(clients).size, 1);
    assert.equal(writes, 2);
    assert.equal(
      (
        await app.inject({
          url: `/wallet-recovery/v1/${id}`,
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: `/wallet-recovery/v1/${id}`,
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
      204,
    );
  } finally {
    await app.close();
  }
});
test("invalid auth, media type and oversized upload are rejected before admission or persistence", async () => {
  let io = 0;
  const app = Fastify();
  recovery.registerWalletRecoveryRoutes(
    app,
    {
      read: async () => {
        io++;
        return null;
      },
      remove: async () => {
        io++;
      },
      write: async () => {
        io++;
        return { status: "missing" };
      },
    },
    {
      admit: async () => {
        io++;
        return true;
      },
    },
  );
  const valid = { authorization: `Bearer ${token}` };
  try {
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: `/wallet-recovery/v1/${id}`,
          headers: { "content-type": "application/json" },
          payload: "{broken",
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: `/wallet-recovery/v1/${id}`,
          headers: { ...valid, "content-type": "text/plain" },
          payload: JSON.stringify({ expectedRevision: 0, ciphertext }),
        })
      ).statusCode,
      415,
    );
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: `/wallet-recovery/v1/${id}`,
          headers: valid,
          payload: { expectedRevision: 0, ciphertext: "a".repeat(1500000) },
        })
      ).statusCode,
      413,
    );
    assert.equal(io, 0);
  } finally {
    await app.close();
  }
});
test("unavailable admission fails new uploads closed while reads stay independent", async () => {
  const app = Fastify();
  let writes = 0;
  recovery.registerWalletRecoveryRoutes(
    app,
    {
      read: async () => ({ version: 1, revision: 1, ciphertext }),
      remove: async () => {},
      write: async () => {
        writes++;
        return { status: "missing" };
      },
    },
    {
      admit: async () => {
        throw new Error("private db/IP detail");
      },
    },
  );
  try {
    const r = await app.inject({
      method: "PUT",
      url: `/wallet-recovery/v1/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { expectedRevision: 0, ciphertext },
    });
    assert.equal(r.statusCode, 503);
    assert.equal(writes, 0);
    assert.equal(
      (
        await app.inject({
          url: `/wallet-recovery/v1/${id}`,
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});
