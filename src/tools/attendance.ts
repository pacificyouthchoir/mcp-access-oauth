import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RockEnv, rockSearch, resolvePerson, orIds, ENSEMBLE_BY_GROUP_ID } from "../rock";

export function registerAttendance(server: McpServer, getEnv: () => RockEnv) {
  server.tool(
    "rock_get_person_attendance",
    "Show a PYC person's recent attendance (present/absent) with dates and ensemble. Read-only.",
    { query: z.string().min(2), limit: z.number().int().min(1).max(50).default(10) },
    async ({ query, limit }) => {
      try {
        const env = getEnv();
        const people = await resolvePerson(env, query);
        if (people.length === 0) return { content: [{ text: `No person found matching "${query}".`, type: "text" }] };
        if (people.length > 1) return { content: [{ text: `Multiple match "${query}":\n${people.map((p) => `- ${(p.nickName || p.firstName || "")} ${p.lastName || ""} (Id ${p.id})`).join("\n")}`, type: "text" }] };
        const person = people[0];
        const name = `${person.nickName || person.firstName || ""} ${person.lastName || ""}`.trim();
        const aliases = await rockSearch(env, "personaliases", { where: `PersonId == ${person.id}`, select: "new { Id }", limit: 50 });
        const aliasIds = aliases.map((a) => a.id).filter(Boolean);
        if (aliasIds.length === 0) return { content: [{ text: `No attendance for ${name}.`, type: "text" }] };
        const rows = await rockSearch(env, "attendances", { where: orIds("PersonAliasId", aliasIds), select: "new { DidAttend, StartDateTime, OccurrenceId }", sort: "StartDateTime desc", limit: limit ?? 10 });
        if (rows.length === 0) return { content: [{ text: `No attendance for ${name}.`, type: "text" }] };
        const occMap: Record<number, number> = {};
        try {
          const occIds = [...new Set(rows.map((r) => r.occurrenceId).filter(Boolean))];
          if (occIds.length) for (const o of await rockSearch(env, "attendanceoccurrences", { where: orIds("Id", occIds), select: "new { Id, GroupId }", limit: 50 })) occMap[o.id] = o.groupId;
        } catch {}
        const lines = rows.map((r) => {
          const date = r.startDateTime ? String(r.startDateTime).slice(0, 10) : "(no date)";
          const status = r.didAttend === true ? "Present" : r.didAttend === false ? "Absent" : "—";
          const ens = ENSEMBLE_BY_GROUP_ID[occMap[r.occurrenceId]] ? ` — ${ENSEMBLE_BY_GROUP_ID[occMap[r.occurrenceId]]}` : "";
          return `- ${date} — ${status}${ens}`;
        });
        return { content: [{ text: `Recent attendance for ${name} (last ${rows.length}):\n${lines.join("\n")}`, type: "text" }] };
      } catch (e: any) { return { content: [{ text: `Error: ${e.message}`, type: "text" }] }; }
    },
  );
}
