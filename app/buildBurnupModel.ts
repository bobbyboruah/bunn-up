// app/buildBurnupModel.ts

/* ------------------------------------------------------------------ */
/* Types used by Burn-up logic                                        */
/* ------------------------------------------------------------------ */

// Minimal shape we need from Jira stories.
// Your Page.tsx IssueRow has superset of this, so you can safely cast.
export interface BurnupIssue {
  key?: string;
  created: string; // Jira created
  resolutiondate: string | null; // Jira resolutiondate
  statusCategory: 'To Do' | 'In Progress' | 'Done' | null;
  status?: string | null; // To detect Withdrawn / CANCELLED if needed
}

export type SprintSummary = {
  index: number;
  startMs: number; // UTC midnight (epoch-day)
  endMs: number; // UTC midnight (epoch-day) (exclusive end boundary for bucketing)
  scopeAtEnd: number; // total scope (stories) existing by end of sprint
  scopeAtStart: number; // scope at sprint start
  doneThisSprint: number; // stories done in this sprint
  cumDoneEnd: number; // cumulative done by end of sprint
  isClosed: boolean; // sprint ended on/before "today"
};

export type BurnupProjection = {
  hasSignal: boolean;
  fromSprintIndex: number | null; // last closed sprint index
  fromTimeMs: number | null;
  fromDone: number | null; // cum done at fromTime
  projectedDonePerSprint: number | null; // stories per sprint at current FTE
  avgVelPerFTE: number | null; // stories per FTE per sprint (recent non-zero)
  projectedCompletionMs: number | null; // central projection
  projectedCompletionEarlyMs: number | null; // +20% velocity
  projectedCompletionLateMs: number | null; // -20% velocity

  // FTE needed from the red dot to hit the target date/scope.
  requiredFTEToHitTarget: number | null;
  // Suggested upper bound for the FTE slider (usually required + 1).
  suggestedMaxFTE: number | null;

  // --------- Velocity-first helpers (stories/sprint) ---------

  // Stories remaining from the anchor (red dot) to latest scope.
  remainingStoriesFromAnchor: number | null;

  // Number of sprints left from anchor to target date (ceil),
  // based on sprint length.
  sprintsRemainingToTarget: number | null;

  // Stories per sprint we would need (from anchor) to hit target scope
  // by the target date.
  requiredStoriesPerSprintToHitTarget: number | null;

  // Recent actual burn rate: average stories done per sprint over the
  // last 2 closed sprints (fallback to 1 if only one closed sprint exists).
  recentStoriesPerSprint: number | null;
};

export type BurnupModel = {
  sprintLengthDays: number;
  originMs: number; // first sprint start (derived from earliest Done, or UI fallback)
  targetDateMs: number; // dev completion (target)
  targetScope: number; // scope at target date
  latestScope: number; // latest scope in horizon
  todayMs: number;

  // Current sprint window (derived from origin + today; UTC date-only)
  currentSprintStartMs: number;
  currentSprintEndMs: number; // inclusive end (date-only)

  sprints: SprintSummary[];
  projection: BurnupProjection;

  // Aggregate Done info (for UI decisions like "no burn-up yet")
  totalDoneStories: number;
  hasAnyDone: boolean;

  // Simple health vs target
  isOnTrack: boolean | null; // null if we can't compute projection
  daysDeltaFromTarget: number | null; // +ve = finishes after target; -ve = before
};

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

export type BuildBurnupInput = {
  stories: BurnupIssue[]; // ONLY Story issues
  sprintStartISO: string; // "YYYY-MM-DD" from UI – only used when no Done yet
  devCompletionISO: string; // "YYYY-MM-DD" target from top section
  sprintFTE: number; // current FTE (can be decimal)
  todayISO?: string; // optional override for tests; default = today
  sprintLengthDays?: number; // default 14
};

