// Derive the app's deployment base URL from a page URL string: origin + the
// directory of the pathname (up to and including its last '/'). The offer
// page is always the deployment's base-root page (`/` or `index.html` inside
// it), so this is the containing directory of that page:
//
//   https://zero-share.github.io/              -> https://zero-share.github.io/
//   https://zero-share.github.io/index.html    -> https://zero-share.github.io/
//   https://ntsd.github.io/zero-share/         -> https://ntsd.github.io/zero-share/
//
// The base must come from a URL object (origin + pathname), never from the
// raw href: the query string and any fragment are dropped (a fragment left in
// the base would land before `/receive` in a generated link, where URL
// parsing treats everything after `#` as a fragment), while a sub-path
// deployment location (e.g. an org GitHub Pages site) is preserved. The
// incidental leaf component (`index.html`) is dropped — the app has no
// sub-path routes, so the offer page is never reachable deeper than the
// base.
export function appBaseFrom(pageUrl: string): string {
  const u = new URL(pageUrl);
  const dir = u.pathname.endsWith('/')
    ? u.pathname
    : u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
  return u.origin + dir;
}

// The URL the Receive page should bounce to when its link is missing the `s`
// param: the app's offer page, i.e. the deployment base with the `receive`
// route leaf stripped from the current pathname. The receive page always
// lives at `<base>/receive/` (or `/receive/` at the domain root), so dropping
// that one segment — plus any incidental leaf — and taking the directory of
// what remains is the containing directory of the offer page. The base comes
// from a URL object so a fragment or query string in the receive URL can
// never leak into the bounce target.
export function receiveBounceTarget(receiveUrl: string): string {
  const u = new URL(receiveUrl);
  return appBaseFrom(u.origin + u.pathname.replace(/\/receive\/?$/, '/'));
}

export function buildURL(baseURL: string, path: string, params: { [key: string]: string }): string {
  const joinedPath = [baseURL, path].map((p) => p.replace(/^\/+|\/+$/g, '')).join('/');
  const queryParams = Object.entries(params)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value))
    .join('&');

  return `${joinedPath}?${queryParams}`;
}
