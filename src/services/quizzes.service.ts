import { and, eq } from "drizzle-orm";
import { db } from "../core/database/index.js";
import {
  badges,
  learningProfiles,
  quizAnswers,
  quizAttempts,
  quizQuestions,
  quizzes,
  subjects,
  userBadges,
} from "../core/database/schema/index.js";
import { getOpenAiClient } from "../clients/openai.js";
import { rateLimit } from "../shared/utils/rate-limit.js";
import { quizPromptTemplate } from "../shared/utils/quiz-prompt.js";
import { HttpError } from "../shared/utils/http-error.js";

type QuizGenerateInput = {
  subjectId: number;
  moduleId: number;
  topic: string;
  grade: number;
  capsTags: string[];
  difficulty: "easy" | "medium" | "hard" | "adaptive";
};

type QuizSubmitInput = {
  quizId: number;
  answers: Array<{ questionId: number; answer: string }>;
};

export async function listQuizzes(moduleId?: number) {
  if (moduleId) {
    return db
      .select()
      .from(quizzes)
      .where(eq(quizzes.moduleId, moduleId))
      .orderBy(quizzes.createdAt);
  }
  return db.select().from(quizzes).orderBy(quizzes.createdAt);
}

export async function getQuizById(id: number) {
  const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, id));
  return quiz ?? null;
}

export async function listQuizQuestions(quizId: number) {
  return db
    .select({
      id: quizQuestions.id,
      quizId: quizQuestions.quizId,
      type: quizQuestions.type,
      questionText: quizQuestions.questionText,
      options: quizQuestions.options,
      points: quizQuestions.points,
    })
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quizId));
}

export async function generateQuiz(input: QuizGenerateInput, userId: string) {
  const limiter = rateLimit(`quiz-gen:${userId}`, { windowMs: 60_000, max: 5 });
  if (!limiter.allowed) {
    throw new HttpError("Rate limit exceeded", 429);
  }

  const [subject] = await db.select().from(subjects).where(eq(subjects.id, input.subjectId));

  let difficulty = input.difficulty;
  if (difficulty === "adaptive") {
    const [profile] = await db
      .select({ recommendedDifficulty: learningProfiles.recommendedDifficulty })
      .from(learningProfiles)
      .where(eq(learningProfiles.userId, userId));
    difficulty = profile?.recommendedDifficulty ?? "medium";
  }

  const prompt = quizPromptTemplate({
    grade: input.grade,
    subject: subject?.name ?? "Subject",
    topic: input.topic,
    capsTags: input.capsTags,
    difficulty,
  });

  const client = await getOpenAiClient();
  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const content = completion.choices[0]?.message?.content ?? "{}";
  let parsedQuiz: { title?: string; description?: string; questions?: any[] } = {};
  try {
    parsedQuiz = JSON.parse(content);
  } catch {
    parsedQuiz = {};
  }

  const [quiz] = await db
    .insert(quizzes)
    .values({
      moduleId: input.moduleId,
      title: parsedQuiz.title ?? input.topic,
      description: parsedQuiz.description ?? "AI generated quiz",
      difficulty,
      source: "ai",
      capsTags: input.capsTags,
      createdBy: userId,
    })
    .returning();

  const questions = Array.isArray(parsedQuiz.questions) ? parsedQuiz.questions : [];

  if (questions.length > 0) {
    await db.insert(quizQuestions).values(
      questions.map((question: any) => ({
        quizId: quiz.id,
        type: question.type ?? "multiple_choice",
        questionText: question.questionText ?? "",
        options: question.options ?? null,
        correctAnswer: question.correctAnswer ?? null,
        explanation: question.explanation ?? null,
        points: question.points ?? 1,
      }))
    );
  }

  return { quizId: quiz.id, questionCount: questions.length };
}

export async function submitQuiz(input: QuizSubmitInput, userId: string) {
  const questions = await db
    .select()
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, input.quizId));

  if (questions.length === 0) {
    throw new HttpError("Quiz has no questions", 400);
  }

  let score = 0;
  const answersToStore = input.answers.map((answer) => {
    const question = questions.find((item) => item.id === answer.questionId);
    const isCorrect = question?.correctAnswer
      ? question.correctAnswer.toLowerCase() === answer.answer.toLowerCase()
      : false;
    const points = isCorrect ? question?.points ?? 1 : 0;
    score += points;
    return {
      questionId: answer.questionId,
      answer: answer.answer,
      isCorrect,
      score: points,
    };
  });

  const maxScore = questions.reduce((total, question) => total + (question.points ?? 1), 0);
  const percentage = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  const recommendedDifficulty =
    percentage >= 85 ? "hard" : percentage >= 65 ? "medium" : "easy";

  const feedback =
    score >= maxScore * 0.8
      ? "Excellent work!"
      : score >= maxScore * 0.5
      ? "Good effort. Review the tricky questions."
      : "Keep practicing. Review the lesson materials.";

  const [attempt] = await db
    .insert(quizAttempts)
    .values({
      quizId: input.quizId,
      userId,
      score,
      maxScore,
      feedback,
    })
    .returning();

  if (answersToStore.length > 0) {
    await db.insert(quizAnswers).values(
      answersToStore.map((answer) => ({
        attemptId: attempt.id,
        questionId: answer.questionId,
        answer: answer.answer,
        isCorrect: answer.isCorrect,
        score: answer.score,
      }))
    );
  }

  const [existingProfile] = await db
    .select()
    .from(learningProfiles)
    .where(eq(learningProfiles.userId, userId));

  if (existingProfile) {
    await db
      .update(learningProfiles)
      .set({
        recommendedDifficulty,
        lastAdaptiveUpdateAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(learningProfiles.userId, userId));
  } else {
    await db.insert(learningProfiles).values({
      userId,
      recommendedDifficulty,
      lastAdaptiveUpdateAt: new Date(),
      updatedAt: new Date(),
    });
  }

  const masteryBadges = await db
    .select()
    .from(badges)
    .where(eq(badges.ruleKey, "quiz_mastery"));

  if (masteryBadges.length > 0) {
    const attempts = await db
      .select({ score: quizAttempts.score, maxScore: quizAttempts.maxScore })
      .from(quizAttempts)
      .where(eq(quizAttempts.userId, userId));

    for (const badge of masteryBadges) {
      const criteria = badge.criteria as { score?: number; count?: number };
      const requiredScore = criteria.score ?? 80;
      const requiredCount = criteria.count ?? 3;

      const qualifying = attempts.filter((entry) => {
        const percentage = Math.round((entry.score / entry.maxScore) * 100);
        return percentage >= requiredScore;
      });

      if (qualifying.length >= requiredCount) {
        const [existingBadge] = await db
          .select()
          .from(userBadges)
          .where(and(eq(userBadges.userId, userId), eq(userBadges.badgeId, badge.id)));

        if (!existingBadge) {
          await db.insert(userBadges).values({
            userId,
            badgeId: badge.id,
            awardedAt: new Date(),
          });
        }
      }
    }
  }

  return {
    attemptId: attempt.id,
    score,
    maxScore,
    feedback,
    recommendedDifficulty,
  };
}
