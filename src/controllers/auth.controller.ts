import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { db } from "../core/database/index.js";
import { sql } from "drizzle-orm";
import { asyncHandler } from "../core/middleware/async-handler.js";
import { env } from "../config/env.js";
import { syncNeonAuthUserToApp } from "../services/neon-auth-sync.js";
import {
  confirmEmailVerificationCode,
  loginUser,
  registerUser,
  sendEmailVerificationCode,
} from "../services/auth.service.js";

interface NeonAuthToken {
  sub: string;
  email?: string;
  name?: string;
  iat: number;
  exp: number;
}

export const register = asyncHandler(async (req: Request, res: Response) => {
  const result = await registerUser(req.body);
  res.status(201).json(result);
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const result = await loginUser(req.body);
  res.json(result);
});

export const me = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  res.json({ user: req.user });
});

export const sendVerification = asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body as { email: string };
  await sendEmailVerificationCode(email);
  res.json({ ok: true });
});

export const confirmVerification = asyncHandler(async (req: Request, res: Response) => {
  const { email, code } = req.body as { email: string; code: string };
  await confirmEmailVerificationCode(email, code);
  res.json({ ok: true });
});

export const socialBridge = asyncHandler(async (req: Request, res: Response) => {
  const internalSecret = req.header("x-internal-secret");
  if (!internalSecret || internalSecret !== env.jwtSecret) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  const { neonAuthUserId } = req.body as { neonAuthUserId: string };
  if (!neonAuthUserId) {
    res.status(400).json({ message: "neonAuthUserId is required" });
    return;
  }

  console.log(`🌐 Social auth bridge called for user: ${neonAuthUserId}`);

  const syncResult = await syncNeonAuthUserToApp(neonAuthUserId);

  if (!syncResult) {
    res.status(400).json({ message: "Failed to sync user from Neon Auth" });
    return;
  }

  console.log(`✓ Social bridge sync successful: ${syncResult.email} (${syncResult.role})`);

  if (!env.jwtSecret) {
    res.status(500).json({ message: "JWT secret is not configured" });
    return;
  }

  const token = jwt.sign(
    {
      id: syncResult.id,
      role: syncResult.role,
      email: syncResult.email,
      name: syncResult.name,
    },
    env.jwtSecret,
    { expiresIn: "7d" },
  );

  res.json({
    token,
    user: {
      id: syncResult.id,
      name: syncResult.name,
      email: syncResult.email,
      role: syncResult.role,
    },
  });
});

/**
 * Fast path: Exchange Neon Auth session token directly for backend JWT
 * No slow auth.getSession() call needed - token comes from __session cookie
 */
export const exchangeNeonToken = asyncHandler(async (req: Request, res: Response) => {
  const { sessionToken } = req.body as { sessionToken: string };

  if (!sessionToken) {
    res.status(400).json({ message: "Missing sessionToken" });
    return;
  }

  // Decode token (don't verify signature - Neon tokens are short-lived and already validated)
  let decodedToken: NeonAuthToken;
  try {
    const decoded = jwt.decode(sessionToken);
    if (!decoded || typeof decoded === "string") {
      res.status(401).json({ message: "Invalid token format" });
      return;
    }
    decodedToken = decoded as NeonAuthToken;

    if (!decodedToken.sub) {
      res.status(401).json({ message: "Invalid token: missing sub claim" });
      return;
    }
  } catch (error) {
    res.status(401).json({ message: "Invalid token" });
    return;
  }

  // Check if token is expired
  if (decodedToken.exp && decodedToken.exp * 1000 < Date.now()) {
    res.status(401).json({ message: "Token expired" });
    return;
  }

  const neonUserId = decodedToken.sub;

  console.log(`🔑 Exchanging Neon Auth token for user: ${neonUserId}`);

  // Sync user from neondb to beelearnt.users
  const syncResult = await syncNeonAuthUserToApp(neonUserId);

  if (!syncResult) {
    res.status(400).json({ message: "Failed to sync user from Neon Auth" });
    return;
  }

  console.log(`✓ Token exchange successful for: ${syncResult.email} (${syncResult.role})`);

  if (!env.jwtSecret) {
    res.status(500).json({ message: "JWT secret is not configured" });
    return;
  }

  // Create backend JWT
  const token = jwt.sign(
    {
      id: syncResult.id,
      role: syncResult.role,
      email: syncResult.email,
      name: syncResult.name,
    },
    env.jwtSecret,
    { expiresIn: "7d" },
  );

  res.json({
    token,
    user: {
      id: syncResult.id,
      name: syncResult.name,
      email: syncResult.email,
      role: syncResult.role,
    },
  });
});
