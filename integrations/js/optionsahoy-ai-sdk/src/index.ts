// AlphaLatitude Inc. © 2026
//
// optionsahoy-ai-sdk: Vercel AI SDK tools for the OptionsAhoy equity-
// compensation calculators. Keyless, deterministic, full federal tax code plus
// all 50 states and DC. See https://optionsahoy.com/for-agents.

export {
  createOptionsAhoyTools,
  optionsAhoyTools,
  type OptionsAhoyToolName,
  type OptionsAhoyClientOptions,
} from './tools.js';

export {
  callEndpoint,
  DEFAULT_BASE_URL,
  type EndpointSlug,
  type FetchLike,
} from './client.js';

export {
  amtIsoParameters,
  nsoParameters,
  rsuParameters,
  concentrationParameters,
  protectivePutParameters,
  qsbsParameters,
  equityFundingParameters,
  filingStatus,
  stateCode,
  sector,
} from './schemas.js';
