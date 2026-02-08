import { randomUUID } from "crypto";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { db } from "../../core/database/index.js";
import {
  assessmentAttempts,
  assessmentQuestions,
  assessmentSections,
  assessments,
  attemptAnswers,
  questionBankItems,
  subjects,
} from "../../core/database/schema/index.js";
import type { BeeLearntRole } from "../../shared/types/auth.js";
import { HttpError } from "../../shared/utils/http-error.js";
import { questionRenderer } from "../questions/question-renderer.service.js";
import { gradingService } from "./grading.service.js";
import { masteryService } from "./mastery.service.js";
import type { UserAnswer } from "../questions/questions.types.js";

export type AssessmentType =
  | "quiz"
  | "test"
  | "exam"
  | "practice"
  | "nsc_simulation"
  | "diagnostic";

export type AssessmentStatus = "draft" | "published" | "archived";

export type AttemptStatus =
  | "in_progress"
  | "submitted"
  | "timed_out"
  | "graded"
  | "reviewed";

type ListAssessmentsInput = {
  role: BeeLearntRole;
  subjectId?: number;
  moduleId?: number;
  grade?: number;
  type?: AssessmentType;
  status?: AssessmentStatus;
  limit?: number;
  offset?: number;
};

type CreateAssessmentInput = {
  title: string;
  description?: string;
  type: AssessmentType;
  status?: AssessmentStatus;
  subjectId: number;
  grade?: number;
  moduleId?: number;
  timeLimitMinutes?: number;
  maxAttempts?: number;
  shuffleQuestions?: boolean;
  shuffleOptions?: boolean;
  showResultsImmediately?: boolean;
  showCorrectAnswers?: boolean;
  showExplanations?: boolean;
  instructions?: string;
  sections: Array<{
    title?: string;
    instructions?: string;
    order: number;
    timeLimitMinutes?: number;
    questions: Array<{
      questionBankItemId: number;
      order: number;
      overridePoints?: number;
    }>;
  }>;
};

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractValue(payload: unknown): unknown {
  if (payload === null || payload === undefined) return null;
  if (typeof payload !== "object") return payload;
  if (Array.isArray(payload)) return payload;

  const obj = payload as Record<string, unknown>;
  // Handle common JSON shapes: { value }, { answer }, { correctAnswer }
  if (obj.value !== undefined) return obj.value;
  if (obj.answer !== undefined) return obj.answer;
  if (obj.correctAnswer !== undefined) return obj.correctAnswer;
  return payload;
}

function equalsNormalized(a: unknown, b: unknown): boolean {
  const av = extractValue(a);
  const bv = extractValue(b);

  if (typeof av === "string" && typeof bv === "string") {
    return av.trim().toLowerCase() === bv.trim().toLowerCase();
  }
  if (typeof av === "number" && typeof bv === "number") return av === bv;
  if (typeof av === "boolean" && typeof bv === "boolean") return av === bv;

  // Last-resort structural compare for json-ish answers.
  try {
    return JSON.stringify(av) === JSON.stringify(bv);
  } catch {
    return false;
  }
}

function canViewSolutions(role: BeeLearntRole, assessment: typeof assessments.$inferSelect) {
  if (role === "ADMIN" || role === "TUTOR") return true;
  return Boolean(assessment.showCorrectAnswers);
}

function canViewExplanations(role: BeeLearntRole, assessment: typeof assessments.$inferSelect) {
  if (role === "ADMIN" || role === "TUTOR") return true;
  return Boolean(assessment.showExplanations);
}

export async function listAssessments(input: ListAssessmentsInput) {
  const now = new Date();
  const conditions: any[] = [];

  if (input.subjectId) conditions.push(eq(assessments.subjectId, input.subjectId));
  if (input.moduleId) conditions.push(eq(assessments.moduleId, input.moduleId));
  if (input.grade) conditions.push(eq(assessments.grade, input.grade));
  if (input.type) conditions.push(eq(assessments.type, input.type));

  const isPrivileged = input.role === "ADMIN" || input.role === "TUTOR";
  if (isPrivileged) {
    if (input.status) conditions.push(eq(assessments.status, input.status));
  } else {
    // Students/parents only see published + currently available assessments.
    conditions.push(eq(assessments.status, "published"));
    conditions.push(or(isNull(assessments.availableFrom), lte(assessments.availableFrom, now)));
    conditions.push(or(isNull(assessments.availableUntil), gte(assessments.availableUntil, now)));
  }

  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;

  let query = db
    .select({
      id: assessments.id,
      title: assessments.title,
      description: assessments.description,
      type: assessments.type,
      status: assessments.status,
      subjectId: assessments.subjectId,
      subjectName: subjects.name,
      grade: assessments.grade,
      moduleId: assessments.moduleId,
      timeLimitMinutes: assessments.timeLimitMinutes,
      availableFrom: assessments.availableFrom,
      availableUntil: assessments.availableUntil,
      createdAt: assessments.createdAt,
      updatedAt: assessments.updatedAt,
    })
    .from(assessments)
    .$dynamic()
    .innerJoin(subjects, eq(assessments.subjectId, subjects.id))
    .orderBy(desc(assessments.createdAt))
    .limit(limit)
    .offset(offset);

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  return query;
}

