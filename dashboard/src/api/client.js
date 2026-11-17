let csrfTokenInMemory = '';

export function setCsrfToken(token) {
  csrfTokenInMemory = token || '';
}

export function getCsrfToken() {
  return csrfTokenInMemory;
}

export async function apiRequest(method, path, body = undefined) {
  const headers = {
    Accept: 'application/json',
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && csrfTokenInMemory) {
    headers['X-CSRF-Token'] = csrfTokenInMemory;
  }

  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const err = new Error(json?.error?.message || res.statusText || 'Request failed');
    err.code = json?.error?.code || `HTTP_${res.status}`;
    err.status = res.status;
    throw err;
  }
  return json.data;
}

