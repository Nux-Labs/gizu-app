import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import { z } from "zod";
import type { CatalogCategory, CatalogToken } from "../../adapters/oneinch/token-catalog.ts";
import { DETAIL_PERIODS, type RobinhoodTokenDetails } from "../../adapters/oneinch/token-details.ts";

// Robinhood first: its stock tokens are the only swap targets, so they lead a cross-chain list.
const CATALOG_CHAIN_IDS = [4663, 143, 1];

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
  details?: Pick<RobinhoodTokenDetails, "details">,
) {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/v1/tokens",
    { schema: { querystring: querySchema } },
    async (request, reply) => {
      const { chainId, category } = request.query;
      const chainIds = chainId === undefined ? CATALOG_CHAIN_IDS : [chainId];
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
      const list = matches.slice(page * items, (page + 1) * items);
      return reply.code(200).send({ list, page, items, total: matches.length });
    },
  );
  if (!details) return;
  // Token addresses are public, so unlike wallet routes this one can carry its address in the path.
  app.withTypeProvider<ZodTypeProvider>().get(
    "/v1/tokens/4663/:address/details",
    {
      schema: {
        params: z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/) }),
        querystring: z.object({ period: z.enum(DETAIL_PERIODS).default("1M") }),
      },
    },
    async (request, reply) => {
      const found = await details.details(request.params.address, request.query.period);
      if (!found) return reply.code(404).send({ code: "TOKEN_NOT_BUYABLE", message: "token is not a swap target" });
      return reply.code(200).send(found);
    },
  );
}
