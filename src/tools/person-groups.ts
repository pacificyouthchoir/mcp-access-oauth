import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RockEnv, rockSearch, resolvePerson, orIds, ENSEMBLE_BY_GROUP_ID } from "../rock";

export function registerPersonGroups(server: McpServer, getEnv: () => RockEnv) {
  server.tool(
    "rock_get_person_groups",
    "List all of a PYC person's group memberships — current and prior (including archived) — across every group type (ensembles, volunteer teams, serving groups, communication lists, etc.). Read-only. Hides Rock's auto system groups (family, known-relationships) by default; pass includeSystem=true to include them, or filter='volunteer' to narrow by group or type name.",
    {
      query: z.string().min(2).describe("Name or email of the person"),
      filter: z.string().optional().describe("Optional: only groups whose group name OR group-type name contains this (e.g. 'volunteer', 'Pacific')"),
      includeSystem: z.boolean().default(false).describe("Include Rock's auto system groups (family, known-relationships, peer network). Default false."),
    },
    async ({ query, filter, includeSystem }) => {
      try {
        const env = getEnv();
        const people = await resolvePerson(env, query);
        if (people.length === 0) return { content: [{ text: `No person found matching "${query}".`, type: "text" }] };
        if (people.length > 1) return { content: [{ text: `Multiple match "${query}":\n${people.map((p) => `- ${(p.nickName || p.firstName || "")} ${p.lastName || ""} (Id ${p.id})`).join("\n")}`, type: "text" }] };
        const person = people[0];
        const name = `${person.nickName || person.firstName || ""} ${person.lastName || ""}`.trim();
        const mems = await rockSearch(env, "groupmembers", { where: `PersonId == ${person.id}`, select: "new { GroupId, GroupMemberStatus, IsArchived, DateTimeAdded, CreatedDateTime }", limit: 300 });
        if (mems.length === 0) return { content: [{ text: `No group memberships found for ${name}.`, type: "text" }] };
        const groupIds = [...new Set(mems.map((m) => m.groupId).filter(Boolean))];
        const groupName: Record<number, string> = {};
        const groupTypeId: Record<number, number> = {};
        for (let i = 0; i < groupIds.length; i += 50)
          for (const g of await rockSearch(env, "groups", { where: orIds("Id", groupIds.slice(i, i + 50)), select: "new { Id, Name, GroupTypeId }", limit: 50 })) { groupName[g.id] = g.name; groupTypeId[g.id] = g.groupTypeId; }
        const typeIds = [...new Set(Object.values(groupTypeId).filter(Boolean))];
        const typeName: Record<number, string> = {};
        const typeSystem: Record<number, boolean> = {};
        for (let i = 0; i < typeIds.length; i += 50)
          for (const t of await rockSearch(env, "grouptypes", { where: orIds("Id", typeIds.slice(i, i + 50)), select: "new { Id, Name, IsSystem }", limit: 50 })) { typeName[t.id] = t.name; typeSystem[t.id] = t.isSystem === true; }
        const f = (filter || "").toLowerCase().trim();
        const rows = mems.map((m) => {
          const tid = groupTypeId[m.groupId];
          const gName = ENSEMBLE_BY_GROUP_ID[m.groupId] || groupName[m.groupId] || `Group ${m.groupId}`;
          const tName = typeName[tid] || "?";
          const joined = m.dateTimeAdded || m.createdDateTime;
          const status = m.isArchived ? "archived" : m.groupMemberStatus === 1 ? "active" : m.groupMemberStatus === 0 ? "inactive" : m.groupMemberStatus === 2 ? "pending" : "—";
          return { isSys: typeSystem[tid] === true, gName, tName, key: joined ? new Date(joined).getTime() : 0, line: `- ${joined ? String(joined).slice(0, 10) : "(no date)"} — ${gName} [${tName}] — ${status}` };
        })
          .filter((r) => (includeSystem || !r.isSys) && (!f || r.gName.toLowerCase().includes(f) || r.tName.toLowerCase().includes(f)))
          .sort((a, b) => a.key - b.key);
        if (rows.length === 0) return { content: [{ text: `No matching group memberships for ${name}${f ? ` (filter "${filter}")` : ""}.`, type: "text" }] };
        const hidden = !includeSystem && !f ? mems.length - rows.length : 0;
        return { content: [{ text: `Groups for ${name} (${rows.length}${f ? ` matching "${filter}"` : ""}, oldest first):\n${rows.map((r) => r.line).join("\n")}${hidden > 0 ? `\n(${hidden} system/auto membership(s) hidden — includeSystem=true to show)` : ""}`, type: "text" }] };
      } catch (e: any) { return { content: [{ text: `Error getting group memberships: ${e.message}`, type: "text" }] }; }
    },
  );
}
