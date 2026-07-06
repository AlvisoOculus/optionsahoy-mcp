// AlphaLatitude Inc. © 2026
//
// Keyless REST client for the OptionsAhoy calculators. Each tool POSTs a JSON
// payload to https://optionsahoy.com/api/v1/<slug> and returns the parsed
// `result`. No OptionsAhoy account and no API key are read, stored, or sent.

/** The seven public calculator endpoints, keyed by their REST slug. */
export type EndpointSlug =
  | 'amt-iso'
  | 'nso'
  | 'rsu-sell-vs-hold'
  | 'concentration'
  | 'protective-put'
  | 'qsbs'
  | 'equity-funding';

/** A `fetch`-compatible function. Defaults to the runtime global `fetch`. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface OptionsAhoyClientOptions {
  /** Base URL of the OptionsAhoy REST API. Defaults to https://optionsahoy.com. */
  baseURL?: string;
  /** Override the `fetch` implementation (useful for tests). Defaults to global `fetch`. */
  fetch?: FetchLike;
}

/** Default API origin. The `/api/v1/*` endpoints are keyless and rate-limited. */
export const DEFAULT_BASE_URL = 'https://optionsahoy.com';

/** Shape of a successful OptionsAhoy REST response: `{ ok: true, result: {...} }`. */
interface ApiEnvelope {
  ok?: boolean;
  result?: unknown;
  error?: string;
}

/**
 * POST `payload` to `/api/v1/<slug>` and return the parsed `result`.
 * Throws an Error carrying the API's `error` string on a non-2xx response or
 * an `ok: false` envelope.
 */
export async function callEndpoint(
  slug: EndpointSlug,
  payload: Record<string, unknown>,
  options: OptionsAhoyClientOptions = {},
): Promise<unknown> {
  const baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof doFetch !== 'function') {
    throw new Error(
      'No fetch implementation available. Pass { fetch } to the tool factory or run on a runtime with a global fetch (Node 18+).',
    );
  }

  const url = `${baseURL}/api/v1/${slug}`;
  const response = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  let data: ApiEnvelope;
  try {
    data = (await response.json()) as ApiEnvelope;
  } catch {
    throw new Error(`OptionsAhoy request to ${url} failed (HTTP ${response.status}, non-JSON body)`);
  }

  if (!response.ok || data.ok === false) {
    throw new Error(data.error ?? `OptionsAhoy request to ${url} failed (HTTP ${response.status})`);
  }
  return data.result;
}
