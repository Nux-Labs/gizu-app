import type { FastifyReply, FastifyRequest } from "fastify";
import { supportedProtocols } from "../../domain/protocol.ts";
import type { GetOpportunityTvlRecordsUseCase } from "../../usecase/opportunities/get-opportunity-tvl-records.usecase.ts";
import type { GetOpportunityUseCase } from "../../usecase/opportunities/get-opportunity.usecase.ts";
import type { ListOpportunitiesUseCase } from "../../usecase/opportunities/list-opportunities.usecase.ts";
import type {
  ListOpportunitiesQuery,
  OpportunityParams,
  ProtocolParams,
  TvlRecordsParams,
  TvlRecordsQuery,
} from "../routes/opportunities.routes.ts";

export class OpportunitiesController {
  constructor(
    private readonly listOpportunities: ListOpportunitiesUseCase,
    private readonly getOpportunity: GetOpportunityUseCase,
    private readonly getOpportunityTvlRecords: GetOpportunityTvlRecordsUseCase,
  ) {}

  protocols = async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send({ list: supportedProtocols });
  };

  list = async (
    request: FastifyRequest<{ Querystring: ListOpportunitiesQuery }>,
    reply: FastifyReply,
  ) => {
    const response = await this.listOpportunities.execute({
      protocol: request.query.protocol ?? "all",
      search: request.query.search,
      page: request.query.page,
      items: request.query.items,
      chainId: request.query.chainId,
    });
    return reply.code(200).send({
      list: response.list,
      page: request.query.page,
      items: request.query.items,
      total: response.total,
      ...(response.partial ? { partial: true } : {}),
      ...(response.facets ? { facets: response.facets } : {}),
    });
  };

  listByProtocol = async (
    request: FastifyRequest<{
      Params: ProtocolParams;
      Querystring: ListOpportunitiesQuery;
    }>,
    reply: FastifyReply,
  ) => {
    const response = await this.listOpportunities.execute({
      protocol: request.params.protocolId,
      search: request.query.search,
      page: request.query.page,
      items: request.query.items,
      chainId: request.query.chainId,
    });
    return reply.code(200).send({
      list: response.list,
      page: request.query.page,
      items: request.query.items,
      total: response.total,
      ...(response.partial ? { partial: true } : {}),
      ...(response.facets ? { facets: response.facets } : {}),
    });
  };

  getById = async (
    request: FastifyRequest<{ Params: OpportunityParams }>,
    reply: FastifyReply,
  ) => {
    const opportunity = await this.getOpportunity.execute(request.params.id);
    return reply.code(200).send({ opportunity });
  };

  tvlRecords = async (
    request: FastifyRequest<{ Params: TvlRecordsParams; Querystring: TvlRecordsQuery }>,
    reply: FastifyReply,
  ) => {
    const list = await this.getOpportunityTvlRecords.execute({
      id: request.params.id,
      items: request.query.items,
    });
    return reply.code(200).send({ list });
  };
}
