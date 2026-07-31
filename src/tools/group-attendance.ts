import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RockEnv, rockSearch, orIds } from "../rock";

export function registerGroupAttendance(server: McpServer, getEnv: () => RockEnv) {
  server.tool(
    "rock_get_group_attendance",
    "Attendance for ANY PYC group or event by name — rehearsals, retreats, gala, dress rehearsals, volunteer teams. Read-only. With no date, returns recent occurrences with turnout counts; with a date, returns who was present and who was absent that day.",
    {
      group: z.string().min(2).describe("Group/event name fragment, e.g. 'Cascadia', 'gala', 'retreat'"),
      date: z.string().optional().describe("Optional: a specific occurrence date, YYYY-MM-DD. Omit for a turnout summary."),
      occurrences: z.number().int().min(1).max(20).default(6).describe("How many recent occurrences to summarize (default 6)"),
    },
    async ({ group, date, occurrences }) => {
      try {
        const env = getEnv();
        const q = group.replace(/["\\]/g, "").trim();
        const matches = await rockSearch(env, "groups", { where: `Name.Contains("${q}")`, select: "new { Id, Name, IsActive, IsArchived }", limit: 50 });
        if (matches.length === 0) return { content: [{ text: `No group matching "${group}".`, type: "text" }] };
        const active = matches.filter((g) => g.isActive === true && g.isArchived !== true);
        let target: any;
        if (active.length === 1) target = active[0];
        else if (active.length > 1)
          return { content: [{ text: `Several active groups match "${group}" — which one?\n${active.map((g) => `- ${g.name} (Id ${g.id})`).join("\n")}`, type: "text" }] };
        else
          return { content: [{ text: `No active group matches "${group}". These exist:\n${matches.map((g) => `- ${g.name} (Id ${g.id}${g.isArchived ? ", archived" : ", inactive"})`).join("\n")}`, type: "text" }] };

        const occs = await rockSearch(env, "attendanceoccurrences", {
          where: `GroupId == ${target.id}`,
          select: "new { Id, OccurrenceDate, DidNotOccur, Notes }",
          sort: "OccurrenceDate desc",
          limit: 200,
        });
        if (occs.length === 0) return { content: [{ text: `${target.name}: no attendance occurrences recorded.`, type: "text" }] };

        // ---------- one specific date ----------
        if (date && date.trim() !== "") {
          const d = date.trim().slice(0, 10);
          const occ = occs.find((o) => String(o.occurrenceDate || "").slice(0, 10) === d);
          if (!occ)
            return { content: [{ text: `No ${target.name} occurrence on ${d}. Recent dates: ${occs.slice(0, 10).map((o) => String(o.occurrenceDate).slice(0, 10)).join(", ")}`, type: "text" }] };
          if (occ.didNotOccur) return { content: [{ text: `${target.name} on ${d}: marked as did not occur.`, type: "text" }] };

          const rows = await rockSearch(env, "attendances", { where: `OccurrenceId == ${occ.id}`, select: "new { PersonAliasId, DidAttend }", limit: 500 });
          if (rows.length === 0) return { content: [{ text: `${target.name} on ${d}: no attendance recorded.`, type: "text" }] };
          const aliasIds = [...new Set(rows.map((r) => r.personAliasId).filter(Boolean))];
          const aliasToPerson: Record<number, number> = {};
          for (let i = 0; i < aliasIds.length; i += 50)
            for (const a of await rockSearch(env, "personaliases", { where: orIds("Id", aliasIds.slice(i, i + 50)), select: "new { Id, PersonId }", limit: 50 })) aliasToPerson[a.id] = a.personId;
          const pids = [...new Set(Object.values(aliasToPerson))];
          const pname: Record<number, string> = {};
          for (let i = 0; i < pids.length; i += 50)
            for (const p of await rockSearch(env, "people", { where: orIds("Id", pids.slice(i, i + 50)), select: "new { Id, NickName, FirstName, LastName }", limit: 50 }))
              pname[p.id] = `${p.nickName || p.firstName || ""} ${p.lastName || ""}`.trim();

          const nameOf = (r: any) => pname[aliasToPerson[r.personAliasId]] || `Alias ${r.personAliasId}`;
          const present = rows.filter((r) => r.didAttend === true).map(nameOf).sort();
          const absent = rows.filter((r) => r.didAttend === false).map(nameOf).sort();
          const pct = rows.length ? Math.round((present.length / rows.length) * 100) : 0;
          return {
            content: [{
              text:
                `${target.name} — ${d}\n${present.length} present, ${absent.length} absent (${pct}% turnout)` +
                (occ.notes ? `\nNote: ${String(occ.notes).trim().slice(0, 200)}` : "") +
                (present.length ? `\n\nPresent:\n${present.map((n) => `- ${n}`).join("\n")}` : "") +
                (absent.length ? `\n\nAbsent:\n${absent.map((n) => `- ${n}`).join("\n")}` : ""),
              type: "text",
            }],
          };
        }

        // ---------- summary across recent occurrences ----------
        const take = occs.slice(0, occurrences ?? 6);
        const lines: string[] = [];
        for (const o of take) {
          const d = String(o.occurrenceDate || "").slice(0, 10);
          if (o.didNotOccur) { lines.push(`- ${d} — did not occur`); continue; }
          const rows = await rockSearch(env, "attendances", { where: `OccurrenceId == ${o.id}`, select: "new { DidAttend }", limit: 500 });
          const present = rows.filter((r) => r.didAttend === true).length;
          const total = rows.length;
          const pct = total ? Math.round((present / total) * 100) : 0;
          lines.push(`- ${d} — ${present}/${total} present (${pct}%)`);
        }
        return { content: [{ text: `${target.name} — last ${take.length} occurrence(s):\n${lines.join("\n")}\n\n(Ask for a specific date to see who was present and absent.)`, type: "text" }] };
      } catch (e: any) {
        return { content: [{ text: `Error getting group attendance: ${e.message}`, type: "text" }] };
      }
    },
  );
}
