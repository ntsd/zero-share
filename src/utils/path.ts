export function buildURL(baseURL: string, path: string, params: { [key: string]: string }): string {
  const joinedPath = [baseURL, path].map((p) => p.replace(/^\/+|\/+$/g, '')).join('/');
  const queryParams = Object.entries(params)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value))
    .join('&');

  return `${joinedPath}?${queryParams}`;
}
