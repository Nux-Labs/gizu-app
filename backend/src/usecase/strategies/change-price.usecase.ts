import type { Hex } from "viem";
import { DomainError } from "../../domain/errors/domain-error.ts";
import { NotFoundError } from "../../domain/errors/not-found-error.ts";
import { StatusDomainError } from "../../domain/errors/status-error.ts";
import {
  STRATEGY_SIGNATURE_MAX_AHEAD_SECONDS,
  priceChangeAllowedAt,
  strategyPriceHistory,
  updatePriceSigner,
} from "../../domain/strategy.ts";
import type { StrategyRegistryGateway, StrategyStore } from "../../ports/strategies.port.ts";

export type ChangePriceInput = {
  version: number;
  monthlyPriceAtoms: string;
  signalPriceAtoms: string;
  deadline: number;
  signature: Hex;
};

export type PriceLog = (event: { code: "STRATEGY_PRICE_PUSH_QUEUE_FAILED"; strategyId: number; version: number }) => void;

/** Tolerates a device clock slightly ahead of the server's when checking the one-hour deadline. */
const CLOCK_SKEW_SECONDS = 60;

/**
 * Applies a price change signed by the strategy key as EIP-712 `UpdatePrice` under the registry
 * domain. The registry never sees it: the creation terms on chain stay version 0, and the new
 * prices apply to new subscriptions and agent signals from now on.
 */
export class ChangePriceUseCase {
  constructor(
    private readonly store: Pick<
      StrategyStore,
      "strategy" | "priceChanges" | "addPriceChange" | "queuePricePush"
    >,
    private readonly registry: Pick<StrategyRegistryGateway, "chainId" | "address">,
    private readonly log: PriceLog = () => {},
  ) {}

  async execute(strategyId: number, input: ChangePriceInput, now = new Date()): Promise<void> {
    const strategy = await this.store.strategy(strategyId);
    if (!strategy) throw new NotFoundError({ name: "Strategy" }, String(strategyId));
    const signer = await updatePriceSigner({
      chainId: this.registry.chainId,
      registry: this.registry.address,
      strategyId: BigInt(strategyId),
      version: input.version,
      monthlyPriceAtoms: input.monthlyPriceAtoms,
      signalPriceAtoms: input.signalPriceAtoms,
      deadline: input.deadline,
      signature: input.signature,
    });
    if (signer.toLowerCase() !== strategy.signer.toLowerCase())
      throw new DomainError("STRATEGY_SIGNATURE_INVALID", "The signature does not match the strategy key.");

    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (input.deadline <= nowSeconds)
      throw new DomainError("STRATEGY_SIGNATURE_EXPIRED", "The signature has expired.");
    if (input.deadline > nowSeconds + STRATEGY_SIGNATURE_MAX_AHEAD_SECONDS + CLOCK_SKEW_SECONDS)
      throw new DomainError("STRATEGY_DEADLINE_TOO_FAR", "The signature must expire within an hour.");

    const history = strategyPriceHistory(strategy, await this.store.priceChanges([strategyId]));
    const current = history.at(-1)!;
    if (input.version !== current.version + 1)
      throw new DomainError("STRATEGY_PRICE_VERSION_STALE", "The price change was signed for another version.");
    if (
      input.monthlyPriceAtoms === current.monthlyPriceAtoms &&
      input.signalPriceAtoms === current.signalPriceAtoms
    )
      throw new DomainError("STRATEGY_PRICE_UNCHANGED", "At least one price must change.");
    const allowedAt = priceChangeAllowedAt(history, now);
    if (allowedAt)
      throw new StatusDomainError(
        409,
        "PRICE_CHANGE_TOO_SOON",
        `Prices change at most once every 7 days; the next change is possible at ${allowedAt.toISOString()}.`,
      );

    const added = await this.store.addPriceChange({
      strategyId,
      version: input.version,
      monthlyPriceAtoms: input.monthlyPriceAtoms,
      signalPriceAtoms: input.signalPriceAtoms,
      signature: input.signature,
      deadline: input.deadline,
      at: now,
    });
    if (!added)
      throw new DomainError("STRATEGY_PRICE_VERSION_STALE", "The price change was signed for another version.");
    try {
      await this.store.queuePricePush(strategyId, input.version);
    } catch {
      this.log({ code: "STRATEGY_PRICE_PUSH_QUEUE_FAILED", strategyId, version: input.version });
    }
  }
}
