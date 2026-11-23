const TIMEOUT_MS = 12_000;

/** GET JSON with the caller's cancellation plus a 12 s timeout. */
export async function getJson(
  url: string,
  signal: AbortSignal,
  unavailable: string,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort);
  if (signal.aborted) abort();
  const timeout = setTimeout(abort, TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(unavailable);
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

/** A failed API call with the server's error code when it sent one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * JSON request with optional body and headers and a caller-chosen timeout, failing with the
 * server's error code. Writes that wait for an on-chain confirmation need longer than reads.
 */
export async function sendJson(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  body: unknown,
  options: {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    timeoutMs?: number;
    unavailable: string;
  },
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort);
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(abort, options.timeoutMs ?? TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    // A proxy or gateway may answer with HTML; that is an unavailable service, not a crash.
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      if (response.ok) throw new Error(options.unavailable);
    }
    if (!response.ok) {
      const code =
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { code?: unknown }).code === "string"
          ? (parsed as { code: string }).code
          : null;
      throw new ApiError(response.status, code, options.unavailable);
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
