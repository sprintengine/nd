import { findCustomer, saveCustomerId } from "../data/bookings.ts";
import { HttpProblem } from "../http/problem.ts";
import type { Services } from "../services.ts";
import type { SavedCard } from "../stripe/payments.ts";

// A Stripe Customer per driver, created the first time they save a card.

/** The user's Stripe customer id, creating the customer on first use. */
export async function ensureCustomer(services: Services, userId: string): Promise<string> {
  const user = await findCustomer(services.db, userId);
  if (user === undefined) throw new HttpProblem(401, "unauthenticated", "Sign in to continue");
  if (user.stripeCustomerId !== null) return user.stripeCustomerId;
  const customer = await services.payments.createCustomer({
    userId,
    email: user.email,
    name: user.name,
  });
  return saveCustomerId(services.db, userId, customer.id);
}

/** The user's saved cards and which is the default; none before their first card. */
export async function cardsOf(
  services: Services,
  userId: string,
): Promise<{ cards: SavedCard[]; defaultCardId: string | null }> {
  const customerId = (await findCustomer(services.db, userId))?.stripeCustomerId ?? null;
  if (customerId === null) return { cards: [], defaultCardId: null };
  return services.payments.listCards(customerId);
}

/** Makes one of the user's saved cards the default for bookings. */
export async function chooseDefaultCard(
  services: Services,
  userId: string,
  paymentMethodId: string,
): Promise<void> {
  const user = await findCustomer(services.db, userId);
  const customerId = user?.stripeCustomerId ?? null;
  const card =
    customerId === null ? undefined : await services.payments.findCard(customerId, paymentMethodId);
  if (customerId === null || card === undefined) {
    throw new HttpProblem(
      404,
      "payment-method-not-found",
      "That card is not saved on your account",
    );
  }
  await services.payments.setDefaultCard(customerId, paymentMethodId);
}
