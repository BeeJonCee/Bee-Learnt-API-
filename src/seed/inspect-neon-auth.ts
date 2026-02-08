import "dotenv/config";
import { sql } from "drizzle-orm";
import { db as authDb } from "../core/database/neon-auth-db.js";

/**
 * Script to inspect Neon Auth (neondb) database tables and their data.
 *
 * Neon Auth tables live in the public schema of a separate "neondb" database,
 * NOT in a "neon_auth" schema of the app database. We connect via authDb.
 */

async function inspectNeonAuth() {
  console.log("🔍 Inspecting Neon Auth Database (neondb)\n");

  if (!authDb) {
    console.log("❌ NEON_AUTH_DATABASE_URL not set. Cannot inspect neon auth database.");
    process.exit(1);
  }

  try {
    // 1. List all tables in neondb public schema
    console.log("1️⃣  Tables in neondb public schema:");
    const tables = await authDb.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    for (const table of tables.rows as any[]) {
      console.log(`   - ${table.table_name}`);
    }
    console.log();

    // 2. Inspect member table structure
    console.log("2️⃣  member table structure:");
    const memberColumns = await authDb.execute(sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'member'
      ORDER BY ordinal_position;
    `);

    if (memberColumns.rows.length === 0) {
      console.log("   ℹ️  member table not found\n");
    } else {
      console.log("   Columns:");
      for (const col of memberColumns.rows as any[]) {
        console.log(`   - ${col.column_name} (${col.data_type}) ${col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
      }
      console.log();
    }

    // 3. Check member data
    console.log("3️⃣  Data in member table:");
    const members = await authDb.execute(sql`
      SELECT m.*, u.email, u.name, o.name as org_name
      FROM member m
      LEFT JOIN "user" u ON m."userId" = u.id
      LEFT JOIN organization o ON m."organizationId" = o.id
      ORDER BY m."createdAt" DESC
      LIMIT 10;
    `);

    if (members.rows.length === 0) {
      console.log("   ℹ️  No members found\n");
    } else {
      console.log(`   Found ${members.rows.length} members:\n`);
      for (const member of members.rows as any[]) {
        console.log(`   Member ID: ${member.id}`);
        console.log(`   User: ${member.name || 'N/A'} (${member.email || 'N/A'})`);
        console.log(`   Organization: ${member.org_name || 'N/A'} (${member.organizationId})`);
        console.log(`   Role: ${member.role}`);
        console.log(`   Created: ${member.createdAt}`);
        console.log();
      }
    }

    // 4. Check user table
    console.log("4️⃣  Data in user table:");
    const users = await authDb.execute(sql`
      SELECT id, email, name, role, "emailVerified", banned, "createdAt"
      FROM "user"
      ORDER BY "createdAt" DESC
      LIMIT 10;
    `);

    if (users.rows.length === 0) {
      console.log("   ℹ️  No users found\n");
    } else {
      console.log(`   Found ${users.rows.length} users:\n`);
      for (const user of users.rows as any[]) {
        console.log(`   User ID: ${user.id}`);
        console.log(`   Email: ${user.email}`);
        console.log(`   Name: ${user.name || 'N/A'}`);
        console.log(`   Role: ${user.role || 'N/A'}`);
        console.log(`   Email Verified: ${user.emailVerified}`);
        console.log(`   Banned: ${user.banned}`);
        console.log(`   Created: ${user.createdAt}`);
        console.log();
      }
    }

    // 5. Check organization table
    console.log("5️⃣  Data in organization table:");
    const orgs = await authDb.execute(sql`
      SELECT id, name, slug, logo, "createdAt"
      FROM organization
      ORDER BY "createdAt" DESC
      LIMIT 10;
    `);

    if (orgs.rows.length === 0) {
      console.log("   ℹ️  No organizations found\n");
    } else {
      console.log(`   Found ${orgs.rows.length} organizations:\n`);
      for (const org of orgs.rows as any[]) {
        console.log(`   Org ID: ${org.id}`);
        console.log(`   Name: ${org.name}`);
        console.log(`   Slug: ${org.slug}`);
        console.log(`   Created: ${org.createdAt}`);
        console.log();
      }
    }

    // 6. Check account table
    console.log("6️⃣  Data in account table:");
    const accounts = await authDb.execute(sql`
      SELECT a.id, a."userId", a."providerId", a."accountId", u.email
      FROM account a
      LEFT JOIN "user" u ON a."userId" = u.id
      ORDER BY a."createdAt" DESC
      LIMIT 10;
    `);

    if (accounts.rows.length === 0) {
      console.log("   ℹ️  No accounts found\n");
    } else {
      console.log(`   Found ${accounts.rows.length} accounts:\n`);
      for (const acc of accounts.rows as any[]) {
        console.log(`   Account ID: ${acc.id}`);
        console.log(`   User Email: ${acc.email || 'N/A'}`);
        console.log(`   Provider: ${acc.providerId}`);
        console.log(`   Account ID: ${acc.accountId}`);
        console.log();
      }
    }

    // Summary
    console.log("📊 Summary:");
    console.log(`   Users: ${users.rows.length}`);
    console.log(`   Members: ${members.rows.length}`);
    console.log(`   Organizations: ${orgs.rows.length}`);
    console.log(`   Accounts: ${accounts.rows.length}`);
    console.log();

  } catch (error) {
    console.error("❌ Error inspecting neondb:", error);
    throw error;
  }
}

inspectNeonAuth()
  .then(() => {
    console.log("✅ Inspection completed");
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ Inspection failed:", error);
    process.exit(1);
  });