/**
 * Main entry point: turn raw stories + sprint parameters into a burn-up model.
 *
 * Sprint logic (workaround for Jira sprint hygiene):
 * - If there are Done stories:
 *     firstSprintEnd   = earliest Done resolutiondate (date-only)
 *     firstSprintStart = firstSprintEnd - N working days (Mon–Fri),
 *                        where N ~= sprintLengthDays * 5/7 (14 -> 10)
 * - If there are NO Done stories yet:
 *     origin = min(UI sprintStartISO, earliest created) or today.
 *
 * IMPORTANT FIXES:
 * 1) All "midnight" values are computed using epoch-day flooring (UTC date-only).
 * 2) Projection signal uses recent NON-ZERO closed sprints.
 */
export function buildBurnupModel(input: BuildBurnupInput): BurnupModel {
  const sprintLenDays = input.sprintLengthDays ?? 14;
  const sprintLenMs = sprintLenDays * DAY_MS;

  const uiOriginMs = parseISODate(input.sprintStartISO);
  const targetDateMs = parseISODate(input.devCompletionISO);

  const todayMs = input.todayISO
    ? parseISODate(input.todayISO)
    : epochDayFloorMs(Date.now());

  if (!Number.isFinite(targetDateMs)) {
    // Invalid target – return empty-ish model but don't throw.
    return emptyModel(sprintLenDays, uiOriginMs, targetDateMs, todayMs);
  }

  const sprintFTE = Math.max(
    0,
    Number.isFinite(input.sprintFTE) ? input.sprintFTE : 0
  );

  // Normalise stories to day-level timestamps (epoch-day / UTC midnight)
  const stories = (input.stories ?? [])
    .map(normaliseIssue)
    .filter(Boolean) as NormalisedIssue[];

  // ---------- Derive origin (first sprint start) ----------

  let originMs: number;

  if (stories.length === 0) {
    // No stories at all – fall back to UI start or today.
    originMs = Number.isFinite(uiOriginMs) ? uiOriginMs : todayMs;
  } else {
    const validDone = stories.filter(
      (s) => s.isDone && !s.isCancelled && s.resolvedMs != null
    );
    const allCreated = stories.map((s) => s.createdMs);

    if (validDone.length > 0) {
      // Variant 1:
      // earliest valid Done story → first sprint END (date-only),
      // then subtract working days to derive first sprint START.
      const earliestDoneMs = Math.min(
        ...validDone.map((s) => s.resolvedMs as number)
      );

      // 14 calendar days => ~10 working days (Mon–Fri)
      const workingDaysBack = Math.max(1, Math.round((sprintLenDays * 5) / 7));

      originMs = subtractWorkingDaysUTC(earliestDoneMs, workingDaysBack);
    } else {
      // No Done yet: anchor on earliest created (or UI if earlier)
      const earliestCreatedMs = Math.min(...allCreated);
      originMs = Number.isFinite(uiOriginMs)
        ? Math.min(uiOriginMs, earliestCreatedMs)
        : earliestCreatedMs;
    }
  }

  if (!Number.isFinite(originMs)) originMs = todayMs;

  // Ensure origin is epoch-day aligned (timezone-proof)
  originMs = epochDayFloorMs(originMs);

  // If there are no stories, still build some empty sprints along the time axis.
  const lastStoryCreatedMs =
    stories.length > 0
      ? Math.max(...stories.map((s) => s.createdMs))
      : originMs;

  const lastStoryResolvedMsArr = stories
    .filter((s) => s.resolvedMs != null)
    .map((s) => s.resolvedMs as number);

  const lastStoryMs =
    lastStoryResolvedMsArr.length > 0
      ? Math.max(lastStoryCreatedMs, Math.max(...lastStoryResolvedMsArr))
      : lastStoryCreatedMs;

  // Base horizon: cover until max(today, target, last story)
  const baseHorizonMs = Math.max(todayMs, targetDateMs, lastStoryMs);

  // Extend horizon so that projection cone has room.
  const horizonMs = baseHorizonMs + sprintLenMs * 6;

  // ---------- Build sprint buckets from origin until horizon ----------
  const sprints: SprintSummary[] = [];

  let i = 0;
  let prevScopeAtEnd = 0;
  let prevCumDone = 0;

  while (true) {
    const startMs = originMs + i * sprintLenMs;
    const endMs = startMs + sprintLenMs;
    if (startMs > horizonMs) break;

    const isClosed = endMs <= todayMs;

    // Scope = stories that exist by end of sprint (created < end, not cancelled)
    const scopeAtEnd = stories.filter(
      (s) => s.createdMs < endMs && !s.isCancelled
    ).length;

    const scopeAtStart = i === 0 ? 0 : prevScopeAtEnd;

    // Cumulative "done" by end of this sprint (raw)
    // Only count stories that exist by endMs (created < endMs)
    const doneByEndRaw = stories.filter(
      (s) =>
        s.isDone &&
        s.resolvedMs != null &&
        s.resolvedMs < endMs &&
        s.createdMs < endMs &&
        !s.isCancelled
    ).length;

    // Clamp cumulative done so we never show more completed than exist.
    const cumDoneEnd = Math.min(doneByEndRaw, scopeAtEnd);

    // Incremental done in this sprint
    const doneThisSprint =
      i === 0 ? cumDoneEnd : Math.max(0, cumDoneEnd - prevCumDone);

    sprints.push({
      index: i,
      startMs,
      endMs,
      scopeAtEnd,
      scopeAtStart,
      doneThisSprint,
      cumDoneEnd,
      isClosed,
    });

    prevScopeAtEnd = scopeAtEnd;
    prevCumDone = cumDoneEnd;
    i += 1;
  }

  const latestScope =
    sprints.length > 0 ? sprints[sprints.length - 1]!.scopeAtEnd : 0;
  const targetScope = computeScopeAtDate(sprints, targetDateMs);

  const totalDoneStories =
    sprints.length > 0 ? sprints[sprints.length - 1]!.cumDoneEnd : 0;
  const hasAnyDone = totalDoneStories > 0;

  const projection = computeProjection(
    sprints,
    sprintLenMs,
    sprintFTE,
    latestScope,
    targetScope,
    targetDateMs
  );

  // Derive current sprint window (UTC date-only) from origin + today
  let currentSprintStartMs = originMs;
  let currentSprintEndMs = originMs; // inclusive
  if (Number.isFinite(originMs) && Number.isFinite(todayMs) && sprintLenMs > 0) {
    const deltaMs = todayMs - originMs;
    const idx = Math.max(0, Math.floor(deltaMs / sprintLenMs));
    currentSprintStartMs = originMs + idx * sprintLenMs;
    currentSprintEndMs =
      currentSprintStartMs + (sprintLenDays - 1) * DAY_MS; // inclusive end date
  }

  // Simple health vs target
  let isOnTrack: boolean | null = null;
  let daysDelta: number | null = null;
  if (projection.hasSignal && projection.projectedCompletionMs != null) {
    daysDelta = Math.round(
      (projection.projectedCompletionMs - targetDateMs) / DAY_MS
    );
    if (Number.isFinite(daysDelta)) {
      isOnTrack = daysDelta <= 0;
    }
  }

  return {
    sprintLengthDays: sprintLenDays,
    originMs,
    targetDateMs,
    targetScope,
    latestScope,
    todayMs,

    currentSprintStartMs,
    currentSprintEndMs,

    sprints,
    projection,
    totalDoneStories,
    hasAnyDone,
    isOnTrack,
    daysDeltaFromTarget: daysDelta,
  };
}

