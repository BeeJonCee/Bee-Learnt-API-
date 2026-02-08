import { db } from "../core/database/index.js";
import { sql } from "drizzle-orm";

export async function getParentInsights(parentId: string) {
  // Get all children for this parent
  const children = await db.execute<{
    student_id: string;
    student_name: string;
    completed_lessons: number;
    quiz_average: number;
    total_assignments: number;
    assignments_submitted: number;
  }>(
    sql`
      SELECT
        u.id as student_id,
        u.name as student_name,
        COALESCE(
          (SELECT COUNT(*) FROM lessons l
           INNER JOIN progress p ON l.id = p.lesson_id
           WHERE p.user_id = u.id AND p.completed_at IS NOT NULL),
          0
        ) as completed_lessons,
        COALESCE(
          (SELECT ROUND(AVG(CAST(score AS DECIMAL)) / MAX(max_score) * 100, 1)
           FROM quiz_attempts
           WHERE user_id = u.id AND completed_at IS NOT NULL),
          0
        ) as quiz_average,
        COALESCE(
          (SELECT COUNT(*) FROM assignments a
           WHERE a.class_id IN (
             SELECT c.id FROM classes c
             WHERE c.id = ANY(
               SELECT DISTINCT cm.class_id FROM class_members cm
               WHERE cm.user_id = u.id
             )
           )),
          0
        ) as total_assignments,
        COALESCE(
          (SELECT COUNT(*) FROM assignments a
           INNER JOIN assignment_submissions s ON a.id = s.assignment_id
           WHERE s.user_id = u.id AND a.class_id IN (
             SELECT c.id FROM classes c
             WHERE c.id = ANY(
               SELECT DISTINCT cm.class_id FROM class_members cm
               WHERE cm.user_id = u.id
             )
           )),
          0
        ) as assignments_submitted
      FROM users u
      INNER JOIN parent_children pc ON u.id = pc.student_id
      WHERE pc.parent_id = ${parentId}
      ORDER BY u.name
    `
  );

  // Calculate aggregates
  const totalLessonsCompleted = children.rows.reduce((sum: number, child: any) => sum + child.completed_lessons, 0);
  const averageQuizScore =
    children.rows.length > 0
      ? Math.round(
          children.rows.reduce((sum: number, child: any) => sum + child.quiz_average, 0) / children.rows.length
        )
      : 0;
  const totalAssignmentsSubmitted = children.rows.reduce((sum: number, child: any) => sum + child.assignments_submitted, 0);

  // Get 7-day learning trend
  const learningTrend = await db.execute<{
    date: string;
    average_score: number;
    lessons_completed: number;
  }>(
    sql`
      WITH RECURSIVE dates AS (
        SELECT CAST(CURRENT_DATE - INTERVAL '6 days' AS DATE) as date
        UNION ALL
        SELECT date + INTERVAL '1 day' FROM dates
        WHERE date < CURRENT_DATE
      )
      SELECT
        TO_CHAR(d.date, 'MM-DD') as date,
        ROUND(AVG(
          CASE
            WHEN qa.completed_at::DATE = d.date AND qa.user_id IN (
              SELECT u.id FROM users u
              INNER JOIN parent_children pc ON u.id = pc.student_id
              WHERE pc.parent_id = ${parentId}
            )
            THEN CAST(qa.score AS DECIMAL) / qa.max_score * 100
            ELSE NULL
          END
        )::NUMERIC, 1) as average_score,
        COUNT(DISTINCT
          CASE
            WHEN p.completed_at::DATE = d.date AND p.user_id IN (
              SELECT u.id FROM users u
              INNER JOIN parent_children pc ON u.id = pc.student_id
              WHERE pc.parent_id = ${parentId}
            )
            THEN p.lesson_id
            ELSE NULL
          END
        ) as lessons_completed
      FROM dates d
      LEFT JOIN quiz_attempts qa ON 1=1
      LEFT JOIN progress p ON 1=1
      GROUP BY d.date
      ORDER BY d.date
    `
  );

  return {
    children: children.rows.map((child: any) => ({
      studentId: child.student_id,
      studentName: child.student_name,
      completedLessons: child.completed_lessons,
      quizAverage: child.quiz_average,
      totalAssignments: child.total_assignments,
      assignmentsSubmitted: child.assignments_submitted,
    })),
    averageQuizScore,
    totalLessonsCompleted,
    totalAssignmentsSubmitted,
    learningTrend: learningTrend.rows.map((trend: any) => ({
      date: trend.date,
      averageScore: Number(trend.average_score),
      lessonsCompleted: Number(trend.lessons_completed),
    })),
  };
}
