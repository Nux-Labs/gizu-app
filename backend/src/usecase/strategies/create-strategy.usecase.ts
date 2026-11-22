import { getAddress, type Address, type Hex } from "viem";
import { DomainError } from "../../domain/errors/domain-error.ts";
import {
  STRATEGY_MAX_EMBARGO_SECONDS,
  StrategyRuleError,
  createStrategySigner,
  strategyMetadataHash,
  type StrategyMetadata,
} from "../../domain/strategy.ts";
import type {
  StrategyRecord,
  StrategyRegistryGateway,
  StrategyStore,
} from "../../ports/strategies.port.ts";

export type CreateStrategyInput = {
  signer: Address;
  embargo: number;
  metadata: StrategyMetadata;
  deadline: number;
  signature: Hex;
};

/**
 * Verifies the strategy key's CreateStrategy signature over the submitted metadata and relays it.
 * Retrying the same request is safe: an existing strategy with the same terms is returned.
 */
export class CreateStrategyUseCase {
  constructor(
    private readonly store: StrategyStore,
    private readonly registry: StrategyRegistryGateway,
  ) {}

  async execute(input: CreateStrategyInput, now = new Date()): Promise<StrategyRecord> {
    if (
      !Number.isInteger(input.embargo) ||
      input.embargo < 1 ||
      input.embargo > STRATEGY_MAX_EMBARGO_SECONDS
    )
      throw new StrategyRuleError("The embargo must be between one second and 30 days.");
    const signer = getAddress(input.signer);
    const metadataHash = strategyMetadataHash(input.metadata);
    const recovered = await createStrategySigner({
      chainId: this.registry.chainId,
      registry: this.registry.address,
      embargo: input.embargo,
      metadataHash,
      deadline: input.deadline,
      signature: input.signature,
    });
    if (recovered !== signer)
      throw new DomainError("STRATEGY_SIGNATURE_INVALID", "The signature does not match the signer.");

    const saved = await this.store.strategyBySigner(signer);
    if (saved) return sameTerms(saved, input.embargo, metadataHash);

    let id = await this.registry.strategyOf(signer);
    let createTx: Hex | null = null;
    if (id === 0) {
      if (input.deadline * 1000 <= now.getTime())
        throw new DomainError("STRATEGY_SIGNATURE_EXPIRED", "The signature has expired.");
      ({ id, tx: createTx } = await this.registry.create({
        signer,
        embargo: input.embargo,
        metadataHash,
        deadline: input.deadline,
        signature: input.signature,
      }));
    } else {
      // Created on chain by an earlier attempt that did not reach the database.
      const onchain = await this.registry.strategy(id);
      if (
        onchain.metadataHash.toLowerCase() !== metadataHash.toLowerCase() ||
        onchain.embargoSeconds !== input.embargo
      )
        throw strategyExists();
    }
    await this.store.saveStrategy({
      id,
      signer,
      embargoSeconds: input.embargo,
      metadata: input.metadata,
      metadataHash,
      createTx,
      createdAt: now,
    });
    const stored = await this.store.strategy(id);
    if (!stored) throw new Error("Strategy was not stored.");
    return sameTerms(stored, input.embargo, metadataHash);
  }
}

function sameTerms(saved: StrategyRecord, embargo: number, metadataHash: Hex): StrategyRecord {
  if (saved.embargoSeconds !== embargo || saved.metadataHash.toLowerCase() !== metadataHash.toLowerCase())
    throw strategyExists();
  return saved;
}

function strategyExists() {
  return new DomainError("STRATEGY_EXISTS", "This strategy key already has a strategy with other terms.");
}
