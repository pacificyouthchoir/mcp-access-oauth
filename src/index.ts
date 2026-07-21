import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { handleAccessRequest } from "./access-handler";
import type { Props } from "./workers-oauth-utils";
import { RockEnv } from "./rock";
import { registerFindPerson } from "./tools/find-person";
import { registerRoster } from "./tools/roster";
import { registerAttendance } from "./tools/attendance";
import { registerTuition } from "./tools/tuition";
import { registerRegistrations } from "./tools/registrations";
import { registerPersonGroups } from "./tools/person-groups";
import { registerGroupMembers } from "./tools/group-members";

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({ name: "PYC Rock MCP", version: "1.0.0" });

  async init() {
    const getEnv = () => this.env as unknown as RockEnv;
    registerFindPerson(this.server, getEnv);
    registerRoster(this.server, getEnv);
    registerAttendance(this.server, getEnv);
    registerTuition(this.server, getEnv);
    registerRegistrations(this.server, getEnv);
    registerPersonGroups(this.server, getEnv);
    registerGroupMembers(this.server, getEnv);
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
