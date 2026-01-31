// app/JiraTicket.tsx
'use client';

import React, { useState } from 'react';
import type { CSSProperties } from 'react';
import type { IssueRow } from '../types';

/* ------------------ API types ------------------ */

type SearchResponse = {
  items?: IssueRow[];
  nextPageToken?: string | null;
  upstream?: { errorMessages?: string[]; [k: string]: unknown };
  error?: string;
};

/* ------------------ small style helpers ------------------ */

const baseInput: CSSProperties = {
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  fontSize: 13,
  backgroundColor: 'white',
};

const inp = (w = 200): CSSProperties => ({
  ...baseInput,
  width: w,
});

const btn: CSSProperties = {
  padding: '6px 12px',
  borderRadius: 999,
  border: 'none',
  background: '#2563EB',
  fontSize: 13,
  color: 'white',
  cursor: 'pointer',
};

const card: CSSProperties = {
  border: '1px solid #e5e7eb',
  borderRadius: 10,
  padding: 10,
  backgroundColor: '#ffffff',
};

/* ------------------ generic helpers ------------------ */

function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso ?? '—';
  return new Intl.DateTimeFormat('en-AU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
}

function diffInDays(fromISO?: string | null, toISO?: string | null): number | null {
  if (!fromISO || !toISO) return null;
  const a = new Date(fromISO);
  const b = new Date(toISO);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const ms = b.getTime() - a.getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function getIssueTypeName(issue: IssueRow | null): string {
  if (!issue) return '';
  const t: any = (issue as any).issuetype;
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (typeof t.name === 'string') return t.name;
  return '';
}

function getStatusName(issue: IssueRow | null): string {
  if (!issue) return '';
  const s: any = (issue as any).status;
  if (!s) return '';
  if (typeof s === 'string') return s;
  if (typeof s.name === 'string') return s.name;
  return '';
}

function getProjectKey(issue: IssueRow | null): string {
  if (!issue) return '';
  const p: any = (issue as any).project;
  if (!p) return '';
  if (typeof p === 'string') return p;
  if (typeof p.key === 'string') return p.key;
  return '';
}

/** Flatten Jira ADF / rich text or plain string into text */
function flattenJiraRichText(raw: any): string {
  if (!raw) return '';
  if (typeof raw === 'string') return raw.trim();

  const acc: string[] = [];

  const walk = (node: any): void => {
    if (!node) return;

    if (typeof node === 'string') {
      acc.push(node);
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (typeof node.text === 'string') {
      acc.push(node.text);
    }

    if (Array.isArray(node.content)) {
      node.content.forEach(walk);
    }
  };

  walk(raw);
  const joined = acc.join(' ');
  return joined.replace(/\s+/g, ' ').trim();
}

/** Flatten Jira description (string or Atlassian ADF JSON) into plain text */
function extractPlainDescription(issue: IssueRow | null): string {
  if (!issue) return '';
  const raw: any = (issue as any).description;
  if (!raw) return '';
  return flattenJiraRichText(raw);
}

function isDone(issue: IssueRow): boolean {
  const cat = (issue.statusCategory ?? '') as string;
  return cat.toLowerCase() === 'done';
}

function isInProgress(issue: IssueRow): boolean {
  const cat = (issue.statusCategory ?? '') as string;
  return cat.toLowerCase() === 'in progress';
}

function isTodo(issue: IssueRow): boolean {
  const cat = (issue.statusCategory ?? '') as string;
  return cat.toLowerCase() === 'to do';
}

/* ------------------ Jira search helper ------------------ */

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
          'description',
          'issuetype',
          'status',
          'project',
          'created',
          'updated',
          'resolutiondate',
          'flagged',
          'statuscategory',
          'labels',
          'parent',
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

/* ------------------ derived "AI-ish" health summary ------------------ */

function buildHealthSummary(main: IssueRow | null, children: IssueRow[]): string {
  if (!main) return 'No issue loaded yet.';

  const typeName = getIssueTypeName(main);
  const statusName = getStatusName(main);
  const hasChildren = children.length > 0;

  const done = children.filter(isDone).length;
  const total = children.length;
  const donePct = total > 0 ? Math.round((done / total) * 100) : 0;

  if (!hasChildren) {
    const lead = main.resolutiondate
      ? diffInDays(main.created, main.resolutiondate)
      : diffInDays(main.created, new Date().toISOString());
    if (lead != null && lead >= 0) {
      return `${typeName || 'Issue'} is ${statusName || 'Unknown'} and has been open for ~${lead} day(s).`;
    }
    return `${typeName || 'Issue'} is ${statusName || 'Unknown'} with no linked child work items.`;
  }

  if (donePct >= 80 && (statusName || '').toLowerCase() === 'done') {
    return `${typeName || 'Issue'} looks healthy: ${done}/${total} child items (~${donePct}%) are done.`;
  }

  if (donePct >= 50) {
    return `${typeName || 'Issue'} is partially complete: ${done}/${total} child items (~${donePct}%) are done.`;
  }

  if (total > 0 && done === 0) {
    return `${typeName || 'Issue'} has ${total} child items, but none are done yet.`;
  }

  return `${typeName || 'Issue'} has ${done}/${total} child items done (~${donePct}%).`;
}

/* ------------------ problem-style summary ------------------ */

function normaliseProblemText(text: string): string {
  let out = text.trim();

  // Drop headings before colon (e.g. "Change Request:", "Scope of Changes:")
  const headingMarkers = [
    'Change Request:',
    'Change request:',
    'Scope of Changes:',
    'Scope of changes:',
    'Current Implementation:',
    'Current implementation:',
    'Problem:',
    'Goal:',
  ];
  for (const marker of headingMarkers) {
    const idx = out.indexOf(marker);
    if (idx >= 0) {
      out = out.slice(idx + marker.length).trim();
      break;
    }
  }

  // Small language cleanups
  out = out.replace(/^This is an enhancement to/i, 'Enhances');
  out = out.replace(/^This is enhancement to/i, 'Enhances');
  out = out.replace(/^This change/i, 'The change');
  out = out.replace(/^Change request/i, 'The change');

  return out.trim();
}

/** Take description/summary and compress into 1–2 sentences of "what this is solving" */
function summariseProblem(description: string, summary: string): string {
  let base = description || summary;
  if (!base) return 'No clear problem description has been provided yet.';

  base = normaliseProblemText(base);
  // Remove extra whitespace
  base = base.replace(/\s+/g, ' ');

  // Take first 2 sentences max
  const sentences = base.split(/(?<=[.!?])\s+/);
  const snippet = sentences.slice(0, 2).join(' ').trim();

  // Guard against over-long blobs
  if (snippet.length > 260) {
    return snippet.slice(0, 257) + '…';
  }

  return snippet || summary || 'No clear problem description has been provided yet.';
}

/* ------------------ comments helper ------------------ */

type SimpleComment = {
  author: string;
  date: string;
  text: string;
};

function getLatestComments(main: IssueRow | null, max = 3): SimpleComment[] {
  if (!main) return [];

  const anyIssue: any = main as any;
  const rawComment = anyIssue.comment;

  let commentsArray: any[] = [];
  if (Array.isArray(rawComment)) {
    commentsArray = rawComment;
  } else if (rawComment && Array.isArray(rawComment.comments)) {
    commentsArray = rawComment.comments;
  }

  if (!commentsArray.length) return [];

  const mapped = commentsArray
    .map((c) => {
      const author =
        (c?.author?.displayName as string) ||
        (c?.author?.name as string) ||
        'Unknown';

      const updated = (c?.updated as string) || (c?.created as string) || null;
      const text = flattenJiraRichText(c?.body ?? c?.bodyText ?? '');
      if (!text) return null;

      return {
        author,
        dateRaw: updated,
        date: updated ? fmtDate(updated) : '—',
        text,
      };
    })
    .filter(
      (x): x is { author: string; dateRaw: string | null; date: string; text: string } =>
        !!x
    );

  mapped.sort((a, b) => {
    const da = a.dateRaw ? new Date(a.dateRaw).getTime() : 0;
    const db = b.dateRaw ? new Date(b.dateRaw).getTime() : 0;
    return db - da;
  });

  return mapped.slice(0, max).map(({ author, date, text }) => ({ author, date, text }));
}

/* ------------------ plain-English "user guide" summary ------------------ */

function buildUserGuide(main: IssueRow | null, children: IssueRow[]): string {
  if (!main) return '';

  const key = main.key;
  const project = getProjectKey(main);
  const typeName = getIssueTypeName(main) || 'Issue';
  const statusName = getStatusName(main) || 'Unknown';
  const summary = ((main as any).summary as string) || '';
  const description = extractPlainDescription(main);
  const totalChildren = children.length;

  const created = fmtDate(main.created);
  const resolved = main.resolutiondate ? fmtDate(main.resolutiondate) : null;

  const lines: string[] = [];

  // 1. Core problem / goal (1–2 sentences)
  const problemSentence = summariseProblem(description, summary);
  lines.push(
    `In simple terms, Jira ${key} (${typeName.toLowerCase()}) is trying to solve the following problem:\n\n${problemSentence}`
  );

  // 2. Status + where it stands
  lines.push(`Right now this item is ${statusName.toLowerCase()} in project ${project || '—'}.`);

  // 3. How the work is broken down (children)
  if (totalChildren > 0) {
    const doneCount = children.filter(isDone).length;
    const inProgressCount = children.filter(isInProgress).length;
    const todoCount = children.filter(isTodo).length;

    lines.push(
      `To deliver this outcome, the work is split across ${totalChildren} related Jira item${
        totalChildren === 1 ? '' : 's'
      } (stories, tasks or subtasks). Of these, ${doneCount} are done, ${inProgressCount} are in progress and ${todoCount} are still to do.`
    );

    const childBullets = children.map((c) => {
      const cType = getIssueTypeName(c) || 'Issue';
      const cStatus = getStatusName(c) || 'Unknown';
      const cSummary = ((c as any).summary as string) || '';
      const cDesc = extractPlainDescription(c);
      const childProblem = summariseProblem(cDesc, cSummary);
      return `• ${c.key} – ${childProblem} (${cType}, ${cStatus})`;
    });

    if (childBullets.length > 0) {
      lines.push(`You can think of the main pieces of work as:\n${childBullets.join('\n')}`);
    }
  } else {
    lines.push(
      `At the moment there are no linked stories or tasks recorded for this item, so all of the work may still be captured in the main description.`
    );
  }

  // 4. Timing context
  const leadTimeDays =
    main.resolutiondate != null ? diffInDays(main.created, main.resolutiondate) : null;
  const openDays =
    main.resolutiondate == null ? diffInDays(main.created, new Date().toISOString()) : null;

  if (resolved && leadTimeDays != null) {
    lines.push(
      `It was created on ${created} and resolved on ${resolved}, taking about ${leadTimeDays} day${
        leadTimeDays === 1 ? '' : 's'
      } from creation to completion.`
    );
  } else if (openDays != null) {
    lines.push(
      `It was created on ${created} and has been open for roughly ${openDays} day${
        openDays === 1 ? '' : 's'
      } so far.`
    );
  } else if (created !== '—') {
    lines.push(`It was created on ${created}.`);
  }

  return lines.join('\n\n');
}

/* ------------------ main component ------------------ */

export default function JiraTicket() {
  const [jiraKey, setJiraKey] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mainIssue, setMainIssue] = useState<IssueRow | null>(null);
  const [children, setChildren] = useState<IssueRow[]>([]);

  async function onLoad() {
    const rawKey = jiraKey.trim();
    if (!rawKey) {
      setError('Enter a Jira key (e.g. PPP-15).');
      setMainIssue(null);
      setChildren([]);
      return;
    }

    const key = rawKey.toUpperCase();

    setLoading(true);
    setError(null);

    try {
      // 1. Load the main issue by key, including comments
      const mainList = await fetchAllIssues(`issuekey = ${key}`, 1, [
        'key',
        'summary',
        'description',
        'issuetype',
        'status',
        'project',
        'created',
        'updated',
        'resolutiondate',
        'flagged',
        'statuscategory',
        'labels',
        'parent',
        'comment',
      ]);

      if (!mainList.length) {
        setMainIssue(null);
        setChildren([]);
        setError(`No Jira issue found for key "${key}".`);
        return;
      }

      const issue = mainList[0]!;
      setMainIssue(issue);

      // 2. Load children: stories linked by Epic Link + direct subtasks (parent)
      const childJql = `"Epic Link" = ${key} OR parent = ${key}`;
      let childList: IssueRow[] = [];
      try {
        childList = await fetchAllIssues(childJql, 200);
      } catch {
        // If it fails, we still show the main issue
        childList = [];
      }

      // Remove self if ever included
      const filteredChildren = childList.filter((c) => c.key !== issue.key);
      setChildren(filteredChildren);
    } catch (e: any) {
      const msg = e?.message ?? 'Failed to load Jira issue.';
      setError(msg);
      setMainIssue(null);
      setChildren([]);
    } finally {
      setLoading(false);
    }
  }

  const typeName = getIssueTypeName(mainIssue);
  const statusName = getStatusName(mainIssue);
  const projectKey = getProjectKey(mainIssue);

  const leadTimeDays =
    mainIssue?.resolutiondate != null
      ? diffInDays(mainIssue.created, mainIssue.resolutiondate)
      : null;
  const openDays =
    mainIssue && mainIssue.resolutiondate == null
      ? diffInDays(mainIssue.created, new Date().toISOString())
      : null;

  const doneCount = children.filter(isDone).length;
  const inProgressCount = children.filter(isInProgress).length;
  const todoCount = children.filter(isTodo).length;
  const totalChildren = children.length;

  const healthSummary = buildHealthSummary(mainIssue, children);
  const userGuide = buildUserGuide(mainIssue, children);
  const latestComments = getLatestComments(mainIssue, 3);

  return (
    <section
      style={{
        padding: 12,
        border: '1px solid #eee',
        borderRadius: 12,
        boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
        display: 'grid',
        gap: 16,
      }}
    >
      {/* Controls */}
      <div
        style={{
          display: 'grid',
          gridAutoFlow: 'column',
          gridAutoColumns: 'max-content',
          alignItems: 'center',
          gap: 12,
          overflowX: 'auto',
          paddingBottom: 4,
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ fontSize: 18, fontWeight: 600, marginRight: 16 }}>
          Jira ticket
        </span>

        <span style={{ color: '#4b5563', fontSize: 13 }}>Key</span>
        <input
          type="text"
          value={jiraKey}
          onChange={(e) => setJiraKey(e.target.value)}
          placeholder="e.g. PPP-15"
          style={inp(160)}
        />

        <button
          type="button"
          onClick={onLoad}
          disabled={loading}
          style={btn}
          title="Load this Jira issue"
        >
          {loading ? 'Loading…' : 'Load'}
        </button>
      </div>

      {error && <div style={{ color: '#b91c1c', fontSize: 13 }}>{error}</div>}

      {!mainIssue && !error && (
        <div style={{ color: '#6b7280', fontSize: 13 }}>
          Enter a Jira key above and click <b>Load</b> to see details and related issues.
        </div>
      )}

      {/* Main issue summary */}
      {mainIssue && (
        <div style={{ ...card, display: 'grid', gap: 6 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            {mainIssue.key}{' '}
            <span style={{ fontWeight: 400 }}>
              · {typeName || 'Issue'} · {statusName || 'Status unknown'}
            </span>
          </div>
          <div style={{ fontSize: 13, color: '#374151' }}>
            {(mainIssue as any).summary || 'No summary'}
          </div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            Project: <b>{projectKey || '—'}</b> · Created:{' '}
            <b>{fmtDate(mainIssue.created)}</b>{' '}
            {mainIssue.resolutiondate && (
              <>
                · Resolved: <b>{fmtDate(mainIssue.resolutiondate)}</b>
              </>
            )}
          </div>
          <div style={{ fontSize: 12, color: '#4b5563', marginTop: 4 }}>
            {healthSummary}
          </div>
        </div>
      )}

      {/* KPI cards */}
      {mainIssue && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 12,
          }}
        >
          {/* Status & type */}
          <div style={card}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>Status</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>
              {statusName || 'Unknown'}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
              {typeName || 'Issue'}
            </div>
          </div>

          {/* Timing */}
          <div style={card}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>Timing</div>
            {mainIssue.resolutiondate && leadTimeDays != null ? (
              <>
                <div style={{ fontSize: 16, fontWeight: 600 }}>
                  {leadTimeDays} day{leadTimeDays === 1 ? '' : 's'}
                </div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                  Lead time (created → resolved)
                </div>
              </>
            ) : openDays != null ? (
              <>
                <div style={{ fontSize: 16, fontWeight: 600 }}>
                  {openDays} day{openDays === 1 ? '' : 's'}
                </div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                  Time since created (still open)
                </div>
              </>
            ) : (
              <div style={{ fontSize: 13, color: '#6b7280' }}>
                Timing not available.
              </div>
            )}
          </div>

          {/* Children / progress */}
          <div style={card}>
            <div style={{ fontSize: 12, color: '#6b7280' }}>Linked work items</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>
              {totalChildren} {totalChildren === 1 ? 'item' : 'items'}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
              Done: <b>{doneCount}</b> · In progress: <b>{inProgressCount}</b> · To do:{' '}
              <b>{todoCount}</b>
            </div>
          </div>
        </div>
      )}

      {/* Related issues list */}
      {mainIssue && (
        <div style={{ ...card, marginTop: 4 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            Related issues
          </div>
          {children.length === 0 ? (
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              No linked stories, tasks or subtasks found via{' '}
              <code>"Epic Link" = {mainIssue.key}</code> or{' '}
              <code>parent = {mainIssue.key}</code>.
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {children.map((child) => {
                const childType = getIssueTypeName(child);
                const childStatus = getStatusName(child);

                const isSubtask =
                  childType.toLowerCase().includes('sub-task') ||
                  childType.toLowerCase().includes('subtask');

                return (
                  <li
                    key={child.key}
                    style={{
                      marginBottom: 6,
                      paddingLeft: isSubtask ? 20 : 0,
                    }}
                  >
                    <div style={{ fontSize: 13 }}>
                      <span style={{ fontWeight: 600 }}>{child.key}</span>{' '}
                      · {childType || 'Issue'} ·{' '}
                      <span style={{ color: '#374151' }}>
                        {childStatus || 'Unknown'}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: '#6b7280',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {(child as any).summary || 'No summary'}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Latest comments */}
      {mainIssue && latestComments.length > 0 && (
        <div style={{ ...card, marginTop: 4 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            Latest comments
          </div>
          {latestComments.map((c, idx) => (
            <div key={idx} style={{ marginBottom: idx === latestComments.length - 1 ? 0 : 8 }}>
              <div style={{ fontSize: 12, color: '#374151', marginBottom: 2 }}>
                <b>{c.author}</b>{' '}
                <span style={{ color: '#6b7280' }}>· {c.date}</span>
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: '#111827',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {c.text}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* User guide auto-draft */}
      {mainIssue && userGuide && (
        <div style={{ ...card, marginTop: 4 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            User guide (auto-draft)
          </div>
          <div
            style={{
              fontSize: 12,
              color: '#111827',
              whiteSpace: 'pre-line',
            }}
          >
            {userGuide}
          </div>
        </div>
      )}
    </section>
  );
}
