import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RockEnv, rockSearch, resolvePerson, orIds } from "../rock";

// Rock.Enums/Communication/CommunicationRecipientStatus.cs (v19.1)
const RSTATUS: Record<number, string> = {
  0: "pending", 1: "delivered", 2: "FAILED", 3: "cancelled", 4: "opened", 5: "sending",
};

export function registerPersonCommunications(server: McpServer, getEnv: () => RockEnv) {
  server.tool(
    "rock_get_person_communications",
    "Show what emails/SMS a PYC person (or their household) has actually been sent from Rock — subject, date, delivery status, whether they opened it, and any unsubscribe or bounce. Read-only. Use this to answer 'did this family get the email?' or to check before sending something again.",
    {
      query: z.string().min(2).describe("Name, email, or Rock Id of the person"),
      familyWide: z.boolean().default(false).describe("Include the whole household (default false — just this person)"),
      limit: z.number().int().min(1).max(100).default(20).describe("Max messages, newest first (default 20)"),
    },
    async ({ query, familyWide, limit }) => {
      try {
        const env = getEnv();
        const people = await resolvePerson(env, query);
        if (people.length === 0) return { content: [{ text: `No person found matching "${query}".`, type: "text" }] };
        if (people.length > 1)
          return { content: [{ text: `Multiple match "${query}" — narrow it (you can pass the Id):\n${people.map((p) => `- ${(p.nickName || p.firstName || "")} ${p.lastName || ""} (Id ${p.id})`).join("\n")}`, type: "text" }] };
        const person = people[0];
        const personName = `${person.nickName || person.firstName || ""} ${person.lastName || ""}`.trim();

        // who? (optionally the household)
        const nameById: Record<number, string> = { [person.id]: personName };
        let personIds = [person.id];
        let scopeLabel = "";
        if (familyWide) {
          try {
            const famType = (await rockSearch(env, "grouptypes", { where: `Name == "Family"`, select: "new { Id }", limit: 1 }))[0];
            if (famType?.id) {
              const mine = await rockSearch(env, "groupmembers", { where: `PersonId == ${person.id} && GroupTypeId == ${famType.id} && IsArchived == false`, select: "new { GroupId }", limit: 10 });
              const gids = [...new Set(mine.map((m) => m.groupId).filter(Boolean))];
              if (gids.length) {
                const mem = await rockSearch(env, "groupmembers", { where: `(${orIds("GroupId", gids)}) && IsArchived == false`, select: "new { PersonId }", limit: 50 });
                const ids = [...new Set(mem.map((m) => m.personId).filter(Boolean))];
                if (ids.length) {
                  personIds = ids;
                  for (let i = 0; i < ids.length; i += 50)
                    for (const p of await rockSearch(env, "people", { where: orIds("Id", ids.slice(i, i + 50)), select: "new { Id, NickName, FirstName, LastName }", limit: 50 }))
                      nameById[p.id] = `${p.nickName || p.firstName || ""} ${p.lastName || ""}`.trim();
                  if (ids.length > 1) scopeLabel = ` (household of ${ids.length})`;
                }
              }
            }
          } catch { /* fall back to single person */ }
        }

        // person -> aliases (recipients are keyed by alias)
        const aliasToPerson: Record<number, number> = {};
        for (let i = 0; i < personIds.length; i += 50)
          for (const a of await rockSearch(env, "personaliases", { where: `(${orIds("PersonId", personIds.slice(i, i + 50))})`, select: "new { Id, PersonId }", limit: 200 }))
            aliasToPerson[a.id] = a.personId;
        const aliasIds = Object.keys(aliasToPerson).map(Number);
        if (aliasIds.length === 0) return { content: [{ text: `No communication history for ${personName}.`, type: "text" }] };

        // recipient rows
        const recips: any[] = [];
        for (let i = 0; i < aliasIds.length; i += 50)
          recips.push(...(await rockSearch(env, "communicationrecipients", {
            where: `(${orIds("PersonAliasId", aliasIds.slice(i, i + 50))})`,
            select: "new { CommunicationId, PersonAliasId, Status, SendDateTime, DeliveredDateTime, OpenedDateTime, UnsubscribeDateTime, SpamComplaintDateTime, StatusNote }",
            sort: "SendDateTime desc",
            limit: (limit ?? 20) * 2,
          })));
        if (recips.length === 0) return { content: [{ text: `No communications found for ${personName}${scopeLabel}.`, type: "text" }] };

        recips.sort((a, b) => new Date(b.sendDateTime || b.deliveredDateTime || 0).getTime() - new Date(a.sendDateTime || a.deliveredDateTime || 0).getTime());
        const top = recips.slice(0, limit ?? 20);

        // subjects
        const commIds = [...new Set(top.map((r) => r.communicationId).filter(Boolean))];
        const comm: Record<number, any> = {};
        for (let i = 0; i < commIds.length; i += 50)
          for (const c of await rockSearch(env, "communications", { where: orIds("Id", commIds.slice(i, i + 50)), select: "new { Id, Subject, Name, IsBulkCommunication, SendDateTime }", limit: 50 }))
            comm[c.id] = c;

        const lines = top.map((r) => {
          const c = comm[r.communicationId] || {};
          const subject = c.subject || c.name || `Communication ${r.communicationId}`;
          const when = r.sendDateTime || r.deliveredDateTime || c.sendDateTime;
          const date = when ? String(when).slice(0, 10) : "(no date)";
          const who = personIds.length > 1 ? ` → ${nameById[aliasToPerson[r.personAliasId]] || "?"}` : "";
          const status = RSTATUS[r.status as number] ?? `status ${r.status}`;
          const opened = r.openedDateTime ? " · opened" : "";
          const unsub = r.unsubscribeDateTime ? " · ⚠ UNSUBSCRIBED" : "";
          const spam = r.spamComplaintDateTime ? " · ⚠ SPAM COMPLAINT" : "";
          const note = r.status === 2 && r.statusNote ? `\n    reason: ${String(r.statusNote).slice(0, 160)}` : "";
          const bulk = c.isBulkCommunication ? " [bulk]" : "";
          return `- ${date} — ${subject}${bulk}${who}\n    ${status}${opened}${unsub}${spam}${note}`;
        });

        const failed = top.filter((r) => r.status === 2).length;
        const header = failed > 0 ? `\n⚠ ${failed} of these failed to deliver.` : "";
        const more = recips.length > top.length ? `\n\n(more history exists — raise limit to see it)` : "";
        return { content: [{ text: `Communications for ${personName}${scopeLabel} — ${top.length} most recent:${header}\n${lines.join("\n")}${more}`, type: "text" }] };
      } catch (e: any) {
        return { content: [{ text: `Error getting communications: ${e.message}`, type: "text" }] };
      }
    },
  );
}
