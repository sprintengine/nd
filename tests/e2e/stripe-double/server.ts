// A stateful Stripe for end-to-end tests, in front of stripe-mock.
//
// stripe-mock checks every request against Stripe's OpenAPI spec but keeps no
// state: it answers from fixtures, so every customer has the same id and a
// PaymentIntent is never `requires_capture`. The API under test needs more
// than that, so each request is first sent to stripe-mock (a request Stripe
// would refuse is refused here with stripe-mock's answer), then answered from
// state kept here, applying the changes Stripe documents: unique ids, cards
// saved by confirming a SetupIntent, destination charges (a confirmed intent
// `succeeded`, or `requires_capture` with manual capture), captures,
// cancellations, refunds and deleted customers. Requests with an
// Idempotency-Key are replayed.
//
// Tests drive it the way the app and Stripe would: POST
// /v1/setup_intents/:id/confirm stands in for the app confirming a card with
// Stripe's SDK. Under /__double/ they can read what happened (accounts by
// host, intents and refunds by booking) and make the next charge of a
// customer decline.
//
// Node runs this file directly (type stripping); it uses only built-ins.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env.PORT ?? "12112");
const STRIPE_MOCK_URL = process.env.STRIPE_MOCK_URL ?? "http://localhost:12111";

type Json = Record<string, unknown>;

interface Answer {
  readonly status: number;
  readonly body: Json;
}

interface Card {
  readonly id: string;
  readonly customer: string;
  readonly brand: string;
  readonly last4: string;
}

interface Intent {
  readonly id: string;
  status: string;
  readonly amount: number;
  readonly currency: string;
  readonly customer: string | null;
  readonly paymentMethod: string | null;
  readonly captureMethod: string;
  amountCapturable: number;
  amountReceived: number;
  latestCharge: string | null;
  readonly metadata: Record<string, string>;
  readonly transferGroup: string | null;
  /** The connected account a destination charge pays. */
  readonly destination: string | null;
  readonly applicationFeeAmount: number | null;
}

const accounts = new Map<string, { id: string; email: string | null; metadata: Json }>();
const customers = new Map<
  string,
  { id: string; email: string | null; defaultCard: string | null }
>();
const setupIntents = new Map<
  string,
  { id: string; customer: string; status: string; paymentMethod: string | null; metadata: Json }
>();
const cards = new Map<string, Card>();
const intents = new Map<string, Intent>();
const refunds: {
  id: string;
  paymentIntent: string;
  amount: number;
  reverseTransfer: boolean;
  refundApplicationFee: boolean;
  metadata: Json;
}[] = [];
const declines = new Map<string, string[]>();
const replay = new Map<string, Answer>();

const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;
const now = () => Math.floor(Date.now() / 1000);

function stripeError(
  status: number,
  type: string,
  code: string,
  message: string,
  extra: Json = {},
): Answer {
  return { status, body: { error: { type, code, message, ...extra } } };
}

const missing = (kind: string, id: string) =>
  stripeError(404, "invalid_request_error", "resource_missing", `No such ${kind}: '${id}'`);

/** Stripe's form encoding (`a[b]=c`) read flat: `metadata[bookingId]` and so on. */
function formOf(text: string): URLSearchParams {
  return new URLSearchParams(text);
}

function metadataOf(form: URLSearchParams): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [key, value] of form) {
    const match = /^metadata\[(.+)\]$/.exec(key);
    if (match?.[1] !== undefined) metadata[match[1]] = value;
  }
  return metadata;
}

function intentView(intent: Intent): Json {
  return {
    id: intent.id,
    object: "payment_intent",
    amount: intent.amount,
    amount_capturable: intent.amountCapturable,
    amount_received: intent.amountReceived,
    capture_method: intent.captureMethod,
    currency: intent.currency,
    customer: intent.customer,
    latest_charge: intent.latestCharge,
    metadata: intent.metadata,
    payment_method: intent.paymentMethod,
    status: intent.status,
    transfer_group: intent.transferGroup,
    transfer_data: intent.destination === null ? null : { destination: intent.destination },
    application_fee_amount: intent.applicationFeeAmount,
    created: now(),
    livemode: false,
  };
}

