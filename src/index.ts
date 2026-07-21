import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { handleAccessRequest } from "./access-handler";
import type { Props } from "./workers-oauth-utils";

type RockEnv = { ROCK_BASE_URL: string; ROCK_API_KEY: string };

const GROUP_IDS: Record<string, Record<string, number>> = {
  "23": { "nova 1": 2565, "nova 2": 2566, cascadia: 2567, pacific: 2568, chamber: 2571 },
  "24": { "nova 1": 9322, "nova 2": 9323, cascadia: 9324, pacific: 9325, chamber: 9326 },
};
const ENSEMBLE_BY_GROUP_ID: Record<number, string> = (() => {
  const m: Record<number, string> = {};
  for (const s of Object.keys(GROUP_IDS)) {
    const label = s === "24" ? "2026-27" : "2025-26";
    for (const [n, id] of Object.entries(GROUP_IDS[s])) m[id] = `${n.replace(/\b\w/g, (c) => c.toUpperCase())} ${label}`;
  }
  return m;
})();
const ANNUAL_ENROLLMENT_CATEGORY_ID = 305;
const orIds = (field: string, ids: number[]) => ids.slice(0, 50).map((id) => `${field} == ${id}`).join(" || ");
const sum = (a: any[], f: (x: any) => number) => a.reduce((t, x) => t + (Number(f(x)) || 0), 0);

