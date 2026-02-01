// app/page.tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  buildBurnupModel,
  recomputeProjectionWithFTE,
  type BurnupIssue,
  type BurnupModel,
  type SprintSummary,
} from './buildBurnupModel';
import type { Scope, IssueRow } from '../types';
import { KpiRow } from './KpiRow';
import { BurnupChart } from './BurnupChart';
import JiraTicket from './JiraTicket';

/* ------------------ date helpers ------------------ */

const addDays = (iso: string, days: number): string => {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const todayISO = (): string => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Convert an epoch-ms timestamp that is already "date-only aligned"
 * (UTC epoch-day flooring) into YYYY-MM-DD using UTC fields.
 * This keeps Sprint Plan dates consistent with buildBurnupModel (UTC epoch-day).
 */
const msToISO_UTC = (ms: number): string => {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

/* ------------------ API types ------------------ */

type SearchResponse = {
  items?: IssueRow[];
  nextPageToken?: string | null;
  upstream?: { errorMessages?: string[]; [k: string]: unknown };
  error?: string;
};

/* ------------------ layout config ------------------ */

const DEFAULT_DEV_COMPLETE = '2026-05-31';

/* ------------------ Project list (Option A: local UI add) ------------------ */

const BUILTIN_PROJECTS = ['SO', 'PPP', 'PWS', 'PORE', 'PWPU'] as const;
const CUSTOM_PROJECTS_LS_KEY = 'burnup_custom_projects_v1';
const ADD_PROJECT_SENTINEL = '__add_project__';

/** Basic Jira project key validation (fairly permissive, but safe) */
function normalizeProjectKey(input: string): string {
  return String(input ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}
function isValidProjectKey(key: string): boolean {
  // Jira keys are usually 2–10 (sometimes longer). Keep it practical.
  // Must start with a letter, then letters/numbers/underscore allowed.
  return /^[A-Z][A-Z0-9_]{1,19}$/.test(key);
}
function uniqStrings(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = String(x);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/* ------------------ JQL builders ------------------ */

function buildJql(p: string, s: Scope) {
  return `project = ${p} AND type = ${s} AND status NOT IN (Withdrawn, CANCELLED) ORDER BY created ASC`;
}
function buildJqlPMApproved(p: string) {
  return `project = ${p} AND type = Requirement AND status NOT IN (Withdrawn, CANCELLED) AND labels = PMApproved ORDER BY updated DESC`;
}
function buildJqlNotPMApproved(p: string) {
  return `project = ${p} AND type = Requirement AND status NOT IN (Withdrawn, CANCELLED) AND (labels NOT IN (PMApproved) OR labels IS EMPTY) ORDER BY created ASC`;
}
function buildJqlStoriesAll(p: string) {
  return `project = ${p} AND type = Story AND status NOT IN (Withdrawn, CANCELLED)`;
}
function buildJqlStoriesDone(p: string) {
  return `project = ${p} AND type = Story AND status NOT IN (Withdrawn, CANCELLED) AND statusCategory = Done`;
}

/* ------------------ style helpers ------------------ */

const baseInput: CSSProperties = {
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  fontSize: 13,
  backgroundColor: 'white',
};

const inp = (): CSSProperties => ({
  ...baseInput,
  width: 140,
});

const dd = (w = 150): CSSProperties => ({
  ...baseInput,
  width: w,
});

const btn = (): CSSProperties => ({
  padding: '6px 12px',
  borderRadius: 999,
  border: 'none',
  background: '#2563EB',
  fontSize: 13,
  color: 'white',
  cursor: 'pointer',
});

/* ------------------ small UI bits ------------------ */

function Label({ children }: { children: ReactNode }) {
  return <span style={{ color: '#4b5563' }}>{children}</span>;
}

type ViewMode = 'burnup' | 'jira';

type BurnupLock = { project: string; scope: Scope } | null;

/* ------------------ helper: Velocity slider bounds ------------------ */

function getVelocitySliderBounds(model: BurnupModel | null): {
  min: number;
  max: number;
} {
  const defaultMin = 5;
  const defaultMax = 80;

  const proj = model?.projection;

  if (
    !model ||
    !proj ||
    !proj.hasSignal ||
    proj.fromTimeMs == null ||
    proj.fromDone == null
  ) {
    return { min: defaultMin, max: defaultMax };
  }

  const targetDateMs = model.targetDateMs;
  const sprintLengthDays = model.sprintLengthDays;
  const latestScope = model.latestScope;

  if (!Number.isFinite(targetDateMs) || sprintLengthDays <= 0) {
    return { min: defaultMin, max: defaultMax };
  }

  const fromTimeMs = proj.fromTimeMs as number;
  const fromDone = proj.fromDone as number;

  const remainingStories = Math.max(0, latestScope - fromDone);
  const sprintLenMs = sprintLengthDays * DAY_MS;
  const remainingTimeMs = targetDateMs - fromTimeMs;

  if (remainingStories <= 0 || remainingTimeMs <= 0) {
    return { min: defaultMin, max: defaultMax };
  }

  const sprintsRemaining = Math.max(1, Math.ceil(remainingTimeMs / sprintLenMs));
  const requiredStoriesPerSprint = remainingStories / sprintsRemaining;

  const recent = (proj as any).recentStoriesPerSprint ?? null;

  const baseline =
    recent && recent > 0
      ? recent
      : requiredStoriesPerSprint > 0
      ? requiredStoriesPerSprint
      : null;

  if (!baseline || !Number.isFinite(baseline)) {
    return { min: defaultMin, max: defaultMax };
  }

  const min = Math.max(1, Math.floor(baseline * 0.5));
  const max = Math.max(
    Math.ceil(requiredStoriesPerSprint * 1.5),
    Math.ceil(baseline * 2)
  );

  return {
    min,
    max: Math.max(min + 5, max),
  };
}

/* ------------------ scope slider helpers ------------------ */

type ScopeSliderConfig = {
  enabled: boolean;
  baselineScope: number;
  min: number;
  max: number;
};

function computeScopeSliderConfig(model: BurnupModel | null): ScopeSliderConfig {
  if (!model || !model.sprints.length) {
    return { enabled: false, baselineScope: 0, min: 0, max: 0 };
  }

  const sprints = model.sprints;
  let lastClosedIndex = -1;
  for (let i = 0; i < sprints.length; i += 1) {
    if (sprints[i]!.isClosed) {
      lastClosedIndex = i;
    }
  }

  if (lastClosedIndex < 0 || lastClosedIndex === sprints.length - 1) {
    return { enabled: false, baselineScope: 0, min: 0, max: 0 };
  }

  const baselineScope = sprints[lastClosedIndex]!.scopeAtEnd;
  const safeBaseline = baselineScope > 0 ? baselineScope : 1;
  const span = Math.max(50, Math.round(safeBaseline * 0.5));
  const min = Math.max(0, baselineScope - span);
  const max = baselineScope + span;

  return { enabled: true, baselineScope, min, max };
}

function buildScopeAdjustedModel(
  base: BurnupModel,
  overrideScope: number
): BurnupModel {
  const sprints = base.sprints;
  if (!sprints.length) return base;

  let lastClosedIndex = -1;
  for (let i = 0; i < sprints.length; i += 1) {
    if (sprints[i]!.isClosed) {
      lastClosedIndex = i;
    }
  }

  if (lastClosedIndex < 0) {
    return base;
  }

  const newScope = Math.max(0, Math.round(overrideScope));
  const newSprints: SprintSummary[] = sprints.map((s) => ({ ...s }));

  const nextIndex = Math.min(lastClosedIndex + 1, newSprints.length - 1);

  for (let i = 0; i < newSprints.length; i += 1) {
    const s = newSprints[i]!;
    if (i <= lastClosedIndex) continue;

    if (i === nextIndex) {
      s.scopeAtStart = newSprints[i - 1]!.scopeAtEnd;
      s.scopeAtEnd = newScope;
    } else {
      s.scopeAtStart = newScope;
      s.scopeAtEnd = newScope;
    }
  }

  const lastSprint = newSprints[newSprints.length - 1]!;
  const latestScope = lastSprint.scopeAtEnd;

  const targetDateMs = base.targetDateMs;
  let chosen: SprintSummary | null = null;
  for (const s of newSprints) {
    if (targetDateMs <= s.endMs) {
      chosen = s;
      break;
    }
  }
  if (!chosen) {
    chosen = lastSprint;
  }
  const targetScope = chosen.scopeAtEnd;

  return {
    ...base,
    sprints: newSprints,
    latestScope,
    targetScope,
  };
}

/* -------- velocity insight type -------- */

type VelocityInsights = {
  lastSprintStories: number | null;
  doneSoFar: number | null;
  totalScope: number | null;
  recentVelocity: number | null;
  neededVelocity: number | null;
  finishLabel: string | null;
};

/* ------------------ page ------------------ */

export default function Dashboard() {
  const [viewMode, setViewMode] = useState<ViewMode>('burnup');

  const [project, setProject] = useState<string>('PWS');
  const [scope, setScope] = useState<Scope>('Requirement');

  const [devStartISO, setDevStartISO] = useState<string>('');
  const [devCompletionISO, setDevCompletionISO] =
    useState<string>(DEFAULT_DEV_COMPLETE);

  const [updateStamp, setUpdateStamp] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [issues, setIssues] = useState<IssueRow[]>([]);

  const [pmApprovedCt, setPmApprovedCt] = useState<number>(0);
  const [notPmApprovedCt, setNotPmApprovedCt] = useState<number>(0);

  const [storyDoneCt, setStoryDoneCt] = useState<number>(0);
  const [storyTotalCt, setStoryTotalCt] = useState<number>(0);

  // Burn-up inputs
  // IMPORTANT UI change: keep blank until Create Burnup calculates the window.
  const [sprintStartISO, setSprintStartISO] = useState<string>('');
  const [sprintEndISO, setSprintEndISO] = useState<string>('');

  // Slider value is now *velocity* (stories / sprint), not FTE.
  const [sprintFTE, setSprintFTE] = useState<number>(10);

  const [burnupModel, setBurnupModel] = useState<BurnupModel | null>(null);
  const [burnupError, setBurnupError] = useState<string | null>(null);

  const [burnupLock, setBurnupLock] = useState<BurnupLock>(null);

  const [scopeOverride, setScopeOverride] = useState<number | null>(null);

  /* ---------- Project list state (custom projects) ---------- */

  const [customProjects, setCustomProjects] = useState<string[]>([]);
  const [showAddProject, setShowAddProject] = useState<boolean>(false);
  const [newProjectKey, setNewProjectKey] = useState<string>('');
  const [projectAddError, setProjectAddError] = useState<string | null>(null);

  const allProjects = useMemo(() => {
    const base = Array.from(BUILTIN_PROJECTS) as unknown as string[];
    const customs = (customProjects ?? []).map((p) => normalizeProjectKey(p));
    return uniqStrings([...base, ...customs]).sort((a, b) => a.localeCompare(b));
  }, [customProjects]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Load custom projects
    try {
      const raw = window.localStorage.getItem(CUSTOM_PROJECTS_LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const cleaned = uniqStrings(
            parsed
              .map((x) => normalizeProjectKey(String(x ?? '')))
              .filter((k) => isValidProjectKey(k))
          );
          setCustomProjects(cleaned);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        CUSTOM_PROJECTS_LS_KEY,
        JSON.stringify(customProjects ?? [])
      );
    } catch {
      // ignore
    }
  }, [customProjects]);

  // If current project is not in the list (e.g. cleared storage), fall back to PWS.
  useEffect(() => {
    if (!project) return;
    if (allProjects.includes(project)) return;

    // Prefer PWS if available, else first available.
    const fallback = allProjects.includes('PWS')
      ? 'PWS'
      : allProjects[0] ?? 'PWS';
    setProject(fallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allProjects]);

  function commitAddProject() {
    const normalized = normalizeProjectKey(newProjectKey);

    if (!normalized) {
      setProjectAddError('Enter a project key (e.g., ABC).');
      return;
    }
    if (!isValidProjectKey(normalized)) {
      setProjectAddError(
        'Invalid key. Use letters/numbers/underscore, start with a letter (e.g., ABC, PWS2).'
      );
      return;
    }

    // If it's built-in, just select it.
    if (Array.from(BUILTIN_PROJECTS).includes(normalized as any)) {
      setProject(normalized);
      setProjectAddError(null);
      setNewProjectKey('');
      setShowAddProject(false);
      return;
    }

    setCustomProjects((prev) => {
      const next = uniqStrings([...(prev ?? []), normalized]);
      return next;
    });

    setProject(normalized);
    setProjectAddError(null);
    setNewProjectKey('');
    setShowAddProject(false);
  }

  const { min: sliderMinVelocity, max: sliderMaxVelocity } =
    getVelocitySliderBounds(burnupModel);

  const scopeSliderConfig = useMemo(
    () => computeScopeSliderConfig(burnupModel),
    [burnupModel]
  );

  const displayBurnupModel: BurnupModel | null = useMemo(() => {
    if (!burnupModel) return null;
    if (!scopeSliderConfig.enabled || scopeOverride == null) {
      return burnupModel;
    }
    return buildScopeAdjustedModel(burnupModel, scopeOverride);
  }, [burnupModel, scopeOverride, scopeSliderConfig.enabled]);

  const velocityInsights = useMemo<VelocityInsights | null>(() => {
    if (
      !burnupModel ||
      !burnupModel.projection ||
      !burnupModel.projection.hasSignal
    ) {
      return null;
    }

    const proj: any = burnupModel.projection;
    const sprintsAny = (burnupModel.sprints ?? []) as any[];

    let lastSprintStories: number | null = null;

    if (sprintsAny.length) {
      let lastClosedIndex = -1;
      for (let i = 0; i < sprintsAny.length; i += 1) {
        if (sprintsAny[i]?.isClosed) lastClosedIndex = i;
      }
      if (lastClosedIndex >= 0) {
        const last = sprintsAny[lastClosedIndex] ?? {};
        const prev =
          lastClosedIndex > 0 ? sprintsAny[lastClosedIndex - 1] ?? {} : {};
        const prevDone =
          typeof prev.doneAtEnd === 'number'
            ? prev.doneAtEnd
            : typeof last.doneAtStart === 'number'
            ? last.doneAtStart
            : 0;
        const lastDone =
          typeof last.doneAtEnd === 'number' ? last.doneAtEnd : prevDone;
        const diff = lastDone - prevDone;
        if (Number.isFinite(diff)) {
          lastSprintStories = diff;
        }
      }
    }

    const doneSoFar =
      typeof proj.fromDone === 'number' ? (proj.fromDone as number) : null;
    const totalScope =
      typeof burnupModel.latestScope === 'number'
        ? burnupModel.latestScope
        : null;

    const recentVelocity =
      typeof proj.recentStoriesPerSprint === 'number'
        ? (proj.recentStoriesPerSprint as number)
        : null;

    const neededVelocity =
      typeof proj.requiredStoriesPerSprintToHitTarget === 'number'
        ? (proj.requiredStoriesPerSprintToHitTarget as number)
        : null;

    let finishLabel: string | null = null;
    if (typeof proj.projectedCompletionMs === 'number') {
      const finish = new Date(proj.projectedCompletionMs);
      const finishStr = new Intl.DateTimeFormat('en-AU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).format(finish);

      const deltaMs = proj.projectedCompletionMs - burnupModel.targetDateMs;
      const deltaDays = Math.round(deltaMs / DAY_MS);

      if (Number.isFinite(deltaDays) && deltaDays !== 0) {
        const suffix =
          deltaDays > 0
            ? ` (+${deltaDays} days after target)`
            : ` (${Math.abs(deltaDays)} days before target)`;
        finishLabel = `finish ~${finishStr}${suffix}`;
      } else {
        finishLabel = `finish ~${finishStr} (on target)`;
      }
    }

    return {
      lastSprintStories,
      doneSoFar,
      totalScope,
      recentVelocity,
      neededVelocity,
      finishLabel,
    };
  }, [burnupModel]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const v = window.localStorage.getItem('burnup_last_velocity');
    if (!v) return;
    const parsed = Number(v);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    let n = parsed;
    if (n < 1) n = 1;
    if (n > 200) n = 200;
    setSprintFTE(n);
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('burnup_last_velocity', String(sprintFTE));
    }
  }, [sprintFTE]);

  // Keep end >= start only when we actually have a start date (i.e., user has set it).
  // Default behaviour stays the same, but we don't auto-fill from today's date anymore.
  useEffect(() => {
    if (!sprintStartISO) return;

    const minEnd = addDays(sprintStartISO, 1);
    if (!sprintEndISO || sprintEndISO < minEnd) {
      setSprintEndISO(addDays(sprintStartISO, 13));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sprintStartISO]);

  useEffect(() => {
    setBurnupModel(null);
    setBurnupError(null);
    setBurnupLock(null);
    setScopeOverride(null);

    // IMPORTANT UI change: blank out sprint plan dates until Create Burnup is clicked again.
    setSprintStartISO('');
    setSprintEndISO('');
  }, [project, scope]);

  useEffect(() => {
    if (!burnupModel || !scopeSliderConfig.enabled) {
      setScopeOverride(null);
      return;
    }
    setScopeOverride((prev) =>
      prev == null ? scopeSliderConfig.baselineScope : prev
    );
  }, [burnupModel, scopeSliderConfig.enabled, scopeSliderConfig.baselineScope]);

  useEffect(() => {
    setSprintFTE((current) => {
      let v = current;
      if (v < sliderMinVelocity) v = sliderMinVelocity;
      if (v > sliderMaxVelocity) v = sliderMaxVelocity;
      return v;
    });
  }, [burnupModel, sliderMinVelocity, sliderMaxVelocity]);

  const fmt = (iso?: string) => {
    if (!iso) return '—';
    const parts = String(iso).split('-');
    const y = Number(parts[0]);
    const m = Number(parts[1] ?? '1');
    const d = Number(parts[2] ?? '1');
    if (!Number.isFinite(y) || y < 1000) return iso;

    const dt = new Date(
      Date.UTC(
        y,
        (Number.isFinite(m) ? m : 1) - 1,
        Number.isFinite(d) ? d : 1
      )
    );
    if (Number.isNaN(dt.getTime())) return iso;

    return new Intl.DateTimeFormat('en-AU', {
      timeZone: 'UTC',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(dt);
  };

  const toDateInput = (isoWithTZ: string) => {
    const d = new Date(isoWithTZ);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  /* ---------- API helpers ---------- */

  async function fetchEarliest(startProject: string, startScope: Scope) {
    const res = await fetch('/api/jira/earliest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: startProject, scope: startScope }),
    });
    const data: {
      earliestCreated?: string | null;
      upstream?: { errorMessages?: string[] };
      error?: string;
    } = await res.json();

    if (!res.ok) {
      const msg =
        (Array.isArray(data?.upstream?.errorMessages) &&
          data.upstream!.errorMessages!.join(', ')) ||
        (typeof data?.error === 'string' ? data.error : undefined) ||
        'Failed to fetch earliest';
      throw new Error(msg);
    }
    return data as { earliestCreated: string | null };
  }

  async function fetchAllIssues(
    jql: string,
    pageSize = 200,
    fields?: string[]
  ): Promise<IssueRow[]> {
    let token: string | null = null;
    const out: IssueRow[] = [];
    do {
      const res = await fetch('/api/jira/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jql,
          maxResults: pageSize,
          nextPageToken: token,
          fields: fields ?? [
            'key',
            'summary',
            'issuetype',
            'status',
            'project',
            'created',
            'updated',
            'resolutiondate',
            'flagged',
            'statuscategory',
            'labels',
          ],
        }),
      });
      const data: SearchResponse = await res.json();
      if (!res.ok) {
        const msg =
          (Array.isArray(data?.upstream?.errorMessages) &&
            data.upstream!.errorMessages!.join(', ')) ||
          (typeof data?.error === 'string' ? data.error : undefined) ||
          `Search failed (HTTP ${res.status})`;
        throw new Error(msg);
      }
      out.push(...(data.items ?? []));
      token = data.nextPageToken ?? null;
    } while (token);
    return out;
  }

  async function onClickUpdate() {
    setBusy(true);
    setErr(null);
    try {
      const earliest = await fetchEarliest(project, scope);
      setDevStartISO(
        earliest.earliestCreated ? toDateInput(earliest.earliestCreated) : ''
      );

      const jql = buildJql(project, scope);
      const jqlApp = buildJqlPMApproved(project);
      const jqlNot = buildJqlNotPMApproved(project);

      const jqlStoriesAllStr = buildJqlStoriesAll(project);
      const jqlStoriesDoneStr = buildJqlStoriesDone(project);

      const [all, onlyApproved, onlyNotApproved, storiesAll, storiesDone] =
        await Promise.all([
          fetchAllIssues(jql),
          fetchAllIssues(jqlApp, 400, ['key']),
          fetchAllIssues(jqlNot, 400, ['key']),
          fetchAllIssues(jqlStoriesAllStr, 400, ['key']),
          fetchAllIssues(jqlStoriesDoneStr, 400, ['key']),
        ]);

      setIssues(all);
      setPmApprovedCt(onlyApproved.length);
      setNotPmApprovedCt(onlyNotApproved.length);
      setStoryTotalCt(storiesAll.length);
      setStoryDoneCt(storiesDone.length);

      setUpdateStamp(Date.now());
    } catch (e: any) {
      setErr(e?.message ?? 'Update failed');
      setPmApprovedCt(0);
      setNotPmApprovedCt(0);
      setStoryDoneCt(0);
      setStoryTotalCt(0);
    } finally {
      setBusy(false);
    }
  }

  /* ---------- Burn-up handler ---------- */

  const minSprintEnd = sprintStartISO ? addDays(sprintStartISO, 1) : '';

  function onClickCreateBurnup() {
    if (scope !== 'Story') {
      setBurnupError(
        'Burn-up currently uses Story issues. Switch scope to Story and click Update, then try again.'
      );
      setBurnupModel(null);
      return;
    }

    if (!devCompletionISO) {
      setBurnupError('Set Dev Completion (target) above before creating burn-up.');
      setBurnupModel(null);
      return;
    }

    if (!issues.length) {
      setBurnupError('No issues loaded. Click Update first.');
      setBurnupModel(null);
      return;
    }

    // If there is scope but no Done stories yet, do not create a burn-up
    if (storyTotalCt > 0 && storyDoneCt === 0) {
      setBurnupError(
        `No burn up to show as no Story Done yet. Current scope is = ${storyTotalCt}.`
      );
      setBurnupModel(null);
      setBurnupLock(null);
      return;
    }

    setBurnupError(null);

    const stories = issues.map((it) => ({
      key: it.key,
      created: it.created,
      resolutiondate: it.resolutiondate ?? null,
      statusCategory: it.statusCategory ?? 'To Do',
      status: it.status ?? 'Unknown',
    })) as BurnupIssue[];

    const baseModel = buildBurnupModel({
      stories,
      sprintStartISO: sprintStartISO || todayISO(), // only used when no Done yet; safe fallback
      devCompletionISO,
      sprintFTE: 1,
    });

    // Set Sprint Plan dates to the CURRENT sprint window derived from model.originMs.
    // Keep date-only in UTC to match buildBurnupModel's epoch-day maths.
    if (
      Number.isFinite(baseModel.originMs) &&
      Number.isFinite(baseModel.todayMs) &&
      baseModel.sprintLengthDays > 0
    ) {
      const sprintLenMs = baseModel.sprintLengthDays * DAY_MS;

      const deltaMs = baseModel.todayMs - baseModel.originMs;
      const idx = Math.max(0, Math.floor(deltaMs / sprintLenMs));

      const currentStartMs = baseModel.originMs + idx * sprintLenMs;
      const currentEndInclusiveMs =
        currentStartMs + (baseModel.sprintLengthDays - 1) * DAY_MS;

      setSprintStartISO(msToISO_UTC(currentStartMs));
      setSprintEndISO(msToISO_UTC(currentEndInclusiveMs));
    }

    const proj: any = baseModel.projection;

    if (
      proj &&
      proj.hasSignal &&
      proj.avgVelPerFTE != null &&
      proj.avgVelPerFTE > 0
    ) {
      const required: number | undefined =
        typeof proj.requiredStoriesPerSprintToHitTarget === 'number'
          ? proj.requiredStoriesPerSprintToHitTarget
          : undefined;
      const recent: number | undefined =
        typeof proj.recentStoriesPerSprint === 'number'
          ? proj.recentStoriesPerSprint
          : undefined;

      let baselineVelocity = sprintFTE;

      if (required != null && required > 0) {
        baselineVelocity = required;
      } else if (recent != null && recent > 0) {
        baselineVelocity = recent;
      }

      setSprintFTE(baselineVelocity);

      const fteForBaseline = baselineVelocity / proj.avgVelPerFTE;
      const adjustedModel = recomputeProjectionWithFTE(baseModel, fteForBaseline);

      setBurnupModel(adjustedModel);
    } else {
      setBurnupModel(baseModel);
    }

    setBurnupLock({ project, scope });
    // eslint-disable-next-line no-console
    console.log('Burn-up model', baseModel);
  }

  function onChangeFTE(next: number) {
    let v = next;
    if (v < sliderMinVelocity) v = sliderMinVelocity;
    if (v > sliderMaxVelocity) v = sliderMaxVelocity;

    setSprintFTE(v);

    setBurnupModel((prev) => {
      if (
        !prev ||
        !prev.projection ||
        !prev.projection.hasSignal ||
        (prev.projection as any).avgVelPerFTE == null ||
        (prev.projection as any).avgVelPerFTE <= 0
      ) {
        return prev;
      }

      const avgVelPerFTE = (prev.projection as any).avgVelPerFTE as number;
      const fteForVelocity = v / avgVelPerFTE;

      return recomputeProjectionWithFTE(prev, fteForVelocity);
    });
  }

  /* ---------- JQL strings for KPIs ---------- */

  const jqlBase = buildJql(project, scope);
  const jqlPMApp = buildJqlPMApproved(project);
  const jqlNotPMApp = buildJqlNotPMApproved(project);

  /* ---------- toggle helpers ---------- */

  const isBurnup = viewMode === 'burnup';

  const trackStyle: CSSProperties = {
    width: 46,
    height: 24,
    borderRadius: 999,
    backgroundColor: isBurnup ? '#22c55e' : '#d1d5db',
    position: 'relative',
    cursor: 'pointer',
    transition: 'background-color 150ms ease',
  };

  const thumbStyle: CSSProperties = {
    width: 20,
    height: 20,
    borderRadius: 999,
    backgroundColor: '#ffffff',
    position: 'absolute',
    top: 2,
    left: isBurnup ? 24 : 2,
    boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
    transition: 'left 150ms ease',
  };

  const burnupAlreadyCreated =
    !!burnupLock && burnupLock.project === project && burnupLock.scope === scope;

  // true only for the “no Story Done yet” scenario
  const noBurnupAvailable =
    burnupError?.startsWith('No burn up to show as no Story Done yet') ?? false;

  const burnupDisabledForProject = burnupAlreadyCreated;

  const sprintDatesLocked = burnupDisabledForProject || noBurnupAvailable;

  // IMPORTANT UI change: until burnup is created, keep sprint date fields blank+disabled.
  const sprintDatesReady = !!burnupModel && !noBurnupAvailable;

  const scopeSliderValue =
    scopeOverride ??
    (scopeSliderConfig.enabled ? scopeSliderConfig.baselineScope : 0);

  const sprintFieldLabel: CSSProperties = {
    fontSize: 12,
    color: '#4b5563',
  };

  const leftCardStyle: CSSProperties = {
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#F9FAFB',
    border: '1px solid #E5E7EB',
  };

  const burnupButtonDisabled = burnupAlreadyCreated || noBurnupAvailable;

  const burnupButtonLabel = noBurnupAvailable
    ? 'Burn-up unavailable'
    : burnupAlreadyCreated
    ? 'Burn-up created'
    : 'Create Burnup';

  return (
    <main
      style={{
        display: 'grid',
        gap: 24,
        gridTemplateRows: 'auto auto 1fr',
        paddingBottom: 24,
      }}
    >
      {/* Header + mode toggle */}
      <section
        style={{
          padding: 12,
          border: '1px solid #eee',
          borderRadius: 12,
          boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        <div
          style={{
            fontSize: 22,
            fontWeight: 700,
          }}
        >
          Distribute Power Project Dashboard
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
          }}
        >
          <span
            style={{
              color: isBurnup ? '#111827' : '#6b7280',
              fontWeight: isBurnup ? 600 : 400,
            }}
          >
            Burn-up
          </span>
          <div
            style={trackStyle}
            onClick={() => setViewMode((m) => (m === 'burnup' ? 'jira' : 'burnup'))}
          >
            <div style={thumbStyle} />
          </div>
          <span
            style={{
              color: !isBurnup ? '#111827' : '#6b7280',
              fontWeight: !isBurnup ? 600 : 400,
            }}
          >
            Jira ticket
          </span>
        </div>
      </section>

      {viewMode === 'burnup' ? (
        <>
          {/* Control Bar */}
          <section
            style={{
              padding: 12,
              border: '1px solid #eee',
              borderRadius: 12,
              boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
            }}
          >
            <div
              style={{
                display: 'grid',
                gridAutoColumns: 'max-content',
                gridAutoFlow: 'column',
                alignItems: 'center',
                gap: 12,
                overflowX: 'auto',
                paddingBottom: 4,
                whiteSpace: 'nowrap',
              }}
            >
              <Label>Project</Label>
              <select
                value={project}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === ADD_PROJECT_SENTINEL) {
                    setShowAddProject(true);
                    setProjectAddError(null);
                    return;
                  }
                  setProject(v);
                }}
                style={dd(170)}
              >
                {allProjects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
                <option value={ADD_PROJECT_SENTINEL}>+ Add project…</option>
              </select>

              {showAddProject && (
                <>
                  <Label>Add</Label>
                  <input
                    value={newProjectKey}
                    onChange={(e) => {
                      setNewProjectKey(e.target.value);
                      setProjectAddError(null);
                    }}
                    placeholder="e.g. ABC"
                    style={dd(120)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitAddProject();
                      if (e.key === 'Escape') {
                        setShowAddProject(false);
                        setNewProjectKey('');
                        setProjectAddError(null);
                      }
                    }}
                  />
                  <button
                    type="button"
                    style={btn()}
                    onClick={commitAddProject}
                    title="Add this Jira project key to the dropdown (saved locally)"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    style={{
                      ...btn(),
                      background: '#6b7280',
                    }}
                    onClick={() => {
                      setShowAddProject(false);
                      setNewProjectKey('');
                      setProjectAddError(null);
                    }}
                    title="Cancel adding a project"
                  >
                    Cancel
                  </button>
                </>
              )}

              <Label>Scope</Label>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as Scope)}
                style={dd(170)}
              >
                <option value="Requirement">Requirement</option>
                <option value="Story">Story</option>
              </select>

              <Label>Dev Completion (target)</Label>
              <input
                type="date"
                value={devCompletionISO}
                onChange={(e) => setDevCompletionISO(e.target.value)}
                min={devStartISO || undefined}
                style={inp()}
                title="This date drives Project Health schedule/pace."
              />

              <button
                onClick={onClickUpdate}
                disabled={busy}
                style={btn()}
                title="Load KPIs for current selections"
              >
                {busy ? 'Updating…' : 'Update'}
              </button>
            </div>

            {showAddProject && projectAddError && (
              <div style={{ marginTop: 10, color: '#b91c1c', fontSize: 13 }}>
                {projectAddError}
              </div>
            )}

            {err && (
              <div style={{ marginTop: 12, color: '#b91c1c', fontSize: 13 }}>
                {err}
              </div>
            )}
          </section>

          {/* KPI row */}
          <KpiRow
            scope={scope}
            issues={issues}
            pmApprovedCt={pmApprovedCt}
            notPmApprovedCt={notPmApprovedCt}
            storyDoneCt={storyDoneCt}
            storyTotalCt={storyTotalCt}
            devStartISO={devStartISO}
            devCompletionISO={devCompletionISO}
            jqlBase={jqlBase}
            jqlPMApproved={jqlPMApp}
            jqlNotPMApproved={jqlNotPMApp}
          />

          {/* Burn-up (Sprint parameters + Chart in two-column layout) */}
          <section
            style={{
              padding: 12,
              border: '1px solid #eee',
              borderRadius: 12,
              boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
              Burn-up
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(260px, 320px) 1fr',
                gap: 16,
                alignItems: 'stretch',
              }}
            >
              {/* Left column: Sprint plan + Velocity snapshot cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {/* Sprint plan card */}
                <div style={leftCardStyle}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                    Sprint plan
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(90px, 120px) 1fr',
                      columnGap: 8,
                      rowGap: 8,
                      alignItems: 'center',
                    }}
                  >
                    <div style={sprintFieldLabel}>Sprint start</div>
                    <input
                      type="date"
                      value={sprintDatesReady ? sprintStartISO : ''}
                      onChange={(e) => setSprintStartISO(e.target.value)}
                      style={{
                        ...inp(),
                        width: '90%',
                        backgroundColor:
                          sprintDatesLocked || !sprintDatesReady ? '#e5e7eb' : 'white',
                      }}
                      title={
                        sprintDatesReady
                          ? 'Start date of the current sprint (derived).'
                          : 'Calculated when you click Create Burnup.'
                      }
                      disabled={sprintDatesLocked || !sprintDatesReady}
                    />

                    <div style={sprintFieldLabel}>Sprint end</div>
                    <input
                      type="date"
                      value={sprintDatesReady ? sprintEndISO : ''}
                      onChange={(e) => setSprintEndISO(e.target.value)}
                      min={sprintDatesReady && minSprintEnd ? minSprintEnd : undefined}
                      style={{
                        ...inp(),
                        width: '90%',
                        backgroundColor:
                          sprintDatesLocked || !sprintDatesReady ? '#e5e7eb' : 'white',
                      }}
                      title={
                        sprintDatesReady
                          ? 'End date of the current sprint (derived).'
                          : 'Calculated when you click Create Burnup.'
                      }
                      disabled={sprintDatesLocked || !sprintDatesReady}
                    />

                    <div style={sprintFieldLabel}>Velocity (stories / sprint)</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <input
                        type="range"
                        min={sliderMinVelocity}
                        max={sliderMaxVelocity}
                        step={0.1}
                        value={sprintFTE}
                        onChange={(e) => onChangeFTE(Number(e.target.value))}
                        style={{
                          flex: 1,
                          opacity: noBurnupAvailable ? 0.4 : 1,
                        }}
                        title="Average stories completed per sprint from this point"
                        disabled={noBurnupAvailable}
                      />
                      <span
                        style={{
                          minWidth: 30,
                          marginRight: 8,
                          textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums',
                          color: noBurnupAvailable ? '#9ca3af' : '#111827',
                        }}
                      >
                        {sprintFTE.toFixed(1)}
                      </span>
                    </div>

                    {burnupModel && scopeSliderConfig.enabled && (
                      <>
                        <div style={sprintFieldLabel}>Scope (next sprint)</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <input
                            type="range"
                            min={scopeSliderConfig.min}
                            max={scopeSliderConfig.max}
                            step={1}
                            value={scopeSliderValue}
                            onChange={(e) => setScopeOverride(Number(e.target.value))}
                            style={{ flex: 1 }}
                            title="Adjust total scope for the next sprint; later sprints stay flat at this value."
                          />
                          <span
                            style={{
                              minWidth: 28,
                              marginRight: 8,
                              textAlign: 'right',
                              fontVariantNumeric: 'tabular-nums',
                              color: '#111827',
                            }}
                          >
                            {scopeSliderValue.toFixed(0)}
                          </span>
                        </div>
                      </>
                    )}

                    {/* Button row spans both columns */}
                    <div />
                    <div>
                      <button
                        type="button"
                        onClick={onClickCreateBurnup}
                        style={{
                          ...btn(),
                          backgroundColor: burnupButtonDisabled ? '#9ca3af' : '#2563EB',
                          cursor: burnupButtonDisabled ? 'not-allowed' : 'pointer',
                        }}
                        title="Generate the burn-up projection using these parameters"
                        disabled={burnupButtonDisabled}
                      >
                        {burnupButtonLabel}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Velocity snapshot card */}
                <div style={leftCardStyle}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                    Velocity snapshot
                  </div>
                  {noBurnupAvailable ? (
                    <div style={{ fontSize: 12, color: '#9ca3af' }}>
                      No burn up to show as no Story Done yet. Current scope is = {storyTotalCt}.
                    </div>
                  ) : burnupModel && velocityInsights ? (
                    <div style={{ fontSize: 12, color: '#374151', display: 'grid', rowGap: 4 }}>
                      <div>
                        <strong>Last sprint (closed): </strong>
                        {velocityInsights.lastSprintStories != null
                          ? `${velocityInsights.lastSprintStories} stories`
                          : 'n/a'}
                      </div>
                      <div>
                        <strong>Done so far: </strong>
                        {velocityInsights.doneSoFar != null && velocityInsights.totalScope != null
                          ? `${velocityInsights.doneSoFar} of ${velocityInsights.totalScope} stories`
                          : 'n/a'}
                      </div>
                      <div>
                        <strong>Recent average: </strong>
                        {velocityInsights.recentVelocity != null
                          ? `${velocityInsights.recentVelocity.toFixed(1)} stories / sprint`
                          : 'n/a'}
                      </div>
                      <div>
                        <strong>Needed to hit {fmt(devCompletionISO)}: </strong>
                        {velocityInsights.neededVelocity != null
                          ? `${velocityInsights.neededVelocity.toFixed(1)} stories / sprint`
                          : 'n/a'}
                      </div>
                      <div>
                        <strong>At current setting ({sprintFTE.toFixed(1)}): </strong>
                        {velocityInsights.finishLabel ?? 'n/a'}
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: '#9ca3af' }}>
                      Run <strong>Update</strong> and then <strong>Create Burnup</strong> to see recent velocity.
                    </div>
                  )}
                </div>
              </div>

              {/* Right column: errors + chart */}
              <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                {burnupError && (
                  <div style={{ color: '#b91c1c', fontSize: 13, marginBottom: 8 }}>
                    {burnupError}
                  </div>
                )}

                {displayBurnupModel && (
                  <div style={{ width: '100%', height: 340, overflow: 'hidden' }}>
                    <BurnupChart model={displayBurnupModel} />
                  </div>
                )}
              </div>
            </div>
          </section>
        </>
      ) : (
        // Jira ticket route
        <section
          style={{
            padding: 12,
            border: '1px solid #eee',
            borderRadius: 12,
            boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
          }}
        >
          <JiraTicket />
        </section>
      )}
    </main>
  );
}
