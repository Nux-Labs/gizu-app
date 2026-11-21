import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";
import type { CatalogCategory, CatalogToken } from "../../adapters/oneinch/token-catalog.ts";
import { DETAIL_PERIODS, type StockChainId, type StockTokenDetails } from "../../adapters/oneinch/token-details.ts";

const CATALOG_CHAIN_IDS = [4663, 8453, 143, 1];
// A list without a chain keeps the chains it always returned, Robinhood first, so clients that
// predate Base never meet its chain or issuer. Base is listed when asked for by chain.
const DEFAULT_CHAIN_IDS = [4663, 143, 1];
const STOCK_CHAIN_IDS: readonly StockChainId[] = [4663, 8453];

const querySchema = z.object({
  chainId: z.coerce.number().int().refine((id) => CATALOG_CHAIN_IDS.includes(id)).optional(),
  category: z.enum(["all", "rwa", "other"]),
  search: z.string().max(200),
  page: z.coerce.number().int().nonnegative(),
  items: z.coerce.number().int().min(1).max(100),
  // The swap picker lists only tokens a buy can target; browsing and earlier-swap lookup still see every token.
  liquidOnly: z.literal("true").optional(),
});

export function registerTokenRoutes(
  app: FastifyInstance,
  catalog: { list(chainId: number, category: CatalogCategory): Promise<CatalogToken[]> },
  details?: Pick<StockTokenDetails, "details" | "prices">,
) {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/v1/tokens",
    { schema: { querystring: querySchema } },
    async (request, reply) => {
      const { chainId, category } = request.query;
      const chainIds = chainId === undefined ? DEFAULT_CHAIN_IDS : [chainId];
      const tokens = (await Promise.all(chainIds.map((id) => catalog.list(id, category)))).flat();
      const search = request.query.search.trim().toLowerCase();
      const liquidOnly = request.query.liquidOnly === "true";
      const matches = tokens.filter((token) =>
        (!liquidOnly || token.buyable) && (
        token.symbol.toLowerCase().includes(search) ||
        token.name.toLowerCase().includes(search) ||
        token.address.toLowerCase().includes(search) ||
        (token.issuer !== null && token.issuer.toLowerCase().includes(search))),
      );
      const { page, items } = request.query;
      const slice = matches.slice(page * items, (page + 1) * items);
      // Buyable stocks carry their price on their own chain; a missing price never fails the list.
      const chains = STOCK_CHAIN_IDS.filter((id) => slice.some((token) => token.buyable && token.chainId === id));
      const prices = details && chains.length > 0
        ? new Map((await Promise.all(chains.map((id) => details.prices(id)))).flatMap((map) => [...map]))
        : undefined;
      const list = prices
        ? slice.map((token) => token.buyable ? { ...token, priceUsd: prices.get(token.address.toLowerCase()) ?? null } : token)
        : slice;
      return reply.code(200).send({ list, page, items, total: matches.length });
    },
  );
  // Swap asset recovery checks a wallet's own balances for every swap-listed token on a chain, so it
  // needs the whole address list at once rather than paging through display rows. Public data only.
  app.withTypeProvider<ZodTypeProvider>().get(
    "/v1/token-addresses",
    {
      schema: {
        querystring: z.object({
          chainId: z.coerce.number().int().refine((id) => CATALOG_CHAIN_IDS.includes(id)),
        }),
      },
    },
    async (request, reply) => {
      const { chainId } = request.query;
      const tokens = await catalog.list(chainId, "all");
      const addresses = [
        ...new Set(tokens.filter((token) => token.swapListed).map((token) => token.address.toLowerCase())),
      ].sort();
      return reply.code(200).send({ chainId, addresses });
    },
  );
  if (!details) return;
  // Token addresses are public, so unlike wallet routes this one can carry its address in the path.
  app.withTypeProvider<ZodTypeProvider>().get(
    "/v1/tokens/:chainId/:address/details",
    {
      schema: {
        params: z.object({
          chainId: z.enum(["4663", "8453"]).transform((id) => Number(id) as StockChainId),
          address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        }),
        querystring: z.object({ period: z.enum(DETAIL_PERIODS).default("1M") }),
      },
    },
    async (request, reply) => {
      const found = await details.details(request.params.address, request.query.period, request.params.chainId);
      if (!found) return reply.code(404).send({ code: "TOKEN_NOT_BUYABLE", message: "token is not a swap target" });
      return reply.code(200).send(found);
    },
  );
}
