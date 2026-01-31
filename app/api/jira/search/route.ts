// app/api/jira/search/route.ts
export const runtime = "nodejs";

type SearchBody = {
  jql: string;
  maxResults?: number;
  fields?: string[];
  nextPageToken?: string; // enhanced paging
};

function need(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v
    .filter((x) => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length ? out : [];
}

function toFlaggedBool(flagged: unknown): boolean {
  // Jira commonly returns "flagged" as:
  // - undefined/null when not flagged
  // - an array (often of objects) when flagged
  if (Array.isArray(flagged)) return flagged.length > 0;
  if (flagged == null) return false;
  return Boolean(flagged);
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<SearchBody> | null;

    const jql = typeof body?.jql === "string" ? body.jql.trim() : "";
    if (!jql) {
      return new Response(JSON.stringify({ error: "jql is required" }), {
        status: 400,
      });
    }

    const maxResultsRaw = body?.maxResults;
    const maxResults =
      typeof maxResultsRaw === "number" && Number.isFinite(maxResultsRaw)
        ? Math.max(1, Math.min(1000, Math.floor(maxResultsRaw)))
        : 50;

    // we force-add fields we need for KPIs; caller can still pass custom fields too
    const defaultFields = [
      "key",
      "summary",
      "issuetype",
      "status",
      "project",
      "created",
      "updated",
      "resolutiondate",
    ];
    const fields = asStringArray(body?.fields) ?? defaultFields;

    const nextPageToken =
      typeof body?.nextPageToken === "string" && body.nextPageToken.trim()
        ? body.nextPageToken.trim()
        : undefined;

    const base = need("JIRA_BASE");
    const email = need("JIRA_EMAIL");
    const token = need("JIRA_TOKEN");
    const auth = Buffer.from(`${email}:${token}`).toString("base64");

    // ensure status & resolutiondate are always requested (for KPI-1 grouping + future use)
    const want = Array.from(new Set([...fields, "status", "resolutiondate"]));

    const payload: any = {
      jql,
      maxResults,
      fields: want,
      fieldsByKeys: true,
    };
    if (nextPageToken) payload.nextPageToken = nextPageToken;

    const r = await fetch(`${base}/rest/api/3/search/jql`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    const data = await r.json();

    if (!r.ok) {
      return new Response(
        JSON.stringify({ upstreamStatus: r.status, upstream: data }),
        { status: 502 }
      );
    }

    const items =
      (data.issues ?? []).map((it: any) => {
        const f = it.fields ?? {};
        const st = f.status ?? {};
        const sc = st.statusCategory ?? {};

        return {
          key: it.key,
          summary: f.summary,
          type: f.issuetype?.name,
          status: st?.name,
          statusCategory: sc?.name ?? null, // "To Do" | "In Progress" | "Done" | null
          project: f.project?.key,
          created: f.created,
          updated: f.updated,
          resolutiondate: f.resolutiondate ?? null,

          // ✅ stable pass-through for UI/KPI consistency
          labels: Array.isArray(f.labels) ? f.labels : [],
          flagged: toFlaggedBool(f.flagged),
        };
      }) ?? [];

    return Response.json({
      total: data.total,
      nextPageToken: data.nextPageToken ?? null,
      items,
    });
  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: e?.message ?? "Unexpected error" }),
      { status: 500 }
    );
  }
}
