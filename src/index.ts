import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { handleAccessRequest } from "./access-handler";
import type { Props } from "./workers-oauth-utils";

type RockEnv = { ROCK_BASE_URL: string; ROCK_API_KEY: string };

// Season group IDs (ensemble ladder). Update each new season.
const GROUP_IDS: Record<string, Record<string, number>> = {
  "23": { "nova 1": 2565, "nova 2": 2566, cascadia: 2567, pacific: 2568, chamber: 2571 },
  "24": { "nova 1": 9322, "nova 2": 9323, cascadia: 9324, pacific: 9325, chamber: 9326 },
};

async function rockSearch(env: RockEnv, entity: string, body: unknown): Promise<any[]> {
  const res = await fetch(`${env.ROCK_BASE_URL}/api/v2/models/${entity}/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization-Token": env.ROCK_API_KEY,
    },
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
            where:
              `FirstName.Contains("${q}") ` +
              `|| LastName.Contains("${q}") ` +
              `|| NickName.Contains("${q}") ` +
              `|| Email.Contains("${q}")`,
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
          return {
            content: [{ text: `Found ${people.length} match(es) for "${query}":\n${lines.join("\n")}`, type: "text" }],
          };
        } catch (err: any) {
          return { content: [{ text: `Error searching Rock: ${err.message}`, type: "text" }] };
        }
      },
    );

    // --- Tool 2: get an ensemble roster (two-step) -----------------------
    this.server.tool(
      "rock_get_roster",
      "Get the active roster (singers) of a Pacific Youth Choir ensemble for a season. Read-only. Returns each member's name and email.",
      {
        ensemble: z
          .enum(["Nova 1", "Nova 2", "Cascadia", "Pacific", "Chamber"])
          .describe("Which ensemble's roster to pull"),
        season: z.enum(["23", "24"]).default("24").describe("'23' = 2025-26, '24' = 2026-27 (default)"),
      },
      async ({ ensemble, season }) => {
        try {
          const env = this.env as unknown as RockEnv;
          const groupId = GROUP_IDS[season]?.[ensemble.toLowerCase()];
          if (!groupId)
            return { content: [{ text: `No group ID known for ${ensemble}, season ${season}.`, type: "text" }] };

          // Step 1: active, non-archived member PersonIds in the group
          const members = await rockSearch(env, "groupmembers", {
            where: `GroupId == ${groupId} && GroupMemberStatus == 1 && IsArchived == false`,
            select: "new { PersonId }",
            limit: 300,
          });
          const ids = [...new Set(members.map((m) => m.personId).filter(Boolean))];
          if (ids.length === 0)
            return { content: [{ text: `No active members found in ${ensemble} (season ${season}).`, type: "text" }] };

          // Step 2: look those people up in batches of 50
          const people: any[] = [];
          for (let i = 0; i < ids.length; i += 50) {
            const where = ids.slice(i, i + 50).map((id) => `Id == ${id}`).join(" || ");
            const chunk = await rockSearch(env, "people", {
              where,
              select: "new { Id, FirstName, LastName, NickName, Email }",
              limit: 50,
            });
            people.push(...chunk);
          }
          people.sort((a, b) => (a.lastName || "").localeCompare(b.lastName || ""));

          const lines = people.map((p) => {
            const name = `${p.nickName || p.firstName || ""} ${p.lastName || ""}`.trim();
            return `- ${name}${p.email ? ` — ${p.email}` : ""}`;
          });
          const label = season === "24" ? "2026-27" : "2025-26";
          return {
            content: [{ text: `${ensemble} — ${label} (${people.length} active):\n${lines.join("\n")}`, type: "text" }],
          };
        } catch (err: any) {
          return { content: [{ text: `Error getting roster: ${err.message}`, type: "text" }] };
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