async function rockSearch(env: RockEnv, entity: string, body: unknown): Promise<any[]> {
  const res = await fetch(`${env.ROCK_BASE_URL}/api/v2/models/${entity}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization-Token": env.ROCK_API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Rock API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return Array.isArray(data) ? data : (data.items ?? data.Items ?? []);
}
async function resolvePerson(env: RockEnv, query: string) {
  const q = query.replace(/["\\]/g, "").trim();
  return rockSearch(env, "people", {
    where: `FirstName.Contains("${q}") || LastName.Contains("${q}") || NickName.Contains("${q}") || Email.Contains("${q}")`,
    select: "new { Id, FirstName, LastName, NickName, Email }",
    limit: 10,
  });
}

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({ name: "PYC Rock MCP", version: "1.0.0" });

  async init() {
    // --- Tool 1: find a person ---
    this.server.tool(
      "rock_find_person",
      "Search PYC's Rock database for people by name or email fragment. Read-only.",
      { query: z.string().min(2).describe("Name or email fragment"), limit: z.number().int().min(1).max(50).default(10) },
      async ({ query, limit }) => {
        try {
          const env = this.env as unknown as RockEnv;
          const people = await resolvePerson(env, query);
          if (people.length === 0) return { content: [{ text: `No people found matching "${query}".`, type: "text" }] };
          const lines = people.slice(0, limit ?? 10).map((p) => `- ${(p.nickName || p.firstName || "")} ${p.lastName || ""} (Id ${p.id})${p.email ? ` — ${p.email}` : ""}`);
          return { content: [{ text: `Found ${people.length} match(es):\n${lines.join("\n")}`, type: "text" }] };
        } catch (e: any) { return { content: [{ text: `Error: ${e.message}`, type: "text" }] }; }
      },
    );

    // --- Tool 2: ensemble roster ---
    this.server.tool(
      "rock_get_roster",
      "Get the active roster of a PYC ensemble for a season. Read-only.",
      { ensemble: z.enum(["Nova 1", "Nova 2", "Cascadia", "Pacific", "Chamber"]), season: z.enum(["23", "24"]).default("24") },
      async ({ ensemble, season }) => {
        try {
          const env = this.env as unknown as RockEnv;
          const groupId = GROUP_IDS[season]?.[ensemble.toLowerCase()];
          if (!groupId) return { content: [{ text: `No group ID for ${ensemble}/${season}.`, type: "text" }] };
          const members = await rockSearch(env, "groupmembers", { where: `GroupId == ${groupId} && GroupMemberStatus == 1 && IsArchived == false`, select: "new { PersonId }", limit: 300 });
          const ids = [...new Set(members.map((m) => m.personId).filter(Boolean))];
          if (ids.length === 0) return { content: [{ text: `No active members in ${ensemble} (${season}).`, type: "text" }] };
          const people: any[] = [];
          for (let i = 0; i < ids.length; i += 50)
            people.push(...(await rockSearch(env, "people", { where: orIds("Id", ids.slice(i, i + 50)), select: "new { Id, FirstName, LastName, NickName, Email }", limit: 50 })));
          people.sort((a, b) => (a.lastName || "").localeCompare(b.lastName || ""));
          const lines = people.map((p) => `- ${(p.nickName || p.firstName || "")} ${p.lastName || ""}${p.email ? ` — ${p.email}` : ""}`);
          const label = season === "24" ? "2026-27" : "2025-26";
          return { content: [{ text: `${ensemble} — ${label} (${people.length}):\n${lines.join("\n")}`, type: "text" }] };
        } catch (e: any) { return { content: [{ text: `Error: ${e.message}`, type: "text" }] }; }
      },
    );

    // --- Tool 3: recent attendance ---
    this.server.tool(
      "rock_get_person_attendance",
      "Show a PYC person's recent attendance (present/absent) with dates and ensemble. Read-only.",
      { query: z.string().min(2), limit: z.number().int().min(1).max(50).default(10) },
      async ({ query, limit }) => {
        try {
          const env = this.env as unknown as RockEnv;
          const people = await resolvePerson(env, query);
          if (people.length === 0) return { content: [{ text: `No person found matching "${query}".`, type: "text" }] };
          if (people.length > 1) return { content: [{ text: `Multiple match "${query}":\n${people.map((p) => `- ${(p.nickName || p.firstName || "")} ${p.lastName || ""} (Id ${p.id})`).join("\n")}`, type: "text" }] };
          const person = people[0];
          const name = `${person.nickName || person.firstName || ""} ${person.lastName || ""}`.trim();
          const aliases = await rockSearch(env, "personaliases", { where: `PersonId == ${person.id}`, select: "new { Id }", limit: 50 });
          const aliasIds = aliases.map((a) => a.id).filter(Boolean);
          if (aliasIds.length === 0) return { content: [{ text: `No attendance for ${name}.`, type: "text" }] };
          const rows = await rockSearch(env, "attendances", { where: orIds("PersonAliasId", aliasIds), select: "new { DidAttend, StartDateTime, OccurrenceId }", sort: "StartDateTime desc", limit: limit ?? 10 });
          if (rows.length === 0) return { content: [{ text: `No attendance for ${name}.`, type: "text" }] };
          const occMap: Record<number, number> = {};
          try {
            const occIds = [...new Set(rows.map((r) => r.occurrenceId).filter(Boolean))];
            if (occIds.length) for (const o of await rockSearch(env, "attendanceoccurrences", { where: orIds("Id", occIds), select: "new { Id, GroupId }", limit: 50 })) occMap[o.id] = o.groupId;
          } catch {}
          const lines = rows.map((r) => {
            const date = r.startDateTime ? String(r.startDateTime).slice(0, 10) : "(no date)";
            const status = r.didAttend === true ? "Present" : r.didAttend === false ? "Absent" : "—";
            const ens = ENSEMBLE_BY_GROUP_ID[occMap[r.occurrenceId]] ? ` — ${ENSEMBLE_BY_GROUP_ID[occMap[r.occurrenceId]]}` : "";
            return `- ${date} — ${status}${ens}`;
          });
          return { content: [{ text: `Recent attendance for ${name} (last ${rows.length}):\n${lines.join("\n")}`, type: "text" }] };
        } catch (e: any) { return { content: [{ text: `Error: ${e.message}`, type: "text" }] }; }
      },
    );

    // --- Tool 4: tuition balance + payment-plan health (evergreen) ---
    // VALIDATE against Singer Dashboard before trusting the numbers.
    this.server.tool(
      "rock_get_tuition_balance",
      "Compute a PYC family's tuition balance (total due minus payments), including payment-plan details when present. Read-only. Discovers tuition templates by the Annual Enrollment category (new seasons auto-included). Matches a person as parent/registrar or singer/registrant.",
      { query: z.string().min(2).describe("Name or email of a family member (parent or singer)") },
      async ({ query }) => {
        try {
          const env = this.env as unknown as RockEnv;
          const templates = await rockSearch(env, "registrationtemplates", { where: `CategoryId == ${ANNUAL_ENROLLMENT_CATEGORY_ID}`, select: "new { Id, Name }", limit: 50 });
          const templateIds = templates.map((t) => t.id).filter(Boolean);
          const templateName: Record<number, string> = {};
          for (const t of templates) templateName[t.id] = t.name;
          if (templateIds.length === 0) return { content: [{ text: `No tuition templates found in the Annual Enrollment category.`, type: "text" }] };

          const people = await resolvePerson(env, query);
          if (people.length === 0) return { content: [{ text: `No person found matching "${query}".`, type: "text" }] };
          if (people.length > 1) return { content: [{ text: `Multiple match "${query}" — narrow it:\n${people.map((p) => `- ${(p.nickName || p.firstName || "")} ${p.lastName || ""} (Id ${p.id})`).join("\n")}`, type: "text" }] };
          const person = people[0];
          const name = `${person.nickName || person.firstName || ""} ${person.lastName || ""}`.trim();

          const aliases = await rockSearch(env, "personaliases", { where: `PersonId == ${person.id}`, select: "new { Id }", limit: 50 });
          const aliasIds = aliases.map((a) => a.id).filter(Boolean);
          if (aliasIds.length === 0) return { content: [{ text: `No tuition registrations found for ${name}.`, type: "text" }] };

          const asRegistrar = await rockSearch(env, "registrations", { where: `(${orIds("PersonAliasId", aliasIds)})`, select: "new { Id }", limit: 100 });
          const asRegistrant = await rockSearch(env, "registrationregistrants", { where: `(${orIds("PersonAliasId", aliasIds)})`, select: "new { RegistrationId }", limit: 200 });
          const regIds = [...new Set([...asRegistrar.map((r) => r.id), ...asRegistrant.map((r) => r.registrationId)].filter(Boolean))];
          if (regIds.length === 0) return { content: [{ text: `No tuition registrations found for ${name}.`, type: "text" }] };

          const regs: any[] = [];
          for (let i = 0; i < regIds.length; i += 50)
            regs.push(...(await rockSearch(env, "registrations", { where: `(${orIds("Id", regIds.slice(i, i + 50))}) && (${orIds("RegistrationTemplateId", templateIds)})`, select: "new { Id, RegistrationTemplateId, DiscountAmount, DiscountPercentage, FirstName, LastName, PaymentPlanFinancialScheduledTransactionId }", limit: 100 })));
          if (regs.length === 0) return { content: [{ text: `No current tuition registrations found for ${name}.`, type: "text" }] };

          const etype = await rockSearch(env, "entitytypes", { where: `Name == "Rock.Model.Registration"`, select: "new { Id }", limit: 1 });
          const regTypeId = etype[0]?.id;

          const out: string[] = [];
          let familyBalance = 0;
          for (const reg of regs) {
            const registrants = await rockSearch(env, "registrationregistrants", { where: `RegistrationId == ${reg.id}`, select: "new { Id, Cost, DiscountApplies }", limit: 100 });
            const registrantIds = registrants.map((r) => r.id).filter(Boolean);
            let feeSum = 0;
            if (registrantIds.length) {
              const fees = await rockSearch(env, "registrationregistrantfees", { where: `(${orIds("RegistrationRegistrantId", registrantIds)})`, select: "new { Cost, Quantity }", limit: 200 });
              feeSum = sum(fees, (f) => (Number(f.cost) || 0) * (Number(f.quantity) || 0));
            }
            const gross = sum(registrants, (r) => r.cost) + feeSum;
            const eligible = registrants.filter((r) => r.discountApplies === true).length;
            const discount = (Number(reg.discountAmount) || 0) * eligible + gross * (Number(reg.discountPercentage) || 0);
            const totalDue = gross - discount;

            let paid = 0;
            if (regTypeId) {
              const details = await rockSearch(env, "financialtransactiondetails", { where: `EntityTypeId == ${regTypeId} && EntityId == ${reg.id}`, select: "new { Amount }", limit: 500 });
              paid = sum(details, (d) => d.amount);
            }
            const balance = totalDue - paid;
            familyBalance += balance;

            // payment plan follow-through
            let planLine = "";
            const planId = reg.paymentPlanFinancialScheduledTransactionId;
            if (planId) {
              try {
                const st = (await rockSearch(env, "financialscheduledtransactions", { where: `Id == ${planId}`, select: "new { NumberOfPayments, NextPaymentDate, TransactionFrequencyValueId, IsActive }", limit: 1 }))[0];
                const pd = await rockSearch(env, "financialscheduledtransactiondetails", { where: `ScheduledTransactionId == ${planId}`, select: "new { Amount }", limit: 50 });
                const perPayment = sum(pd, (d) => d.amount);
                let freq = "";
                try {
                  if (st?.transactionFrequencyValueId) {
                    const dv = (await rockSearch(env, "definedvalues", { where: `Id == ${st.transactionFrequencyValueId}`, select: "new { Value }", limit: 1 }))[0];
                    if (dv?.value) freq = ` ${String(dv.value).toLowerCase()}`;
                  }
                } catch {}
                const next = st?.nextPaymentDate ? String(st.nextPaymentDate).slice(0, 10) : null;
                const overdue = next && st?.isActive && new Date(st.nextPaymentDate).getTime() < Date.now() ? " ⚠ next payment appears overdue — verify in Rock" : "";
                planLine = `\n   ↳ payment plan (${st?.isActive ? "active" : "inactive"}): $${perPayment.toFixed(2)}${freq}, ${st?.numberOfPayments ?? "?"} payments${next ? `, next due ${next}` : ""}${overdue}`;
              } catch (e: any) {
                planLine = `\n   ↳ on a payment plan (plan details unavailable: ${e.message})`;
              }
            }

            const label = templateName[reg.registrationTemplateId] || `template ${reg.registrationTemplateId}`;
            const paidFull = balance <= 5 ? " ✓ paid in full" : "";
            out.push(`• Reg ${reg.id} — ${label} (${reg.firstName || ""} ${reg.lastName || ""}): due $${totalDue.toFixed(2)}, paid $${paid.toFixed(2)}, balance $${balance.toFixed(2)}${paidFull}${planLine}`);
          }
          return { content: [{ text: `Tuition for ${name}:\n${out.join("\n")}\n\nFamily balance: $${familyBalance.toFixed(2)}`, type: "text" }] };
        } catch (e: any) { return { content: [{ text: `Error getting tuition balance: ${e.message}`, type: "text" }] }; }
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
