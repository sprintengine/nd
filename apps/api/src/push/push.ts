import type { DevicePlatform, PushData } from "@nd/domain";

// Push notifications behind one interface: FCM (HTTP v1 through
// firebase-admin) for iOS and Android, web push with VAPID for the web app,
// and a console fake for development and tests. Providers are chosen by the
// environment (`from-env.ts`).

/** What a notification shows, and the ids the app opens when it is tapped. */
export interface PushMessage {
  readonly title: string;
  readonly body: string;
  readonly data: PushData;
}

/** A device registered for push. Its token is secret: never log it. */
export interface PushDevice {
  readonly id: string;
  readonly platform: DevicePlatform;
  /** FCM registration token, or a web push subscription's endpoint. */
  readonly token: string;
  /** A web push subscription's keys; null for FCM devices. */
  readonly webPush: { readonly p256dh: string; readonly auth: string } | null;
}

/**
 * What became of one push: accepted by the provider; refused because the
 * token is no longer valid (the device should be forgotten); or failed for
 * another reason, which may be worth retrying.
 */
export type PushOutcome =
  | { readonly status: "sent" }
  | { readonly status: "invalid_token" }
  | { readonly status: "failed"; readonly retryable: boolean; readonly reason: string };

/** Sends one message to some devices, answering one outcome per device, in order. */
export interface PushSender {
  /** The provider name, for logs. */
  readonly name: string;
  send(devices: readonly PushDevice[], message: PushMessage): Promise<PushOutcome[]>;
}

/** Where the console sender writes. */
export type PushSink = (line: string) => void;

const defaultSink: PushSink = (line) => {
  console.info(line);
};

/**
 * Writes pushes to the console instead of sending them, for development and
 * end-to-end tests. Tokens are never written; with `redact` (production
 * running with ALLOW_CONSOLE_PUSH) neither is the text.
 */
export function consolePushSender(options: { redact?: boolean; sink?: PushSink } = {}): PushSender {
  const { redact = false, sink = defaultSink } = options;
  return {
    name: "console",
    send(devices, message) {
      for (const device of devices) {
        sink(
          redact
            ? `[push] not sent to ${device.platform} device ${device.id}: no push provider is configured`
            : `[push] to ${device.platform} device ${device.id}: ${message.title}: ${message.body}`,
        );
      }
      return Promise.resolve(devices.map(() => ({ status: "sent" }) as const));
    },
  };
}

/** Ignores a device no provider is configured for. */
const unconfigured = (): PushOutcome => ({
  status: "failed",
  retryable: false,
  reason: "no provider for this platform",
});

/**
 * Sends each device through the provider for its platform: `mobile` for iOS
 * and Android (FCM delivers to iOS through APNs), `web` for web push. A
 * platform without a provider fails without retry.
 */
export function routedPushSender(providers: {
  readonly mobile: PushSender | undefined;
  readonly web: PushSender | undefined;
}): PushSender {
  const names = [providers.mobile?.name, providers.web?.name].filter((name) => name !== undefined);
  return {
    name: names.join("+"),
    async send(devices, message) {
      const outcomes: PushOutcome[] = devices.map(unconfigured);
      const mobile = {
        sender: providers.mobile,
        indexes: [] as number[],
        devices: [] as PushDevice[],
      };
      const web = { sender: providers.web, indexes: [] as number[], devices: [] as PushDevice[] };
      devices.forEach((device, index) => {
        const group = device.platform === "web" ? web : mobile;
        group.indexes.push(index);
        group.devices.push(device);
      });
      await Promise.all(
        [mobile, web].map(async ({ sender, indexes, devices: grouped }) => {
          if (sender === undefined || grouped.length === 0) return;
          const results = await sender.send(grouped, message);
          indexes.forEach((deviceIndex, resultIndex) => {
            outcomes[deviceIndex] = results[resultIndex] ?? {
              status: "failed",
              retryable: true,
              reason: "no outcome from provider",
            };
          });
        }),
      );
      return outcomes;
    },
  };
}
