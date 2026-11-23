import { DomainError } from "../../domain/errors/domain-error.ts";
import { InfrastructureError } from "../../domain/errors/infrastructure-error.ts";
import { NotFoundError } from "../../domain/errors/not-found-error.ts";
import {
  SignalPaymentRejected,
  type SignalPaywall,
  type StrategyStore,
} from "../../ports/strategies.port.ts";
import {
  currentPrices,
  paymentRequired,
  type StrategyQueries,
  type StrategySignal,
} from "./strategy-queries.usecase.ts";

export type SignalPurchase =
  | { kind: "signal"; signal: StrategySignal; paymentResponse: string | null }
  | { kind: "payment-required"; header: string; body: unknown };

/** Reports a settled payment the ledger could not book, so it can be booked by hand. */
export type SignalPaymentLog = (event: {
  code: "STRATEGY_PAYMENT_NOT_BOOKED";
  strategyId: number;
  transaction: string;
  amountAtoms: string;
}) => void;

/**
 * Serves a strategy's current signal to a trial subscriber key, or sells it through x402: a
 * request without payment gets the strategy's price as payment requirements; a paid request is
 * verified and settled before the signal is returned, and the revenue is booked once.
 */
export class PurchaseSignalUseCase {
  constructor(
    private readonly store: Pick<StrategyStore, "strategy" | "priceChanges" | "recordPayment">,
    private readonly queries: Pick<StrategyQueries, "signal" | "latestSignal">,
    private readonly paywall: SignalPaywall | null,
    private readonly log: SignalPaymentLog = () => {},
  ) {}

  async execute(input: {
    strategyId: number;
    subscriberKey?: string;
    paymentHeader?: string;
    resourceUrl: string;
  }): Promise<SignalPurchase> {
    const { strategyId } = input;
    if (input.subscriberKey && !input.paymentHeader) {
      try {
        return {
          kind: "signal",
          signal: await this.queries.signal(strategyId, input.subscriberKey),
          paymentResponse: null,
        };
      } catch (error) {
        // An expired or unknown key falls back to a free signal or the x402 offer, so agents
        // can still pay.
        if (!(error instanceof InfrastructureError && error.code === "PAYMENT_REQUIRED")) throw error;
      }
    }
    const strategy = await this.store.strategy(strategyId);
    if (!strategy) throw new NotFoundError({ name: "Strategy" }, String(strategyId));

    // Never charge for a strategy that has not sealed a basket yet.
    const signal = await this.queries.latestSignal(strategyId);
    if (!signal.signal)
      throw new DomainError("STRATEGY_NO_SIGNAL", "This strategy has not sealed a basket yet.");
    // A price change applies to agent signals from the moment it is accepted.
    const price = currentPrices(strategy, await this.store.priceChanges([strategyId])).signalPriceAtoms;
    if (price === "0") return { kind: "signal", signal, paymentResponse: null };
    if (!this.paywall) throw paymentRequired();

    const request = {
      priceAtoms: price,
      resourceUrl: input.resourceUrl,
      description: `Current basket of the Gizu strategy "${strategy.metadata.name}"`,
    };
    const required = await this.unavailableOnFailure(() => this.paywall!.required(request));
    if (!input.paymentHeader)
      return { kind: "payment-required", header: required.header, body: required.body };

    let settled;
    try {
      settled = await this.paywall.settle({ paymentHeader: input.paymentHeader, required });
    } catch (error) {
      if (!(error instanceof SignalPaymentRejected)) throw unavailable(error);
      // x402 answers a rejected payment with fresh requirements and the reason.
      const again = await this.unavailableOnFailure(() =>
        this.paywall!.required({ ...request, error: error.reason }),
      );
      return { kind: "payment-required", header: again.header, body: again.body };
    }
    // The agent has paid: from here on it gets the signal even if the ledger fails.
    const payment = { strategyId, amountAtoms: settled.amountAtoms, transaction: settled.transaction };
    try {
      await this.store.recordPayment({
        strategyId,
        kind: "x402",
        amountAtoms: payment.amountAtoms,
        reference: payment.transaction,
      });
    } catch {
      this.log({ code: "STRATEGY_PAYMENT_NOT_BOOKED", ...payment });
    }
    // The basket may have moved while the payment settled; the buyer gets the newest one.
    const fresh = await this.queries.latestSignal(strategyId).catch(() => signal);
    return {
      kind: "signal",
      signal: fresh.signal ? fresh : signal,
      paymentResponse: settled.responseHeader,
    };
  }

  private async unavailableOnFailure<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw unavailable(error);
    }
  }
}

function unavailable(cause: unknown) {
  return new InfrastructureError(
    502,
    "PAYMENT_UNAVAILABLE",
    "The payment service is unavailable.",
    { cause },
  );
}
