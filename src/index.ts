import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { handleAccessRequest } from "./access-handler";
import type { Props } from "./workers-oauth-utils";

// --- Rock REST client -------------------------------------------------------
async function rockFindPeople(
  env: { ROCK_BASE_URL: string; ROCK_API_KEY: string },
  query: string,
  limit: number,
): Promise<any[]> {
  const q = query.replace(/["\\]/g, "").trim();
  const body = {
    where:
      `FirstName.Contains("${q}") ` +
      `|| LastName.Contains("${q}") ` +
      `|| NickName.Contains("${q}") ` +
      `|| Email.Contains("${q}")`,
    select: "new { Id, FirstName, LastName, NickName, Email }",
    sort: "LastName, FirstName",
    limit,
  };
  const res = await fetch(`${env.ROCK_BASE_URL}/api/v2/models/people/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization-Token": env.ROCK_API_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Rock API ${res.status}: ${text.slice(0, 300)}`);
  }
  const data: any = await res.json();
  return Array.isArray(data) ? data : (data.items ?? data.Items ?? []);
}

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "PYC Rock MCP",
    version: "1.0.0",
  });

  async init() {
    this.server.tool(
      "rock_find_person",
      "Search Pacific Youth Choir's Rock database for people by name or email fragment. Read-only. Returns matching people with their Rock Id, name, nickname, and email.",
      {
        query: z
          .string()
          .min(2)
          .describe("Name or email fragment, e.g. 'Hansen' or 'chris@'"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Max number of people to return (default 10)"),
      },
      async ({ query, limit }) => {
        try {
          const env = this.env as unknown as {
            ROCK_BASE_URL: string;
            ROCK_API_KEY: string;
          };
          const people = await rockFindPeople(env, query, limit ?? 10);
          if (people.length === 0) {
            return {
              content: [{ text: `No people found matching "${query}".`, type: "text" }],
            };
          }
          const lines = people.map((p) => {
            const name = `${p.nickName || p.firstName || ""} ${p.lastName || ""}`.trim();
            return `- ${name} (Id ${p.id})${p.email ? ` — ${p.email}` : ""}`;
          });
          return {
            content: [
              {
                text: `Found ${people.length} match(es) for "${query}":\n${lines.join("\n")}`,
                type: "text",
              },
            ],
          };
        } catch (err: any) {
          return { content: [{ text: `Error searching Rock: ${err.message}`, type: "text" }] };
        }
      },
    );
  }
}

export default new OAuthProvider({
  apiHandler: MyMCP.serve("/mcp"),
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: { fetch: handleAccessRequest as any },
  tokenEndpoint: "/token",
});
