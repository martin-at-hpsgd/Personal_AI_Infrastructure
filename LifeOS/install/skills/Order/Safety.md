# Order — Purchase Gate Doctrine

The reasons behind the four rules in `SKILL.md` § The Purchase Gate. Read this when deciding whether something needs the gate.

A charge is neither reversible nor recoverable by me: money leaves, food gets made, a driver dispatches. There is no `git revert` for a placed order. That is why purchases sit permanently in the "must ask" column of the assistant's autonomy settings, which already default-deny financial actions; this gate is that boundary applied to ordering, and it does not replace it.

## The four gates

**1. Explicit confirmation before the charge.**
It prevents search, cart and checkout running in one breath before the principal has seen the real total. Fees, service charges, tip and tax are invisible until the cart is assembled, so the menu price is never the charged price. A "yes, order it" said before the total was shown is not consent to the total.

**2. Per-order USD ceiling — default $75.**
A backstop against a wrong parse or a fat-fingered quantity turning into a $300 order. That is why it stops an order even after the principal said go, and why a raise never becomes the new default.

**3. Sanctioned paths only.**
Covers official tooling (dd-cli) and sanctioned mechanisms (Amazon deep-links, Subscribe & Save). The community browser-scraper MCPs violate provider ToS, and enforcement is real: Cloudflare bot management, IP bans, permanent account termination. A banned DoorDash or Amazon account is a strictly worse outcome than a slower order, so there is no "just this once."

**4. No silent substitution or absorbed change.**
Out of stock, a price that moved since search, an ambiguous address, a store that just closed: the principal decides each one. I never pick a "close enough" substitute or quietly eat a price delta, because guessing with their money is the failure.

## What does NOT need the gate

Search, menu browsing, order-history reads and delivery tracking are read-only and free, so they run without asking. The gate fires at the charge and nowhere else; making the principal confirm a restaurant search is the over-asking failure, which is its own kind of broken.
