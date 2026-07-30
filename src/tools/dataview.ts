import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RockEnv, rockSearch, rockGet, orIds } from "../rock";

export function registerDataView(server: McpServer, getEnv: () => RockEnv) {
  server.tool(
    "rock_run_dataview",
    "Run a saved Rock Data View and return who's in it — this is how to answer segment questions like 'all lapsed donors' or 'families with an outstanding balance'. Read-only. Call with no argument to list the available Data Views, or pass a name fragment to run one. Segments are defined in Rock's UI, so any new Data View is instantly usable here.",
    {
      dataview: z.string().optional().describe("Name fragment of the Data View to run. Omit to list what's available."),
      limit: z.number().int().min(1).max(200).default(50).describe("Max people to list individually (default 50). The total count is always reported."),
    },
    async ({ dataview, limit }) => {
      try {
        const env = getEnv();
        const views = await rockSearch(env, "dataviews", {
          select: "new { Id, Name, Description, EntityTypeId, CategoryId }",
          sort: "Name",
          limit: 300,
        });
        if (views.length === 0) return { content: [{ text: "No Data Views found in Rock.", type: "text" }] };

        // entity type names (so we know which views return people)
        const etIds = [...new Set(views.map((v) => v.entityTypeId).filter(Boolean))];
        const etName: Record<number, string> = {};
        for (let i = 0; i < etIds.length; i += 50)
          for (const t of await rockSearch(env, "entitytypes", { where: orIds("Id", etIds.slice(i, i + 50)), select: "new { Id, FriendlyName, Name }", limit: 50 }))
            etName[t.id] = t.friendlyName || String(t.name || "").split(".").pop() || "?";

        // ---------- list mode ----------
        if (!dataview || dataview.trim() === "") {
          const personViews = views.filter((v) => String(etName[v.entityTypeId] || "").toLowerCase().includes("person"));
          const others = views.length - personViews.length;
          const lines = personViews.map((v) => `- ${v.name}${v.description ? ` — ${String(v.description).trim().slice(0, 90)}` : ""}`);
          return {
            content: [{
              text:
                (personViews.length
                  ? `Person Data Views (${personViews.length}):\n${lines.join("\n")}`
                  : "No person-based Data Views found.") +
                (others > 0 ? `\n\n(${others} other Data View(s) target non-person entities.)` : "") +
                `\n\nAsk me to run one by name to see who's in it.`,
              type: "text",
            }],
          };
        }

        // ---------- run mode ----------
        const q = dataview.trim().toLowerCase();
        const matches = views.filter((v) => String(v.name || "").toLowerCase().includes(q));
        if (matches.length === 0)
          return { content: [{ text: `No Data View matching "${dataview}". Ask with no argument to see the list.`, type: "text" }] };
        if (matches.length > 1)
          return { content: [{ text: `Several Data Views match "${dataview}" — which one?\n${matches.map((v) => `- ${v.name}`).join("\n")}`, type: "text" }] };
        const view = matches[0];
        const entity = etName[view.entityTypeId] || "?";

        const contents = await rockGet(env, `/api/v2/models/dataviews/actions/contents/${view.id}`);
        const items: any[] = Array.isArray(contents) ? contents : (contents?.items ?? []);
        const ids = items.map((i) => i?.id ?? i?.Id).filter((x) => typeof x === "number");
        if (ids.length === 0)
          return { content: [{ text: `"${view.name}" returned no results.`, type: "text" }] };

        if (!entity.toLowerCase().includes("person")) {
          return { content: [{ text: `"${view.name}" (${entity}) returned ${ids.length} record(s). This Data View targets ${entity}, not people, so I can only report the count and ids: ${ids.slice(0, 25).join(", ")}${ids.length > 25 ? "…" : ""}`, type: "text" }] };
        }

        const cap = limit ?? 50;
        const show = ids.slice(0, cap);
        const people: any[] = [];
        for (let i = 0; i < show.length; i += 50)
          people.push(...(await rockSearch(env, "people", { where: orIds("Id", show.slice(i, i + 50)), select: "new { Id, NickName, FirstName, LastName, Email }", limit: 50 })));
        people.sort((a, b) => String(a.lastName || "").localeCompare(String(b.lastName || "")));
        const lines = people.map((p) => `- ${(p.nickName || p.firstName || "")} ${p.lastName || ""}${p.email ? ` — ${p.email}` : ""} (Id ${p.id})`);
        const more = ids.length > show.length ? `\n\n(${ids.length - show.length} more not listed — raise limit to see them.)` : "";
        return {
          content: [{
            text: `${view.name} — ${ids.length} ${ids.length === 1 ? "person" : "people"}${view.description ? `\n${String(view.description).trim()}` : ""}\n\n${lines.join("\n")}${more}`,
            type: "text",
          }],
        };
      } catch (e: any) {
        return { content: [{ text: `Error running Data View: ${e.message}`, type: "text" }] };
      }
    },
  );
}
