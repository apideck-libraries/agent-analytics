/**
 * Paid-access entry point. **EXPERIMENTAL** — see `payments.ts`.
 *
 * Kept out of the package root deliberately. Charging is opt-in and rare;
 * classification is what every consumer needs. Exporting these from the root
 * put the challenge builders, the gateway and the entitlement store into every
 * edge bundle whether or not the site ever charged anyone — the root grew from
 * 9.6 kB to 22.5 kB before anyone noticed.
 *
 *     import { paymentGate } from '@apideck/agent-analytics/payments'
 */
export * from './payments.js'
export * from './gateway.js'
export * from './entitlement.js'
