import { createLogger } from "../src/logger.ts";

export const silentLogger = createLogger({ level: "silent" });
