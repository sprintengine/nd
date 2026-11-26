import { NOTIFICATION_CATEGORIES, type NotificationCategory } from "@nd/domain";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireUser, sessionOf } from "../auth/session.ts";
import {
  deleteDevice,
  preferencesOf,
  registerDevice,
  savePreferences,
} from "../data/notifications.ts";
import { HttpProblem, problemResponses } from "../http/problem.ts";
import type { Services } from "../services.ts";

/** A base64url value, as browsers give a push subscription's keys. */
const base64Url = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+=*$/, "must be base64url");

const fcmDevice = z.object({
  platform: z.enum(["ios", "android"]),
  token: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^\S+$/, "must not contain spaces")
    .describe("The FCM registration token (iOS devices register through FCM too)"),
});

const webDevice = z.object({
  platform: z.literal("web"),
  subscription: z
    .object({
      endpoint: z.url({ protocol: /^https$/ }).max(2048),
      keys: z.object({ p256dh: base64Url(256), auth: base64Url(64) }),
    })
    .describe("The browser's PushSubscription, as `subscription.toJSON()` gives it"),
});

const deviceBody = z.discriminatedUnion("platform", [fcmDevice, webDevice]);

const deviceSchema = z
  .object({
    id: z.uuid(),
    platform: z.enum(["ios", "android", "web"]),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: "Device" });

const deviceParams = z.object({ id: z.uuid() });

const preferencesSchema = z
  .object(
    Object.fromEntries(NOTIFICATION_CATEGORIES.map((name) => [name, z.boolean()])) as Record<
      NotificationCategory,
      z.ZodBoolean
    >,
  )
  .describe(
    "Hosts: bookingRequests (new requests and bookings, cancellations), guestArrivals, sessionUpdates (started; ended, with the amount billed and earned), chargerAlerts (offline, fault). Drivers: bookingUpdates (approved, declined, expired, cancelled) and chargingUpdates (started, stopped, failed to start).",
  )
  .meta({ id: "NotificationPreferences" });

const preferencesPatch = preferencesSchema
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "send at least one switch");

export function registerDeviceRoutes(app: FastifyInstance, services: Services): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { db } = services;

  typed.post(
    "/me/devices",
    {
      onRequest: requireUser,
      schema: {
        summary: "Register a device for push notifications",
        description:
          "iOS and Android send their FCM registration token; the web app sends its push subscription. A token already registered (by this account or another signed in on the same device) is moved to the caller and refreshed: 201 when new, 200 when known. Each account keeps its 10 most recently seen devices.",
        tags: ["notifications"],
        body: deviceBody,
        response: { 200: deviceSchema, 201: deviceSchema, ...problemResponses(400, 401) },
      },
    },
    async (request, reply) => {
      const { userId } = sessionOf(request);
      const body = request.body;
      const device =
        body.platform === "web"
          ? {
              platform: body.platform,
              token: body.subscription.endpoint,
              webPush: body.subscription.keys,
            }
          : { platform: body.platform, token: body.token, webPush: null };
      const saved = await registerDevice(db, userId, device, services.clock.now());
      void reply.code(saved.created ? 201 : 200);
      return { id: saved.id, platform: body.platform, createdAt: saved.createdAt.toISOString() };
    },
  );

  typed.delete(
    "/me/devices/:id",
    {
      onRequest: requireUser,
      schema: {
        summary: "Stop push notifications to a device",
        description: "Call on sign-out. Another account's device is 404.",
        tags: ["notifications"],
        params: deviceParams,
        response: { 204: z.null(), ...problemResponses(400, 401, 404) },
      },
    },
    async (request, reply) => {
      const removed = await deleteDevice(db, sessionOf(request).userId, request.params.id);
      if (!removed) throw new HttpProblem(404, "device-not-found", "No such device");
      return reply.code(204).send(null);
    },
  );

  typed.get(
    "/me/notification-preferences",
    {
      onRequest: requireUser,
      schema: {
        summary: "Notification switches",
        description: "Every switch is on until the user turns it off.",
        tags: ["notifications"],
        response: { 200: preferencesSchema, ...problemResponses(401) },
      },
    },
    (request) => preferencesOf(db, sessionOf(request).userId),
  );

  typed.patch(
    "/me/notification-preferences",
    {
      onRequest: requireUser,
      schema: {
        summary: "Change notification switches",
        description: "Changes only the switches sent; answers all of them.",
        tags: ["notifications"],
        body: preferencesPatch,
        response: { 200: preferencesSchema, ...problemResponses(400, 401) },
      },
    },
    (request) => {
      const patch: Partial<Record<NotificationCategory, boolean>> = {};
      for (const name of NOTIFICATION_CATEGORIES) {
        const value = request.body[name];
        if (value !== undefined) patch[name] = value;
      }
      return savePreferences(db, sessionOf(request).userId, patch);
    },
  );
}
