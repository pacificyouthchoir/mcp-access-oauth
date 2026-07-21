import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RockEnv, rockSearch, orIds } from "../rock";

export function registerGroupMembers(server: McpServer, getEnv: () => RockEnv) {
  server.tool(
    "rock_get_group_members",
    "Get the active members of ANY PYC group by name — ensembles, volunteer/serving teams, ushers, committees, etc. Read-only. Finds the group by name fragment; if several match, shows the active/current one and notes the others.",
    { group: z.string().min(2).describe("Group name fragment, e.g. 'usher', 'volunteer', 'Pacific'") },
    async ({ group }) => {
      try {
        const env = getEnv();
        const q = group.replace(/["\\]/g, "").trim();
        const matches = await rockSearch(env, "groups", { where: `Name.Contains("${q}")`, select: "new { Id, Name, GroupTypeId, IsActive, IsArchived }", limit: 50 });
        if (matches.length === 0) return { content: [{ text: `No group matching "${group}".`, type: "text" }] };
        const active = matches.filter((g) => g.isActive === true && g.isArchived !== true);
        let target: any;
        let note = "";
        if (active.length === 1) {
          target = active[0];
          const others = matches.filter((g) => g.id !== target.id);
          if (others.length) note = `\n(also matched: ${others.map((g) => `${g.name} [Id ${g.id}${g.isArchived ? ", archived" : g.isActive ? "" : ", inactive"}]`).join("; ")})`;
        } else if (active.length > 1) {
          return { content: [{ text: `Several active groups match "${group}" — which one?\n${active.map((g) => `- ${g.name} (Id ${g.id})`).join("\n")}`, type: "text" }] };
        } else {
          return { content: [{ text: `No *active* group matches "${group}", but these exist:\n${matches.map((g) => `- ${g.name} (Id ${g.id}${g.isArchived ? ", archived" : ", inactive"})`).join("\n")}\nAsk again with a more specific name.`, type: "text" }] };
        }
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
