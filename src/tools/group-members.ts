import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RockEnv, rockSearch, orIds, resolveGroup } from "../rock";

export function registerGroupMembers(server: McpServer, getEnv: () => RockEnv) {
  server.tool(
    "rock_get_group_members",
    "Get the active members of ANY PYC group by name — ensembles, volunteer/serving teams, ushers, committees, etc. Read-only. Finds the group by name fragment; if several match, shows the active/current one and notes the others.",
    { group: z.string().min(2).describe("Group name fragment, e.g. 'usher', 'volunteer', 'Pacific'") },
    async ({ group }) => {
      try {
        const env = getEnv();
        const res = await resolveGroup(env, group);
        if (res.matches.length === 0) return { content: [{ text: `No group matching "${group}".`, type: "text" }] };
        if (!res.target)
          return { content: [{ text: `Several groups match "${group}" — re-run with the Id:\n${res.enriched.join("\n")}`, type: "text" }] };
        const target = res.target;
        const note = "";
        
        let typeLabel = "";
        try {
          const t = (await rockSearch(env, "grouptypes", { where: `Id == ${target.groupTypeId}`, select: "new { Name }", limit: 1 }))[0];
          if (t?.name) typeLabel = ` [${t.name}]`;
        } catch {}
        const members = await rockSearch(env, "groupmembers", { where: `GroupId == ${target.id} && GroupMemberStatus == 1 && IsArchived == false`, select: "new { PersonId }", limit: 500 });
        const ids = [...new Set(members.map((m) => m.personId).filter(Boolean))];
        if (ids.length === 0) return { content: [{ text: `${target.name}${typeLabel}: no active members.${note}`, type: "text" }] };
        const people: any[] = [];
        for (let i = 0; i < ids.length; i += 50)
          people.push(...(await rockSearch(env, "people", { where: orIds("Id", ids.slice(i, i + 50)), select: "new { Id, NickName, FirstName, LastName, Email }", limit: 50 })));
        people.sort((a, b) => (a.lastName || "").localeCompare(b.lastName || ""));
        const lines = people.map((p) => `- ${(p.nickName || p.firstName || "")} ${p.lastName || ""}${p.email ? ` — ${p.email}` : ""}`);
        return { content: [{ text: `${target.name}${typeLabel} — ${people.length} active member(s):\n${lines.join("\n")}${note}`, type: "text" }] };
      } catch (e: any) { return { content: [{ text: `Error getting group members: ${e.message}`, type: "text" }] }; }
    },
  );
}
