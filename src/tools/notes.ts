import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RockEnv, rockSearch, resolvePerson, orIds } from "../rock";

// Auto-generated / noise note types excluded from the digest (matched by name,
// not id, so renames or new seasons don't break it).
const NOISE_TYPES = ["csv import error", "event registration"];
const MAX_NOTE_CHARS = 400;

export function registerNotes(server: McpServer, getEnv: () => RockEnv) {
  server.tool(
    "rock_get_person_notes",
    "Read the notes on a PYC person's record — and by default across their whole family/household — so you have the history before replying to a parent or logging a follow-up. Read-only. Returns note date, type, author, and text. Private notes are excluded; auto-generated import/registration notes are filtered out.",
    {
      query: z.string().min(2).describe("Name, email, or Rock Id of the person"),
      familyWide: z.boolean().default(true).describe("Include notes on all household members (default true). Set false for just this person."),
      noteType: z.string().optional().describe("Optional: only notes whose type name contains this, e.g. 'conductor', 'enrollment'"),
      limit: z.number().int().min(1).max(100).default(25).describe("Max notes to return, newest first (default 25)"),
    },
    async ({ query, familyWide, noteType, limit }) => {
      try {
        const env = getEnv();
        const people = await resolvePerson(env, query);
        if (people.length === 0) return { content: [{ text: `No person found matching "${query}".`, type: "text" }] };
        if (people.length > 1)
          return { content: [{ text: `Multiple match "${query}" — narrow it (you can pass the Id):\n${people.map((p) => `- ${(p.nickName || p.firstName || "")} ${p.lastName || ""} (Id ${p.id})`).join("\n")}`, type: "text" }] };
        const person = people[0];
        const personName = `${person.nickName || person.firstName || ""} ${person.lastName || ""}`.trim();

        // --- who are we pulling notes for? ---
        const nameById: Record<number, string> = { [person.id]: personName };
        let personIds: number[] = [person.id];
        let familyLabel = "";
        if (familyWide) {
          try {
            const famTypes = await rockSearch(env, "grouptypes", { where: `Name == "Family"`, select: "new { Id }", limit: 1 });
            const famTypeId = famTypes[0]?.id;
            if (famTypeId) {
              const myFam = await rockSearch(env, "groupmembers", { where: `PersonId == ${person.id} && GroupTypeId == ${famTypeId} && IsArchived == false`, select: "new { GroupId }", limit: 10 });
              const famGroupIds = [...new Set(myFam.map((m) => m.groupId).filter(Boolean))];
              if (famGroupIds.length) {
                const members = await rockSearch(env, "groupmembers", { where: `(${orIds("GroupId", famGroupIds)}) && IsArchived == false`, select: "new { PersonId }", limit: 50 });
                const ids = [...new Set(members.map((m) => m.personId).filter(Boolean))];
                if (ids.length) {
                  personIds = ids;
                  for (let i = 0; i < ids.length; i += 50)
                    for (const p of await rockSearch(env, "people", { where: orIds("Id", ids.slice(i, i + 50)), select: "new { Id, NickName, FirstName, LastName }", limit: 50 }))
                      nameById[p.id] = `${p.nickName || p.firstName || ""} ${p.lastName || ""}`.trim();
                  if (ids.length > 1) familyLabel = ` (household of ${ids.length})`;
                }
              }
            }
          } catch { /* family lookup failed — fall back to the single person */ }
        }

        // --- which note types? (discovered at runtime, by name) ---
        const etype = await rockSearch(env, "entitytypes", { where: `Name == "Rock.Model.Person"`, select: "new { Id }", limit: 1 });
        const personEntityTypeId = etype[0]?.id;
        if (!personEntityTypeId) return { content: [{ text: "Could not resolve the Person entity type.", type: "text" }] };
        const allTypes = await rockSearch(env, "notetypes", { where: `EntityTypeId == ${personEntityTypeId}`, select: "new { Id, Name }", limit: 100 });
        const typeName: Record<number, string> = {};
        const nf = (noteType || "").toLowerCase().trim();
        const typeIds = allTypes
          .filter((t) => {
            const n = String(t.name || "").toLowerCase();
            if (NOISE_TYPES.some((x) => n.includes(x))) return false;
            if (nf && !n.includes(nf)) return false;
            return true;
          })
          .map((t) => { typeName[t.id] = t.name; return t.id; })
          .filter(Boolean);
        if (typeIds.length === 0)
          return { content: [{ text: `No note types match${nf ? ` "${noteType}"` : ""}. Available: ${allTypes.map((t) => t.name).join(", ")}`, type: "text" }] };

        // --- fetch notes ---
        const notes: any[] = [];
        for (let i = 0; i < personIds.length; i += 50) {
          const chunk = personIds.slice(i, i + 50);
          notes.push(...(await rockSearch(env, "notes", {
            where: `(${orIds("EntityId", chunk)}) && (${orIds("NoteTypeId", typeIds)}) && IsPrivateNote == false`,
            select: "new { Id, EntityId, NoteTypeId, Text, Caption, CreatedDateTime, CreatedByPersonAliasId, IsAlert }",
            sort: "CreatedDateTime desc",
            limit: limit ?? 25,
          })));
        }
        if (notes.length === 0)
          return { content: [{ text: `No notes found for ${personName}${familyLabel}${nf ? ` (type "${noteType}")` : ""}.`, type: "text" }] };

        notes.sort((a, b) => new Date(b.createdDateTime || 0).getTime() - new Date(a.createdDateTime || 0).getTime());
        const top = notes.slice(0, limit ?? 25);

        // --- author names (optional enrichment) ---
        const authorName: Record<number, string> = {};
        try {
          const aliasIds = [...new Set(top.map((n) => n.createdByPersonAliasId).filter(Boolean))];
          const aliasToPerson: Record<number, number> = {};
          for (let i = 0; i < aliasIds.length; i += 50)
            for (const a of await rockSearch(env, "personaliases", { where: orIds("Id", aliasIds.slice(i, i + 50)), select: "new { Id, PersonId }", limit: 50 })) aliasToPerson[a.id] = a.personId;
          const pids = [...new Set(Object.values(aliasToPerson))];
          const pname: Record<number, string> = {};
          for (let i = 0; i < pids.length; i += 50)
            for (const p of await rockSearch(env, "people", { where: orIds("Id", pids.slice(i, i + 50)), select: "new { Id, NickName, FirstName, LastName }", limit: 50 })) pname[p.id] = `${p.nickName || p.firstName || ""} ${p.lastName || ""}`.trim();
          for (const [alias, pid] of Object.entries(aliasToPerson)) authorName[Number(alias)] = pname[pid] || "";
        } catch { /* author enrichment optional */ }

        const lines = top.map((n) => {
          const date = n.createdDateTime ? String(n.createdDateTime).slice(0, 10) : "(no date)";
          const who = nameById[n.entityId] || `Person ${n.entityId}`;
          const type = typeName[n.noteTypeId] || "Note";
          const author = authorName[n.createdByPersonAliasId] ? ` by ${authorName[n.createdByPersonAliasId]}` : "";
          let text = String(n.text || "").replace(/\s+/g, " ").trim();
          if (text.length > MAX_NOTE_CHARS) text = text.slice(0, MAX_NOTE_CHARS) + "…";
          const cap = n.caption ? `${String(n.caption).trim()}: ` : "";
          const alert = n.isAlert ? " ⚠" : "";
          return `- ${date} — ${who} — [${type}]${author}${alert}\n    ${cap}${text || "(empty)"}`;
        });

        const more = notes.length > top.length ? `\n\n(${notes.length - top.length} older note(s) not shown — raise limit to see more)` : "";
        return { content: [{ text: `Notes for ${personName}${familyLabel} — ${top.length} shown, newest first:\n${lines.join("\n")}${more}`, type: "text" }] };
      } catch (e: any) {
        return { content: [{ text: `Error getting notes: ${e.message}`, type: "text" }] };
      }
    },
  );
}
