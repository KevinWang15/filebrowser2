export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public code = 'REQUEST_FAILED') {
    super(message)
  }
}

export function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
