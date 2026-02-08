import { Router } from "express";
import { confirmVerification, login, me, register, sendVerification, socialBridge, exchangeNeonToken } from "../controllers/auth.controller.js";
import { requireAuth } from "../core/middleware/auth.js";
import { validateBody } from "../core/middleware/validate.js";
import { emailVerificationConfirmSchema, emailVerificationSendSchema, loginSchema, registerSchema } from "../shared/validators/index.js";

const authRoutes = Router();

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: Authentication and session management
 */

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new BeeLearnt account
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RegisterRequest'
 *     responses:
 *       201:
 *         description: Account created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       400:
 *         description: Invalid registration details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
authRoutes.post("/register", validateBody(registerSchema), register);

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Authenticate a user and return a JWT
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginRequest'
 *     responses:
 *       200:
 *         description: Authentication successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       401:
 *         description: Invalid email or password
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
authRoutes.post("/login", validateBody(loginSchema), login);

authRoutes.post("/verify/send", validateBody(emailVerificationSendSchema), sendVerification);
authRoutes.post("/verify/confirm", validateBody(emailVerificationConfirmSchema), confirmVerification);

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Retrieve the currently authenticated user
 *     tags: [Auth]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Current user profile
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       401:
 *         description: Missing or invalid token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
authRoutes.get("/me", requireAuth, me);
authRoutes.post("/social-bridge", socialBridge);

/**
 * @swagger
 * /api/auth/exchange-neon-token:
 *   post:
 *     summary: Exchange Neon Auth session token for backend JWT (fast path)
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               sessionToken:
 *                 type: string
 *                 description: Neon Auth session token from __session cookie
 *     responses:
 *       200:
 *         description: Token exchange successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       401:
 *         description: Invalid or expired token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
authRoutes.post("/exchange-neon-token", exchangeNeonToken);

export { authRoutes };
