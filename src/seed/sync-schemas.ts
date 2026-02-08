/**
 * Schema Sync and Verification Script
 *
 * Run this to verify both databases are accessible and sync users:
 * 1. Verify authDb (neondb) and appDb (beelearnt) are connected
 * 2. Display current stats from both databases
 * 3. Check for inconsistencies
 * 4. Sync users if needed
 *
 * Architecture:
 * - beelearnt DB (appDb/db): public.users, public.roles, etc.
 * - neondb DB (authDb): public.user, public.account, public.member, etc.
 */

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../core/database/index.js";
import { db as authDb } from "../core/database/neon-auth-db.js";
import {
  syncAllUsersToNeonAuth,
  verifySchemaConsistency,
} from "../shared/utils/schema-sync.js";

async function checkDatabases(): Promise<boolean> {
  console.log("🔍 Checking database connections...\n");

  // Check beelearnt (appDb)
  try {
    await db.execute(sql`SELECT 1`);
    console.log("✅ beelearnt database (appDb) connected");
  } catch (error) {
    console.log("❌ beelearnt database (appDb) connection failed!");
    return false;
  }

  // Check neondb (authDb)
  if (!authDb) {
    console.log("❌ neondb (authDb) not configured! Set NEON_AUTH_DATABASE_URL.");
    return false;
  }

  try {
    await authDb.execute(sql`SELECT 1`);
    console.log("✅ neondb (authDb) connected");
  } catch (error) {
    console.log("❌ neondb (authDb) connection failed!");
    return false;
  }

  // Check required tables in beelearnt
  const beelearntTables = ["users", "roles"];
  for (const table of beelearntTables) {
    const exists = await db.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${table}
    `);

    if (exists.rows.length === 0) {
      console.log(`❌ beelearnt.${table} table doesn't exist!`);
      return false;
    }
    console.log(`✅ beelearnt.${table} exists`);
  }

  // Check required tables in neondb
  const neondbTables = ["user", "account", "member"];
  for (const table of neondbTables) {
    const exists = await authDb.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${table}
    `);

    if (exists.rows.length === 0) {
      console.log(`❌ neondb.${table} table doesn't exist!`);
      return false;
    }
    console.log(`✅ neondb.${table} exists`);
  }

  return true;
}

async function displayStats() {
  console.log("\n📊 Database Statistics\n");

  // Count users in beelearnt
  const publicUsersCount = await db.execute(sql`SELECT COUNT(*)::text as count FROM users`);
  console.log(`beelearnt.users:           ${(publicUsersCount.rows[0] as any).count}`);

  if (authDb) {
    // Count records in neondb
    const neonUsersCount = await authDb.execute(sql`SELECT COUNT(*)::text as count FROM "user"`);
    const neonAccountsCount = await authDb.execute(sql`SELECT COUNT(*)::text as count FROM account WHERE password IS NOT NULL`);
    const neonMembersCount = await authDb.execute(sql`SELECT COUNT(*)::text as count FROM member`);

    console.log(`neondb.user:               ${(neonUsersCount.rows[0] as any).count}`);
    console.log(`neondb.account (w/ pwd):   ${(neonAccountsCount.rows[0] as any).count}`);
    console.log(`neondb.member:             ${(neonMembersCount.rows[0] as any).count}`);
  }

  // Show role distribution
  console.log("\n📈 Role Distribution:\n");
  const roleStats = await db.execute(sql`
    SELECT r.name, COUNT(u.id)::text as count
    FROM roles r
    LEFT JOIN users u ON u.role_id = r.id
    GROUP BY r.name
    ORDER BY r.name
  `);

  for (const stat of roleStats.rows as any[]) {
    const emoji = stat.name === "ADMIN" ? "👑" : stat.name === "PARENT" ? "👨‍👩‍👧" : "🎓";
    console.log(`   ${emoji} ${stat.name.padEnd(10)}: ${stat.count}`);
  }
}

async function main() {
  console.log("\n🚀 BeeLearnt Schema Sync & Verification\n");
  console.log("=".repeat(80));

  try {
    // Step 1: Check databases
    const dbsOk = await checkDatabases();
    if (!dbsOk) {
      console.log("\n❌ Database check failed. Cannot proceed with sync.");
      process.exit(1);
    }

    // Step 2: Display current stats
    await displayStats();

    // Step 3: Verify consistency
    console.log("\n" + "=".repeat(80));
    const { consistent, mismatches } = await verifySchemaConsistency();

    if (!consistent) {
      console.log("\n⚠️  Found inconsistencies. Running sync...\n");
      console.log("=".repeat(80));

      // Step 4: Sync users
      const { synced, failed } = await syncAllUsersToNeonAuth();

      console.log("\n" + "=".repeat(80));
      console.log(`\n✨ Sync Summary:`);
      console.log(`   ✅ Synced: ${synced}`);
      console.log(`   ❌ Failed: ${failed}`);

      // Step 5: Verify again
      console.log("\n" + "=".repeat(80));
      const finalCheck = await verifySchemaConsistency();

      if (finalCheck.consistent) {
        console.log("\n🎉 All databases are now consistent!");
      } else {
        console.log("\n⚠️  Some inconsistencies remain:");
        for (const mismatch of finalCheck.mismatches) {
          console.log(`   - ${mismatch.issue}`);
        }
      }
    }

    // Step 6: Final stats
    console.log("\n" + "=".repeat(80));
    await displayStats();

    console.log("\n" + "=".repeat(80));
    console.log("\n✅ Schema sync complete!");
    console.log("\n💡 Key Points:");
    console.log("   • beelearnt.users.id matches neondb.user.id (both uuid)");
    console.log("   • Passwords stored in both neondb.account and beelearnt.users");
    console.log("   • Roles synced: neondb.user.role ←→ beelearnt.users.role_id");
    console.log("   • Member roles take precedence when organizationId present");
    console.log("   • Email/name/image fields kept in sync\n");

  } catch (error) {
    console.error("\n❌ Error:", error);
    throw error;
  }
}

main()
  .then(() => {
    console.log("👋 Done!");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  });
