import { Router } from "express";
import type { Db } from "@paperclipai/db";

import { companyService } from "../services/index.js";
import {
  allPolicyDashboardRows,
  getCeoFlowPolicyState,
} from "../services/ceo-flow-policy.js";
import { assertBoard } from "./authz.js";
import { badRequest } from "../errors.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function parseLimit(raw: unknown): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value == null || value === "") return DEFAULT_LIMIT;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw badRequest("'limit' must be a positive integer");
  }
  return Math.min(Math.trunc(parsed), MAX_LIMIT);
}

/**
 * Opaque keyset cursor. We page over companies sorted by id ascending; the
 * cursor is the last companyId emitted on the previous page (exclusive lower
 * bound). Encoding keeps the boundary opaque to callers and robust to
 * companies being added or removed between pages.
 */
function decodeCursor(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value == null || value === "") return null;
  try {
    const decoded = Buffer.from(String(value), "base64url").toString("utf8");
    if (!decoded) throw new Error("empty cursor");
    return decoded;
  } catch {
    throw badRequest("invalid 'cursor'");
  }
}

function encodeCursor(companyId: string): string {
  return Buffer.from(companyId, "utf8").toString("base64url");
}

/**
 * Cross-company effective CEO flow policy dashboard (spec:
 * docs/specs/2026-05-25-effective-ceo-flow-policy-endpoint.md §3). Board-only
 * read path that emits one row per active company so operators can spot policy
 * drift across the fleet at a glance.
 */
export function ceoFlowPolicyRoutes(db: Db) {
  const router = Router();
  const companies = companyService(db);

  router.get("/effective-ceo-flow-policy/dashboard", async (req, res) => {
    assertBoard(req);

    const limit = parseLimit(req.query.limit);
    const after = decodeCursor(req.query.cursor);

    const { resolved, loadError } = getCeoFlowPolicyState();
    if (loadError) {
      res.status(503).json({
        error: "CEO flow policy failed to load",
        detail: loadError,
      });
      return;
    }

    // Active companies only, in a stable order so keyset pagination is
    // deterministic across pages.
    const activeIds = (await companies.list())
      .filter((c) => c.status === "active")
      .map((c) => c.id)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const startIdx = after == null ? 0 : activeIds.findIndex((id) => id > after);
    const windowIds =
      startIdx < 0 ? [] : activeIds.slice(startIdx, startIdx + limit);
    const hasMore = startIdx >= 0 && startIdx + limit < activeIds.length;

    const rows = allPolicyDashboardRows(resolved, windowIds);
    const nextCursor =
      hasMore && windowIds.length > 0
        ? encodeCursor(windowIds[windowIds.length - 1]!)
        : null;

    res.json({ rows, nextCursor });
  });

  return router;
}
