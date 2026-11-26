import { randomInt } from "node:crypto";

import { startZappiSim, type ZappiSim, type ZappiSimOptions } from "@nd/ocpp-core/sim";

import { type Person, signUp } from "./accounts.ts";
import { availabilityAroundNow, TIME_ZONE } from "./slots.ts";
import { completePayoutsOnboarding } from "./stripe.ts";
import { eventually } from "./wait.ts";

export interface Credentials {
  readonly chargerId: string;
  readonly chargeboxId: string;
  readonly wssUrl: string;
  readonly secret: string;
}

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

export interface Host extends Person {
  readonly hostId: string;
}

export interface ListedCharger {
  readonly host: Host;
  readonly credentials: Credentials;
  readonly sim: ZappiSim;
  readonly location: LatLng;
}

/** A spot in Dublin of its own, so a search finds one scenario's charger. */
export function dublinSpot(index: number): LatLng {
  return { lat: 53.3 + index * 0.02, lng: -6.3 + index * 0.02 };
}

/** A Zappi v2.1 serial (eight digits, starting with 2). */
const zappiSerial = () => `2${String(randomInt(1_000_000, 9_999_999))}`;

/**
 * A new host: signed up, a payouts account opened (and Stripe's onboarding
 * reported complete), tax details given.
 */
export async function becomeHost(firstName: string): Promise<Host> {
  const person = await signUp(firstName);
  const { hostId } = await person.api.post<{ hostId: string }>("/hosts", { country: "IE" });
  await person.api.expect(200, "PUT", "/hosts/me/tax-details", {
    type: "individual",
    legalName: `${firstName} Tester`,
    dateOfBirth: "1988-03-14",
    address: { line1: "1 Test Lane", city: "Dublin", postalCode: "D06 X000", country: "IE" },
    taxCountry: "IE",
    tin: "1234567FA",
  });
  await completePayoutsOnboarding(hostId);
  return { ...person, hostId };
}

/** Registers a charger; the credentials are what the host types into the Zappi's account. */
export function addCharger(host: Host, location: LatLng): Promise<Credentials> {
  return host.api.post<Credentials>(
    "/hosts/chargers",
    {
      serial: zappiSerial(),
      model: "zappi",
      connectorType: "untethered",
      maxKw: 7.4,
      address: "1 Test Lane, Dublin",
      location,
      timezone: TIME_ZONE,
    },
    201,
  );
}

/** The simulated Zappi, connecting to the gateway with the issued credentials. */
export function connectZappi(
  credentials: Credentials,
  options: Partial<ZappiSimOptions> = {},
): Promise<ZappiSim> {
  return startZappiSim({
    url: credentials.wssUrl,
    chargeboxId: credentials.chargeboxId,
    secret: credentials.secret,
    startDelayMs: 300,
    ...options,
  });
}

/**
 * The whole of a host's onboarding: become a host, register a Zappi, connect
 * the simulator with the issued credentials, set price and hours, publish.
 */
export async function listCharger(
  firstName: string,
  location: LatLng,
  options: {
    pricePerHourCents?: number;
    instantBook?: boolean;
    sim?: Partial<ZappiSimOptions>;
  } = {},
): Promise<ListedCharger> {
  const host = await becomeHost(firstName);
  const credentials = await addCharger(host, location);
  const sim = await connectZappi(credentials, options.sim);
  const onboarding = await host.api.get<{ connected: boolean; firmwareSupported: boolean | null }>(
    `/hosts/chargers/${credentials.chargerId}/onboarding?wait=20`,
  );
  if (!onboarding.connected || onboarding.firmwareSupported !== true) {
    throw new Error(`the charger did not finish connecting: ${JSON.stringify(onboarding)}`);
  }
  // The gateway configures a new charger after its boot: no charging until a
  // booking's idTag is accepted.
  await eventually("the gateway to turn FreeCharging off", () =>
    Promise.resolve(sim.config.get("FreeCharging") ? undefined : true),
  );
  await host.api.expect(200, "PATCH", `/hosts/chargers/${credentials.chargerId}`, {
    pricePerHourCents: options.pricePerHourCents ?? 1200,
    instantBook: options.instantBook ?? false,
    availability: availabilityAroundNow(),
    maxSessionsPerDay: 10,
  });
  const published = await host.api.expect<{
    acceptingBookings: boolean;
    publishBlockers: unknown[];
  }>(200, "PATCH", `/hosts/chargers/${credentials.chargerId}`, { acceptingBookings: true });
  if (!published.acceptingBookings || published.publishBlockers.length > 0) {
    throw new Error(`the charger was not published: ${JSON.stringify(published)}`);
  }
  return { host, credentials, sim, location };
}
