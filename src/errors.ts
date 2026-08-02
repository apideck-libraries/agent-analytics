/** Thrown when the analytics backend rejects, errors, or times out a capture. */
export class CaptureTransportError extends Error {
  readonly status: number | undefined
  readonly body: string | undefined
  constructor(message: string, status?: number, body?: string) {
    super(message)
    this.name = 'CaptureTransportError'
    this.status = status
    this.body = body
  }
}
