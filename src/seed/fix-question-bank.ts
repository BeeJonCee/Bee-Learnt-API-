import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../core/database/index.js";

async function fixQuestionBank() {
  console.log("Adding missing columns to question_bank_items...");
  
  await db.execute(sql`
    ALTER TABLE question_bank_items
      ADD COLUMN IF NOT EXISTS topic_id integer,
      ADD COLUMN IF NOT EXISTS learning_outcome_id integer,
      ADD COLUMN IF NOT EXISTS nsc_paper_question_id integer;
  `);

  console.log("Columns added successfully!");
}

fixQuestionBank().catch((error) => {
  console.error("Fix failed", error);
  process.exit(1);
});
