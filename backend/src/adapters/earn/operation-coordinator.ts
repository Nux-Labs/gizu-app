import { createHmac } from "node:crypto";
import type { OperationCoordinationStore } from "../../ports/operation-coordination.port.ts";
export class CoordinationError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(unavailable = false) {
    super(
      unavailable
        ? "Earn coordination unavailable"
        : "Earn binding already consumed or changed",
    );
    this.statusCode = unavailable ? 503 : 409;
    this.code = unavailable
      ? "EARN_COORDINATION_UNAVAILABLE"
      : "EARN_COORDINATION_CONFLICT";
  }
}
/** Only keyed commitments leave this transient processing boundary. The key must
 * be stable across replicas; changing it requires waiting out all authority. */
export class OperationCoordinator {
  private key: Buffer | undefined;
  constructor(
    private store: OperationCoordinationStore,
    keyHex?: string,
  ) {
    if (keyHex && /^[0-9a-f]{64}$/i.test(keyHex))
      this.key = Buffer.from(keyHex, "hex");
  }
  private digest(purpose: string, value: unknown) {
    if (!this.key) throw new CoordinationError(true);
    return createHmac("sha256", this.key)
      .update(`gizu-operation-coordination:v1\0${purpose}\0`)
      .update(JSON.stringify(value))
      .digest("hex");
  }
  private async reserve(
    scope: string,
    identity: unknown,
    binding: unknown,
    expires: number,
    exclusive: boolean,
  ) {
    try {
      return await this.store.bind(
        this.digest("identity", [scope, identity]),
        this.digest("binding", [scope, binding]),
        expires,
        exclusive,
      );
    } catch {
      throw new CoordinationError(true);
    }
  }
  async bind(
    scope: string,
    identity: unknown,
    binding: unknown,
    expires: number,
  ) {
    if (!(await this.reserve(scope, identity, binding, expires, false)))
      throw new CoordinationError();
  }
  /** Atomic proof + membership + global event claims, with exact legacy-owner recovery. */
  async bindMany(
    bindings: Array<{
      scope: string;
      identity: unknown;
      binding: unknown;
      compatible?: unknown[];
    }>,
    expiresAtMs: number,
  ) {
    if (!this.store.bindMany) throw new CoordinationError(true);
    const opaque = bindings.map((row) => ({
      opaqueKey: this.digest("identity", [row.scope, row.identity]),
      commitments: [row.binding, ...(row.compatible ?? [])].map((binding) =>
        this.digest("binding", [row.scope, binding]),
      ),
      expiresAtMs,
    }));
    let accepted: boolean;
    try {
      accepted = await this.store.bindMany(opaque);
    } catch {
      throw new CoordinationError(true);
    }
    if (!accepted) throw new CoordinationError();
  }
  async claim(
    scope: string,
    identity: unknown,
    binding: unknown,
    expires: number,
  ) {
    return this.reserve(scope, identity, binding, expires, true);
  }
}