export async function getAssessment(id: number) {
  const [row] = await db.select().from(assessments).where(eq(assessments.id, id));
  return row ?? null;
}

export async function getAssessmentDetail(id: number) {
  const assessment = await getAssessment(id);
  if (!assessment) return null;

  const sections = await db
    .select()
    .from(assessmentSections)
    .where(eq(assessmentSections.assessmentId, id))
    .orderBy(assessmentSections.order);

  const questions = await db
    .select({
      assessmentQuestionId: assessmentQuestions.id,
      assessmentId: assessmentQuestions.assessmentId,
      sectionId: assessmentQuestions.sectionId,
      order: assessmentQuestions.order,
      overridePoints: assessmentQuestions.overridePoints,
      questionBankItemId: questionBankItems.id,
      type: questionBankItems.type,
      difficulty: questionBankItems.difficulty,
      questionText: questionBankItems.questionText,
      questionHtml: questionBankItems.questionHtml,
      imageUrl: questionBankItems.imageUrl,
      options: questionBankItems.options,
      correctAnswer: questionBankItems.correctAnswer,
      explanation: questionBankItems.explanation,
      points: questionBankItems.points,
      timeLimitSeconds: questionBankItems.timeLimitSeconds,
      source: questionBankItems.source,
      sourceReference: questionBankItems.sourceReference,
      tags: questionBankItems.tags,
    })
    .from(assessmentQuestions)
    .innerJoin(
      questionBankItems,
      eq(assessmentQuestions.questionBankItemId, questionBankItems.id)
    )
    .where(eq(assessmentQuestions.assessmentId, id))
    .orderBy(assessmentQuestions.order);

  const sectionModels = sections.map((section) => ({
    id: section.id,
    title: section.title,
    instructions: section.instructions,
    order: section.order,
    timeLimitMinutes: section.timeLimitMinutes,
    questions: [] as Array<typeof questions[number] & { points: number }>,
  }));

  const bySectionId = new Map<number, (typeof sectionModels)[number]>();
  for (const section of sectionModels) bySectionId.set(section.id, section);

  // In normal flows, sectionId is present. If it's null, we attach to the first section.
  const fallbackSection = sectionModels[0];

  for (const question of questions) {
    const effectivePoints = question.overridePoints ?? question.points ?? 1;
    const target =
      question.sectionId && bySectionId.get(question.sectionId)
        ? bySectionId.get(question.sectionId)
        : fallbackSection;
    if (!target) continue;
    target.questions.push({ ...question, points: effectivePoints });
  }

  return { assessment, sections: sectionModels };
}

export async function createAssessment(input: CreateAssessmentInput, createdBy: string) {
  const questionIds = Array.from(
    new Set(
      input.sections.flatMap((section) =>
        section.questions.map((question) => question.questionBankItemId)
      )
    )
  );

  if (questionIds.length === 0) {
    throw new HttpError("Assessment must contain at least one question.", 400);
  }

  const existingQuestions = await db
    .select({ id: questionBankItems.id })
    .from(questionBankItems)
    .where(inArray(questionBankItems.id, questionIds));

  const existingIds = new Set(existingQuestions.map((row) => row.id));
  const missing = questionIds.filter((id) => !existingIds.has(id));
  if (missing.length > 0) {
    throw new HttpError(`Unknown questionBankItemId(s): ${missing.join(", ")}`, 400);
  }

  const [assessment] = await db
    .insert(assessments)
    .values({
      title: input.title,
      description: input.description ?? null,
      type: input.type,
      status: input.status ?? "draft",
      subjectId: input.subjectId,
      grade: input.grade ?? null,
      moduleId: input.moduleId ?? null,
      timeLimitMinutes: input.timeLimitMinutes ?? null,
      maxAttempts: input.maxAttempts ?? null,
      shuffleQuestions: input.shuffleQuestions ?? false,
      shuffleOptions: input.shuffleOptions ?? false,
      showResultsImmediately: input.showResultsImmediately ?? true,
      showCorrectAnswers: input.showCorrectAnswers ?? true,
      showExplanations: input.showExplanations ?? true,
      instructions: input.instructions ?? null,
      createdBy,
      updatedAt: new Date(),
    })
    .returning();

  for (const section of input.sections) {
    const [createdSection] = await db
      .insert(assessmentSections)
      .values({
        assessmentId: assessment.id,
        title: section.title ?? null,
        instructions: section.instructions ?? null,
        order: section.order,
        timeLimitMinutes: section.timeLimitMinutes ?? null,
      })
      .returning();

    await db.insert(assessmentQuestions).values(
      section.questions.map((question) => ({
        assessmentId: assessment.id,
        sectionId: createdSection.id,
        questionBankItemId: question.questionBankItemId,
        order: question.order,
        overridePoints: question.overridePoints ?? null,
      }))
    );
  }

  return assessment;
}

