import type { AnalyticsAdapter, CaptureEvent } from '../types.js'

/**
 * Escape hatch for wiring a callback directly as an analytics adapter.
 * Useful when you want to log events, pipe them through your own SDK, or
 * compose multiple adapters.
 *
 * @example
 * ```ts
 * const devAnalytics = customAnalytics((e) => console.log('[doc_view]', e))
 * ```
 */
export function customAnalytics(
  capture: (event: CaptureEvent) => Promise<void> | void
): AnalyticsAdapter {
  return { capture }
}
