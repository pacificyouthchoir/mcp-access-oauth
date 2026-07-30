import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RockEnv, rockSearch, rockPost, resolvePerson } from "../rock";

// LOCKED: this tool writes ONLY this note type. There is deliberately no
// note-type parameter — volunteer-visible types are unreachable by construction.
const LOCKED_NOTE_TYPE_NAME = "Staff Note";

export function registerAddNote(server: McpServer, getEnv: () => RockEnv, getProps?: () => any) {
  server.tool(
    "rock_add_person_note",
    "Add a staff note to a PYC person's record in Rock. Always writes as the 'Staff Note' type — the note type cannot be changed. Requires confirm=true; calling without it returns a preview of exactly what would be written.",
    {
      query: z.string().min(2).describe("Name, email, or Rock Id of the person the note is about"),
      text: z.string().min(3).max(4000).describe("The note text"),
      confirm: z.boolean().default(false).describe("Must be true to actually write. Omit or false to preview first."),
    },
    async ({ query, text, confirm }) => {
      try {
        const env = getEnv();

        // resolve target person (read key)
        const people = await resolvePerson(env, query);
        if (people.length === 0) return { content: [{ text: `No person found matching "${query}". Nothing written.`, type: "text" }] };
        if (people.length > 1)
          return { content: [{ text: `Multiple people match "${query}" — nothing written. Re-run with the Id:\n${people.map((p) => `- ${(p.nickName || p.firstName || "")} ${p.lastName || ""} (Id ${p.id})${p.email ? ` — ${p.email}` : ""}`).join("\n")}`, type: "text" }] };
        const person = people[0];
        const personName = `${person.nickName || person.firstName || ""} ${person.lastName || ""}`.trim();

        // resolve the locked note type by name (Person entity), at runtime
        const etype = await rockSearch(env, "entitytypes", { where: `Name == "Rock.Model.Person"`, select: "new { Id }", limit: 1 });
        const personEntityTypeId = etype[0]?.id;
        if (!personEntityTypeId) return { content: [{ text: "Could not resolve the Person entity type. Nothing written.", type: "text" }] };
        const types = await rockSearch(env, "notetypes", { where: `EntityTypeId == ${personEntityTypeId} && Name == "${LOCKED_NOTE_TYPE_NAME}"`, select: "new { Id, Name }", limit: 1 });
        const noteType = types[0];
        if (!noteType?.id)
          return { content: [{ text: `Could not find the "${LOCKED_NOTE_TYPE_NAME}" note type in Rock. Nothing written.`, type: "text" }] };

        // who's writing? (Cloudflare Access identity -> Rock person -> alias)
        const props: any = (getProps && getProps()) || {};
        const authorEmail: string | undefined = props.email || props.claims?.email || props.user?.email || props.userEmail;
        let authorAliasId: number | undefined;
        let authorLabel = "service account";
        if (authorEmail) {
          try {
            const matches = await rockSearch(env, "people", { where: `Email == "${String(authorEmail).replace(/["\\]/g, "")}"`, select: "new { Id, NickName, FirstName, LastName }", limit: 5 });
            if (matches.length === 1) {
              const aliases = await rockSearch(env, "personaliases", { where: `PersonId == ${matches[0].id}`, select: "new { Id }", limit: 1 });
              if (aliases[0]?.id) {
                authorAliasId = aliases[0].id;
                authorLabel = `${matches[0].nickName || matches[0].firstName || ""} ${matches[0].lastName || ""}`.trim() || String(authorEmail);
              }
            }
          } catch { /* attribution optional */ }
        }

        const caption = "Added via Claude";
        const body: Record<string, unknown> = {
          noteTypeId: noteType.id,
          entityId: person.id,
          text,
          caption,
          isPrivateNote: false,
          isAlert: false,
          ...(authorAliasId ? { createdByPersonAliasId: authorAliasId } : {}),
        };

        if (confirm !== true) {
          return {
            content: [{
              text:
                `PREVIEW — nothing has been written yet.\n\n` +
                `  Person:    ${personName} (Id ${person.id})${person.email ? ` — ${person.email}` : ""}\n` +
                `  Note type: ${noteType.name} (locked)\n` +
                `  Author:    ${authorLabel}\n` +
                `  Caption:   ${caption}\n` +
                `  Text:      ${text}\n\n` +
                `Re-run with confirm=true to write this note.`,
              type: "text",
            }],
          };
        }

        const res = await rockPost(env, "/api/v2/models/notes", body);
        if (!res.ok) {
          const hint = res.status === 401 ? " (check: Execute Write on Rock.Rest.v2.Models.NotesController for the MCP Write role, and that the note type itself allows this user to add notes)" : "";
          return { content: [{ text: `Write failed — Rock API ${res.status}${hint}: ${res.text.slice(0, 300)}`, type: "text" }] };
        }
        return { content: [{ text: `✓ Note added to ${personName} (Id ${person.id}) as "${noteType.name}", authored by ${authorLabel}.`, type: "text" }] };
      } catch (e: any) {
        return { content: [{ text: `Error adding note: ${e.message}. Nothing written.`, type: "text" }] };
      }
    },
  );
}
