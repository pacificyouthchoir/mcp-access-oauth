import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type RockEnv = { ROCK_BASE_URL: string; ROCK_API_KEY: string };
export type ToolRegistrar = (server: McpServer, getEnv: () => RockEnv) => void;

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
  const q = query.replace(/["\\]/g, "").trim();
  return rockSearch(env, "people", {
    where: `FirstName.Contains("${q}") || LastName.Contains("${q}") || NickName.Contains("${q}") || Email.Contains("${q}")`,
    select: "new { Id, FirstName, LastName, NickName, Email }",
    limit: 10,
  });
}
