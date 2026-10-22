// Talking to the local server. Every API call carries the token from the URL
// that `code-review-agent ui` printed.

let token = null;

export function initToken() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('t');
  if (fromUrl) {
    try { sessionStorage.setItem('cra-token', fromUrl); } catch { /* storage blocked */ }
    url.searchParams.delete('t');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    token = fromUrl;
  } else {
    try { token = sessionStorage.getItem('cra-token'); } catch { token = null; }
  }
  return token;
}

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'X-CRA-Token': token ?? '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    const error = new Error(data?.error ?? `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return res;
}

export async function api(path, options) {
  return (await request(path, options)).json();
}

export async function apiText(path) {
  return (await request(path)).text();
}

export const withToken = (path) => `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token ?? '')}`;

export const pdfUrl = (id, download = false) => withToken(`/api/history/${id}/pdf${download ? '?download=1' : ''}`);