export async function publishAssessment(id: number) {
  const [updated] = await db
    .update(assessments)
    .set({ status: "published", updatedAt: new Date() })
    .where(eq(assessments.id, id))
    .returning();

  return updated ?? null;
}

export async function startAssessmentAttempt(assessmentId: number, userId: string) {
  const assessment = await getAssessment(assessmentId);
  if (!assessment) {
    throw new HttpError("Assessment not found.", 404);
  }

  if (assessment.status !== "published") {
    throw new HttpError("Assessment is not available.", 403);
  }

  const now = new Date();
  if (assessment.availableFrom && assessment.availableFrom > now) {
    throw new HttpError("Assessment is not available yet.", 403);
  }
  if (assessment.availableUntil && assessment.availableUntil < now) {
    throw new HttpError("Assessment is no longer available.", 403);
  }

  if (assessment.maxAttempts) {
    const result = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM assessment_attempts
      WHERE assessment_id = ${assessmentId}
        AND user_id = ${userId}::uuid
    `);
    const count = result.rows[0]?.count ?? 0;
    if (count >= assessment.maxAttempts) {
      throw new HttpError("Maximum attempts reached for this assessment.", 400);
    }
  }

  const attemptId = randomUUID();

  await db.insert(assessmentAttempts).values({
    id: attemptId,
    assessmentId,
    userId,
    status: "in_progress",
    startedAt: new Date(),
    metadata: {},
  });

  const detail = await getAssessmentDetail(assessmentId);
  if (!detail) throw new HttpError("Assessment not found.", 404);

  return {
    attemptId,
    assessment: {
      id: assessment.id,
      title: assessment.title,
      type: assessment.type,
      timeLimitMinutes: assessment.timeLimitMinutes,
      instructions: assessment.instructions,
    },
    sections: detail.sections.map((section) => ({
      id: section.id,
      title: section.title,
      order: section.order,
      instructions: section.instructions,
      questions: section.questions.map((q) => {
        // Use question renderer to strip correct answers and format for display
        const rendered = questionRenderer.renderForAttempt(q as any, {
          shuffleOptions: assessment.shuffleOptions,
          showPoints: true,
          showTimeLimit: true,
        });

        return {
          assessmentQuestionId: q.assessmentQuestionId,
          questionBankItemId: q.questionBankItemId,
          order: q.order,
          ...rendered,
        };
      }),
    })),
  };
}

export async function getAttempt(attemptId: string) {
  const [attempt] = await db
    .select()
    .from(assessmentAttempts)
    .where(eq(assessmentAttempts.id, attemptId));
  return attempt ?? null;
}

export async function answerAttempt(input: {
  attemptId: string;
  userId: string;
  assessmentQuestionId: number;
  answer: unknown;
  timeTakenSeconds?: number;
}) {
  const attempt = await getAttempt(input.attemptId);
  if (!attempt) throw new HttpError("Attempt not found.", 404);
  if (attempt.userId !== input.userId) throw new HttpError("Forbidden.", 403);
  if (attempt.status !== "in_progress") {
    throw new HttpError("Attempt is not accepting answers.", 400);
  }

  const [question] = await db
    .select({
      id: assessmentQuestions.id,
      questionBankItemId: assessmentQuestions.questionBankItemId,
    })
    .from(assessmentQuestions)
    .where(
      and(
        eq(assessmentQuestions.id, input.assessmentQuestionId),
        eq(assessmentQuestions.assessmentId, attempt.assessmentId)
      )
    );

  if (!question) {
    throw new HttpError("Invalid assessment question.", 400);
  }

  await db
    .insert(attemptAnswers)
    .values({
      attemptId: attempt.id,
      assessmentQuestionId: question.id,
      questionBankItemId: question.questionBankItemId,
      answer: input.answer as any,
      timeTakenSeconds: input.timeTakenSeconds ?? null,
      answeredAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [attemptAnswers.attemptId, attemptAnswers.assessmentQuestionId],
      set: {
        answer: input.answer as any,
        timeTakenSeconds: input.timeTakenSeconds ?? null,
        answeredAt: new Date(),
      },
    });

  return { ok: true };
}

export async function submitAttempt(input: { attemptId: string; userId: string }) {
  const attempt = await getAttempt(input.attemptId);
  if (!attempt) throw new HttpError("Attempt not found.", 404);
  if (attempt.userId !== input.userId) throw new HttpError("Forbidden.", 403);

  if (attempt.status !== "in_progress") {
    throw new HttpError("Attempt already submitted.", 400);
  }

  const assessment = await getAssessment(attempt.assessmentId);
  if (!assessment) throw new HttpError("Assessment not found.", 404);

  const questions = await db
    .select({
      assessmentQuestionId: assessmentQuestions.id,
      questionBankItemId: assessmentQuestions.questionBankItemId,
      overridePoints: assessmentQuestions.overridePoints,
      type: questionBankItems.type,
      difficulty: questionBankItems.difficulty,
      questionText: questionBankItems.questionText,
      questionHtml: questionBankItems.questionHtml,
      imageUrl: questionBankItems.imageUrl,
      options: questionBankItems.options,
      points: questionBankItems.points,
      correctAnswer: questionBankItems.correctAnswer,
      explanation: questionBankItems.explanation,
      solutionSteps: questionBankItems.solutionSteps,
      topicId: questionBankItems.topicId,
      timeLimitSeconds: questionBankItems.timeLimitSeconds,
      tags: questionBankItems.tags,
      source: questionBankItems.source,
      sourceReference: questionBankItems.sourceReference,
      subjectId: questionBankItems.subjectId,
      learningOutcomeId: questionBankItems.learningOutcomeId,
      language: questionBankItems.language,
      isActive: questionBankItems.isActive,
    })
    .from(assessmentQuestions)
    .innerJoin(
      questionBankItems,
      eq(assessmentQuestions.questionBankItemId, questionBankItems.id)
    )
    .where(eq(assessmentQuestions.assessmentId, attempt.assessmentId))
    .orderBy(assessmentQuestions.order);

  if (questions.length === 0) {
    throw new HttpError("Assessment has no questions.", 400);
  }

  const answers = await db
    .select()
    .from(attemptAnswers)
    .where(eq(attemptAnswers.attemptId, attempt.id));

  const answersByQuestion = new Map<number, (typeof answers)[number]>();
  for (const answer of answers) {
    answersByQuestion.set(answer.assessmentQuestionId, answer);
  }

  let totalScore = 0;
  let maxScore = 0;
  let hasUngraded = false;

  for (const question of questions) {
    const points = question.overridePoints ?? question.points ?? 1;
    maxScore += points;

    const answerRow = answersByQuestion.get(question.assessmentQuestionId);

    // If no answer provided, score as 0
    if (!answerRow) {
      await db.insert(attemptAnswers).values({
        attemptId: attempt.id,
        assessmentQuestionId: question.assessmentQuestionId,
        questionBankItemId: question.questionBankItemId,
        answer: null as any,
        isCorrect: false,
        score: 0,
        maxScore: points,
      }).onConflictDoNothing();
      continue;
    }

    // Essay and complex short answer need manual grading
    if (question.type === "essay" || (question.type === "short_answer" && !question.correctAnswer)) {
      hasUngraded = true;
      await db
        .update(attemptAnswers)
        .set({
          maxScore: points,
        })
        .where(eq(attemptAnswers.id, answerRow.id));
      continue;
    }

    // Use grading service for objective questions
    const questionBankItem: any = {
      id: question.questionBankItemId,
      type: question.type,
      difficulty: question.difficulty,
      questionText: question.questionText,
      questionHtml: question.questionHtml,
      imageUrl: question.imageUrl,
      options: question.options,
      correctAnswer: question.correctAnswer,
      explanation: question.explanation,
      solutionSteps: question.solutionSteps,
      points,
      topicId: question.topicId,
      subjectId: question.subjectId,
      learningOutcomeId: question.learningOutcomeId,
      timeLimitSeconds: question.timeLimitSeconds,
      tags: question.tags,
      source: question.source,
      sourceReference: question.sourceReference,
      language: question.language,
      isActive: question.isActive,
    };

    const userAnswer = answerRow.answer as UserAnswer;

    try {
      const gradingResult = gradingService.gradeAnswer(questionBankItem, userAnswer);

      totalScore += gradingResult.score;

      await db
        .update(attemptAnswers)
        .set({
          isCorrect: gradingResult.isCorrect,
          score: gradingResult.score,
          maxScore: gradingResult.maxScore,
        })
        .where(eq(attemptAnswers.id, answerRow.id));
    } catch (error: any) {
      console.error(`Error grading question ${question.assessmentQuestionId}:`, error);
      // If grading fails, mark as ungraded
      hasUngraded = true;
      await db
        .update(attemptAnswers)
        .set({
          maxScore: points,
        })
        .where(eq(attemptAnswers.id, answerRow.id));
    }
  }

  const status: AttemptStatus = hasUngraded ? "submitted" : "graded";
  const percentage = !hasUngraded && maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : null;

  const [updated] = await db
    .update(assessmentAttempts)
    .set({
      status,
      submittedAt: new Date(),
      totalScore,
      maxScore,
      percentage: percentage as any,
      gradedAt: status === "graded" ? new Date() : null,
    })
    .where(eq(assessmentAttempts.id, attempt.id))
    .returning();

  // Trigger mastery calculation (async, fire-and-forget)
  if (status === "graded") {
    masteryService.updateMasteryAfterAttempt(input.userId, input.attemptId)
      .catch((error) => {
        console.error("Error updating topic mastery:", error);
      });
  }

  return {
    attemptId: updated?.id ?? attempt.id,
    status,
    totalScore,
    maxScore,
    percentage,
    showResultsImmediately: assessment.showResultsImmediately,
  };
}

export async function getAttemptReview(input: {
  attemptId: string;
  userId: string;
  role: BeeLearntRole;
}) {
  const attempt = await getAttempt(input.attemptId);
  if (!attempt) throw new HttpError("Attempt not found.", 404);

  const isOwner = attempt.userId === input.userId;
  const isPrivileged = input.role === "ADMIN" || input.role === "TUTOR";
  if (!isOwner && !isPrivileged) throw new HttpError("Forbidden.", 403);

  if (attempt.status === "in_progress") {
    throw new HttpError("Attempt is still in progress.", 400);
  }

  const detail = await getAssessmentDetail(attempt.assessmentId);
  if (!detail) throw new HttpError("Assessment not found.", 404);

  const assessment = detail.assessment;

  const answers = await db
    .select()
    .from(attemptAnswers)
    .where(eq(attemptAnswers.attemptId, attempt.id));

  const byAssessmentQuestionId = new Map<number, (typeof answers)[number]>();
  for (const answer of answers) byAssessmentQuestionId.set(answer.assessmentQuestionId, answer);

  const includeSolutions = canViewSolutions(input.role, assessment);
  const includeExplanations = canViewExplanations(input.role, assessment);

  return {
    attempt: {
      id: attempt.id,
      assessmentId: attempt.assessmentId,
      userId: attempt.userId,
      status: attempt.status,
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
      totalScore: attempt.totalScore,
      maxScore: attempt.maxScore,
      percentage: attempt.percentage,
    },
    assessment: {
      id: assessment.id,
      title: assessment.title,
      type: assessment.type,
      instructions: assessment.instructions,
      showCorrectAnswers: assessment.showCorrectAnswers,
      showExplanations: assessment.showExplanations,
    },
    sections: detail.sections.map((section) => ({
      id: section.id,
      title: section.title,
      order: section.order,
      instructions: section.instructions,
      questions: section.questions.map((q) => {
        const answer = byAssessmentQuestionId.get(q.assessmentQuestionId) ?? null;
        return {
          assessmentQuestionId: q.assessmentQuestionId,
          questionBankItemId: q.questionBankItemId,
          order: q.order,
          type: q.type,
          difficulty: q.difficulty,
          questionText: q.questionText,
          questionHtml: q.questionHtml,
          imageUrl: q.imageUrl,
          options: q.options,
          points: q.points,
          answer: answer?.answer ?? null,
          isCorrect: answer?.isCorrect ?? null,
          score: answer?.score ?? null,
          maxScore: answer?.maxScore ?? q.points,
          ...(includeSolutions ? { correctAnswer: q.correctAnswer ?? null } : {}),
          ...(includeExplanations ? { explanation: q.explanation ?? null } : {}),
        };
      }),
    })),
  };
}
