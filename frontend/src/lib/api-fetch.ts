type TokenGetter = () => string | null

export function createApiFetch(getToken: TokenGetter) {
  return async function apiFetch(
    url: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const token = getToken()
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    }

    // Don't set Content-Type for FormData (browser sets it with boundary)
    if (options.body instanceof FormData) {
      delete headers["Content-Type"]
    } else if (!headers["Content-Type"]) {
      headers["Content-Type"] = "application/json"
    }

    if (token) {
      headers["Authorization"] = `Bearer ${token}`
    }

    return fetch(url, { ...options, headers })
  }
}
