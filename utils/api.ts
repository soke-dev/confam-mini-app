/**
 * Where the backend lives, and what to do when it does not.
 *
 * `EXPO_PUBLIC_API_URL` is inlined at build time by Expo, so this is a
 * constant for the life of the build rather than something to re-check.
 * While it is unset — the case until the API is deployed — callers are told
 * plainly instead of being handed a fabricated success.
 */
export const API_BASE = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/+$/, '');

export const hasApi: boolean = API_BASE.length > 0;

/** http→ws, https→wss. Same host and port as the API — one deploy. */
export function realtimeUrl(): string | null {
  if (!hasApi) return null;
  return `${API_BASE.replace(/^http/, 'ws')}/realtime`;
}

/**
 * A result rather than an exception.
 *
 * Nearly every call here sits behind something a person already did — walked
 * to a filling station, recorded a clip, waited on mobile data. A thrown error
 * makes the caller choose between a try/catch at each site or an unhandled
 * rejection, and the tempting third option is to treat any failure as a pass.
 * Returning the failure as a value makes handling it the path of least
 * resistance instead of the one that needs discipline.
 */
/**
 * How apiFetch gets a Privy token without being a hook.
 *
 * The token lives behind `usePrivy`, which only a component can reach, but
 * apiFetch is a plain function called from anywhere. Rather than thread a
 * token through every call site — where one forgotten argument means an
 * anonymous request that fails confusingly — a component registers a getter
 * once at startup and every request picks it up.
 *
 * Privy rotates access tokens, so this asks for one per request rather than
 * caching. The SDK returns the cached token when it is still valid, so this
 * is a memory read in the normal case, not a network round trip.
 */
let tokenProvider: (() => Promise<string | null>) | null = null;

export function setTokenProvider(fn: (() => Promise<string | null>) | null): void {
  tokenProvider = fn;
}

/**
 * What to do when a credential we actually sent comes back refused.
 *
 * Privy rotates its own tokens, so this almost never fires there. A wallet
 * session is different: it is a fixed string with an expiry, and the server
 * will stop honouring it when it lapses, when the account is re-keyed, or
 * when the signing secret changes. Nothing was watching for that, so a stale
 * session produced "invalid_token" on whatever screen the person happened to
 * be using — an error message where a sign-in prompt belonged.
 *
 * The handler clears the session, which makes the app's own auth gate send
 * them back to sign in, which is where the wallet connect lives.
 */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  /**
   * `code` is the machine-readable identifier to branch on; `detail` is the
   * sentence to put in front of a person. Keeping them apart stops error
   * codes leaking into the interface.
   */
  | { ok: false; code: string | null; detail: string; status: number };

export async function apiFetch<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<ApiResult<T>> {
  if (!hasApi) {
    return { ok: false, code: 'no_api', detail: 'this build has no server', status: 0 };
  }

  const { timeoutMs = 30_000, ...rest } = init;

  /**
   * React Native's fetch has no timeout of its own. On a stalled connection
   * the promise never settles, and a screen waiting on it waits forever
   * behind a spinner with no way out. The abort turns that into an ordinary
   * failure the caller can act on.
   */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // A failure to produce a token is not a failure to make the request: some
  // endpoints are readable anonymously, and the server decides which.
  let token: string | null = null;
  try {
    token = (await tokenProvider?.()) ?? null;
  } catch {
    token = null;
  }

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...rest,
      signal: controller.signal,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        // FormData must set its own Content-Type: the multipart boundary is
        // generated per request and overriding it makes the body unparseable.
        ...(rest.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...rest.headers,
      },
    });

    /**
     * A 304 carries no body, so there is nothing to parse and nothing to
     * return. It should never happen now the API sends no ETag, but a proxy
     * or a browser cache can still produce one, and the failure it causes is
     * nasty: a response that looks successful while carrying no data.
     */
    if (response.status === 304) {
      return { ok: false, code: 'cached_empty', detail: 'The server sent no data.', status: 304 };
    }

    const raw = await response.text();
    let parsed: unknown = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return {
          ok: false,
          status: response.status,
          code: 'unreadable',
          detail: 'the server sent something unreadable',
        };
      }
    }

    /**
     * A credential we sent, refused.
     *
     * Guarded on having sent one, which matters: several calls are made
     * deliberately without a token and a 401 is their normal answer. Treating
     * those as an expired session would sign people out at startup, every
     * time, for no reason.
     */
    if (response.status === 401 && token) onUnauthorized?.();

    if (!response.ok) {
      /**
       * The server sends two things, and they are for different readers:
       * `error` is a stable code for the app to branch on, `detail` is a
       * sentence for the person. This used to surface the code, so somebody
       * was shown "relayer_unconfigured" where the server had written
       * "Withdrawals are not available yet."
       *
       * Both are returned now: `code` to compare against, `detail` to show.
       */
      const body = (parsed ?? {}) as { error?: unknown; detail?: unknown };
      const code = typeof body.error === 'string' ? body.error : null;
      const detail =
        typeof body.detail === 'string' && body.detail.length > 0
          ? body.detail
          : (code ?? `the server said ${response.status}`);

      return { ok: false, code, detail, status: response.status };
    }

    return { ok: true, data: parsed as T };
  } catch (error) {
    /*
     * Asked of the controller, not of the error.
     *
     * React Native does not settle on one shape here: depending on the
     * platform an aborted fetch arrives as an AbortError, as a DOMException,
     * or as a plain "Network request failed" TypeError from the native layer.
     * Reading the name alone reported our own timeout as the server being
     * unreachable, which sent somebody looking for a network fault that was
     * never there. The controller knows.
     */
    const aborted =
      controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
    /*
     * The underlying message is carried through.
     *
     * "the server could not be reached" is the right thing to show somebody
     * whose train went into a tunnel, and it is useless when the request never
     * left the device for a reason that has nothing to do with the network. A
     * funding relay has failed repeatedly with the server confirming it never
     * arrived, and this string was everything anybody could see. What React
     * Native actually threw goes on the screen now.
     */
    const because = error instanceof Error && error.message ? ` (${error.message})` : '';
    return {
      ok: false,
      status: 0,
      code: aborted ? 'timeout' : 'unreachable',
      detail: aborted
        ? 'the network did not respond'
        : `the server could not be reached${because}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends a picked image to the server and returns the URL it was stored at.
 *
 * A local `file://` or `blob:` URI only means something on the device that
 * produced it, so storing one is how an avatar survives until the next sign-in
 * and no further. This exchanges it for a URL any device can load.
 */
export async function uploadAvatar(uri: string): Promise<ApiResult<{ url: string }>> {
  if (!hasApi) return { ok: false, code: 'no_api', detail: 'No server configured.', status: 0 };

  const form = new FormData();

  if (uri.startsWith('data:') || uri.startsWith('blob:')) {
    // Web hands back a blob URL; fetch turns it back into bytes.
    const blob = await fetch(uri).then((r) => r.blob());
    form.append('avatar', blob, 'avatar.jpg');
  } else {
    // React Native accepts this shape directly and streams the file itself.
    form.append('avatar', {
      uri,
      name: 'avatar.jpg',
      type: 'image/jpeg',
    } as unknown as Blob);
  }

  return apiFetch<{ url: string }>('/auth/avatar', { method: 'POST', body: form });
}

/** Turns a stored relative path into something an <Image> can load. */
export function mediaUrl(path: string | null): string | null {
  if (!path) return null;
  if (path.startsWith('http') || path.startsWith('data:')) return path;
  return `${API_BASE}${path}`;
}
