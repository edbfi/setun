/**
 * Whether a cookie set or deleted while answering this request is `Secure` (PRD §7, §21).
 *
 * True exactly when the request's public origin is `https:`. Behind `server.js`'s front
 * `url` carries ORIGIN's scheme; without ORIGIN the adapter assumes `https`, which keeps
 * cookies `Secure` behind a TLS-terminating proxy.
 *
 * Every server-side `cookies.set` and `cookies.delete` passes it explicitly. SvelteKit's
 * default is `secure: true` except in development and on `http://localhost`, and browsers
 * refuse a `Secure` cookie, and a `Secure` deletion, over plain HTTP from anywhere but
 * loopback. Left to that default, a plain-HTTP classroom server reached by its LAN address
 * never clears the session cookie on sign-out and never keeps the pupil's language.
 */
export function secureCookie(url: URL): boolean {
  return url.protocol === "https:";
}

/**
 * Options for deleting a cookie: the `path` it was set with, and `Secure` exactly when the
 * cookie itself was. A deletion is a `Set-Cookie` too, and a `Secure` one sent over plain
 * HTTP is ignored by the browser, which then keeps presenting the cookie it was meant to drop.
 */
export function cookieDeletion(url: URL, path: string): { path: string; secure: boolean } {
  return { path, secure: secureCookie(url) };
}

/**
 * Options for Paraglide's locale cookie (PRD §8, §18).
 *
 * Not `HttpOnly`: Paraglide's client reads it, which is the whole point. It carries a
 * locale and nothing else.
 */
export function localeCookieOptions(url: URL) {
  return {
    path: "/",
    httpOnly: false,
    sameSite: "lax",
    secure: secureCookie(url),
    maxAge: 60 * 60 * 24 * 365,
  } as const;
}