function cardView(card: Card): Json {
  return {
    id: card.id,
    object: "payment_method",
    type: "card",
    customer: card.customer,
    card: { brand: card.brand, last4: card.last4, exp_month: 12, exp_year: 2034 },
    created: now(),
    livemode: false,
  };
}

function customerView(customer: { id: string; email: string | null; defaultCard: string | null }) {
  return {
    id: customer.id,
    object: "customer",
    email: customer.email,
    invoice_settings: { default_payment_method: customer.defaultCard },
    created: now(),
    livemode: false,
  };
}

function setupIntentView(intent: {
  id: string;
  customer: string;
  status: string;
  paymentMethod: string | null;
  metadata: Json;
}): Json {
  return {
    id: intent.id,
    object: "setup_intent",
    client_secret: `${intent.id}_secret_${randomBytes(8).toString("hex")}`,
    customer: intent.customer,
    metadata: intent.metadata,
    payment_method: intent.paymentMethod,
    status: intent.status,
    usage: "off_session",
    created: now(),
    livemode: false,
  };
}

/** The state change for one Stripe API call, after stripe-mock accepted it. */
function apply(
  method: string,
  path: string,
  form: URLSearchParams,
  query: URLSearchParams,
): Answer {
  const parts = path.split("/").filter((part) => part !== "");
  const [, resource, id, action] = parts;

  if (resource === "accounts" && method === "POST" && id === undefined) {
    const account = { id: newId("acct"), email: form.get("email"), metadata: metadataOf(form) };
    accounts.set(account.id, account);
    return {
      status: 200,
      body: {
        id: account.id,
        object: "account",
        type: "express",
        email: account.email,
        metadata: account.metadata,
        charges_enabled: false,
        payouts_enabled: false,
      },
    };
  }
  if (resource === "account_links" && method === "POST") {
    return {
      status: 200,
      body: {
        object: "account_link",
        url: `https://connect.stripe.com/setup/e/${form.get("account") ?? "acct"}/${randomBytes(8).toString("hex")}`,
        created: now(),
        expires_at: now() + 300,
      },
    };
  }

  if (resource === "customers") {
    if (method === "POST" && id === undefined) {
      const customer = { id: newId("cus"), email: form.get("email"), defaultCard: null };
      customers.set(customer.id, customer);
      return { status: 200, body: customerView(customer) };
    }
    const customer = id === undefined ? undefined : customers.get(id);
    if (customer === undefined) return missing("customer", id ?? "");
    if (method === "DELETE") {
      customers.delete(customer.id);
      for (const card of [...cards.values()]) {
        if (card.customer === customer.id) cards.delete(card.id);
      }
      return { status: 200, body: { id: customer.id, object: "customer", deleted: true } };
    }
    if (method === "POST") {
      const card = form.get("invoice_settings[default_payment_method]");
      if (card !== null) customer.defaultCard = card === "" ? null : card;
    }
    return { status: 200, body: customerView(customer) };
  }

  if (resource === "setup_intents") {
    if (method === "POST" && id === undefined) {
      const customer = form.get("customer");
      if (customer === null || !customers.has(customer)) return missing("customer", customer ?? "");
      const intent = {
        id: newId("seti"),
        customer,
        status: "requires_payment_method",
        paymentMethod: null,
        metadata: metadataOf(form),
      };
      setupIntents.set(intent.id, intent);
      return { status: 200, body: setupIntentView(intent) };
    }
    const intent = id === undefined ? undefined : setupIntents.get(id);
    if (intent === undefined) return missing("setup_intent", id ?? "");
    if (method === "POST" && action === "confirm") {
      // What the app's Stripe SDK does with the card the driver typed in.
      const card: Card = {
        id: newId("pm"),
        customer: intent.customer,
        brand: "visa",
        last4: (form.get("payment_method") ?? "").includes("mastercard") ? "4444" : "4242",
      };
      cards.set(card.id, card);
      intent.status = "succeeded";
      intent.paymentMethod = card.id;
    }
    return { status: 200, body: setupIntentView(intent) };
  }

  if (resource === "payment_methods") {
    if (method === "GET" && id === undefined) {
      const customer = query.get("customer");
      const data = [...cards.values()]
        .filter((card) => card.customer === customer)
        .map((card) => cardView(card));
      return {
        status: 200,
        body: { object: "list", data, has_more: false, url: "/v1/payment_methods" },
      };
    }
    const card = id === undefined ? undefined : cards.get(id);
    if (card === undefined) return missing("payment_method", id ?? "");
    return { status: 200, body: cardView(card) };
  }

  if (resource === "payment_intents") {
    if (method === "POST" && id === undefined) {
      const customer = form.get("customer");
      const paymentMethod = form.get("payment_method");
      const intent: Intent = {
        id: newId("pi"),
        status: "requires_payment_method",
        amount: Number(form.get("amount")),
        currency: form.get("currency") ?? "eur",
        customer,
        paymentMethod,
        captureMethod: form.get("capture_method") ?? "automatic",
        amountCapturable: 0,
        amountReceived: 0,
        latestCharge: null,
        metadata: metadataOf(form),
        transferGroup: form.get("transfer_group"),
        destination: form.get("transfer_data[destination]"),
        applicationFeeAmount:
          form.get("application_fee_amount") === null
            ? null
            : Number(form.get("application_fee_amount")),
      };
      intents.set(intent.id, intent);
      const card = paymentMethod === null ? undefined : cards.get(paymentMethod);
      if (form.get("confirm") === "true") {
        if (card?.customer !== customer) {
          return missing("payment_method", paymentMethod ?? "");
        }
        const decline = declines.get(customer)?.shift();
        if (decline !== undefined) {
          intent.status = "requires_payment_method";
          return stripeError(402, "card_error", "card_declined", "Your card was declined.", {
            decline_code: decline,
            payment_intent: intentView(intent),
          });
        }
        if (intent.captureMethod === "manual") {
          intent.status = "requires_capture";
          intent.amountCapturable = intent.amount;
        } else {
          intent.status = "succeeded";
          intent.amountReceived = intent.amount;
          intent.latestCharge = newId("ch");
        }
      }
      return { status: 200, body: intentView(intent) };
    }
    const intent = id === undefined ? undefined : intents.get(id);
    if (intent === undefined) return missing("payment_intent", id ?? "");
    if (method === "POST" && action === "cancel") {
      if (intent.status === "succeeded" || intent.status === "canceled") {
        return stripeError(
          400,
          "invalid_request_error",
          "payment_intent_unexpected_state",
          `This PaymentIntent's status is ${intent.status}`,
        );
      }
      intent.status = "canceled";
      intent.amountCapturable = 0;
    } else if (method === "POST" && action === "capture") {
      const amount = Number(form.get("amount_to_capture") ?? intent.amountCapturable);
      if (intent.status !== "requires_capture" || amount > intent.amountCapturable) {
        return stripeError(
          400,
          "invalid_request_error",
          intent.status === "requires_capture"
            ? "amount_too_large"
            : "payment_intent_unexpected_state",
          "This PaymentIntent cannot be captured for that amount",
        );
      }
      intent.status = "succeeded";
      intent.amountReceived = amount;
      intent.amountCapturable = 0;
      intent.latestCharge = newId("ch");
    }
    return { status: 200, body: intentView(intent) };
  }

  if (resource === "refunds" && method === "POST" && id === undefined) {
    const intentId = form.get("payment_intent") ?? "";
    const intent = intents.get(intentId);
    if (intent === undefined) return missing("payment_intent", intentId);
    const refunded = refunds
      .filter((refund) => refund.paymentIntent === intent.id)
      .reduce((total, refund) => total + refund.amount, 0);
    const amount = Number(form.get("amount") ?? intent.amountReceived - refunded);
    if (intent.status !== "succeeded" || refunded + amount > intent.amountReceived) {
      return stripeError(
        400,
        "invalid_request_error",
        "charge_already_refunded",
        "This charge cannot be refunded for that amount",
      );
    }
    const refund = {
      id: newId("re"),
      paymentIntent: intent.id,
      amount,
      reverseTransfer: form.get("reverse_transfer") === "true",
      refundApplicationFee: form.get("refund_application_fee") === "true",
      metadata: metadataOf(form),
    };
    refunds.push(refund);
    return {
      status: 200,
      body: {
        id: refund.id,
        object: "refund",
        amount,
        currency: intent.currency,
        payment_intent: intent.id,
        charge: intent.latestCharge,
        status: "succeeded",
        metadata: refund.metadata,
        created: now(),
      },
    };
  }

  return stripeError(
    404,
    "invalid_request_error",
    "unknown_route",
    `The Stripe double does not handle ${method} ${path}`,
  );
}

