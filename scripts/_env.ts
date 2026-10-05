// Side-effect module: load .env* files exactly the way `next dev`/`next start` do, so CLI
// scripts and the app agree on configuration. Import this FIRST in every script.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
