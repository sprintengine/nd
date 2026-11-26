import { parseEnv } from "@nd/config";

import { createGatewayServer, gatewayEnvSchema } from "./index.ts";
import { createDatabaseProbe, readinessEnvSchema } from "./readiness.ts";
import { closeOnSignal } from "./shutdown.ts";

const env = parseEnv(gatewayEnvSchema);
const { DATABASE_URL } = parseEnv(readinessEnvSchema);
const probe = DATABASE_URL === undefined ? undefined : createDatabaseProbe(DATABASE_URL);
const server = createGatewayServer({ readiness: probe });

closeOnSignal(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
    server.closeIdleConnections();
  });
  await probe?.close();
});

server.listen(env.PORT, env.HOST, () => {
  // Log what the socket is bound to, never fields of the parsed environment,
  // which will hold secrets.
  const address = server.address();
  const bound =
    typeof address === "object" && address !== null
      ? `${address.address}:${String(address.port)}`
      : String(address);
  console.info(`ocpp-gateway listening on ${bound}`);
});
