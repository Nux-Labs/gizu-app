import {
  detailPeriods,
  type DetailPeriod,
  type TokenDetails,
  type TokenDetailsService,
} from "@/domain/tokenDetails";
import { getJson } from "./http";

const UNAVAILABLE = "Token details unavailable.";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
const nullableString = (value: unknown) => value === null || typeof value === "string";
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

function isChart(value: unknown, period: DetailPeriod): boolean {
  if (value === null) return true;
  return (
    isRecord(value) &&
    value.period === period &&
    Array.isArray(value.points) &&
    value.points.length >= 2 &&
    value.points.every(
      (point, index, points) =>
        isRecord(point) &&
        Number.isSafeInteger(point.time) &&
        positive(point.price) &&
        (index === 0 || (point.time as number) > (points[index - 1] as { time: number }).time),
    )
  );
}

function isDetails(value: unknown, address: string, period: DetailPeriod): value is TokenDetails {
  if (!isRecord(value) || !isRecord(value.sessions)) return false;
  const sessions = value.sessions;
  return (
    value.chainId === 4663 &&
    typeof value.address === "string" &&
    value.address.toLowerCase() === address.toLowerCase() &&
    typeof value.symbol === "string" &&
    value.symbol.length > 0 &&
    typeof value.name === "string" &&
    typeof value.logoURI === "string" &&
    (value.kind === "stock" || value.kind === "fund") &&
    typeof value.description === "string" &&
    nullableString(value.isin) &&
    (value.sharesPerToken === null ||
      (typeof value.sharesPerToken === "string" && /^\d+(\.\d+)?$/.test(value.sharesPerToken))) &&
    typeof sessions.regular === "boolean" &&
    typeof sessions.extended === "boolean" &&
    typeof sessions.overnight === "boolean" &&
    (value.priceUsd === null || positive(value.priceUsd)) &&
    isChart(value.chart, period)
  );
}

export function createTokenDetailsService(baseUrl: string): TokenDetailsService {
  const root = baseUrl.replace(/\/$/, "");
  return {
    async details(address, period, signal) {
      if (!root) throw new Error("Token details are not configured.");
      if (!ADDRESS.test(address) || !detailPeriods.includes(period)) throw new Error(UNAVAILABLE);
      const body = await getJson(
        `${root}/v1/tokens/4663/${address}/details?period=${period}`,
        signal,
        UNAVAILABLE,
      );
      if (!isDetails(body, address, period)) throw new Error(UNAVAILABLE);
      return body;
    },
  };
}

export const tokenDetailsService = createTokenDetailsService(
  process.env.EXPO_PUBLIC_API_URL ?? (__DEV__ ? "http://127.0.0.1:3000" : ""),
);
