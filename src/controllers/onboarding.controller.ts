import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { db } from "../core/database/index.js";
import { moduleAccessCodes, modules, subjects, userModuleSelections } from "../core/database/schema/index.js";
import { asyncHandler } from "../core/middleware/async-handler.js";
import { HttpError } from "../shared/utils/http-error.js";
import { isDailyAccessCodeMatch } from "../shared/utils/access-codes.js";

export const listModules = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?.id ?? null;
  if (!userId) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  const [moduleRows, selectionRows] = await Promise.all([
    db
      .select({
        id: modules.id,
        title: modules.title,
        grade: modules.grade,
        order: modules.order,
        subjectName: subjects.name,
      })
      .from(modules)
      .innerJoin(subjects, eq(modules.subjectId, subjects.id))
      .orderBy(subjects.name, modules.grade, modules.order),
    db.select().from(userModuleSelections).where(eq(userModuleSelections.userId, userId)),
  ]);

  const selectionMap = new Map(
    selectionRows.map((selection) => [selection.moduleId, selection.status])
  );

  res.json({
    modules: moduleRows.map((module) => ({
      ...module,
      selected: selectionMap.has(module.id),
      status: selectionMap.get(module.id) ?? null,
    })),
  });
});

export const selectModule = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user?.id ?? null;
  if (!userId) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  const { moduleId, code } = req.body as { moduleId: number; code: string };

  const [moduleRow] = await db
    .select({ id: modules.id, grade: modules.grade, order: modules.order })
    .from(modules)
    .where(eq(modules.id, moduleId));

  if (!moduleRow) {
    throw new HttpError("Module not found", 404);
  }

  const [existingUnlocked] = await db
    .select({ id: userModuleSelections.id })
    .from(userModuleSelections)
    .where(and(eq(userModuleSelections.userId, userId), eq(userModuleSelections.status, "unlocked")))
    .limit(1);

  const [codeRow] = await db
    .select()
    .from(moduleAccessCodes)
    .where(and(eq(moduleAccessCodes.moduleId, moduleId), eq(moduleAccessCodes.active, true)));

  const dailyMatch = isDailyAccessCodeMatch({
    code,
    moduleId: moduleRow.id,
    grade: moduleRow.grade,
    order: moduleRow.order,
  });
  const storedMatch = codeRow ? await bcrypt.compare(code, codeRow.codeHash) : false;

  const valid = existingUnlocked ? dailyMatch || storedMatch : dailyMatch;
  if (!valid) {
    throw new HttpError("Invalid access code for today", 403);
  }

  const [existing] = await db
    .select()
    .from(userModuleSelections)
    .where(and(eq(userModuleSelections.userId, userId), eq(userModuleSelections.moduleId, moduleId)));

  if (existing) {
    const [updated] = await db
      .update(userModuleSelections)
      .set({ status: "unlocked", unlockedAt: new Date() })
      .where(eq(userModuleSelections.id, existing.id))
      .returning();
    res.json({ moduleId, status: updated.status });
    return;
  }

  const [created] = await db
    .insert(userModuleSelections)
    .values({
      userId,
      moduleId,
      status: "unlocked",
      unlockedAt: new Date(),
    })
    .returning();

  res.status(201).json({ moduleId, status: created.status });
});
