import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type RockEnv = { ROCK_BASE_URL: string; ROCK_API_KEY: string; ROCK_WRITE_API_KEY?: string };
export type ToolRegistrar = (server: McpServer, getEnv: () => RockEnv) => void;

export async function rockPost(env: RockEnv, path: string, body: unknown): Promise<{ ok: boolean; status: number; text: string }> {
  const key = env.ROCK_WRITE_API_KEY || env.ROCK_API_KEY;
  const res = await fetch(`${env.ROCK_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization-Token": key },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

export const GROUP_IDS: Record<string, Record<string, number>> = {
  "23": { "nova 1": 2565, "nova 2": 2566, cascadia: 2567, pacific: 2568, chamber: 2571 },
  "24": { "nova 1": 9322, "nova 2": 9323, cascadia: 9324, pacific: 9325, chamber: 9326 },
};
export const ENSEMBLE_BY_GROUP_ID: Record<number, string> = (() => {
  const m: Record<number, string> = {};
  for (const s of Object.keys(GROUP_IDS)) {
    const label = s === "24" ? "2026-27" : "2025-26";
    for (const [n, id] of Object.entries(GROUP_IDS[s])) m[id] = `${n.replace(/\b\w/g, (c) => c.toUpperCase())} ${label}`;
  }
  return m;
})();
export const ANNUAL_ENROLLMENT_CATEGORY_ID = 305;

export const orIds = (field: string, ids: number[]) => ids.slice(0, 50).map((id) => `${field} == ${id}`).join(" || ");
export const sum = (a: any[], f: (x: any) => number) => a.reduce((t, x) => t + (Number(f(x)) || 0), 0);

export async function rockSearch(env: RockEnv, entity: string, body: unknown): Promise<any[]> {
  const res = await fetch(`${env.ROCK_BASE_URL}/api/v2/models/${entity}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization-Token": env.ROCK_API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Rock API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return Array.isArray(data) ? data : (data.items ?? data.Items ?? []);
}

export async function resolvePerson(env: RockEnv, query: string) {
  const raw = String(query || "").trim();
  const SELECT = "new { Id, FirstName, LastName, NickName, Email }";

  // 1) Explicit Id — "1", "id:1", "#1", or "...(Id 1)"
  const idMatch =
    raw.match(/^\s*(?:id[:\s]*|#)?(\d{1,9})\s*$/i) ||
    raw.match(/\(\s*id\s*[:\s]?\s*(\d{1,9})\s*\)/i);
  if (idMatch) {
    const byId = await rockSearch(env, "people", {
      where: `Id == ${Number(idMatch[1])}`,
      select: SELECT,
      limit: 1,
    });
    if (byId.length) return byId;
  }

  const q = raw.replace(/["\\]/g, "").trim();

  // 2) Full name — "Andrew Hansen" or "Hansen, Andrew"
  let first = "";
  let last = "";
  if (q.includes(",")) {
    const [l, f] = q.split(",").map((s) => s.trim());
    last = l;
    first = f || "";
  } else {
    const parts = q.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      first = parts[0];
      last = parts[parts.length - 1];
    }
  }
  if (first && last) {
    const byName = await rockSearch(env, "people", {
      where: `(FirstName.Contains("${first}") || NickName.Contains("${first}")) && LastName.Contains("${last}")`,
      select: SELECT,
      limit: 10,
    });
    if (byName.length) return byName;
  }

  // 3) Single-token fallback — name or email fragment
  return rockSearch(env, "people", {
    where: `FirstName.Contains("${q}") || LastName.Contains("${q}") || NickName.Contains("${q}") || Email.Contains("${q}")`,
    select: SELECT,
    limit: 10,
  });
}

export async function rockGet(env: RockEnv, path: string): Promise<any> {
  const res = await fetch(`${env.ROCK_BASE_URL}${path}`, {
    headers: { "Authorization-Token": env.ROCK_API_KEY },
  });
  if (!res.ok) throw new Error(`Rock API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export type ResolvedGroup = { target?: any; matches: any[]; enriched: string[] };

export async function resolveGroup(env: RockEnv, query: string): Promise<ResolvedGroup> {
  const raw = String(query || "").trim();
  const SELECT = "new { Id, Name, GroupTypeId, ParentGroupId, IsActive, IsArchived }";

  // 1) explicit Id — "2567", "id:2567", "#2567", or "...(Id 2567)"
  const idMatch =
    raw.match(/^\s*(?:id[:\s]*|#)?(\d{1,9})\s*$/i) || raw.match(/\(\s*id\s*[:\s]?\s*(\d{1,9})\s*\)/i);
  if (idMatch) {
    const byId = await rockSearch(env, "groups", { where: `Id == ${Number(idMatch[1])}`, select: SELECT, limit: 1 });
    if (byId.length) return { target: byId[0], matches: byId, enriched: [] };
  }

  const q = raw.replace(/["\\]/g, "").trim();
  const matches = await rockSearch(env, "groups", { where: `Name.Contains("${q}")`, select: SELECT, limit: 50 });
  if (matches.length === 0) return { matches: [], enriched: [] };

  const active = matches.filter((g) => g.isActive === true && g.isArchived !== true);
  const pool = active.length ? active : matches;
  if (pool.length === 1) return { target: pool[0], matches, enriched: [] };

  // enrich for disambiguation: parent group (season anchor) + group type
  const parentIds = [...new Set(pool.map((g) => g.parentGroupId).filter(Boolean))];
  const parentName: Record<number, string> = {};
  for (let i = 0; i < parentIds.length; i += 50)
    for (const p of await rockSearch(env, "groups", { where: orIds("Id", parentIds.slice(i, i + 50)), select: "new { Id, Name }", limit: 50 }))
      parentName[p.id] = p.name;
  const typeIds = [...new Set(pool.map((g) => g.groupTypeId).filter(Boolean))];
  const typeName: Record<number, string> = {};
  for (let i = 0; i < typeIds.length; i += 50)
    for (const t of await rockSearch(env, "grouptypes", { where: orIds("Id", typeIds.slice(i, i + 50)), select: "new { Id, Name }", limit: 50 }))
      typeName[t.id] = t.name;

  // highest ParentGroupId ≈ most recent season
  const maxParent = Math.max(...pool.map((g) => g.parentGroupId || 0));
  const enriched = pool
    .sort((a, b) => (b.parentGroupId || 0) - (a.parentGroupId || 0))
    .map((g) => {
      const parts: string[] = [];
      if (parentName[g.parentGroupId]) parts.push(`under ${parentName[g.parentGroupId]}`);
      if (typeName[g.groupTypeId]) parts.push(typeName[g.groupTypeId]);
      if (!g.isActive) parts.push("inactive");
      if (g.isArchived) parts.push("archived");
      const current = g.parentGroupId === maxParent && maxParent > 0 ? "  ← likely current season" : "";
      return `- ${g.name} (Id ${g.id})${parts.length ? ` — ${parts.join(", ")}` : ""}${current}`;
    });

  return { matches, enriched };
}
