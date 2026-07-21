import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { handleAccessRequest } from "./access-handler";
import type { Props } from "./workers-oauth-utils";

type RockEnv = { ROCK_BASE_URL: string; ROCK_API_KEY: string };

const GROUP_IDS: Record<string, Record<string, number>> = {
  "23": { "nova 1": 2565, "nova 2": 2566, cascadia: 2567, pacific: 2568, chamber: 2571 },
  "24": { "nova 1": 9322, "nova 2": 9323, cascadia: 9324, pacific: 9325, chamber: 9326 },
};

const ENSEMBLE_BY_GROUP_ID: Record<number, string> = (() => {
  const m: Record<number, string> = {};
  for (const season of Object.keys(GROUP_IDS)) {
    const label = season === "24" ? "2026-27" : "2025-26";
    for (const [name, id] of Object.entries(GROUP_IDS[season])) {
      m[id] = `${name.replace(/\b\w/g, (c) => c.toUpperCase())} ${label}`;
    }
  }
  return m;
})();

async function rockSearch(env: RockEnv, entity: string, body: unknown): Promise<any[]> {
  const res = await fetch(`${env.ROCK_BASE_URL}/api/v2/models/${entity}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization-Token": env.ROCK_API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Rock API ${res.status}: ${text.slice(0, 300)}`);
  }
  const data: any = await res.json();
  return Array.isArray(data) ? data : (data.items ?? data.Items ?? []);
}

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({ name: "PYC Rock MCP", version: "1.0.0" });

  async init() {
    // --- Tool 1: find a person -------------------------------------------
    this.server.tool(
      "rock_find_person",
      "Search Pacific Youth Choir's Rock database for people by name or email fragment. Read-only. Returns matching people with their Rock Id, name, nickname, and email.",
      {
        query: z.string().min(2).describe("Name or email fragment, e.g. 'Hansen' or 'chris@'"),
        limit: z.number().int().min(1).max(50).default(10).describe("Max people to return (default 10)"),
      },
      async ({ query, limit }) => {
        try {
          const env = this.env as unknown as RockEnv;
          const q = query.replace(/["\\]/g, "").trim();
          const people = await rockSearch(env, "people", {
            where: `FirstName.Contains("${q}") || LastName.Contains("${q}") || NickName.Contains("${q}") || Email.Contains("${q}")`,
            select: "new { Id, FirstName, LastName, NickName, Email }",
            sort: "LastName, FirstName",
            limit: limit ?? 10,
          });
          if (people.length === 0)
            return { content: [{ text: `No people found matching "${query}".`, type: "text" }] };
          const lines = people.map((p) => {
            const name = `${p.nickName || p.firstName || ""} ${p.lastName || ""}`.trim();
            return `- ${name} (Id ${p.id})${p.email ? ` — ${p.email}` : ""}`;
          });
          return { content: [{ text: `Found ${people.length} match(es) for "${query}":\n${lines.join("\n")}`, type: "text" }] };
        } catch (err: any) {
          return { content: [{ text: `Error searching Rock: ${err.message}`, type: "text" }] };
        }
      },
    );

    // --- Tool 2: get an ensemble roster ----------------------------------
    this.server.tool(
      "rock_get_roster",
      "Get the active roster (singers) of a Pacific Youth Choir ensemble for a season. Read-only. Returns each member's name and email.",
      {
        ensemble: z.enum(["Nova 1", "Nova 2", "Cascadia", "Pacific", "Chamber"]).describe("Which ensemble"),
        season: z.enum(["23", "24"]).default("24").describe("'23'=2025-26, '24'=2026-27 (default)"),
      },
      async ({ ensemble, season }) => {
        try {
          const env = this.env as unknown as RockEnv;
          const groupId = GROUP_IDS[season]?.[ensemble.toLowerCase()];
          if (!groupId) return { content: [{ text: `No group ID for ${ensemble}, season ${season}.`, type: "text" }] };
          const members = await rockSearch(env, "groupmembers", {
            where: `GroupId == ${groupId} && GroupMemberStatus == 1 && IsArchived == false`,
            select: "new { PersonId }",
            limit: 300,
          });
          const ids = [...new Set(members.map((m) => m.personId).filter(Boolean))];
          if (ids.length === 0) return { content: [{ text: `No active members in ${ensemble} (season ${season}).`, type: "text" }] };
          const people: any[] = [];
          for (let i = 0; i < ids.length; i += 50) {
            const where = ids.slice(i, i + 50).map((id) => `Id == ${id}`).join(" || ");
            people.push(...(await rockSearch(env, "people", { where, select: "new { Id, FirstName, LastName, NickName, Email }", limit: 50 })));
          }
          people.sort((a, b) => (a.lastName || "").localeCompare(b.lastName || ""));
          const lines = people.map((p) => {
            const name = `${p.nickName || p.firstName || ""} ${p.lastName || ""}`.trim();
            return `- ${name}${p.email ? ` — ${p.email}` : ""}`;
          });
          const label = season === "24" ? "2026-27" : "2025-26";
          return { content: [{ text: `${ensemble} — ${label} (${people.length} active):\n${lines.join("\n")}`, type: "text" }] };
        } catch (err: any) {
          return { content: [{ text: `Error getting roster: ${err.message}`, type: "text" }] };
        }
      },
    );

    // --- Tool 3: a person's recent attendance ----------------------------
    this.server.tool(
      "rock_get_person_attendance",
      "Show a Pacific Youth Choir person's recent attendance (present/absent) with dates and, when known, which ensemble's rehearsal. Read-only. Use to answer 'did X show up lately?'",
      {
        query: z.string().min(2).describe("Name or email of the person, e.g. 'Hansen' or 'chris@'"),
        limit: z.number().int().min(1).max(50).default(10).describe("How many recent records (default 10)"),
      },
      async ({ query, limit }) => {
        try {
          const env = this.env as unknown as RockEnv;
          const q = query.replace(/["\\]/g, "").trim();

          // 1) resolve person
          const people = await rockSearch(env, "people", {
            where: `FirstName.Contains("${q}") || LastName.Contains("${q}") || NickName.Contains("${q}") || Email.Contains("${q}")`,
            select: "new { Id, FirstName, LastName, NickName, Email }",
            limit: 10,
          });
          if (people.length === 0) return { content: [{ text: `No person found matching "${query}".`, type: "text" }] };
          if (people.length > 1) {
            const opts = people.map((p) => `- ${(p.nickName || p.firstName || "")} ${p.lastName || ""} (Id ${p.id})${p.email ? ` — ${p.email}` : ""}`);
            return { content: [{ text: `Multiple people match "${query}" — narrow it down:\n${opts.join("\n")}`, type: "text" }] };
          }
          const person = people[0];
          const personName = `${person.nickName || person.firstName || ""} ${person.lastName || ""}`.trim();

          // 2) person's alias IDs
          const aliases = await rockSearch(env, "personaliases", { where: `PersonId == ${person.id}`, select: "new { Id }", limit: 50 });
          const aliasIds = aliases.map((a) => a.id).filter(Boolean);
          if (aliasIds.length === 0) return { content: [{ text: `No attendance records found for ${personName}.`, type: "text" }] };

          // 3) recent attendance rows
          const aliasWhere = aliasIds.slice(0, 50).map((id) => `PersonAliasId == ${id}`).join(" || ");
          const rows = await rockSearch(env, "attendances", {
            where: aliasWhere,
            select: "new { DidAttend, StartDateTime, OccurrenceId }",
            sort: "StartDateTime desc",
            limit: limit ?? 10,
          });
          if (rows.length === 0) return { content: [{ text: `No attendance records found for ${personName}.`, type: "text" }] };

          // 4) optional: name the ensemble via occurrence -> group (degrades gracefully)
          const occMap: Record<number, number> = {};
          try {
            const occIds = [...new Set(rows.map((r) => r.occurrenceId).filter(Boolean))];
            if (occIds.length > 0) {
              const occWhere = occIds.slice(0, 50).map((id) => `Id == ${id}`).join(" || ");
              const occs = await rockSearch(env, "attendanceoccurrences", { where: occWhere, select: "new { Id, GroupId }", limit: 50 });
              for (const o of occs) if (o.id) occMap[o.id] = o.groupId;
            }
          } catch { /* occurrence grant not set; skip ensemble labels */ }

          const lines = rows.map((r) => {
            const date = r.startDateTime ? String(r.startDateTime).slice(0, 10) : "(no date)";
            const status = r.didAttend === true ? "Present" : r.didAttend === false ? "Absent" : "—";
            const gid = occMap[r.occurrenceId];
            const ens = gid && ENSEMBLE_BY_GROUP_ID[gid] ? ` — ${ENSEMBLE_BY_GROUP_ID[gid]}` : "";
            return `- ${date} — ${status}${ens}`;
          });
          return { content: [{ text: `Recent attendance for ${personName} (last ${rows.length}):\n${lines.join("\n")}`, type: "text" }] };
        } catch (err: any) {
          return { content: [{ text: `Error getting attendance: ${err.message}`, type: "text" }] };
        }
      },
    );
  }
}

export default new OAuthProvider({
  apiHandler: MyMCP.serve("/mcp"),
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: { fetch: handleAccessRequest as any },
  tokenEndpoint: "/token",
});
