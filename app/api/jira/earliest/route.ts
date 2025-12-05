// app/api/jira/earliest/route.ts
export const runtime = "nodejs";

type Body = {
  project: "SO" | "PPP" | "PWS" | "PORE" | "PWPU";
  scope: "Requirement" | "Story";
};

function need(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export async function POST(req: Request) {
  try {
    const { project, scope } = (await req.json()) as Body;

    if (!project || !scope) {
      return new Response(JSON.stringify({ error: "project and scope are required" }), { status: 400 });
    }

    const base = need("JIRA_BASE");
    const email = need("JIRA_EMAIL");
    const token = need("JIRA_TOKEN");
    const auth = Buffer.from(`${email}:${token}`).toString("base64");

    // Build JQL: valid issues (exclude withdrawn/cancelled), ordering by created ASC
    const jql =
      `project = ${project} AND issuetype in (${scope}) ` +
      `AND status NOT IN (Withdrawn, CANCELLED) ORDER BY created ASC`;

    // Ask for just 1 result (first created)
    const payload = {
      jql,
      maxResults: 1,
      fields: ["key", "created"], // minimal fields
      fieldsByKeys: true
    };

    const r = await fetch(`${base}/rest/api/3/search/jql`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      cache: "no-store"
    });

    const data = await r.json();

    if (!r.ok) {
      return new Response(JSON.stringify({ upstreamStatus: r.status, upstream: data }), { status: 502 });
    }

    const first = (data.issues ?? [])[0];
    const earliestCreated: string | null = first?.fields?.created ?? null;

    return Response.json({
      project,
      scope,
      jql,
      earliestCreated // ISO string or null if no issues matched
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message ?? "Unexpected error" }), { status: 500 });
  }
}