/**
 * Recompute the projection (cone + dates) for a new FTE value, keeping:
 * - the last closed sprint as the anchor (red pulsating dot)
 * - the historical avg stories-per-FTE (avgVelPerFTE) fixed.
 */
export function recomputeProjectionWithFTE(
  model: BurnupModel,
  sprintFTE: number
): BurnupModel {
  const safeFte = Math.max(0, Number.isFinite(sprintFTE) ? sprintFTE : 0);

  const {
    sprints,
    latestScope,
    sprintLengthDays,
    targetDateMs,
    projection,
    currentSprintStartMs,
    currentSprintEndMs,
  } = model;

  if (
    !sprints.length ||
    !projection ||
    !projection.hasSignal ||
    projection.fromSprintIndex == null ||
    projection.fromTimeMs == null ||
    projection.fromDone == null ||
    projection.avgVelPerFTE == null ||
    projection.avgVelPerFTE <= 0
  ) {
    return model;
  }

  const sprintLenMs = sprintLengthDays * DAY_MS;

  const fromTimeMs = projection.fromTimeMs;
  const fromDone = projection.fromDone;
  const avgVelPerFTE = projection.avgVelPerFTE;

  const fte = Math.max(0.1, safeFte || 0);
  const projectedDonePerSprint = avgVelPerFTE * fte;

  if (projectedDonePerSprint <= 0) {
    const newProjection: BurnupProjection = {
      ...projection,
      projectedDonePerSprint: null,
      projectedCompletionMs: null,
      projectedCompletionEarlyMs: null,
      projectedCompletionLateMs: null,
    };
    return {
      ...model,
      projection: newProjection,
      isOnTrack: null,
      daysDeltaFromTarget: null,
      currentSprintStartMs,
      currentSprintEndMs,
    };
  }

  const remaining = Math.max(0, latestScope - fromDone);

  let projectedCompletionMs: number;
  let projectedCompletionEarlyMs: number;
  let projectedCompletionLateMs: number;

  if (remaining === 0) {
    projectedCompletionMs = fromTimeMs;
    projectedCompletionEarlyMs = fromTimeMs;
    projectedCompletionLateMs = fromTimeMs;
  } else {
    const projectedSprints = remaining / projectedDonePerSprint;
    projectedCompletionMs = fromTimeMs + projectedSprints * sprintLenMs;

    const fastDonePerSprint = projectedDonePerSprint * 1.2;
    const slowDonePerSprint = projectedDonePerSprint * 0.8;

    projectedCompletionEarlyMs =
      fastDonePerSprint > 0
        ? fromTimeMs + (remaining / fastDonePerSprint) * sprintLenMs
        : projectedCompletionMs;

    projectedCompletionLateMs =
      slowDonePerSprint > 0
        ? fromTimeMs + (remaining / slowDonePerSprint) * sprintLenMs
        : projectedCompletionMs;
  }

  const newProjection: BurnupProjection = {
    ...projection,
    hasSignal: true,
    projectedDonePerSprint,
    projectedCompletionMs,
    projectedCompletionEarlyMs,
    projectedCompletionLateMs,
  };

  let isOnTrack: boolean | null = null;
  let daysDeltaFromTarget: number | null = null;

  if (Number.isFinite(targetDateMs) && projectedCompletionMs != null) {
    daysDeltaFromTarget = Math.round(
      (projectedCompletionMs - targetDateMs) / DAY_MS
    );
    if (Number.isFinite(daysDeltaFromTarget)) {
      isOnTrack = daysDeltaFromTarget <= 0;
    }
  }

  return {
    ...model,
    projection: newProjection,
    isOnTrack,
    daysDeltaFromTarget,
    currentSprintStartMs,
    currentSprintEndMs,
  };
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;

type NormalisedIssue = {
  createdMs: number;
  resolvedMs: number | null;
  isDone: boolean;
  isCancelled: boolean;
};

/**
 * Timezone-proof "UTC midnight" flooring by epoch-day.
 * Works regardless of runtime timezone / DST.
 */
function epochDayFloorMs(ms: number): number {
  if (!Number.isFinite(ms)) return NaN;
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * Subtract N working days (Mon–Fri) from a UTC date-only timestamp.
 * Input and output are UTC midnight (epoch-day).
 */
function subtractWorkingDaysUTC(endMs: number, workingDays: number): number {
  let ms = epochDayFloorMs(endMs);
  let left = Math.max(0, Math.floor(workingDays));

  // Count backwards excluding weekends.
  while (left > 0) {
    ms -= DAY_MS;
    const dow = new Date(ms).getUTCDay(); // 0=Sun ... 6=Sat
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return ms;
}

/**
 * Normalise a Jira issue into timestamps + Done/cancelled flags.
 */
function normaliseIssue(issue: BurnupIssue): NormalisedIssue | null {
  if (!issue || !issue.created) return null;

  const createdMs = parseJiraDate(issue.created);
  if (!Number.isFinite(createdMs)) return null;

  const rawStatus = (issue.status ?? '').trim().toUpperCase();
  const categoryDone = issue.statusCategory === 'Done';

  const isCancelled =
    rawStatus.includes('WITHDRAWN') || rawStatus.includes('CANCELLED');

  let resolvedMs: number | null = null;
  if (issue.resolutiondate) {
    const parsed = parseJiraDate(issue.resolutiondate);
    if (Number.isFinite(parsed)) resolvedMs = parsed;
  }

  if (!resolvedMs && (categoryDone || rawStatus === 'DONE')) {
    resolvedMs = createdMs;
  }

  const isDone =
    !!resolvedMs &&
    !isCancelled &&
    (categoryDone || rawStatus === 'DONE' || rawStatus.startsWith('DONE '));

  return {
    createdMs,
    resolvedMs,
    isDone,
    isCancelled,
  };
}

/**
 * Parse "YYYY-MM-DD" into UTC midnight timestamp (epoch-day).
 */
function parseISODate(iso: string): number {
  if (!iso) return NaN;
  const [yStr, mStr, dStr] = iso.split('-');
  const y = Number(yStr);
  const m = Number(mStr) - 1;
  const d = Number(dStr);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return NaN;
  }
  return Date.UTC(y, m, d);
}

/**
 * Parse arbitrary Jira date string into UTC midnight (epoch-day).
 */
function parseJiraDate(value: string): number {
  if (!value) return NaN;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return NaN;
  return epochDayFloorMs(ms);
}

function emptyModel(
  sprintLengthDays: number,
  originMs: number,
  targetDateMs: number,
  todayMs: number
): BurnupModel {
  const safeOrigin = Number.isFinite(originMs) ? originMs : todayMs;

  return {
    sprintLengthDays,
    originMs: safeOrigin,
    targetDateMs: Number.isFinite(targetDateMs) ? targetDateMs : todayMs,
    targetScope: 0,
    latestScope: 0,
    todayMs,

    currentSprintStartMs: safeOrigin,
    currentSprintEndMs: safeOrigin,

    sprints: [],
    projection: {
      hasSignal: false,
      fromSprintIndex: null,
      fromTimeMs: null,
      fromDone: null,
      projectedDonePerSprint: null,
      avgVelPerFTE: null,
      projectedCompletionMs: null,
      projectedCompletionEarlyMs: null,
      projectedCompletionLateMs: null,
      requiredFTEToHitTarget: null,
      suggestedMaxFTE: null,
      remainingStoriesFromAnchor: null,
      sprintsRemainingToTarget: null,
      requiredStoriesPerSprintToHitTarget: null,
      recentStoriesPerSprint: null,
    },
    totalDoneStories: 0,
    hasAnyDone: false,
    isOnTrack: null,
    daysDeltaFromTarget: null,
  };
}

/**
 * Find the scope (stories existing) at a particular date by using the sprint
 * whose end date is >= that date.
 */
function computeScopeAtDate(sprints: SprintSummary[], dateMs: number): number {
  if (!sprints.length) return 0;
  let chosen: SprintSummary | null = null;
  for (const s of sprints) {
    if (dateMs <= s.endMs) {
      chosen = s;
      break;
    }
  }
  if (!chosen) chosen = sprints[sprints.length - 1]!;
  return chosen.scopeAtEnd;
}

/**
 * Compute average stories/sprint over last N closed sprints (includes zeros).
 * Returns null if there are no closed sprints.
 */
function avgStoriesLastNClosed(
  sprints: SprintSummary[],
  lastClosedIndex: number,
  n: number
): number | null {
  const vals: number[] = [];
  for (let i = lastClosedIndex; i >= 0 && vals.length < n; i--) {
    const s = sprints[i]!;
    if (!s.isClosed) continue;
    vals.push(s.doneThisSprint);
  }
  if (!vals.length) return null;
  return vals.reduce((sum, v) => sum + v, 0) / vals.length;
}

/**
 * Projection FIX:
 * - Anchor at last closed sprint (still true).
 * - Velocity signal: look back across several closed sprints and use the most recent
 *   1–2 NON-ZERO doneThisSprint values to derive avgVelPerFTE.
 *
 * Additional behaviour:
 * - recentStoriesPerSprint is now the average stories/sprint over the LAST 2 closed sprints
 *   (includes zeros; fallback to 1 if only one closed sprint exists).
 */
function computeProjection(
  sprints: SprintSummary[],
  sprintLenMs: number,
  sprintFTE: number,
  latestScope: number,
  targetScope: number,
  targetDateMs: number
): BurnupProjection {
  if (!sprints.length) {
    return {
      hasSignal: false,
      fromSprintIndex: null,
      fromTimeMs: null,
      fromDone: null,
      projectedDonePerSprint: null,
      avgVelPerFTE: null,
      projectedCompletionMs: null,
      projectedCompletionEarlyMs: null,
      projectedCompletionLateMs: null,
      requiredFTEToHitTarget: null,
      suggestedMaxFTE: null,
      remainingStoriesFromAnchor: null,
      sprintsRemainingToTarget: null,
      requiredStoriesPerSprintToHitTarget: null,
      recentStoriesPerSprint: null,
    };
  }

  // Find last closed sprint
  let lastClosedIndex: number | null = null;
  for (let i = sprints.length - 1; i >= 0; i--) {
    if (sprints[i]!.isClosed) {
      lastClosedIndex = i;
      break;
    }
  }

  if (lastClosedIndex == null || lastClosedIndex < 0) {
    return {
      hasSignal: false,
      fromSprintIndex: null,
      fromTimeMs: null,
      fromDone: null,
      projectedDonePerSprint: null,
      avgVelPerFTE: null,
      projectedCompletionMs: null,
      projectedCompletionEarlyMs: null,
      projectedCompletionLateMs: null,
      requiredFTEToHitTarget: null,
      suggestedMaxFTE: null,
      remainingStoriesFromAnchor: null,
      sprintsRemainingToTarget: null,
      requiredStoriesPerSprintToHitTarget: null,
      recentStoriesPerSprint: null,
    };
  }

  const fromTimeMs = sprints[lastClosedIndex]!.endMs;
  const fromDone = sprints[lastClosedIndex]!.cumDoneEnd;

  const remainingStoriesFromAnchor = Math.max(0, latestScope - fromDone);
  const remainingToTarget = Math.max(0, targetScope - fromDone);

  // Sprints remaining (ceil) and required stories/sprint to hit target
  let sprintsRemainingToTarget: number | null = null;
  let requiredStoriesPerSprintToHitTarget: number | null = null;

  if (Number.isFinite(targetDateMs) && targetDateMs > fromTimeMs) {
    const msToTarget = targetDateMs - fromTimeMs;
    const sprintsFloat = msToTarget / sprintLenMs;
    if (sprintsFloat > 0) {
      sprintsRemainingToTarget = Math.ceil(sprintsFloat);
      requiredStoriesPerSprintToHitTarget =
        remainingToTarget > 0 ? remainingToTarget / sprintsFloat : 0;
    }
  }

  const fte = Math.max(0.1, Number.isFinite(sprintFTE) ? sprintFTE : 0);

  // ✅ Current average velocity (stories/sprint) over last 2 closed sprints (includes zeros)
  const recentStoriesPerSprint = avgStoriesLastNClosed(
    sprints,
    lastClosedIndex,
    2
  );

  // Look back across several closed sprints to find non-zero done sprints (signal)
  const LOOKBACK_CLOSED = 8;

  const nonZeroVelPerFTE: number[] = [];

  let takenClosed = 0;
  for (let i = lastClosedIndex; i >= 0 && takenClosed < LOOKBACK_CLOSED; i--) {
    if (!sprints[i]!.isClosed) continue;
    takenClosed += 1;

    const doneThis = sprints[i]!.doneThisSprint;
    if (doneThis > 0) {
      nonZeroVelPerFTE.push(doneThis / fte);
      if (nonZeroVelPerFTE.length >= 2) break; // most recent 2 non-zero
    }
  }

  if (!nonZeroVelPerFTE.length) {
    return {
      hasSignal: false,
      fromSprintIndex: lastClosedIndex,
      fromTimeMs,
      fromDone,
      projectedDonePerSprint: null,
      avgVelPerFTE: null,
      projectedCompletionMs: null,
      projectedCompletionEarlyMs: null,
      projectedCompletionLateMs: null,
      requiredFTEToHitTarget: null,
      suggestedMaxFTE: null,
      remainingStoriesFromAnchor,
      sprintsRemainingToTarget,
      requiredStoriesPerSprintToHitTarget,
      recentStoriesPerSprint,
    };
  }

  const avgVelPerFTE =
    nonZeroVelPerFTE.reduce((sum, v) => sum + v, 0) / nonZeroVelPerFTE.length;

  // ---------- FTE needed to hit target date/scope from this anchor ----------
  let requiredFTEToHitTarget: number | null = null;
  let suggestedMaxFTE: number | null = null;

  if (avgVelPerFTE > 0 && Number.isFinite(targetDateMs)) {
    if (remainingToTarget <= 0) {
      requiredFTEToHitTarget = 0;
      suggestedMaxFTE = Math.max(sprintFTE, 0) + 1;
    } else if (targetDateMs > fromTimeMs) {
      const sprintsFloat = (targetDateMs - fromTimeMs) / sprintLenMs;
      if (sprintsFloat > 0) {
        const requiredPerSprint = remainingToTarget / sprintsFloat;
        const fteRequired = requiredPerSprint / avgVelPerFTE;

        if (Number.isFinite(fteRequired) && fteRequired > 0) {
          requiredFTEToHitTarget = fteRequired;
          suggestedMaxFTE = fteRequired + 1;
        }
      }
    }
  }

  const projectedDonePerSprint = avgVelPerFTE * fte;

  if (!(projectedDonePerSprint > 0)) {
    return {
      hasSignal: false,
      fromSprintIndex: lastClosedIndex,
      fromTimeMs,
      fromDone,
      projectedDonePerSprint: null,
      avgVelPerFTE,
      projectedCompletionMs: null,
      projectedCompletionEarlyMs: null,
      projectedCompletionLateMs: null,
      requiredFTEToHitTarget,
      suggestedMaxFTE,
      remainingStoriesFromAnchor,
      sprintsRemainingToTarget,
      requiredStoriesPerSprintToHitTarget,
      recentStoriesPerSprint,
    };
  }

  const remaining = Math.max(0, latestScope - fromDone);

  if (remaining === 0) {
    return {
      hasSignal: true,
      fromSprintIndex: lastClosedIndex,
      fromTimeMs,
      fromDone,
      projectedDonePerSprint,
      avgVelPerFTE,
      projectedCompletionMs: fromTimeMs,
      projectedCompletionEarlyMs: fromTimeMs,
      projectedCompletionLateMs: fromTimeMs,
      requiredFTEToHitTarget,
      suggestedMaxFTE,
      remainingStoriesFromAnchor,
      sprintsRemainingToTarget,
      requiredStoriesPerSprintToHitTarget,
      recentStoriesPerSprint,
    };
  }

  const projectedSprints = remaining / projectedDonePerSprint;
  const projectedCompletionMs = fromTimeMs + projectedSprints * sprintLenMs;

  const fastDonePerSprint = projectedDonePerSprint * 1.2;
  const slowDonePerSprint = projectedDonePerSprint * 0.8;

  const projectedCompletionEarlyMs =
    fastDonePerSprint > 0
      ? fromTimeMs + (remaining / fastDonePerSprint) * sprintLenMs
      : projectedCompletionMs;

  const projectedCompletionLateMs =
    slowDonePerSprint > 0
      ? fromTimeMs + (remaining / slowDonePerSprint) * sprintLenMs
      : projectedCompletionMs;

  return {
    hasSignal: true,
    fromSprintIndex: lastClosedIndex,
    fromTimeMs,
    fromDone,
    projectedDonePerSprint,
    avgVelPerFTE,
    projectedCompletionMs,
    projectedCompletionEarlyMs,
    projectedCompletionLateMs,
    requiredFTEToHitTarget,
    suggestedMaxFTE,
    remainingStoriesFromAnchor,
    sprintsRemainingToTarget,
    requiredStoriesPerSprintToHitTarget,
    recentStoriesPerSprint,
  };
}
