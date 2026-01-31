// app/KpiRow.tsx
'use client';

import React, { useMemo, useState } from 'react';
import type {
  CSSProperties,
  ReactNode,
  MouseEvent as ReactMouseEvent,
} from 'react';
import type { IssueRow, Scope } from '../types';
import { computeHealth, round1 } from './projectHealth';

/* ------------------ colors ------------------ */

function colorFor(label: string): string {
  const palette: readonly string[] = [
    '#2563EB',
    '#F59E0B',
    '#10B981',
    '#EF4444',
    '#8B5CF6',
    '#06B6D4',
    '#84CC16',
    '#F43F5E',
    '#F97316',
    '#0EA5E9',
    '#A855F7',
    '#14B8A6',
  ];
  if (!palette.length) return '#999999';
  let h = 0;
  for (let i = 0; i < label.length; i++) {
    h = (h * 31 + label.charCodeAt(i)) >>> 0;
  }
  return palette[h % palette.length]!;
}

/**
 * Explicit + normalized status colors to avoid misleading duplicates.
 * Goal: "Open" and "Done" should never share the same color.
 */
const STATUS_COLOR_EXACT: Record<string, string> = {
  // Make Open clearly distinct from Done
  Open: '#6B7280', // grey
  Done: '#10B981', // green
  DONE: '#10B981', // green (common in some Jira workflows)
  Closed: '#10B981', // green

  // Common buckets / workflow signals
  'To Do': '#6B7280',
  'In Progress': '#2563EB',
  'In Dev': '#8B5CF6',

  Blocked: '#F59E0B',
  Onhold: '#F59E0B',
  'On Hold': '#F59E0B',
  'On Hold (By Dev)': '#F59E0B',
  'On Hold (By QA)': '#F59E0B',

  // Your previous special cases
  'Define Complete': '#0EA5E9',
  'Allocated to QA (I)': '#2563EB',
  'Analysis Complete': '#F59E0B',
};

function normalizeStatus(s: string): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Normalized + keyword fallback so "Done-ish" statuses stay green even if named differently.
 */
function getColor(label: string): string {
  const exact = STATUS_COLOR_EXACT[label];
  if (exact) return exact;

  const n = normalizeStatus(label);

  // Hard normalized matches (case/spacing differences)
  if (n === 'open') return '#6B7280';
  if (n === 'done' || n === 'closed') return '#10B981';
  if (n === 'to do') return '#6B7280';
  if (n === 'in progress') return '#2563EB';
  if (n === 'in dev') return '#8B5CF6';

  // Keyword heuristics (covers "Done (UAT)", "Dev Done", etc.)
  if (/\bdone\b/.test(n) || /\bclosed\b/.test(n) || n.includes('complete')) {
    // If it's "complete" but clearly QA/dev complete, keep it distinct (cyan) else green.
    if (n.includes('qa') || n.includes('test')) return '#06B6D4';
    if (n.includes('define')) return '#0EA5E9';
    return '#10B981';
  }

  if (n.includes('blocked') || n.includes('on hold') || n.includes('hold')) {
    return '#F59E0B';
  }

  if (n.includes('qa') || n.includes('test') || n.includes('uat')) {
    return '#06B6D4';
  }

  if (n.includes('dev') || n.includes('build')) {
    return '#8B5CF6';
  }

  // Fallback: stable hash palette
  return colorFor(label);
}

/* ------------------ Jira link helper ------------------ */

const JIRA_BASE =
  process.env.NEXT_PUBLIC_JIRA_BROWSE_BASE ??
  'https://pentana-solutions.atlassian.net';

const jiraUrl = (jql: string) =>
  `${JIRA_BASE}/issues/?jql=${encodeURIComponent(jql)}`;

/**
 * Insert an extra filter into the base JQL used for stories.
 * We keep the same ORDER BY as the base query.
 */
function storyJqlWithFilter(baseJql: string, filter: string): string {
  const upper = baseJql.toUpperCase();
  const idx = upper.lastIndexOf(' ORDER BY ');
  const core = idx >= 0 ? baseJql.slice(0, idx) : baseJql;
  const order = idx >= 0 ? baseJql.slice(idx) : ' ORDER BY created ASC';
  return `${core} AND ${filter}${order}`;
}

