/**
 * Gateway failure mapping (PRD §9, §16, §21).
 *
 * "Gateway failures produce a single student-facing message about temporary
 * unavailability. Upstream URLs, provider identifiers, OAuth errors, tokens, and
 * stack traces never reach the browser."
 *
 * So the adapter raises one error type carrying two separate things: a stable
 * code the interface turns into a localised message, and a detail string that is
 * logged and never serialised toward a browser.
 */

export type GatewayFailureCode =
  /** Anything upstream: connection refused, 5xx, malformed stream, timeout. */
  | "unavailable"
  /** The listener key was rejected — an operator misconfiguration, not a student problem. */
  | "unauthorised"
  /** The upstream declined this request specifically (bad model id, malformed request). */
  | "rejected"
  /**
   * The request did not fit the model's context window (§10).
   *
   * Told apart from `rejected` because it is the one refusal Setun can recover
   * from on its own: shorten what it sends and ask again. Recognised by what the
   * provider *says*, never by status alone — a 400 is just as often a bad model
   * id, and a 429 tokens-per-minute limit reads "request too large" too.
   */
  | "context-overflow";

export class GatewayError extends Error {
  readonly code: GatewayFailureCode;
  /** Operator-facing. Logged; never sent to the browser (§21). */
  readonly detail: string;
  /**
   * The upstream HTTP status, when there was one (§9).
   *
   * Three codes collapse into one `rejected`, which is the right vocabulary for
   * a student-facing message and the wrong one for a dialect deciding whether an
   * endpoint exists at all: a 404 from `/v1/responses` means "use the other
   * transport", and a 400 means "this request was wrong". The status used to
   * survive only as text inside `detail`.
   *
   * Absent when the failure never reached a response — a refused connection, a
   * malformed stream, a dialect refusing a request of its own.
   */
  readonly status?: number;

  constructor(code: GatewayFailureCode, detail: string, status?: number) {
    super(`gateway ${code}`);
    this.name = "GatewayError";
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

/**
 * Redaction lives in `$lib/server/logging`, and is re-exported here.
 *
 * The gateway was the first caller and is still the loudest one, but the MCP
 * registry, the agent loop and the job scheduler log failures too — one copy of
 * the patterns, four importers (§16, §21, §6.1).
 */
export { redactCredentials, redactHeaders } from "../logging";

/**
 * What providers say when a request outgrows the context window.
 *
 * Every provider behind CPA phrases it differently, and CPA passes their bodies
 * through: OpenAI's `context_length_exceeded` code and "maximum context length",
 * Anthropic's "prompt is too long", Gemini's "input token count … exceeds",
 * and the variants local and compatibility servers write. Narrow phrases only:
 * a pattern that also matched a bad-request or rate-limit message would send a
 * broken request round the compaction loop instead of to the operator log.
 */
const CONTEXT_OVERFLOW =
  /context_length_exceeded|model_context_window_exceeded|maximum context length|context (?:length|window) (?:exceeded|is exceeded)|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context|prompt is too long|input is too long|input (?:token count|tokens?) .{0,40}exceed|too many (?:input )?tokens|reduce the length of the (?:messages|input|prompt)/i;

/**
 * Whether a refusal says the request outgrew the model's context (§10).
 *
 * 401 and 403 are credentials and 429 is a rate limit — OpenAI's
 * tokens-per-minute message reads "Request too large … tokens" — so none of
 * them is ever an overflow, whatever the text. Nor is a bare 413: that is a
 * proxy's limit on bytes, which two phone photos reach long before any model's
 * window, and compacting the history does nothing for it.
 */
export function isContextOverflow(status: number | undefined, detail: string): boolean {
  if (status === 401 || status === 403 || status === 429) return false;
  return CONTEXT_OVERFLOW.test(detail);
}

/** Map an upstream HTTP status, and the body it came with, onto a failure code. */
export function failureCodeForStatus(status: number, detail = ""): GatewayFailureCode {
  if (status === 401 || status === 403) return "unauthorised";
  if (status >= 400 && status < 500 && isContextOverflow(status, detail)) return "context-overflow";
  if (status === 400 || status === 404 || status === 413 || status === 422) return "rejected";
  return "unavailable";
}

/**
 * The code for a failure a stream reported mid-flight, with no status.
 *
 * The Responses transport and Anthropic's both report a refused request as an
 * `error` event inside a 200 stream, so the overflow has to be read there too.
 */
export function streamFailureCode(message: string): GatewayFailureCode {
  return isContextOverflow(undefined, message) ? "context-overflow" : "unavailable";
}
