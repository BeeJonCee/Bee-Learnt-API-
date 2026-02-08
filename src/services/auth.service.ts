/**
 * Auth Service
 *
 * Neon Auth is the sole identity provider.
 * This service handles legacy email/password login (for existing local users)
 * and Neon Auth credential login as a fallback.
 *
 * Registration and email verification are handled by Neon Auth SDK on the frontend.
 */

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db } from "../core/database/index.js";
import { roles, users } from "../core/database/schema/index.js";
import { env } from "../config/env.js";
import { HttpError } from "../shared/utils/http-error.js";
import type { BeeLearntRole } from "../shared/types/auth.js";
import {
  isNeonAuthAvailable,
  authenticateViaNeonAuth,
} from "./neon-auth-sync.js";

type LoginInput = {
  email: string;
  password: string;
};

export async function loginUser(input: LoginInput) {
  if (!env.jwtSecret) {
    throw new HttpError("JWT secret is not configured.", 500);
  }

  // Look up user in beelearnt database
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      passwordHash: users.passwordHash,
      role: roles.name,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.email, input.email));

  // Path 1: Local auth — user exists with a passwordHash in beelearnt
  if (user?.passwordHash) {
    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) {
      throw new HttpError("Invalid email or password.", 401);
    }

    const normalizedRole = user.role.toUpperCase() as BeeLearntRole;

    const token = jwt.sign(
      { id: user.id, role: normalizedRole, email: user.email, name: user.name },
      env.jwtSecret,
      { expiresIn: "7d" },
    );

    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
    console.log(`✓ User logged in (local): ${user.email} (Role: ${normalizedRole})`);

    return {
      token,
      user: { id: user.id, name: user.name, email: user.email, role: normalizedRole },
    };
  }

  // Path 2: Neon Auth fallback — check neondb.neon_auth.account for credential provider
  if (isNeonAuthAvailable()) {
    const neonResult = await authenticateViaNeonAuth(input.email, input.password);
    if (neonResult) {
      const token = jwt.sign(
        { id: neonResult.id, role: neonResult.role, email: neonResult.email, name: neonResult.name },
        env.jwtSecret,
        { expiresIn: "7d" },
      );

      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, neonResult.id));
      console.log(`✓ User logged in (Neon Auth): ${neonResult.email} (Role: ${neonResult.role})`);

      return {
        token,
        user: { id: neonResult.id, name: neonResult.name, email: neonResult.email, role: neonResult.role },
      };
    }
  }

  throw new HttpError("Invalid email or password.", 401);
}
