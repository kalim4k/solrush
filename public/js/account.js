// Accounts against this project's own /api, replacing Supabase.
//
// The shape is kept deliberately close to what the app already expected — a
// `session` object carrying an `access_token` — so the rest of app.js barely
// changes. What is genuinely different is where the token lives.
//
// Supabase kept its session in localStorage and refreshed it in the background.
// There is no refresh here: the token is valid for thirty days and is simply
// re-issued at the next login. That is the right trade for a game. A refresh
// endpoint is a second thing that can fail at boot, and the cost of getting it
// wrong is a player who cannot log in; the cost of not having it is a login
// screen once a month.

const KEY = 'wr_session';

let session = null;
try {
  const raw = localStorage.getItem(KEY);
  if (raw) session = JSON.parse(raw);
} catch { session = null; }

export function getSession() { return session; }

export function setSession(s) {
  session = s || null;
  try {
    if (session) localStorage.setItem(KEY, JSON.stringify(session));
    else localStorage.removeItem(KEY);
  } catch { /* private mode; the session simply does not survive a reload */ }
  return session;
}

export function clearSession() { return setSession(null); }

export const authHeader = () =>
  (session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {});

/* Every call answers {ok, data} or {ok:false, error}. Never throws: these are
   wired straight to button handlers, and an unhandled rejection there leaves
   the button spinning with no message. */
async function post(path, body) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) return { ok: false, error: data.error || 'err_generic', data };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'network' };
  }
}

export async function register(email, password, nick, device) {
  const r = await post('/api/register', { email, password, nick, device });
  if (r.ok) setSession({ access_token: r.data.token, user: r.data.user });
  return r;
}

export async function login(email, password, device) {
  const r = await post('/api/resolve-login', { email, password, device });
  if (r.ok) setSession({ access_token: r.data.token, user: r.data.user });
  return r;
}

export function logout() { clearSession(); }

// The profile, or null when the token has expired — which is the normal way a
// thirty-day session ends, so it must read as "logged out", not as an error.
export async function fetchProfile(tzOffsetMin = 0) {
  if (!session) return null;
  try {
    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ tz: tzOffsetMin }),
    });
    if (res.status === 401) { clearSession(); return null; }
    const data = await res.json();
    return data.error ? null : data;
  } catch {
    return null;
  }
}

export const startReset = (email) => post('/api/reset/start', { email });
export const finishReset = (token, password) => post('/api/reset/finish', { token, password });

// A reset link arrives as /?reset=<token>. Read once at boot, then scrubbed
// from the address bar so the token is not left in history or copied out of it
// when the player shares the page.
export function takeResetToken() {
  try {
    const url = new URL(location.href);
    const token = url.searchParams.get('reset');
    if (!token) return '';
    url.searchParams.delete('reset');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    return token;
  } catch { return ''; }
}

/* Maps a server error code to an i18n key. Kept here rather than in the button
   handler so the server and the wording stay one hop apart. */
export function authErrorKey(code) {
  return ({
    bad_email: 'err_email_bad',
    email_taken: 'err_email_taken',
    weak_password: 'err_password_short',
    bad_credentials: 'err_login_not_found',
    nick_taken: 'err_nick_taken',
    nick_bad: 'err_nick_bad',
    nick_rude: 'err_nick_rude',
    nick_reserved: 'err_nick_reserved',
    bad_token: 'err_generic',
    too_many: 'err_generic',
    network: 'err_generic',
  })[code] || 'err_generic';
}
