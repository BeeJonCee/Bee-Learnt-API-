import "dotenv/config";
import { sql } from "drizzle-orm";
import { db as authDb } from "../core/database/neon-auth-db.js";
import { syncUserFromNeonAuth } from "../services/neon-auth-sync.js";

async function run() {
  if (!authDb) {
    console.log("❌ NEON_AUTH_DATABASE_URL not set. Cannot sync neon auth users.");
    process.exit(1);
  }

  console.log("\n🔄 Syncing neondb.user -> beelearnt.users\n");

  const result = await authDb.execute<{ id: string }>(sql`
    SELECT id::text as id FROM "user"
  `);

  if (result.rows.length === 0) {
    console.log("No neondb users found. Nothing to sync.");
    return;
  }

  let synced = 0;
  let failed = 0;

  for (const row of result.rows) {
    try {
      await syncUserFromNeonAuth(row.id);
      synced++;
    } catch (error) {
      failed++;
      console.error(`Failed to sync user ${row.id}:`, error);
    }
  }

  console.log(`\n✅ Sync complete: ${synced} synced, ${failed} failed`);
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Sync failed:", error);
    process.exit(1);
  });
