# 0003. Payments: Stripe Connect Express with separate charges and transfers

- Status: Accepted
- Date: 2026-11-26

## Context

Drivers pay for time used, and the amount is only known after the session ends. A host should be paid only once the session is reconciled and their tax details (needed for platform reporting) are complete. Card authorisations expire after about 7 days, and slots can be booked further ahead than that.

## Decision

- Hosts onboard to **Stripe Connect Express**; Stripe handles their identity checks and payouts.
- Use **separate charges and transfers**: the driver is charged on the platform account, and the host is paid by a transfer linked to the charge (`transfer_group`, `source_transaction`). The transfer is **held** until the session is reconciled and the host's tax details are complete, and released by a job.
- **Authorise at confirmation** with a manual-capture PaymentIntent when the slot starts within 6 days. Otherwise save the card with a **SetupIntent** and authorise off-session with a job **24 h before** the start; if that fails, ask the driver to update the card, and cancel at no charge if it is still not authorised 2 h before the start.
- **Bill** the actual minutes used, rounded up to the next 5, at the hourly price, **capped at the quoted amount**. Never capture more than was authorised, and never before the session stops.
- The **platform fee** is configuration (`PLATFORM_FEE_BPS`), defaulting to 0. It is taken by transferring less than was captured.

## Consequences

- Payouts can wait for evidence (meter reconciliation, disputes) and for compliance (tax details) without any refund-and-recharge.
- The platform is the merchant of record for the charge and pays Stripe's processing fees, and funds sit in the platform balance between capture and transfer. This needs legal review before launch.
- Off-session authorisation can fail, so the booking flow needs a "card needs attention" path and the 2-hour cancellation rule.
- Webhooks must be verified and idempotent, and capture and transfer jobs must be safe to retry.
