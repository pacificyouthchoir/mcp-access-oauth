import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RockEnv, rockSearch, resolvePerson, orIds, sum, ANNUAL_ENROLLMENT_CATEGORY_ID } from "../rock";

export function registerTuition(server: McpServer, getEnv: () => RockEnv) {
  server.tool(
    "rock_get_tuition_balance",
    "Compute a PYC family's tuition balance (total due minus payments), including payment-plan details. Read-only. Discovers tuition templates by the Annual Enrollment category. Matches a person as parent/registrar or singer/registrant.",
    { query: z.string().min(2).describe("Name or email of a family member (parent or singer)") },
    async ({ query }) => {
      try {
        const env = getEnv();
        const templates = await rockSearch(env, "registrationtemplates", { where: `CategoryId == ${ANNUAL_ENROLLMENT_CATEGORY_ID}`, select: "new { Id, Name }", limit: 50 });
        const templateIds = templates.map((t) => t.id).filter(Boolean);
        const templateName: Record<number, string> = {};
        for (const t of templates) templateName[t.id] = t.name;
        if (templateIds.length === 0) return { content: [{ text: `No tuition templates in the Annual Enrollment category.`, type: "text" }] };
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
        if (regs.length === 0) return { content: [{ text: `No current tuition registrations for ${name}.`, type: "text" }] };
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
