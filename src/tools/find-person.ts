import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RockEnv, resolvePerson } from "../rock";

export function registerFindPerson(server: McpServer, getEnv: () => RockEnv) {
  server.tool(
    "rock_find_person",
    "Search PYC's Rock database for people by name or email fragment. Read-only.",
    { query: z.string().min(2).describe("Name or email fragment"), limit: z.number().int().min(1).max(50).default(10) },
    async ({ query, limit }) => {
      try {
        const people = await resolvePerson(getEnv(), query);
        if (people.length === 0) return { content: [{ text: `No people found matching "${query}".`, type: "text" }] };
        const lines = people.slice(0, limit ?? 10).map((p) => `- ${(p.nickName || p.firstName || "")} ${p.lastName || ""} (Id ${p.id})${p.email ? ` — ${p.email}` : ""}`);
        return { content: [{ text: `Found ${people.length} match(es):\n${lines.join("\n")}`, type: "text" }] };
      } catch (e: any) { return { content: [{ text: `Error: ${e.message}`, type: "text" }] }; }
    },
  );
}