/* Blocked / On Hold statuses (for all projects) */
const BLOCKED_STATUS_NAMES = [
  'Blocked',
  'Onhold',
  'On Hold',
  'On Hold (By Dev)',
  'On Hold (By QA)',
] as const;

const BLOCKED_STATUS_SET = new Set(
  BLOCKED_STATUS_NAMES.map((s) => s.toLowerCase())
);

/** For JQL IN / NOT IN clauses (we rely on the base JQL for Withdrawn/CANCELLED). */
const BLOCKED_STATUS_JQL_LIST =
  'Blocked, Onhold, "On Hold", "On Hold (By Dev)", "On Hold (By QA)"';

function jiraUrlForStories(
  baseJql: string,
  mode: 'todo' | 'inProg' | 'blocked' | 'done'
): string {
  let filter: string;
  switch (mode) {
    case 'todo':
      filter = 'statusCategory = "To Do"';
      break;
    case 'inProg':
      filter = `statusCategory = "In Progress" AND status NOT IN (${BLOCKED_STATUS_JQL_LIST})`;
      break;
    case 'blocked':
      filter = `status IN (${BLOCKED_STATUS_JQL_LIST})`;
      break;
    case 'done':
      filter = 'statusCategory = Done';
      break;
    default:
      filter = '';
  }
  return jiraUrl(storyJqlWithFilter(baseJql, filter));
}

/* ------------------ types ------------------ */

type StatusSlice = { status: string; count: number; pct: number };

const KPI_CARD_MIN_H = 260;
const PIE_SIZE = 200;

/* ------------------ shared UI helpers ------------------ */

function Card({
  title,
  children,
  minH = 0,
}: {
  title: string;
  children: ReactNode;
  minH?: number;
}) {
  return (
    <div
      style={{
        border: '1px solid #eee',
        borderRadius: 12,
        padding: 12,
        boxShadow: '0 1px 4px rgba(0, 0, 0, 0.04)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: minH,
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ flex: 1, overflow: 'hidden', color: '#374151' }}>
        {children}
      </div>
    </div>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div
      style={{
        border: '1px dashed #d1d5db',
        borderRadius: 12,
        padding: 16,
        width: '100%',
        textAlign: 'center',
        color: '#6b7280',
      }}
    >
      {text}
    </div>
  );
}

const td = (bold?: boolean): CSSProperties => ({
  padding: '4px 0',
  fontSize: 13,
  color: bold ? '#111827' : '#374151',
});

/* label accepts ReactNode so we can pass links */
function SummaryRow({
  label,
  value,
  color,
}: {
  label: ReactNode;
  value: number;
  color: string;
}) {
  return (
    <tr>
      <td style={td(true)}>
        <span
          style={{
            display: 'inline-block',
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: color,
            marginRight: 6,
            verticalAlign: 'middle',
          }}
        />
        {label}
      </td>
      <td style={{ ...td(true), textAlign: 'right' }}>{value}</td>
    </tr>
  );
}

/* ------------------ KPI Row ------------------ */

export type KpiRowProps = {
  scope: Scope;
  issues: IssueRow[];

  pmApprovedCt: number;
  notPmApprovedCt: number;

  storyDoneCt: number;
  storyTotalCt: number;

  devStartISO: string;
  devCompletionISO: string;

  jqlBase: string;
  jqlPMApproved: string;
  jqlNotPMApproved: string;
};

