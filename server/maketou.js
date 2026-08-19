// Payments, through Maketou (which settles through Moneroo — mobile money,
// which is what most of this game's players actually have).
//
// Two calls, and that is the whole API surface:
//
//   POST /api/v1/stores/cart/checkout   -> { cart: { id, status }, redirectUrl }
//   GET  /api/v1/stores/cart/{cartId}   -> { status, ... }
//
// THERE ARE NO WEBHOOKS. The OpenAPI document defines none, so nothing will
// ever call us to say a payment landed. That single fact decides the shape of
// everything here and in the routes that use it: the redirect back from the
// checkout page is a hint, not the truth. It is lost every time somebody closes
// the tab, switches to their mobile-money app and never comes back, or loses
// signal at the wrong moment — and a player who pays and does not return would
// otherwise be charged and given nothing.
//
// So the cart id is written down when it is created, and the ANSWER comes from
// asking Maketou. The redirect just makes us ask sooner.

const BASE = process.env.MAKETOU_BASE || 'https://api.maketou.net';

/* Both are set in the environment and never in the repository. The product is
   created once in the Maketou dashboard — "SolRush Plus", 1 000 FCFA — and its
   documentId is what identifies it here. */
export const configured = () =>
  Boolean(process.env.MAKETOU_API_KEY && process.env.MAKETOU_PRODUCT_ID);

/* A hard ceiling on how long we will wait for their API.

   Without it, a slow payment provider becomes a slow game: the checkout route
   is called from a tap on a button, and Node's default is to wait more or less
   forever. Ten seconds is far longer than a healthy call and short enough that
   a player learns something went wrong while they still remember pressing it. */
async function call(path, { method = 'GET', body } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(BASE + path, {
      method,
      signal: ctl.signal,
      headers: {
        'Authorization': 'Bearer ' + process.env.MAKETOU_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      /* Their message, not ours, and truncated: it goes into a log, and an
         upstream error body is the one place a stray token or an email tends
         to turn up in something we then write to disk. */
      const err = new Error(`maketou ${res.status}: ${String(text).slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* Their API demands a first and last name. SolRush has neither — an account is
   an email and a nickname — so the nickname is split on its space, which is
   what the generated ones look like ("Calm Ibex"). A chosen nickname with no
   space repeats. Nothing here is used to identify anybody; it exists because
   the field is required. */
function splitNick(nick) {
  const parts = String(nick || 'SolRush').trim().split(/\s+/);
  return {
    firstName: parts[0] || 'SolRush',
    lastName: parts.slice(1).join(' ') || parts[0] || 'Player',
  };
}

export async function createCart({ user, redirectURL }) {
  const { firstName, lastName } = splitNick(user.nick);
  const out = await call('/api/v1/stores/cart/checkout', {
    method: 'POST',
    body: {
      productDocumentId: process.env.MAKETOU_PRODUCT_ID,
      email: user.email,
      firstName,
      lastName,
      redirectURL,
      /* Values must be strings. This is a second, independent way to tell whose
         payment a cart is — the first being our own table. Belt and braces on
         the one operation where getting the person wrong means somebody paid
         and somebody else was upgraded. */
      meta: { userId: String(user.id) },
    },
  });
  const id = out?.cart?.id;
  const url = out?.redirectUrl;
  if (!id || !url) throw new Error('maketou: no cart id or redirect url in response');
  return { id, url, status: out.cart.status || 'waiting_payment' };
}

export async function getCart(cartId) {
  const out = await call('/api/v1/stores/cart/' + encodeURIComponent(cartId));
  return { status: out?.status || null, meta: out?.meta || null };
}

// The only status that means money arrived. Anything else — including the two
// failure states and anything they add later — is not a reason to grant Plus.
export const PAID = 'completed';
