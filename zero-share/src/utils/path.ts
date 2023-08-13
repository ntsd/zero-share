export function joinPath(...paths: string[]): string {
  return paths.map((path) => path.replace(/^\/+|\/+$/g, '')).join('/');
}

export function buildURLParams(obj: { [key: string]: string }): string {
  const queryParams = Object.entries(obj)
    .filter(([_, value]) => {
      return value !== '';
    })
    .map(([key, value]) => {
      return encodeURIComponent(key) + '=' + encodeURIComponent(value);
    })
    .join('&');

  return queryParams;
}

export function buildURL(baseURL: string, path: string, params: { [key: string]: string }): string {
  const joinedPath = joinPath(baseURL, path);
  const queryParams = buildURLParams(params);

  return `${joinedPath}?${queryParams}`;
}
