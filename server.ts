#!/usr/bin/env bun
import { startServer } from "@agiterra/crew-fleet-tools";

startServer().catch((e) => {
  console.error("[crew-fleet] fatal:", e);
  process.exit(1);
});
