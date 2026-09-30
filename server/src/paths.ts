/** The path part of a request URL, without the query string. */
export function pathnameOf(url: string): string {
  return new URL(url, "http://localhost").pathname;
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}
