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

/* The catalogue price, in FCFA, for BOOKKEEPING only — it is never what makes
   the charge. A fixed-price product is priced in the Maketou dashboard and this
   number never reaches them; it is only what we write on the receipt row so the
   admin panel can add sales up.

   PLUS_PRICE exists so that arrangement stays possible. With MAKETOU_PRICE
   unset — which is where this is heading — the server would otherwise have no
   idea what any sale was worth and would report a revenue of zero. */
export const PRICE = Number(process.env.MAKETOU_PRICE)
  || Number(process.env.PLUS_PRICE)
  || 1000;

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

  /* Only for a pay-what-you-want product, which is what the Maketou API calls
     one with no price of its own — it refuses every cart until it is told an
     amount. A fixed-price product needs none of this and MAKETOU_PRICE stays
     unset, which is the arrangement to prefer: the amount then exists once, in
     the Maketou dashboard, instead of once there and once here.

     Sent by the server either way. The amount must never come from the browser
     on a product whose price is open — that is a shop where the customer fills
     in the total. */
  const price = Number(process.env.MAKETOU_PRICE) || 0;

  const out = await call('/api/v1/stores/cart/checkout', {
    method: 'POST',
    body: {
      productDocumentId: process.env.MAKETOU_PRODUCT_ID,
      email: user.email,
      firstName,
      lastName,
      redirectURL,
      ...(price > 0 ? { customerPrice: price } : {}),
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

  /* What this sale is worth, recorded now rather than inferred later.

     Their own figure is preferred where they send one — the field name is not
     in the part of the API we depend on, so several are tried and anything
     unusable falls back to the catalogue price. This is bookkeeping, not the
     charge: getting it wrong misstates a total in the admin panel, it does not
     take a different amount of money from anybody. */
  const said = [out?.cart?.total, out?.cart?.amount, out?.cart?.price, out?.total]
    .map(Number).find((n) => Number.isFinite(n) && n > 0);

  return { id, url, status: out.cart.status || 'waiting_payment', amount: said || PRICE };
}

export async function getCart(cartId) {
  const out = await call('/api/v1/stores/cart/' + encodeURIComponent(cartId));
  return { status: out?.status || null, meta: out?.meta || null };
}

// The only status that means money arrived. Anything else — including the two
// failure states and anything they add later — is not a reason to grant Plus.
export const PAID = 'completed';
