// app/api/jira/assign/route.ts
import { NextRequest, NextResponse } from 'next/server';

const JIRA_BASE = process.env.JIRA_BASE;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

// Helper to build Jira auth header
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
  const accountId = body?.accountId as string | undefined;
  // (Optional) you could later add support for email/displayName and look up accountId

  if (!key || typeof key !== 'string') {
    return NextResponse.json(
      { error: 'Missing or invalid "key" (Jira issue key, e.g. PPP-123)' },
      { status: 400 }
    );
  }

  if (!accountId || typeof accountId !== 'string') {
    return NextResponse.json(
      { error: 'Missing or invalid "accountId" for assignee' },
      { status: 400 }
    );
  }

  const url = `${JIRA_BASE.replace(/\/+$/, '')}/rest/api/3/issue/${encodeURIComponent(
    key
  )}/assignee`;

  try {
    const jiraRes = await fetch(url, {
      method: 'PUT', // Jira "assign issue" endpoint
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
        Accept: 'application/json',
      },
      body: JSON.stringify({ accountId }),
    });

    if (!jiraRes.ok) {
      let jiraError: any = null;
      try {
        jiraError = await jiraRes.json();
      } catch {
        // ignore parse failure
      }

      const errorMessages =
        jiraError?.errorMessages ||
        jiraError?.errors ||
        jiraError?.message ||
        `Jira returned HTTP ${jiraRes.status}`;

      return NextResponse.json(
        {
          error: 'Failed to update assignee in Jira',
          upstream: errorMessages,
        },
        { status: 502 }
      );
    }

    // Jira usually returns 204 No Content on success
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json(
      {
        error: 'Error calling Jira API',
        details: e?.message ?? String(e),
      },
      { status: 500 }
    );
  }
}
