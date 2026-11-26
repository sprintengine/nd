import { parseEnv } from "@nd/config";

import { createGatewayServer, gatewayEnvSchema } from "./index.ts";

const env = parseEnv(gatewayEnvSchema);
const server = createGatewayServer();

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
