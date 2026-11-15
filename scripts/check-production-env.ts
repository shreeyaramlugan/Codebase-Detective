// scripts/check-production-env.ts
//
// Usage: npm run check:env -- web   |   npm run check:env -- worker
// Reads the current environment (and .env), prints problems, exits 1 on errors.
import "dotenv/config";

import { validateProductionEnv, type Target } from "../lib/config/production-env";

const target = (process.argv[2] ?? "web") as Target;
if (target !== "web" && target !== "worker") {
  console.error('Usage: npm run check:env -- web|worker');
  process.exit(2);
}

const { errors, warnings } = validateProductionEnv(process.env, target);
for (const w of warnings) console.warn(`warning: ${w}`);
for (const e of errors) console.error(`error:   ${e}`);
if (errors.length > 0) {
  console.error(`\n${errors.length} problem(s) must be fixed before deploying the ${target}.`);
  process.exit(1);
}
console.log(`Production environment for the ${target} looks complete.`);
