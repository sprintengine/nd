import { readFileSync } from "node:fs";

import { type ApiEnv, serviceAccountJson } from "../env.ts";
import { createFcmMessaging, fcmPushSender } from "./fcm.ts";
import { consolePushSender, type PushSender, type PushSink, routedPushSender } from "./push.ts";
import { webPushSender } from "./web-push.ts";

/**
 * The push sender the environment chooses: FCM for iOS and Android when a
 * service account is set, web push when the VAPID keys are, and the console
 * when neither is. In production the environment schema allows the console
 * only with ALLOW_CONSOLE_PUSH=true, and it then redacts.
 */
export function pushFromEnv(
  env: ApiEnv,
  options: {
    sink?: PushSink;
    readFile?: (path: string) => string;
    messaging?: typeof createFcmMessaging;
  } = {},
): PushSender {
  const {
    readFile = (path: string) => readFileSync(path, "utf8"),
    messaging = createFcmMessaging,
  } = options;
  let account = env.FCM_SERVICE_ACCOUNT_JSON;
  if (account === undefined && env.FCM_SERVICE_ACCOUNT_FILE !== undefined) {
    // Read and checked like the JSON variable; a bad file stops start-up.
    const parsed = serviceAccountJson.safeParse(readFile(env.FCM_SERVICE_ACCOUNT_FILE));
    if (!parsed.success) {
      throw new Error(
        "FCM_SERVICE_ACCOUNT_FILE must hold a service account key with project_id, client_email and private_key",
      );
    }
    account = parsed.data;
  }
  const mobile = account === undefined ? undefined : fcmPushSender(messaging(account));
  const web =
    env.VAPID_PUBLIC_KEY === undefined ||
    env.VAPID_PRIVATE_KEY === undefined ||
    env.VAPID_SUBJECT === undefined
      ? undefined
      : webPushSender({
          subject: env.VAPID_SUBJECT,
          publicKey: env.VAPID_PUBLIC_KEY,
          privateKey: env.VAPID_PRIVATE_KEY,
        });
  if (mobile === undefined && web === undefined) {
    return consolePushSender({
      redact: env.NODE_ENV === "production",
      ...(options.sink === undefined ? {} : { sink: options.sink }),
    });
  }
  return routedPushSender({ mobile, web });
}
