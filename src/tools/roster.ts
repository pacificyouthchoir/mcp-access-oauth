import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RockEnv, rockSearch, orIds, GROUP_IDS } from "../rock";

export function registerRoster(server: McpServer, getEnv: () => RockEnv) {
  server.tool(
    "rock_get_roster",
    "Get the active roster of a PYC ensemble for a season. Read-only.",
    { ensemble: z.enum(["Nova 1", "Nova 2", "Cascadia", "Pacific", "Chamber"]), season: z.enum(["23", "24"]).default("24") },
    async ({ ensemble, season }) => {
      try {
        const env = getEnv();
        const groupId = GROUP_IDS[season]?.[ensemble.toLowerCase()];
        if (!groupId) return { content: [{ text: `No group ID for ${ensemble}/${season}.`, type: "text" }] };
        const members = await rockSearch(env, "groupmembers", { where: `GroupId == ${groupId} && GroupMemberStatus == 1 && IsArchived == false`, select: "new { PersonId }", limit: 300 });
        const ids = [...new Set(members.map((m) => m.personId).filter(Boolean))];
        if (ids.length === 0) return { content: [{ text: `No active members in ${ensemble} (${season}).`, type: "text" }] };
        const people: any[] = [];
        for (let i = 0; i < ids.length; i += 50)
          people.push(...(await rockSearch(env, "people", { where: orIds("Id", ids.slice(i, i + 50)), select: "new { Id, FirstName, LastName, NickName, Email }", limit: 50 })));
        people.sort((a, b) => (a.lastName || "").localeCompare(b.lastName || ""));
        const lines = people.map((p) => `- ${(p.nickName || p.firstName || "")} ${p.lastName || ""}${p.email ? ` — ${p.email}` : ""}`);
        const label = season === "24" ? "2026-27" : "2025-26";
        return { content: [{ text: `${ensemble} — ${label} (${people.length}):\n${lines.join("\n")}`, type: "text" }] };
      } catch (e: any) { return { content: [{ text: `Error: ${e.message}`, type: "text" }] }; }
    },
  );
}
