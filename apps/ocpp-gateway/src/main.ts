import { parseEnv } from "@nd/config";

import { createGatewayServer, gatewayEnvSchema } from "./index.ts";

const env = parseEnv(gatewayEnvSchema);
const server = createGatewayServer();

server.listen(env.PORT, env.HOST, () => {
  console.info(`ocpp-gateway listening on ${env.HOST}:${String(env.PORT)}`);
});
