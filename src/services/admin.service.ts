import { sql } from "drizzle-orm";
import { db } from "../core/database/index.js";
import { assignments, lessons, modules, quizAttempts, subjects, users } from "../core/database/schema/index.js";
import { syncAllUsersToNeonAuth, verifySchemaConsistency } from "../shared/utils/schema-sync.js";

export async function getAnalytics() {
  const [userCount] = await db.select({ count: sql<number>`count(*)` }).from(users);
  const [subjectCount] = await db.select({ count: sql<number>`count(*)` }).from(subjects);
  const [moduleCount] = await db.select({ count: sql<number>`count(*)` }).from(modules);
  const [lessonCount] = await db.select({ count: sql<number>`count(*)` }).from(lessons);
  const [assignmentCount] = await db.select({ count: sql<number>`count(*)` }).from(assignments);
  const [quizCount] = await db.select({ count: sql<number>`count(*)` }).from(quizAttempts);

  return {
    users: userCount?.count ?? 0,
    subjects: subjectCount?.count ?? 0,
    modules: moduleCount?.count ?? 0,
    lessons: lessonCount?.count ?? 0,
    assignments: assignmentCount?.count ?? 0,
    quizAttempts: quizCount?.count ?? 0,
  };
}

/**
 * Sync all users from public schema to neon_auth schema
 * Call this after enabling Neon Auth integration
 */
export async function syncUsersToNeonAuth() {
  return syncAllUsersToNeonAuth();
}

/**
 * Verify schema consistency between neon_auth and public schemas
 */
export async function checkSchemaConsistency() {
  return verifySchemaConsistency();
}
