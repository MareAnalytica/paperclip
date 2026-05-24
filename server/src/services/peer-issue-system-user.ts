import { eq } from "drizzle-orm";
import { authUsers, type Db } from "@paperclipai/db";

export const SYSTEM_PEER_ISSUE_USER_ID = "system:peer-issue";
const SYSTEM_PEER_ISSUE_USER_NAME = "Peer Issue System";
const SYSTEM_PEER_ISSUE_USER_EMAIL = "system+peer-issue@paperclip.local";

export async function ensureSystemPeerIssueUser(db: Db): Promise<void> {
  const existing = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.id, SYSTEM_PEER_ISSUE_USER_ID))
    .then((rows) => rows[0] ?? null);
  if (existing) return;
  const now = new Date();
  await db.insert(authUsers).values({
    id: SYSTEM_PEER_ISSUE_USER_ID,
    name: SYSTEM_PEER_ISSUE_USER_NAME,
    email: SYSTEM_PEER_ISSUE_USER_EMAIL,
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
  });
}
