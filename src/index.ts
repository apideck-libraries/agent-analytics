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
