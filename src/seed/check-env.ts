import "dotenv/config";
import { env } from "../config/env.js";

console.log("🔍 Environment Configuration\n");
console.log("============================");
console.log(`NODE_ENV: ${env.nodeEnv}`);
console.log(`PORT: ${env.port}`);
console.log(`DATABASE_URL: ${env.databaseUrl ? '✓ Set' : '✗ Missing'}`);
console.log(`NEON_FETCH_TIMEOUT_MS: ${env.neonFetchTimeoutMs}ms`);
console.log(`JWT_SECRET: ${env.jwtSecret ? '✓ Set' : '✗ Missing'}`);
console.log(`NEON_AUTH_BASE_URL: ${env.neonAuthBaseUrl || '✗ Missing'}`);
console.log(`CORS_ORIGIN: ${env.corsOrigin}`);
console.log("\n✅ Configuration check complete!");

if (!env.databaseUrl) {
  console.error("\n❌ ERROR: DATABASE_URL is not set!");
  process.exit(1);
}

if (env.neonFetchTimeoutMs < 30000) {
  console.warn(`\n⚠️  WARNING: NEON_FETCH_TIMEOUT_MS is ${env.neonFetchTimeoutMs}ms.`);
  console.warn("   Recommended minimum is 30000ms (30 seconds) for Neon connections.");
}
