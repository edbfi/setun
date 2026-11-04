import { failureCodeForStatus, GatewayError, redactCredentials } from "./errors";

/**
 * The CPA HTTP client (PRD §9).
 *
 * CPA is internal and replaceable, reachable only over the private Docker
 * network with listener authentication. This module is the only place its base
 * URL and listener key exist; if CPA is replaced, this and the dialects change
 * and nothing else does.
 */

export interface GatewayClientOptions {
  /** e.g. `http://cpa:8317`. Never sent to the browser (§9, §21). */
  readonly baseUrl: string;
  /** The listener key shared with CPA. Never logged, never serialised (§9, §21). */
  readonly listenerKey: string;
  /** Injectable for tests; defaults to the platform fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

export class GatewayClient {
  readonly #baseUrl: string;
  readonly #listenerKey: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: GatewayClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#listenerKey = options.listenerKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /**
   * POST JSON to a gateway path, returning the raw response.
   *
   * Every failure leaves as a `GatewayError`: the caller never sees a fetch
   * error, a status code or a response body it might pass on (§21).
   */
  async post(
    path: string,
    body: unknown,
    init: { signal?: AbortSignal; accept?: string } = {},
  ): Promise<Response> {
    return this.#send(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        accept: init.accept ?? "application/json",
      },
      signal: init.signal,
    });
  }

  async get(path: string, init: { signal?: AbortSignal } = {}): Promise<Response> {
    return this.#send(path, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: init.signal,
    });
  }

  async #send(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    // Listener authentication (§9). Set here and nowhere else.
    headers.set("authorization", `Bearer ${this.#listenerKey}`);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, { ...init, headers });
    } catch (cause) {
      // An abort is the student cancelling their own turn — it is not a failure
      // and must stay distinguishable from one.
      if (cause instanceof Error && cause.name === "AbortError") throw cause;

      throw new GatewayError(
        "unavailable",
        redactCredentials(cause instanceof Error ? cause.message : String(cause)),
      );
    }

    if (!response.ok) {
      // Read the body for the operator log only; it never travels further.
      const detail = await response
        .text()
        .then((text) => redactCredentials(text.slice(0, 500)))
        .catch(() => "");

      throw new GatewayError(
        failureCodeForStatus(response.status, detail),
        `status ${response.status}: ${detail}`,
        response.status,
      );
    }

    return response;
  }

  /** Streaming responses must have a body; a missing one is an upstream failure. */
  static requireBody(response: Response): ReadableStream<Uint8Array> {
    if (!response.body) throw new GatewayError("unavailable", "upstream returned no body");
    return response.body;
  }
}
