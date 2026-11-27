import { afterAll, expect, it } from "vitest";

import { awaitBooking, book, newDriver } from "./driver.ts";
import { dublinSpot, listCharger, type ListedCharger } from "./host.ts";
import { upcomingSlot } from "./slots.ts";
import { paymentIntentsFor, refundsFor } from "./stripe.ts";
import { eventually } from "./wait.ts";

// Scenario 3: the host declines a request, and the hold on the driver's card goes.

let listed: ListedCharger | undefined;

afterAll(async () => {
  await listed?.sim.stop();
});

it("releases the hold on the driver's card when the host declines", async () => {
  listed = await listCharger("Niamh", dublinSpot(1), { instantBook: false });
  const driver = await newDriver("Sam");
  const booking = await book(driver, listed.credentials.chargerId, upcomingSlot(30, 120));
  expect(booking.status).toBe("requested");
  expect(booking.payment?.status).toBe("authorised");

  await listed.host.api.post(`/bookings/${booking.id}/decline`, { reason: "Away that night" });

  const declined = await awaitBooking(
    driver,
    booking.id,
    "cancelled",
    (b) => b.status === "cancelled",
  );
  expect(declined.cancelledBy).toBe("host");
  expect(declined.addressVisible).toBe(false);
  expect(declined.payment?.status).toBe("cancelled");
  const intents = await eventually("the hold to be released", async () => {
    const found = await paymentIntentsFor(booking.id);
    return found.length > 0 && found.every((intent) => intent.status === "canceled")
      ? found
      : undefined;
  });
  expect(intents).toHaveLength(1);
  // Nothing was charged, so there is nothing to refund.
  expect(await refundsFor(booking.id)).toEqual([]);

  // A declined request cannot be approved afterwards.
  const late = await listed.host.api.send("POST", `/bookings/${booking.id}/approve`);
  expect(late.status).toBe(409);
});