/** What tests may read or arrange, under /__double/. */
function inspect(method: string, path: string, query: URLSearchParams): Answer {
  if (method === "GET" && path === "/__double/health") return { status: 200, body: { ok: true } };
  if (method === "GET" && path === "/__double/accounts") {
    const hostId = query.get("hostId");
    const data = [...accounts.values()].filter((account) => account.metadata.hostId === hostId);
    return { status: 200, body: { data } };
  }
  if (method === "GET" && path === "/__double/payment_intents") {
    const bookingId = query.get("bookingId");
    const data = [...intents.values()]
      .filter((intent) => intent.metadata.bookingId === bookingId)
      .map((intent) => intentView(intent));
    return { status: 200, body: { data } };
  }
  if (method === "GET" && path === "/__double/refunds") {
    const bookingId = query.get("bookingId");
    const data = refunds.filter(
      (refund) => intents.get(refund.paymentIntent)?.metadata.bookingId === bookingId,
    );
    return { status: 200, body: { data } };
  }
  if (method === "GET" && path === "/__double/customers") {
    const id = query.get("id") ?? "";
    return { status: 200, body: { exists: customers.has(id) } };
  }
  if (method === "POST" && path === "/__double/declines") {
    const customer = query.get("customer") ?? "";
    const queue = declines.get(customer) ?? [];
    queue.push(query.get("code") ?? "insufficient_funds");
    declines.set(customer, queue);
    return { status: 200, body: { ok: true } };
  }
  return { status: 404, body: { error: "not found" } };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Sends the request to stripe-mock; its answer when it refuses, otherwise undefined. */
async function validate(
  method: string,
  url: string,
  headers: IncomingMessage["headers"],
  body: string,
): Promise<Answer | undefined> {
  const forwarded: Record<string, string> = {};
  for (const name of ["authorization", "content-type", "stripe-version"]) {
    const value = headers[name];
    if (typeof value === "string") forwarded[name] = value;
  }
  const response = await fetch(`${STRIPE_MOCK_URL}${url}`, {
    method,
    headers: forwarded,
    ...(method === "GET" || method === "DELETE" ? {} : { body }),
  });
  if (response.status < 400) {
    await response.body?.cancel();
    return undefined;
  }
  return { status: response.status, body: (await response.json()) as Json };
}

async function handle(request: IncomingMessage): Promise<Answer> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://double");
  const body = await readBody(request);
  if (url.pathname.startsWith("/__double/")) return inspect(method, url.pathname, url.searchParams);

  const key = request.headers["idempotency-key"];
  const replayKey =
    typeof key === "string" && method === "POST" ? `${url.pathname} ${key}` : undefined;
  if (replayKey !== undefined) {
    const saved = replay.get(replayKey);
    if (saved !== undefined) return saved;
  }
  const refused = await validate(method, `${url.pathname}${url.search}`, request.headers, body);
  if (refused !== undefined) return refused;
  const answer = apply(method, url.pathname, formOf(body), url.searchParams);
  if (replayKey !== undefined && answer.status < 500) replay.set(replayKey, answer);
  return answer;
}

function send(response: ServerResponse, answer: Answer): void {
  response.writeHead(answer.status, {
    "content-type": "application/json",
    "request-id": `req_${randomBytes(8).toString("hex")}`,
  });
  response.end(JSON.stringify(answer.body));
}

const server = createServer((request, response) => {
  handle(request).then(
    (answer) => {
      send(response, answer);
    },
    (error: unknown) => {
      console.error(error);
      send(response, stripeError(500, "api_error", "double_failed", "The Stripe double failed"));
    },
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}

server.listen(PORT, "0.0.0.0", () => {
  console.info("stripe double listening");
});
