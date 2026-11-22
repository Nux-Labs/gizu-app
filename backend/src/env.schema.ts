import { z } from "zod";
import {
  catalogChainsSchema,
  catalogVaultsSchema,
  jsonEnvironment,
  defaultCatalogChains,
  vaultChainsEnvironment,
} from "./domain/catalog.ts";

const apiEnvSchema = z
  .object({
    NODE_ENV: z.enum(["local", "production", "test"]),
    PORT: z.coerce.number().int().positive(),
    DATABASE_URL: z.string().min(1),
    ONEINCH_API_KEY: z.string().min(1),
    AURORA_API_KEY: z.string().min(1),
    PIMLICO_API_KEY: z.string().min(1),
    ETHEREUM_RPC_URL: z
      .url()
      .refine((value) => value.startsWith("https://"))
      .optional(),
    ROBINHOOD_RPC_URL: z
      .url()
      .refine((value) => value.startsWith("https://"))
      .optional(),
    BASE_RPC_URL: z
      .url()
      .refine((value) => value.startsWith("https://"))
      .optional(),
    EARN_GATEWAY_RECOVERY_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional(),
    RECOVERY_UPLOAD_CALLS_PER_MINUTE:z.coerce.number().int().positive().max(100000).optional(),
    RECOVERY_UPLOAD_BYTES_PER_MINUTE:z.coerce.number().int().positive().max(1024*1024*1024).optional(),
    RECOVERY_UPLOAD_BYTES_PER_DAY:z.coerce.number().int().positive().max(1024*1024*1024*1024).optional(),
    RECOVERY_UPLOAD_MAX_CLIENTS:z.coerce.number().int().positive().max(1000000).optional(),
    RECOVERY_STORAGE_MAX_BYTES:z.coerce.number().int().positive().max(1024*1024*1024*1024).optional(),
    RECOVERY_STORAGE_MAX_OBJECTS:z.coerce.number().int().positive().max(10000000).optional(),
    // Legacy client admission only; new native settlement uses balance snapshots.
    EARN_AURORA_HISTORY_QUALIFIED: z.enum(["true", "false"]).optional(),
    EARN_ANVIL_PATH: z.string().min(1).optional(),
    EARN_AURORA_FEE_QUALIFICATION_JSON: z.string().min(1).max(16384).optional(),
    VAULT_CHAINS: vaultChainsEnvironment.optional(),
    CATALOG_CHAINS_JSON: jsonEnvironment(catalogChainsSchema).optional(),
    CATALOG_VAULTS_JSON: jsonEnvironment(catalogVaultsSchema).optional(),
    MORPHO_API_URL: z
      .url()
      .refine((value) => value.startsWith("https://"))
      .optional(),
    // Sealed Strategies. All three of registry, chain and relayer key enable the routes together.
    STRATEGY_REGISTRY_ADDRESS: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
    STRATEGY_CHAIN_ID: z
      .enum(["8453", "84532"])
      .transform((value) => Number(value) as 8453 | 84532)
      .optional(),
    STRATEGY_RPC_URL: z
      .url()
      .refine((value) => value.startsWith("https://"))
      .optional(),
    /** Relayer key paying registry gas; it holds no user funds. */
    STRATEGY_RELAYER_KEY: z
      .string()
      .regex(/^(0x)?[0-9a-fA-F]{64}$/)
      .transform((value) => (value.startsWith("0x") ? value : `0x${value}`) as `0x${string}`)
      .optional(),
    STRATEGY_COMMIT_JITTER_MAX_SECONDS: z.coerce.number().int().min(0).max(600).optional(),
  })
  .superRefine((env, context) => {
    const strategyKeys = [
      env.STRATEGY_REGISTRY_ADDRESS,
      env.STRATEGY_CHAIN_ID,
      env.STRATEGY_RELAYER_KEY,
    ];
    if (strategyKeys.some((value) => value !== undefined) && strategyKeys.some((value) => value === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["STRATEGY_REGISTRY_ADDRESS"],
        message: "STRATEGY_REGISTRY_ADDRESS, STRATEGY_CHAIN_ID and STRATEGY_RELAYER_KEY are set together",
      });
    }
    const known = new Set(
      (env.VAULT_CHAINS
        ? [...defaultCatalogChains, ...(env.CATALOG_CHAINS_JSON ?? [])]
        : (env.CATALOG_CHAINS_JSON ?? defaultCatalogChains)
      ).map((chain) => chain.id),
    );
    if (env.VAULT_CHAINS?.some((id) => !known.has(id))) {
      context.addIssue({
        code: "custom",
        path: ["VAULT_CHAINS"],
        message: "unknown chain IDs require metadata in CATALOG_CHAINS_JSON",
      });
    }
    if (env.CATALOG_VAULTS_JSON?.some((vault) => !known.has(vault.chainId))) {
      context.addIssue({
        code: "custom",
        path: ["CATALOG_VAULTS_JSON"],
        message: env.VAULT_CHAINS
          ? "every vault must belong to a known catalog chain"
          : "every vault must belong to an enabled catalog chain",
      });
    }
  });

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function parseApiEnv(source: unknown): ApiEnv {
  const result = apiEnvSchema.safeParse(source);
  if (result.success) {
    return result.data;
  }
  const details = result.error.issues
    .map((issue) => {
      let key = "env";
      if (issue.path.length > 0) {
        key = issue.path.map(String).join(".");
      }
      return `${key}: ${issue.message}`;
    })
    .join("; ");
  throw new Error(`invalid env: ${details}`);
}
