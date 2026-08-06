import dotenv from "dotenv";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Same files Vite reads via `loadEnv(mode, backendDir)`; cwd-independent. */
dotenv.config({ path: path.join(backendRoot, ".env") });
dotenv.config({ path: path.join(backendRoot, ".env.local"), override: true });