export function KpiRow(props: KpiRowProps) {
  const {
    scope,
    issues,
    pmApprovedCt,
    notPmApprovedCt,
    storyDoneCt,
    storyTotalCt,
    devStartISO,
    devCompletionISO,
    jqlBase,
    jqlPMApproved,
    jqlNotPMApproved,
  } = props;

  /* ---------- PM Approved predicate ---------- */
  const isPmApprovedFn = useMemo<((r: IssueRow) => boolean)>(
    () => (r: IssueRow) =>
      scope === 'Requirement' &&
      Array.isArray(r.labels) &&
      r.labels.includes('PMApproved'),
    [scope]
  );

  /* ---------- Overview ---------- */
  const overview = useMemo(() => {
    if (scope === 'Requirement') {
      const pmApproved = Number.isFinite(pmApprovedCt)
        ? pmApprovedCt
        : issues.filter(isPmApprovedFn).length;
      const total = issues.length;
      const yetToApprove = Number.isFinite(notPmApprovedCt)
        ? notPmApprovedCt
        : Math.max(0, total - pmApproved);
      return { mode: 'req' as const, pmApproved, yetToApprove };
    }

    // Story mode: anything "Blocked / On Hold" by status name is Blocked.
    const isBlocked = (r: IssueRow) =>
      BLOCKED_STATUS_SET.has((r.status || '').toLowerCase());

    let todo = 0;
    let progUnblocked = 0;
    let blocked = 0;
    let done = 0;

    for (const r of issues) {
      const cat = r.statusCategory ?? null;

      // 1) Blocked bucket wins regardless of category
      if (isBlocked(r)) {
        blocked++;
        continue;
      }

      // 2) Otherwise follow statusCategory buckets
      if (cat === 'Done') {
        done++;
        continue;
      }
      if (cat === 'To Do') {
        todo++;
        continue;
      }
      if (cat === 'In Progress') {
        progUnblocked++;
        continue;
      }

      // Unknown → To Do
      todo++;
    }

    const all = issues.length;
    return { mode: 'story' as const, todo, progUnblocked, blocked, done, all };
  }, [issues, scope, pmApprovedCt, notPmApprovedCt, isPmApprovedFn]);

  /* ---------- Status Breakdown ---------- */
  const statusBreakdown = useMemo<StatusSlice[]>(() => {
    const map = new Map<string, number>();
    for (const it of issues) {
      const key = it.status || 'Unknown';
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .map(([status, count]) => ({
        status,
        count,
        pct: issues.length ? (count / issues.length) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count);
  }, [issues]);

  /* ---------- Project Health ---------- */

  const healthOpts = useMemo(() => {
    const o: {
      scope: Scope;
      pmApprovedFn: (r: IssueRow) => boolean;
      devPctOverride?: number;
      devCounts?: { done: number; total: number };
    } = {
      scope,
      pmApprovedFn: isPmApprovedFn,
    };

    if (storyTotalCt > 0) {
      o.devPctOverride = storyDoneCt / Math.max(1, storyTotalCt);
      o.devCounts = { done: storyDoneCt, total: storyTotalCt };
    }

    return o;
  }, [scope, isPmApprovedFn, storyDoneCt, storyTotalCt]);

  const healthRaw = useMemo(
    () => computeHealth(issues, devStartISO, devCompletionISO, healthOpts),
    [issues, devStartISO, devCompletionISO, healthOpts]
  );

  // Fix Requirement Completion: use PM Approved + Yet to Approve where possible.
  const health = useMemo(() => {
    let pmA = pmApprovedCt;
    let totalReq = pmApprovedCt + notPmApprovedCt;

    if (!Number.isFinite(totalReq) || totalReq <= 0) {
      // Fallback to issues if counts are missing
      pmA = issues.filter(isPmApprovedFn).length;
      totalReq = issues.length;
    }

    totalReq = Math.max(1, totalReq);
    const defPct = (pmA / totalReq) * 100;

    return {
      ...healthRaw,
      progress: {
        ...healthRaw.progress,
        pmApproved: pmA,
        total: totalReq,
        defPct,
        devPct: healthRaw.progress.devPct,
        devDone: healthRaw.progress.devDone,
        devTotal: healthRaw.progress.devTotal,
      },
    };
  }, [healthRaw, pmApprovedCt, notPmApprovedCt, issues, isPmApprovedFn]);

  return (
    <section
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 16,
      }}
    >
      {/* Overview */}
      <Card title="Overview" minH={KPI_CARD_MIN_H}>
        {issues.length === 0 ? (
          <Placeholder text="Click Update to load data." />
        ) : overview.mode === 'req' ? (
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <tbody>
              <SummaryRow
                label={
                  <a href={jiraUrl(jqlPMApproved)} target="_blank" rel="noreferrer">
                    PM Approved
                  </a>
                }
                value={overview.pmApproved}
                color="#10B981"
              />
              <SummaryRow
                label={
                  <a href={jiraUrl(jqlNotPMApproved)} target="_blank" rel="noreferrer">
                    Yet to Approve
                  </a>
                }
                value={overview.yetToApprove}
                color="#6b7280"
              />
            </tbody>
          </table>
        ) : (
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <tbody>
              <SummaryRow
                label={
                  <a
                    href={jiraUrlForStories(jqlBase, 'todo')}
                    target="_blank"
                    rel="noreferrer"
                  >
                    To Do
                  </a>
                }
                value={overview.todo}
                color="#6b7280"
              />
              <SummaryRow
                label={
                  <a
                    href={jiraUrlForStories(jqlBase, 'inProg')}
                    target="_blank"
                    rel="noreferrer"
                  >
                    In Progress
                  </a>
                }
                value={overview.progUnblocked}
                color="#2563EB"
              />
              <SummaryRow
                label={
                  <a
                    href={jiraUrlForStories(jqlBase, 'blocked')}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Blocked (raw)
                  </a>
                }
                value={overview.blocked}
                color="#F59E0B"
              />
              <SummaryRow
                label={
                  <a
                    href={jiraUrlForStories(jqlBase, 'done')}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Done
                  </a>
                }
                value={overview.done}
                color="#10B981"
              />
              <tr>
                <td style={{ ...td(true), borderTop: '1px solid #e5e7eb' }}>
                  Total
                </td>
                <td
                  style={{
                    ...td(true),
                    textAlign: 'right',
                    borderTop: '1px solid #e5e7eb',
                  }}
                >
                  {overview.all}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </Card>

      {/* Status Breakdown */}
      <Card title="Status Breakdown" minH={KPI_CARD_MIN_H}>
        {issues.length === 0 ? (
          <Placeholder text="Click Update to load data." />
        ) : statusBreakdown.length === 0 ? (
          <Placeholder text="No issues to summarize." />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(160px, 1fr) 280px',
              gap: 12,
              alignItems: 'stretch',
              height: '100%',
            }}
          >
            <div style={{ display: 'grid', placeItems: 'center' }}>
              <FullPie
                size={PIE_SIZE}
                data={statusBreakdown.map((d) => ({
                  label: d.status,
                  value: d.count,
                  pct: d.pct,
                }))}
              />
            </div>

            <Legend
              data={statusBreakdown.map((d) => ({
                label: d.status,
                value: d.count,
                pct: d.pct,
              }))}
            />
          </div>
        )}
        {issues.length > 0 && (
          <div style={{ marginTop: 6, fontSize: 12 }}>
            <a href={jiraUrl(jqlBase)} target="_blank" rel="noreferrer">
              Open in Jira (same filter)
            </a>
          </div>
        )}
      </Card>

      {/* Project Health */}
      <Card title="Project Health" minH={KPI_CARD_MIN_H}>
        {issues.length === 0 || !devStartISO || !devCompletionISO ? (
          <Placeholder text="Set Dev Start (auto) and Dev Completion target, then Update." />
        ) : (
          <HealthPanel health={health} />
        )}
      </Card>
    </section>
  );
}

/* ---------- legend + full pie ---------- */

function Legend({
  data,
}: {
  data: { label: string; value: number; pct: number }[];
}) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  return (
    <div
      style={{
        borderLeft: '1px dashed #e5e7eb',
        paddingLeft: 12,
        height: '100%',
        overflow: 'auto',
      }}
    >
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>
        Legend
      </div>
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'grid',
          gap: 6,
        }}
      >
        {data.map((d) => (
          <li
            key={d.label}
            style={{
              display: 'grid',
              gridTemplateColumns: '14px 1fr auto',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                background: getColor(d.label),
                border: '1px solid rgba(0, 0, 0, 0.06)',
              }}
              aria-hidden
            />
            <span
              style={{
                fontSize: 13,
                color: '#111827',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {d.label}
            </span>
            <span style={{ fontSize: 12, color: '#374151' }}>
              {d.value}{' '}
              <span style={{ color: '#6b7280' }}>
                ({((d.value / total) * 100).toFixed(1)}%)
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FullPie({
  data,
  size = 240,
}: {
  data: { label: string; value: number; pct: number }[];
  size?: number;
}) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 2;

  const [hover, setHover] = useState<{
    x: number;
    y: number;
    d: { label: string; value: number; pct: number };
  } | null>(null);

  // ---- Special case: 100% in a single status -> solid donut ----
  if (data.length === 1 && total > 0) {
    const [d0] = data;
    if (!d0) return null;
    const color = getColor(d0.label);

    return (
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {/* outer filled circle */}
          <circle cx={cx} cy={cy} r={r} fill={color} />
          {/* inner white circle so it looks like a donut */}
          <circle cx={cx} cy={cy} r={r * 0.55} fill="#FFFFFF" />
          <title>
            {d0.label}: {d0.value} ({d0.pct.toFixed(1)}%)
          </title>
        </svg>
      </div>
    );
  }

  // ---- Normal multi-slice pie with hover ----
  let startAngle = 0;
  const paths = data.map((d) => {
    const angle = (d.value / total) * Math.PI * 2;
    const endAngle = startAngle + angle;

    const onMove = (e: ReactMouseEvent<SVGPathElement>) => {
      const svg = e.currentTarget.ownerSVGElement as SVGSVGElement | null;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      setHover({
        x: e.clientX - rect.left + 10,
        y: e.clientY - rect.top + 10,
        d,
      });
    };

    const el = (
      <path
        key={d.label}
        d={arcPath(cx, cy, r, startAngle, endAngle)}
        fill={getColor(d.label)}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <title>
          {d.label}: {d.value} ({d.pct.toFixed(1)}%)
        </title>
      </path>
    );
    startAngle = endAngle;
    return el;
  });

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {paths}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="transparent"
          stroke="white"
          strokeWidth={1}
          style={{ pointerEvents: 'none' }}
        />
      </svg>

      {hover && (
        <div
          style={{
            position: 'absolute',
            left: hover.x,
            top: hover.y,
            pointerEvents: 'none',
            background: 'white',
            border: '1px solid #e5e7eb',
            boxShadow: '0 6px 16px rgba(0, 0, 0, 0.08)',
            borderRadius: 8,
            padding: '8px 10px',
            fontSize: 12,
            color: '#111827',
            zIndex: 1,
          }}
          role="tooltip"
          aria-label={`${hover.d.label}: ${hover.d.value} (${hover.d.pct.toFixed(
            1
          )}%)`}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 4,
            }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: getColor(hover.d.label),
              }}
            />
            <b>{hover.d.label}</b>
          </div>
          <div>
            Count: <b>{hover.d.value}</b>
          </div>
          <div>
            % of total: <b>{hover.d.pct.toFixed(1)}%</b>
          </div>
        </div>
      )}
    </div>
  );
}

