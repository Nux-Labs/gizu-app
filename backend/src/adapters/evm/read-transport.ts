import { http } from "viem";
import type { HttpTransport } from "viem";

/** Short, bounded backoff for fresh chain reads; never reuse a failed read as data. */
export function evmReadTransport(
  url: string,
  fetchFn?: typeof fetch,
): HttpTransport {
  const transport = http(url, {
    fetchFn,
    timeout: 12000,
    retryCount: 3,
    retryDelay: 350,
    methods: {
      include: [
        "eth_chainId",
        "eth_blockNumber",
        "eth_call",
        "eth_estimateGas",
        "eth_getBlockByNumber",
        "eth_getBlockByHash",
        "eth_getBalance",
        "eth_getCode",
        "eth_getStorageAt",
        "eth_getTransactionCount",
        "eth_getLogs",
        "eth_getTransactionByHash",
        "eth_getTransactionReceipt",
        "eth_getProof",
        "eth_gasPrice",
        "eth_maxPriorityFeePerGas",
        "eth_feeHistory",
        "web3_clientVersion",
      ],
    },
  });
  return (options) => {
    const connection = transport(options);
    return {
      ...connection,
      request: (args, requestOptions) => {
        // Bound the whole read, including SDK backoff and a provider's Retry-After.
        const deadline = AbortSignal.timeout(12000);
        const signal = requestOptions?.signal
          ? AbortSignal.any([requestOptions.signal, deadline])
          : deadline;
        return connection.request(args, {
          ...requestOptions,
          methods: connection.config.methods,
          signal,
        });
      },
    };
  };
}
