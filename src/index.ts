/**
 * Package root: detection, classification, policy and capture.
 *
 * Deliberately excludes the paid-access surface and the firewall recommender.
 * Both are opt-in and neither belongs in an edge bundle by default:
 *
 *     @apideck/agent-analytics/verify     identity verification + IP ranges
 *     @apideck/agent-analytics/payments   402 challenges, gateways, entitlements
 *     @apideck/agent-analytics/firewall    WAF rule recommendations (offline)
 */
export { trackVisit } from './track.js'
export {
  AI_BOT_PATTERN,
  HTTP_CLIENT_PATTERN,
  classifyAgent,
  classifyRequest,
  detectHeadless,
  firstUserAgentProduct,
  isAiBot,
  isHttpClient,
  parseBotName
} from './bots.js'
export type { AgentClassification, AgentKind, HeadlessDetection } from './bots.js'
export { hashId, randomSecret, HashSecretError } from './hash.js'
export { CaptureTransportError } from './errors.js'
export { agentIntent, agentPolicy } from './policy.js'
export type {
  GatewayResult,
  Meter,
  MeterRecord,
  MppxResponse,
  PaymentGateOptions,
  PaymentGateway,
  X402GatewayOptions
} from './gateway.js'
export type {
  MppChallenge,
  PaymentChallenge,
  PaymentChallengeOptions,
  PaymentProtocol,
  PaymentRequirements,
  SubmittedPayment,
  X402Challenge
} from './payments.js'
export type {
  AgentAction,
  AgentDecision,
  AgentIntent,
  AgentPolicyOptions
} from './policy.js'
export { posthogAnalytics } from './adapters/posthog.js'
export { webhookAnalytics } from './adapters/webhook.js'
export { customAnalytics } from './adapters/custom.js'
export type {
  AnalyticsAdapter,
  BotVerificationLike,
  CaptureEvent,
  TrackVisitOptions
} from './types.js'
