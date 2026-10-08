export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message) }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch('/api' + path, {
    method: options.method ?? 'GET', credentials: 'same-origin', signal: options.signal,
    headers: { 'X-Filebrowser-Request': '1', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('fb-session-expired'))
    const error = await response.json().catch(() => ({ message: 'The server could not be reached', code: 'REQUEST_FAILED' }))
    throw new ApiError(error.message, response.status, error.code)
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>
}

export function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong' }
