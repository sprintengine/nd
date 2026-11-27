import { type Executor, findHostByUserId, users } from "@nd/db";
import { eq } from "drizzle-orm";

/** A user's profile and host record (null when not a host), or undefined if the user is gone. */
export async function findUserWithHost(db: Executor, userId: string) {
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      emailVerified: users.emailVerified,
      image: users.image,
      phone: users.phone,
      phoneVerified: users.phoneVerified,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (user === undefined) return undefined;
  return { user, host: (await findHostByUserId(db, userId)) ?? null };
}
