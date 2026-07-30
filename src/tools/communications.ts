import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RockEnv, rockSearch, orIds } from "../rock";

// From Rock.Enums/Communication/ (v19.1 source)
const TRIGGER: Record<number, string> = { 1: "Recurring", 2: "On demand", 3: "One time" };
const STATUS: Record<number, string> = { 1: "Active", 2: "Inactive" };
const INACTIVE_REASON: Record<number, string> = {
  0: "unknown", 1: "unsubscribed", 2: "conversion goal met", 3: "opened communication",
  4: "clicked communication", 5: "completed (last email sent)", 6: "person inactivated",
  7: "unsubscribed from flow",
};
const COMM_TYPE: Record<number, string> = { 0: "Recipient preference", 1: "Email", 2: "SMS", 3: "Push" };

export function registerCommunications(server: McpServer, getEnv: () => RockEnv) {
  // --- Communication Flows -------------------------------------------------
  server.tool(
    "rock_get_communication_flows",
    "List PYC's Communication Flows (automated email journeys) with active/inactive status, trigger type, step count, and how many people are enrolled (no argument) — or drill into one flow by name to see its steps, instances, and where recipients ended up. Read-only.",
    { flow: z.string().optional().describe("Optional: flow name fragment to drill into. Omit for the overview.") },
    async ({ flow }) => {
      try {
        const env = getEnv();
        const flows = await rockSearch(env, "communicationflows", {
          select: "new { Id, Name, IsActive, Description, TriggerType, ConversionGoalTargetPercent, ConversionGoalTimeframeInDays }",
          sort: "Name",
          limit: 100,
        });
        if (flows.length === 0) return { content: [{ text: "No communication flows found in Rock.", type: "text" }] };

        // ---------- drill-in ----------
        if (flow && flow.trim() !== "") {
          const f = flow.trim().toLowerCase();
          const matches = flows.filter((x) => String(x.name || "").toLowerCase().includes(f));
          if (matches.length === 0)
            return { content: [{ text: `No flow matching "${flow}". Available:\n${flows.map((x) => `- ${x.name}`).join("\n")}`, type: "text" }] };
          if (matches.length > 1)
            return { content: [{ text: `Several flows match "${flow}" — which one?\n${matches.map((x) => `- ${x.name}`).join("\n")}`, type: "text" }] };
          const target = matches[0];

          const steps = await rockSearch(env, "communicationflowcommunications", {
            where: `CommunicationFlowId == ${target.id}`,
            select: "new { Id, Name, DaysToWait, TimeToSend, CommunicationType, Order }",
            sort: "Order",
            limit: 100,
          });
          const instances = await rockSearch(env, "communicationflowinstances", {
            where: `CommunicationFlowId == ${target.id}`,
            select: "new { Id, StartDate }",
            limit: 200,
          });
          const instIds = instances.map((i) => i.id).filter(Boolean);
          const recips: any[] = [];
          for (let i = 0; i < instIds.length; i += 50)
            recips.push(...(await rockSearch(env, "communicationflowinstancerecipients", {
              where: `(${orIds("CommunicationFlowInstanceId", instIds.slice(i, i + 50))})`,
              select: "new { Status, InactiveReason }",
              limit: 1000,
            })));

          const active = recips.filter((r) => r.status === 1).length;
          const inactive = recips.filter((r) => r.status !== 1);
          const byReason: Record<string, number> = {};
          for (const r of inactive) {
            const label = INACTIVE_REASON[r.inactiveReason as number] ?? `reason ${r.inactiveReason}`;
            byReason[label] = (byReason[label] || 0) + 1;
          }

          const stepLines = steps.length
            ? steps.map((s, i) => {
                const wait = s.daysToWait === 0 || s.daysToWait == null ? "immediately" : `after ${s.daysToWait} day${s.daysToWait === 1 ? "" : "s"}`;
                const t = s.timeToSend ? ` at ${String(s.timeToSend).slice(0, 5)}` : "";
                const ct = COMM_TYPE[s.communicationType as number] ? ` [${COMM_TYPE[s.communicationType as number]}]` : "";
                return `  ${i + 1}. ${s.name || "(unnamed)"}${ct} — sends ${wait}${t}`;
              })
            : ["  (no steps defined)"];

          const goal = target.conversionGoalTargetPercent
            ? `\nConversion goal: ${target.conversionGoalTargetPercent}%${target.conversionGoalTimeframeInDays ? ` within ${target.conversionGoalTimeframeInDays} days` : ""}`
            : "";
          const lastStart = instances
            .map((i) => i.startDate)
            .filter(Boolean)
            .sort()
            .slice(-1)[0];

          return {
            content: [{
              text:
                `${target.name} — ${target.isActive ? "ACTIVE" : "inactive"} · ${TRIGGER[target.triggerType as number] || `trigger ${target.triggerType}`}` +
                (target.description ? `\n${String(target.description).trim()}` : "") +
                goal +
                `\n\nSteps (${steps.length}):\n${stepLines.join("\n")}` +
                `\n\nRuns: ${instances.length} instance(s)${lastStart ? `, most recent started ${String(lastStart).slice(0, 10)}` : ""}` +
                `\nPeople: ${recips.length} enrolled — ${active} currently active, ${inactive.length} finished/exited` +
                (Object.keys(byReason).length ? `\n  ${Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join("\n  ")}` : ""),
              type: "text",
            }],
          };
        }

        // ---------- overview ----------
        const out: string[] = [];
        for (const f of flows) {
          const steps = await rockSearch(env, "communicationflowcommunications", { where: `CommunicationFlowId == ${f.id}`, select: "new { Id }", limit: 100 });
          const instances = await rockSearch(env, "communicationflowinstances", { where: `CommunicationFlowId == ${f.id}`, select: "new { Id }", limit: 200 });
          const instIds = instances.map((i) => i.id).filter(Boolean);
          let enrolled = 0;
          let active = 0;
          for (let i = 0; i < instIds.length; i += 50) {
            const rs = await rockSearch(env, "communicationflowinstancerecipients", { where: `(${orIds("CommunicationFlowInstanceId", instIds.slice(i, i + 50))})`, select: "new { Status }", limit: 1000 });
            enrolled += rs.length;
            active += rs.filter((r) => r.status === 1).length;
          }
          out.push(`• ${f.name} — ${f.isActive ? "ACTIVE" : "inactive"} · ${TRIGGER[f.triggerType as number] || `trigger ${f.triggerType}`} · ${steps.length} step(s) · ${enrolled} enrolled (${active} active)`);
        }
        return { content: [{ text: `Communication Flows:\n${out.join("\n")}\n\n(Ask for one by name to see its steps and where people ended up.)`, type: "text" }] };
      } catch (e: any) {
        return { content: [{ text: `Error getting communication flows: ${e.message}`, type: "text" }] };
      }
    },
  );

  // --- Communication Lists -------------------------------------------------
  server.tool(
    "rock_get_communication_lists",
    "List PYC's Communication Lists (subscriber lists) with their active member counts. Read-only. To see who's actually on a list, use rock_get_group_members with the list name.",
    {},
    async () => {
      try {
        const env = getEnv();
        const types = await rockSearch(env, "grouptypes", { where: `Name == "Communication List"`, select: "new { Id }", limit: 1 });
        const typeId = types[0]?.id;
        if (!typeId) return { content: [{ text: `Could not find a "Communication List" group type in Rock.`, type: "text" }] };
        const lists = await rockSearch(env, "groups", { where: `GroupTypeId == ${typeId} && IsArchived == false`, select: "new { Id, Name, IsActive }", sort: "Name", limit: 200 });
        if (lists.length === 0) return { content: [{ text: "No communication lists found.", type: "text" }] };
        const out: string[] = [];
        for (const l of lists) {
          const members = await rockSearch(env, "groupmembers", { where: `GroupId == ${l.id} && GroupMemberStatus == 1 && IsArchived == false`, select: "new { Id }", limit: 5000 });
          out.push(`• ${l.name}${l.isActive ? "" : " (inactive)"} — ${members.length} active subscriber(s)`);
        }
        return { content: [{ text: `Communication Lists:\n${out.join("\n")}`, type: "text" }] };
      } catch (e: any) {
        return { content: [{ text: `Error getting communication lists: ${e.message}`, type: "text" }] };
      }
    },
  );
}