function arcPath(cx: number, cy: number, r: number, start: number, end: number) {
  let e = end;
  if (e - start <= 1e-6) e = start + 1e-6;
  const sx = cx + r * Math.cos(start);
  const sy = cy + r * Math.sin(start);
  const ex = cx + r * Math.cos(e);
  const ey = cy + r * Math.sin(e);
  const large = e - start > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${ex} ${ey} Z`;
}

/* ---------- Project Health UI ---------- */

type TrafficTone = 'good' | 'warn' | 'bad';

function toneColor(tone: TrafficTone): string {
  switch (tone) {
    case 'good':
      return '#16A34A'; // green
    case 'warn':
      return '#F59E0B'; // amber
    case 'bad':
    default:
      return '#DC2626'; // red
  }
}

function HealthPanel({ health }: { health: any }) {
  const sched = health.metrics.schedule ?? {};
  const wip = health.metrics.wip ?? {};
  const aging = health.metrics.aging ?? {};

  const plannedPct = Number.isFinite(sched.plannedPct)
    ? (sched.plannedPct as number)
    : null;
  const actualPct = Number.isFinite(sched.actualPct)
    ? (sched.actualPct as number)
    : null;

  // Use deltaPP from health if present, otherwise derive from plan/actual.
  const rawDelta =
    Number.isFinite(sched.deltaPP) && sched.deltaPP != null
      ? (sched.deltaPP as number)
      : plannedPct != null && actualPct != null
      ? actualPct - plannedPct
      : null;

  const deltaLabel =
    rawDelta == null
      ? 'No baseline yet'
      : `${Math.abs(rawDelta).toFixed(1)} pp ${
          rawDelta >= 0 ? 'ahead' : 'behind'
        }`;

  /* ---------- Card 1: Delivery pace vs target ---------- */

  let paceTone: TrafficTone = 'good';
  let paceIssue = 'Pace is roughly on plan for this date.';
  let paceRemedy =
    'Keep an eye on blockers; avoid adding new scope without dropping something.';

  if (rawDelta != null) {
    if (rawDelta <= -10) {
      paceTone = 'bad';
      paceIssue = 'Well behind where we expected to be by today.';
      paceRemedy =
        'Reduce WIP, finish oldest work first, and consider descoping or adding capacity.';
    } else if (rawDelta <= -5) {
      paceTone = 'warn';
      paceIssue = 'Slightly behind the planned completion curve.';
      paceRemedy =
        'Protect focus time, keep WIP low, and avoid adding scope until we catch up.';
    } else if (rawDelta >= 5) {
      paceTone = 'good';
      paceIssue = 'Running ahead of plan.';
      paceRemedy =
        'Use the buffer to pay down tech debt or pull forward critical items.';
    }
  }

  const paceMetric =
    plannedPct != null && actualPct != null
      ? `Planned ${plannedPct.toFixed(1)}% vs Actual ${actualPct.toFixed(
          1
        )}% • ${deltaLabel}`
      : 'Not enough data yet to compare plan vs actual.';

  /* ---------- Card 2: WIP health ---------- */

  const wipCount = Number.isFinite(wip.wip) ? (wip.wip as number) : 0;
  const done14 = Number.isFinite(wip.done14) ? (wip.done14 as number) : 0;
  const wipScore = Number.isFinite(wip.score) ? (wip.score as number) : 0;

  let wipTone: TrafficTone =
    wipScore >= 75 ? 'good' : wipScore >= 50 ? 'warn' : 'bad';
  let wipIssue = 'WIP level is balanced against recent throughput.';
  let wipRemedy =
    'Keep active work small and focused; avoid starting new tickets unnecessarily.';

  if (wipTone === 'warn') {
    wipIssue = 'WIP is starting to creep higher than throughput.';
    wipRemedy =
      'Cap active stories per person and finish in-flight work before pulling new items.';
  } else if (wipTone === 'bad') {
    wipIssue = 'Too many items in progress for the current throughput.';
    wipRemedy =
      'Hard-cap WIP, swarm on the oldest items, and stop starting new work until WIP drops.';
  }

  const wipMetric = `WIP ${wipCount} • Done14 ${done14 || '0'}`;

  /* ---------- Card 3: Aging WIP ---------- */

  const medianAge = Number.isFinite(aging.medianAge)
    ? (aging.medianAge as number)
    : null;
  const oldCount = Number.isFinite(aging.oldCount)
    ? (aging.oldCount as number)
    : 0;
  const agingScore = Number.isFinite(aging.score) ? (aging.score as number) : 0;

  let agingTone: TrafficTone =
    agingScore >= 75 ? 'good' : agingScore >= 50 ? 'warn' : 'bad';
  let agingIssue =
    'Most in-progress work is flowing through in reasonable time.';
  let agingRemedy =
    'Continue to prioritise older items so nothing silently stalls.';

  if (agingTone === 'warn') {
    agingIssue = 'Some stories are aging and at risk of stalling.';
    agingRemedy =
      'Review the oldest tickets, remove blockers, and make sure each has a clear owner.';
  } else if (agingTone === 'bad') {
    agingIssue = 'Many stories have been sitting in progress for a long time.';
    agingRemedy =
      'Run an “oldest-first” push: unblock, close, or split aging tickets before starting new ones.';
  }

  const agingMetric =
    medianAge != null
      ? `Median age ${medianAge}d • ${oldCount} items ≥14d`
      : `Old items ≥14d: ${oldCount}`;

  const cards = [
    {
      id: 'pace',
      title: 'Delivery pace vs target',
      metric: paceMetric,
      issue: paceIssue,
      remediation: paceRemedy,
      tone: paceTone,
    },
    {
      id: 'wip',
      title: 'WIP health',
      metric: wipMetric,
      issue: wipIssue,
      remediation: wipRemedy,
      tone: wipTone,
    },
    {
      id: 'aging',
      title: 'Aging WIP',
      metric: agingMetric,
      issue: agingIssue,
      remediation: agingRemedy,
      tone: agingTone,
    },
  ];

  /* ---------- Overall Health (0–100) from the 3 KPIs ---------- */

  const paceScore = Number.isFinite(sched.score) ? (sched.score as number) : 0;
  const overallScoreRaw = 0.4 * paceScore + 0.3 * wipScore + 0.3 * agingScore;
  const overallScore = Math.round(Math.max(0, Math.min(100, overallScoreRaw)));

  let overallBadge: 'Green' | 'Amber' | 'Red';
  let overallSummary: string;

  if (overallScore >= 80) {
    overallBadge = 'Green';
    overallSummary = 'Healthy momentum; keep cadence steady.';
  } else if (overallScore >= 60) {
    overallBadge = 'Amber';
    overallSummary = 'Mixed signals; watch WIP and delivery pace.';
  } else {
    overallBadge = 'Red';
    overallSummary = 'At risk; reduce WIP and finish oldest items now.';
  }

  const overallColor =
    overallBadge === 'Green'
      ? '#10B981'
      : overallBadge === 'Amber'
      ? '#F59E0B'
      : '#EF4444';

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '220px minmax(320px, 1fr)',
        gap: 12,
        height: '100%',
      }}
    >
      {/* Left: overall gauge + summary */}
      <div
        style={{
          display: 'grid',
          placeItems: 'center',
          gap: 4,
          paddingRight: 8,
          borderRight: '1px solid #E5E7EB',
        }}
      >
        <Gauge score={overallScore} color={overallColor} />
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          Overall Health (0–100)
        </div>
        <div
          style={{
            fontSize: 11,
            color: '#6b7280',
            textAlign: 'center',
          }}
        >
          {overallBadge} • {overallSummary}
        </div>
        <div
          style={{
            fontSize: 11,
            color: '#6b7280',
            textAlign: 'center',
            marginTop: 2,
          }}
        >
          Based on pace (40%), WIP (30%), aging WIP (30%).
        </div>
        <div
          style={{
            fontSize: 12,
            color: '#111827',
            textAlign: 'center',
            marginTop: 6,
          }}
        >
          <div>
            Requirement Completion: <b>{round1(health.progress.defPct)}%</b>
          </div>
          <div>
            Development Completion:{' '}
            <b>{round1(health.progress.devPct ?? health.progress.wfPct)}%</b>
          </div>
        </div>
      </div>

      {/* Right: 3 vertical KPI cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateRows: 'repeat(3, minmax(0, 1fr))',
          gap: 8,
        }}
      >
        {cards.map((card) => {
          const color = toneColor(card.tone);
          return (
            <div
              key={card.id}
              style={{
                borderRadius: 10,
                border: '1px solid #E5E7EB',
                padding: 10,
                background: '#FFFFFF',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 2,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      backgroundColor: color,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: '#111827',
                    }}
                  >
                    {card.title}
                  </span>
                </div>
                <span style={{ fontSize: 11, fontWeight: 600, color }}>
                  {card.tone === 'good'
                    ? 'Good'
                    : card.tone === 'warn'
                    ? 'Watch'
                    : 'At risk'}
                </span>
              </div>

              <div style={{ fontSize: 11, color: '#111827' }}>{card.metric}</div>

              <div style={{ fontSize: 11, color: '#B91C1C', marginTop: 4 }}>
                <strong>Issue: </strong>
                {card.issue}
              </div>

              <div style={{ fontSize: 11, color: '#374151' }}>
                <strong>Remediation (next week): </strong>
                {card.remediation}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Gauge ---------- */

function Gauge({ score, color }: { score: number; color: string }) {
  const size = 120;
  const stroke = 12;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const dash = c * pct;
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="#eef2f7"
          strokeWidth={stroke}
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${dash} ${c - dash}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          placeItems: 'center',
          fontWeight: 700,
          color: '#111827',
        }}
      >
        {score}
      </div>
    </div>
  );
}
