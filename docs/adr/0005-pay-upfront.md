# 0005. Payments: pay upfront with destination charges

- Status: Accepted
- Date: 2026-11-27
- Supersedes: [0003](0003-payments-flow.md)

## Context

[ADR 0003](0003-payments-flow.md) billed the time actually used, after the session. That needed a card authorisation at confirmation or a saved card authorised by a job 24 hours ahead, a capture after reconciliation, a separate transfer to the host, transfer holds with release jobs, and a sweep to recover anything that stopped half way. Each part is reasonable on its own. Together they are more moving money than the pilot needs, with failure modes (lapsed authorisations, captures after expiry, transfers held indefinitely) that are hard to test and to support.

A booking is a slot, and the slot is the charging window. A driver who books 02:00–05:00 occupies the charger for those hours, whether or not the car keeps drawing power.

## Decision

- **Price** is the host's hourly price × the booked hours. Nothing is billed by energy or by the minutes used; kWh is shown for information.
- **Pay upfront.** An instant booking is charged in full when it is made (automatic capture). A request holds the full price on the card (manual capture), is charged when the host approves, and is released when the host declines or the request expires. A host has 24 hours to answer a request, never later than the slot start, well within the card hold's validity.
- **Destination charges** (Stripe Connect Express). The charge names the host's connected account (`transfer_data.destination`), so the host receives the money with the charge; there are no separate transfers, holds or payout jobs.
- **The card fee is passed on to the host.** `application_fee_amount` is the platform fee (`PLATFORM_FEE_BPS`, default 0) plus a card-fee estimate (`CARD_FEE_BPS`, default 150, plus `CARD_FEE_FIXED_CENTS`, default 25), rounded up, so the host receives the price less the card fee and the platform nets about zero. One pure function in `@nd/domain` computes the split; hosts see the gross, the card fee and their net when they set a price, on receipts and on the dashboard.
- **Refunds follow fixed rules**, always with `reverse_transfer` and `refund_application_fee`: a driver cancelling before the host's cutoff gets everything back; after it, or on a no-show, nothing; a host cancelling or declining refunds or releases everything; a booking that ends without charging because of the charger (a failed start, or the charger offline) is refunded in full automatically; anything else is refunded by support, in full or in part.
- **Tax details** are required before a listing is published; there are no payout holds.
- **Order of operations.** Every change claims the booking's status first (a guarded update, with any refund it owes recorded in the same transaction), then calls Stripe with one idempotency key per logical action (the booking's charge, its capture, its release, each refund), never one per retry. A call that fails or goes unanswered leaves the row saying so, and a resume job (queued at once, and by the minute sweep) finishes it with the same key.

## Consequences

- Far less code and state: no deferred authorisation, no capture after the session, no billing maths, no transfers or holds.
- Drivers pay for the booked hours even if they stop early; the receipt shows the session (start, stop, kWh, meter readings and power samples) as evidence of what the charger did.
- Funds go to the host at the charge. A refund after the host has paid out leaves their Stripe balance negative until later bookings cover it; Stripe handles that, but it is a risk to watch.
- Refunding the application fee means the platform absorbs Stripe's fee on a refunded booking.
- Requests and approvals are bounded by the card hold; a hold that lapses before approval cancels the booking.
- Webhooks only record what Stripe did (payment succeeded, failed or cancelled, refunds, card disputes, account updates); they never move money.
