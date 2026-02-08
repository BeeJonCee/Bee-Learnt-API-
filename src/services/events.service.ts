import { and, desc, eq, gte, lte, or, type SQL } from "drizzle-orm";
import { db } from "../core/database/index.js";
import { events } from "../core/database/schema/index.js";
import type { BeeLearntRole } from "../shared/types/auth.js";

export type EventInput = {
  title: string;
  description: string;
  startAt: string;
  endAt?: string | null;
  allDay?: boolean;
  location?: string | null;
  audience: "ALL" | BeeLearntRole;
};

export type EventFilters = {
  role: BeeLearntRole;
  limit?: number;
  from?: Date | null;
  to?: Date | null;
};

export async function listEvents({ role, limit = 6, from, to }: EventFilters) {
  const conditions: SQL<any>[] = [or(eq(events.audience, "ALL"), eq(events.audience, role)) as SQL<any>];

  if (from) {
    conditions.push(gte(events.startAt, from));
  }
  if (to) {
    conditions.push(lte(events.startAt, to));
  }

  const whereClause = conditions.length ? and(...conditions) : undefined;
  
  if (whereClause) {
    return db.select().from(events).where(whereClause).orderBy(desc(events.startAt)).limit(limit);
  }
  
  return db.select().from(events).orderBy(desc(events.startAt)).limit(limit);
}

export async function createEvent(input: EventInput) {
  const [created] = await db
    .insert(events)
    .values({
      title: input.title,
      description: input.description,
      startAt: new Date(input.startAt),
      endAt: input.endAt ? new Date(input.endAt) : null,
      allDay: input.allDay ?? false,
      location: input.location ?? null,
      audience: input.audience,
    })
    .returning();

  return created;
}
