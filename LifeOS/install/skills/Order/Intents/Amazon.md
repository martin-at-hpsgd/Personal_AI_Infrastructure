# Amazon — Sanctioned ordering (planned stub)

An Amazon purchase the principal completes with their own tap, from a cart this skill assembles through sanctioned paths only (designed, not built).

## Ideal State

- Until it is built, an Amazon request gets a plain answer that Amazon ordering is not built yet, with the product link for the item asked for, and no cart or checkout is attempted.
- When built, an Amazon request produces an add-to-cart deep link for the item the principal asked for, and the charge is their own tap on "Place order" in their Amazon app, so the order lands in their real Prime account with native history and returns.
- The purchase gate still applies to what goes in the cart, with the item, quantity and price shown; the charge itself is their tap.
- Recurring consumables (household staples, things that go on repeat) are routed to Subscribe & Save, managed in the account UI, rather than re-ordered each time.

## Anti-criteria

- No automated checkout on the principal's consumer Amazon account by any route, a real-Chrome or Interceptor session included.
- No proxy-purchase API (Rye, Zinc, Crossmint) unless the principal wants pure "just buy it" and accepts the tradeoffs: those services buy on *their* accounts and drop-ship, with markup, no Prime, and no native order history or returns.

## Safety gates

Checkout automation on the consumer account is ToS-violating and CAPTCHA/OTP-interrupted. The add-to-cart deep link carries zero ToS exposure, and Subscribe & Save is fully sanctioned and discounted.

## References

**Status: designed, not built.** This file records the decided approach (sanctioned-path-only) so the build is unambiguous when it's time. When the principal asks for Amazon ordering, the build starts from the deep-link cart-build plus a read-only order-history helper, with checkout left as their tap.
