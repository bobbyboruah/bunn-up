// app/projectHealth.ts
import type { IssueRow, Scope } from '../types';

export type Health = {
  overall: { score: number; badge: 'Green' | 'Amber' | 'Red'; summary: string };
  metrics: {
    velocity: { score: number; done14: number; prev14: number };
    wip: { score: number; wip: number; done14: number };
    aging: { score: number; medianAge: number; oldCount: number; wip: number };
    lead: { score: number; currentDays: number; baselineDays: number };
    schedule: {
      score: number;
      plannedPct: number;
      actualPct: number;
      deltaPP: number;
      trend: 'Ahead' | 'Behind' | 'On plan';
    };
  };
  fixes: { title: string; action: string }[];
  progress: {
    defPct: number;
    wfPct: number;
    pmApproved: number;
    wfDone: number;
    total: number;
    devPct?: number;
    devDone?: number;
    devTotal?: number;
  };
};

type FixCtx = {
  done14: number;
  prev14: number;
  wipCount: number;
  medianAge?: number;
  oldCount?: number;
  leadCurrent?: number;
  leadBaseline?: number;
  plannedPct: number;
  actualPct: number;
};

type DriverKey = 'velocity' | 'wip' | 'aging' | 'lead' | 'schedule';

export function computeHealth(
  issues: IssueRow[],
  devStartISO?: string,
  devCompletionISO?: string,
  opts?: {
    scope: Scope;
    pmApprovedFn?: (r: IssueRow) => boolean;
    devPctOverride?: number;
    devCounts?: { done: number; total: number };
  }
): Health {
  const scope = opts?.scope ?? 'Story';
  const isPmApproved = opts?.pmApprovedFn ?? (() => false);

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  const isWorkflowDone = (r: IssueRow) => r.statusCategory === 'Done';

  const wipLike = (r: IssueRow) => {
    const cat = r.statusCategory;
    return (
      cat === 'In Progress' ||
      /(in\s*dev|dev\s*in\s*progress|qa|review|testing|with qa|allocated to qa|analysis complete)/i.test(
        r.status || ''
      )
    );
  };

  const doneWithin = (daysSpan: number, offsetStart = 0) => {
    const start = now - (offsetStart + daysSpan) * day;
    const end = now - offsetStart * day;
    return issues.filter((r) => {
      const tStr = r.resolutiondate;
      if (!tStr) return false;
      const t = new Date(tStr).getTime();
      return t >= start && t < end;
    }).length;
  };

  const defDoneWithin = (daysSpan: number, offsetStart = 0) => {
    const start = now - (offsetStart + daysSpan) * day;
    const end = now - offsetStart * day;
    return issues.filter((r) => {
      if (!isPmApproved(r)) return false;
      const t = new Date(r.updated).getTime();
      return t >= start && t < end;
    }).length;
  };

  const done14 = doneWithin(14, 0);
  const prev14 = doneWithin(14, 14);
  const defDone14 = defDoneWithin(14, 0);
  const defPrev14 = defDoneWithin(14, 14);

  const wipItems = issues.filter(wipLike);
  const wipCount = wipItems.length;

  const ages = wipItems.map(
    (r) => (now - new Date(r.created).getTime()) / day
  );
  const medianAge = median(ages);
  const oldCount = wipItems.filter(
    (r) => (now - new Date(r.created).getTime()) / day >= 14
  ).length;

  const agingScore = clamp(
    100 - mapRange(medianAge || 0, 7, 28, 0, 70),
    0,
    100
  );

  const completions = issues
    .map((r) => ({ r, t: r.resolutiondate }))
    .filter((x) => !!x.t) as { r: IssueRow; t: string }[];

  const recentResolved = completions.filter(
    (x) => now - new Date(x.t).getTime() <= 60 * day
  );

  const avg = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  const leadCurrent = avg(
    recentResolved.map(
      (x) =>
        (new Date(x.t).getTime() - new Date(x.r.created).getTime()) / day
    )
  );
  const leadBaseline = avg(
    completions.map(
      (x) =>
        (new Date(x.t).getTime() - new Date(x.r.created).getTime()) / day
    )
  );

  const total = issues.length || 1;
  const wfDone = issues.filter(isWorkflowDone).length;
  const wfPct = wfDone / total;

  const pmApproved = issues.filter(isPmApproved).length;
  const defPct = pmApproved / total;

  const devPct = opts?.devPctOverride ?? wfPct;

  let plannedPct = 0;
  if (devStartISO && devCompletionISO) {
    const t0 = new Date(devStartISO).getTime();
    const t1 = new Date(devCompletionISO).getTime();
    plannedPct = clamp((now - t0) / Math.max(day, t1 - t0), 0, 1);
  }

  const velRatio = prev14 > 0 ? done14 / prev14 : 1;
  const velocityScore = clamp(mapRange(velRatio, 0.4, 1.3, 30, 100), 0, 100);

  const wipPressure = wipCount / Math.max(1, done14);
  const wipScore = clamp(
    100 - mapRange(wipPressure, 0.3, 2.0, 0, 70),
    0,
    100
  );

  const leadScore =
    Number.isFinite(leadCurrent) && Number.isFinite(leadBaseline)
      ? clamp(
          100 -
            mapRange(
              (leadCurrent - leadBaseline) / Math.max(1, leadBaseline),
              -0.5,
              0.6,
              -20,
              60
            ),
          0,
          100
        )
      : 70;

  const paceGap = Math.max(0, plannedPct - devPct);
  const scheduleScore = clamp(100 - paceGap * 100, 0, 100);

  const overallWorkflow =
    0.25 * velocityScore +
    0.2 * wipScore +
    0.2 * agingScore +
    0.2 * leadScore +
    0.15 * scheduleScore;

  let blendedOverall = overallWorkflow;
  if (scope === 'Requirement') {
    const defVelRatio = defPrev14 > 0 ? defDone14 / defPrev14 : 1;
    const defVelocityScore = clamp(
      mapRange(defVelRatio, 0.4, 1.3, 30, 100),
      0,
      100
    );
    const defPaceGap = Math.max(0, plannedPct - defPct);
    const defScheduleScore = clamp(100 - defPaceGap * 100, 0, 100);
    const overallDef = 0.6 * defScheduleScore + 0.4 * defVelocityScore;
    blendedOverall = Math.min(overallWorkflow, overallDef * 1.05);
  }

  const overall = blendedOverall;
  const badge: Health['overall']['badge'] =
    overall >= 75 ? 'Green' : overall >= 50 ? 'Amber' : 'Red';

  const drivers = (
    [
      { key: 'velocity' as DriverKey, score: velocityScore },
      { key: 'wip' as DriverKey, score: wipScore },
      { key: 'aging' as DriverKey, score: agingScore },
      { key: 'lead' as DriverKey, score: leadScore },
      { key: 'schedule' as DriverKey, score: scheduleScore },
    ] as { key: DriverKey; score: number }[]
  ).sort((a, b) => a.score - b.score);

  const ctx: FixCtx = {
    done14,
    prev14,
    wipCount,
    medianAge,
    oldCount,
    leadCurrent,
    leadBaseline,
    plannedPct,
    actualPct: devPct,
  };
  const fixes = drivers.slice(0, 3).map((d) => mkFix(d.key, ctx));

  const deltaPP = round1((devPct - plannedPct) * 100);
  const trend: 'Ahead' | 'Behind' | 'On plan' =
    Math.abs(deltaPP) < 0.5 ? 'On plan' : deltaPP >= 0 ? 'Ahead' : 'Behind';

  return {
    overall: {
      score: Math.round(overall),
      badge,
      summary:
        badge === 'Green'
          ? 'Healthy momentum; keep cadence steady.'
          : badge === 'Amber'
          ? 'Some risks detected; address top drivers this week.'
          : 'At risk; reduce WIP age and finish oldest items now.',
    },
    metrics: {
      velocity: { score: Math.round(velocityScore), done14, prev14 },
      wip: { score: Math.round(wipScore), wip: wipCount, done14 },
      aging: {
        score: Math.round(agingScore),
        medianAge: round1(medianAge),
        oldCount,
        wip: wipCount,
      },
      lead: {
        score: Math.round(leadScore),
        currentDays: round1(leadCurrent),
        baselineDays: round1(leadBaseline),
      },
      schedule: {
        score: Math.round(scheduleScore),
        plannedPct: round1(plannedPct * 100),
        actualPct: round1(devPct * 100),
        deltaPP,
        trend,
      },
    },
    fixes,
    progress: {
      defPct: defPct * 100,
      wfPct: (wfDone / total) * 100,
      pmApproved,
      wfDone,
      total,
      devPct: devPct * 100,
      devDone: opts?.devCounts?.done,
      devTotal: opts?.devCounts?.total,
    },
  } as Health;
}

