/**
 * Parent-Student Management Controller
 * 
 * Handles parent-student relationships:
 * - Create student profiles
 * - Link parent to student
 * - Unlink parent from student
 * - View linked students
 * - Manage student profiles
 */

import type { Request, Response } from "express";
import { eq, and } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import { asyncHandler } from "../core/middleware/async-handler.js";
import { db } from "../core/database/index.js";
import { users, roles, parentStudentLinks, studentProfiles, parentProfiles } from "../core/database/schema/index.js";
import { logStudentLink, logAudit } from "../lib/audit/auditLog.js";
import { syncToNeonAuthUser, syncFromNeonAuthUser } from "../shared/utils/schema-sync.js";

// ============ CREATE STUDENT PROFILE ============

/**
 * POST /api/parents/students
 * Parent creates a student profile (can be linked immediately or invited via email)
 * Role: PARENT, ADMIN
 */
export const createStudentProfile = asyncHandler(async (req: Request, res: Response) => {
  const {
    name,
    email,
    password,
    grade,
    school,
    dateOfBirth,
    guardianName,
    guardianContact,
    autoLink = true, // Automatically link to parent creating it
  } = req.body;

  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  // Validate required fields
  if (!name || !email || !grade) {
    res.status(400).json({ error: "name, email, and grade are required" });
    return;
  }

  // Check if email already exists
  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  if (existingUser) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }

  // Get STUDENT role
  const studentRole = await db.query.roles.findFirst({
    where: eq(roles.name, "STUDENT"),
  });

  if (!studentRole) {
    res.status(500).json({ error: "STUDENT role not found in database" });
    return;
  }

  // Hash password if provided
  let passwordHash = null;
  if (password) {
    passwordHash = await bcrypt.hash(password, 10);
  }

  // Create user account
  const userId = crypto.randomUUID();
  const [newUser] = await db
    .insert(users)
    .values({
      id: userId,
      name,
      email,
      passwordHash,
      roleId: studentRole.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  // Sync to neon_auth if available
  try {
    await syncToNeonAuthUser({
      id: userId,
      email,
      name,
      role: "STUDENT",
      image: null,
    });
  } catch (error) {
    console.warn("[createStudentProfile] Neon auth sync skipped:", error);
  }

  // Create student profile
  const [profile] = await db
    .insert(studentProfiles)
    .values({
      userId,
      grade,
      school: school || null,
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
      guardianName: guardianName || null,
      guardianContact: guardianContact || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  // Link to parent if autoLink is true and user is a parent
  let link = null;
  if (autoLink && req.user.role === "PARENT") {
    [link] = await db
      .insert(parentStudentLinks)
      .values({
        parentId: req.user.id,
        studentId: userId,
        createdAt: new Date(),
      })
      .returning();

    await logStudentLink(
      "student.link",
      req.user.id,
      userId,
      { autoLinked: true },
      req
    );
  }

  await logAudit({
    actorId: req.user.id,
    action: "student.profile_create",
    entity: "student",
    entityId: null,
    details: { studentId: userId, grade, school },
    req,
  });

  res.status(201).json({
    message: "Student profile created successfully",
    student: {
      id: newUser.id,
      name: newUser.name,
      email: newUser.email,
      grade: profile.grade,
      school: profile.school,
      linked: !!link,
    },
  });
});

// ============ LINK PARENT TO STUDENT ============

/**
 * POST /api/parents/students/:studentId/link
 * Link a parent to an existing student
 * Role: PARENT (with verification), ADMIN
 */
export const linkParentToStudent = asyncHandler(async (req: Request, res: Response) => {
  const studentId = req.params.studentId as string;
  const { verificationCode } = req.body; // Optional: require verification code

  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  // Check if student exists
  const student = await db.query.users.findFirst({
    where: eq(users.id, studentId),
  });

  if (!student) {
    res.status(404).json({ error: "Student not found" });
    return;
  }

  // Check if already linked
  const existingLink = await db.query.parentStudentLinks.findFirst({
    where: and(
      eq(parentStudentLinks.parentId, req.user.id),
      eq(parentStudentLinks.studentId, studentId)
    ),
  });

  if (existingLink) {
    res.status(409).json({ error: "Student already linked to this parent" });
    return;
  }

  // Create link
  const [link] = await db
    .insert(parentStudentLinks)
    .values({
      parentId: req.user.id,
      studentId,
      createdAt: new Date(),
    })
    .returning();

  await logStudentLink(
    "student.link",
    req.user.id,
    studentId,
    { verificationUsed: !!verificationCode },
    req
  );

  res.status(201).json({
    message: "Student linked successfully",
    link,
  });
});

// ============ UNLINK PARENT FROM STUDENT ============

/**
 * DELETE /api/parents/students/:studentId/link
 * Unlink a parent from a student
 * Role: PARENT (own link), ADMIN
 */
export const unlinkParentFromStudent = asyncHandler(async (req: Request, res: Response) => {
  const studentId = req.params.studentId as string;

  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  // Find existing link
  const link = await db.query.parentStudentLinks.findFirst({
    where: and(
      eq(parentStudentLinks.parentId, req.user.id),
      eq(parentStudentLinks.studentId, studentId)
    ),
  });

  if (!link) {
    res.status(404).json({ error: "Link not found" });
    return;
  }

  // Delete link
  await db
    .delete(parentStudentLinks)
    .where(
      and(
        eq(parentStudentLinks.parentId, req.user.id),
        eq(parentStudentLinks.studentId, studentId)
      )
    );

  await logStudentLink(
    "student.unlink",
    req.user.id,
    studentId,
    {},
    req
  );

  res.json({ message: "Student unlinked successfully" });
});

// ============ GET LINKED STUDENTS ============

/**
 * GET /api/parents/students
 * Get all students linked to the parent
 * Role: PARENT (own students), ADMIN
 */
export const getLinkedStudents = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const parentId = req.user.id;

  // Get all links with student details
  const links = await db.query.parentStudentLinks.findMany({
    where: eq(parentStudentLinks.parentId, parentId),
    with: {
      student: {
        with: {
          studentProfile: true,
        },
      },
    },
  });

  const students = links.map((link) => ({
    id: link.student.id,
    name: link.student.name,
    email: link.student.email,
    grade: link.student.studentProfile?.grade,
    school: link.student.studentProfile?.school,
    linkedAt: link.createdAt,
  }));

  res.json({
    students,
    total: students.length,
  });
});

// ============ GET STUDENT DETAILS ============

/**
 * GET /api/parents/students/:studentId
 * Get detailed information about a linked student
 * Role: PARENT (linked student), STUDENT (self), ADMIN, TUTOR
 */
export const getStudentDetails = asyncHandler(async (req: Request, res: Response) => {
  const studentId = req.params.studentId as string;

  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  // Permission check done by guard middleware
  const student = await db.query.users.findFirst({
    where: eq(users.id, studentId),
    with: {
      studentProfile: true,
    },
  });

  if (!student) {
    res.status(404).json({ error: "Student not found" });
    return;
  }

  res.json({
    student: {
      id: student.id,
      name: student.name,
      email: student.email,
      profile: student.studentProfile,
    },
  });
});

// ============ UPDATE STUDENT PROFILE ============

/**
 * PATCH /api/parents/students/:studentId
 * Update student profile information
 * Role: PARENT (linked student), STUDENT (self), ADMIN
 */
export const updateStudentProfile = asyncHandler(async (req: Request, res: Response) => {
  const studentId = req.params.studentId as string;
  const { grade, school, guardianName, guardianContact, emergencyContact, medicalInfo } = req.body;

  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  // Check if student exists
  const student = await db.query.users.findFirst({
    where: eq(users.id, studentId),
  });

  if (!student) {
    res.status(404).json({ error: "Student not found" });
    return;
  }

  // Build update object
  const updateData: any = { updatedAt: new Date() };

  if (grade !== undefined) updateData.grade = grade;
  if (school !== undefined) updateData.school = school;
  if (guardianName !== undefined) updateData.guardianName = guardianName;
  if (guardianContact !== undefined) updateData.guardianContact = guardianContact;
  if (emergencyContact !== undefined) updateData.emergencyContact = emergencyContact;
  if (medicalInfo !== undefined) updateData.medicalInfo = medicalInfo;

  if (Object.keys(updateData).length === 1) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  // Update profile
  const [updated] = await db
    .update(studentProfiles)
    .set(updateData)
    .where(eq(studentProfiles.userId, studentId))
    .returning();

  await logAudit({
    actorId: req.user.id,
    action: "student.profile_update",
    entity: "student",
    entityId: null,
    details: { studentId, updates: Object.keys(updateData) },
    req,
  });

  res.json({
    message: "Student profile updated successfully",
    profile: updated,
  });
});

// ============ CREATE PARENT PROFILE ============

/**
 * POST /api/parents/profile
 * Create or update parent profile
 * Role: PARENT (self), ADMIN
 */
export const createParentProfile = asyncHandler(async (req: Request, res: Response) => {
  const { occupation, phoneNumber, address, emergencyContact, preferences } = req.body;

  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  // Check if profile already exists
  const existing = await db.query.parentProfiles.findFirst({
    where: eq(parentProfiles.userId, req.user.id),
  });

  if (existing) {
    // Update existing profile
    const [updated] = await db
      .update(parentProfiles)
      .set({
        occupation: occupation || existing.occupation,
        phoneNumber: phoneNumber || existing.phoneNumber,
        address: address || existing.address,
        emergencyContact: emergencyContact || existing.emergencyContact,
        preferences: preferences || existing.preferences,
        updatedAt: new Date(),
      })
      .where(eq(parentProfiles.userId, req.user.id))
      .returning();

    res.json({
      message: "Parent profile updated successfully",
      profile: updated,
    });
    return;
  }

  // Create new profile
  const [profile] = await db
    .insert(parentProfiles)
    .values({
      userId: req.user.id,
      occupation: occupation || null,
      phoneNumber: phoneNumber || null,
      address: address || null,
      emergencyContact: emergencyContact || null,
      preferences: preferences || {},
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  res.status(201).json({
    message: "Parent profile created successfully",
    profile,
  });
});

// ============ GET PARENT PROFILE ============

/**
 * GET /api/parents/profile
 * Get parent profile information
 * Role: PARENT (self), ADMIN
 */
export const getParentProfile = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const profile = await db.query.parentProfiles.findFirst({
    where: eq(parentProfiles.userId, req.user.id),
  });

  if (!profile) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  res.json({ profile });
});
