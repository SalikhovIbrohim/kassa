import type { TestApp } from "./test-app.js";

export const SESSION_COOKIE = "kassa_session";

export function postJson(app: TestApp, path: string, body: unknown, cookie?: string, headers: Record<string, string> = {}) {
  return fetch(`${app.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
    body: JSON.stringify(body),
  });
}

export function putJson(app: TestApp, path: string, body: unknown, cookie?: string) {
  return fetch(`${app.baseUrl}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

/** A DELETE, with a JSON body only when there is something to say (a reason). */
export function deleteRequest(app: TestApp, path: string, cookie?: string, body?: unknown) {
  return fetch(`${app.baseUrl}${path}`, {
    method: "DELETE",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function get(app: TestApp, path: string, cookie?: string) {
  return fetch(`${app.baseUrl}${path}`, { headers: cookie ? { cookie } : {} });
}

/** The raw Set-Cookie header for the session cookie, if the response has one. */
export function sessionSetCookie(response: Response): string | undefined {
  return response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
}

/** What a browser would send back: `name=value` without the attributes. */
export function cookieToSend(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

export async function loginAs(app: TestApp, login: string, password: string): Promise<string> {
  const response = await postJson(app, "/api/login", { login, password });
  const setCookie = sessionSetCookie(response);
  if (response.status !== 200 || !setCookie) {
    throw new Error(`Login for ${login} failed with status ${response.status}`);
  }
  return cookieToSend(setCookie);
}
