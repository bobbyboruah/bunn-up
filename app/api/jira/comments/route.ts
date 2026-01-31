// app/api/jira/comments/route.ts
import { NextRequest, NextResponse } from 'next/server';

const JIRA_BASE = process.env.JIRA_BASE;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

function getAuthHeader() {
  if (!JIRA_EMAIL || !JIRA_API_TOKEN) return null;
  const token = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
  return `Basic ${token}`;
}

export async function POST(req: NextRequest) {
  if (!JIRA_BASE) {
    return NextResponse.json(
      { error: 'JIRA_BASE environment variable is not set' },
      { status: 500 }
    );
  }

  const authHeader = getAuthHeader();
  if (!authHeader) {
    return NextResponse.json(
      { error: 'JIRA_EMAIL or JIRA_API_TOKEN environment variable is not set' },
      { status: 500 }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const key = body?.key as string | undefined;
  const maxResults = (body?.maxResults as number | undefined) ?? 10;

  if (!key || typeof key !== 'string') {
    return NextResponse.json(
      { error: 'Missing or invalid "key" (Jira issue key, e.g. PWS-1993)' },
      { status: 400 }
    );
  }

  const base = JIRA_BASE.replace(/\/+$/, '');
  const url = `${base}/rest/api/3/issue/${encodeURIComponent(
    key
  )}/comment?maxResults=${encodeURIComponent(String(maxResults))}`;

  try {
    const jiraRes = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    });

    if (!jiraRes.ok) {
      let jiraError: any = null;
      try {
        jiraError = await jiraRes.json();
      } catch {
        // ignore parse error
      }

      const errorMessages =
        jiraError?.errorMessages ||
        jiraError?.errors ||
        jiraError?.message ||
        `Jira returned HTTP ${jiraRes.status}`;

      return NextResponse.json(
        {
          error: 'Failed to fetch comments from Jira',
          upstream: errorMessages,
        },
        { status: 502 }
      );
    }

    const data = await jiraRes.json();
    // Jira returns { comments: [...], total, startAt, maxResults }
    return NextResponse.json(
      {
        comments: Array.isArray(data?.comments) ? data.comments : [],
      },
      { status: 200 }
    );
  } catch (e: any) {
    return NextResponse.json(
      {
        error: 'Error calling Jira comments API',
        details: e?.message ?? String(e),
      },
      { status: 500 }
    );
  }
}