/* ---------- helpers ---------- */

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

function mapRange(
  x: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number
): number {
  if (inMax === inMin) return outMin;
  const t = (x - inMin) / (inMax - inMin);
  return outMin + (outMax - outMin) * t;
}

function clamp(x: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, x));
}

export function round1(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 10) / 10 : NaN;
}

function mkFix(key: DriverKey, ctx: FixCtx): { title: string; action: string } {
  switch (key) {
    case 'velocity':
      return {
        title: 'Raise delivery pace',
        action: `Done14 ${ctx.done14} vs Prev14 ${ctx.prev14}. Swarm top 2 items. Freeze new starts 5 days.`,
      };
    case 'wip':
      return {
        title: 'Reduce WIP to increase flow',
        action: `WIP ${ctx.wipCount} vs Done14 ${Math.max(
          1,
          ctx.done14
        )}. Cap active ≤ ${Math.max(
          2,
          Math.floor(Math.max(1, ctx.done14) * 1.2)
        )}. Pair on oldest.`,
      };
    case 'aging':
      return {
        title: 'Burn down aging WIP',
        action: `Median ${round1(ctx.medianAge ?? 0)}d; ≥14d: ${
          ctx.oldCount ?? 0
        }. Pull oldest-first. Slice to ≤2d.`,
      };
    case 'lead':
      return {
        title: 'Shorten lead time',
        action: `Lead ${round1(ctx.leadCurrent ?? 0)}d vs ${round1(
          ctx.leadBaseline ?? 0
        )}d. Smaller PRs. Reduce handoffs.`,
      };
    case 'schedule':
      return {
        title: 'Close plan vs actual gap',
        action: `Planned ${round1(
          ctx.plannedPct * 100
        )}% vs Actual ${round1(
          ctx.actualPct * 100
        )}%. Finish WIP first. De-scope 10–20%.`,
      };
  }
  return {
    title: 'Improve delivery',
    action: 'Attack the lowest scoring driver first.',
  };
}
