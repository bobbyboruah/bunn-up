// types/index.ts
// Central shared types for the burn-up app.

/**
 * Scope of the burn-up / health view:
 *  - 'Requirement' = higher-level requirement / epic
 *  - 'Story'       = delivery / story level
 */
export type Scope = 'Requirement' | 'Story';

/**
 * Project keys we support in the UI dropdown.
 * (Matches the values you map over in page.tsx.)
 */
export type ProjectKey = 'SO' | 'PPP' | 'PWS' | 'PORE' | 'PWPU';

/**
 * Minimal shape of a Jira Issue row as used in:
 *  - KpiRow.tsx
 *  - projectHealth.ts
 *
 * You can safely add more fields later if needed, but
 * these cover everything the current code reads.
 */
export type IssueRow = {
  key: string;
  summary: string;

  status: string | null;
  statusCategory?: 'To Do' | 'In Progress' | 'Done' | string | null;

  created: string;        // ISO datetime string
  updated: string;        // ISO datetime string
  resolutiondate?: string | null;

  labels?: string[] | null;
  flagged?: boolean | null;

  // allow extra fields from Jira without type errors
  [extra: string]: unknown;
};
