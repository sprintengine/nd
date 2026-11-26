import { parseEnv } from "@nd/config";

import { apiEnvSchema, buildApp } from "./index.ts";

const env = parseEnv(apiEnvSchema);
const app = buildApp({ logger: true });

await app.listen({ host: env.HOST, port: env.PORT });
