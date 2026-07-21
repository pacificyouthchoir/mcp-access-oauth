import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RockEnv, rockSearch, orIds, ANNUAL_ENROLLMENT_CATEGORY_ID } from "../rock";

export function registerRegistrations(server: McpServer, getEnv: () => RockEnv) {
  server.tool(
    "rock_get_registrations",
    "List PYC enrollment registration instances with registration + singer counts and open/close dates (no argument), or the registrants in one instance (pass an instance name fragment or numeric Id). Read-only. Scopes to the Annual Enrollment template category.",
    { instance: z.string().optional().describe("Optional: instance name fragment or numeric Id to drill into. Omit for the overview.") },
    async ({ instance }) => {
      try {
        const env = getEnv();
        const templates = await rockSearch(env, "registrationtemplates", { where: `CategoryId == ${ANNUAL_ENROLLMENT_CATEGORY_ID}`, select: "new { Id }", limit: 50 });
        const templateIds = templates.map((t) => t.id).filter(Boolean);
        if (templateIds.length === 0) return { content: [{ text: "No enrollment templates in the Annual Enrollment category.", type: "text" }] };
        const instances = await rockSearch(env, "registrationinstances", { where: `(${orIds("RegistrationTemplateId", templateIds)})`, select: "new { Id, Name, StartDateTime, EndDateTime, IsActive }", limit: 100 });
        if (instances.length === 0) return { content: [{ text: "No enrollment instances found.", type: "text" }] };
        if (instance && instance.trim() !== "") {
          const arg = instance.trim();
          const target = /^\d+$/.test(arg) ? instances.find((i) => i.id === Number(arg)) : instances.find((i) => String(i.name || "").toLowerCase().includes(arg.toLowerCase()));
          if (!target) return { content: [{ text: `No instance matching "${arg}". Available:\n${instances.map((i) => `- ${i.name} (Id ${i.id})`).join("\n")}`, type: "text" }] };
          const regs = await rockSearch(env, "registrations", { where: `RegistrationInstanceId == ${target.id}`, select: "new { Id, CreatedDateTime }", limit: 1000 });
          const regDate: Record<number, string> = {};
          for (const r of regs) regDate[r.id] = r.createdDateTime ? String(r.createdDateTime).slice(0, 10) : "";
          const regIds = regs.map((r) => r.id).filter(Boolean);
          if (regIds.length === 0) return { content: [{ text: `${target.name}: no registrations yet.`, type: "text" }] };
          const registrants: any[] = [];
          for (let i = 0; i < regIds.length; i += 50)
            registrants.push(...(await rockSearch(env, "registrationregistrants", { where: `(${orIds("RegistrationId", regIds.slice(i, i + 50))})`, select: "new { Id, RegistrationId, PersonAliasId, OnWaitList }", limit: 500 })));
          const aliasIds = [...new Set(registrants.map((r) => r.personAliasId).filter(Boolean))];
          const aliasToPerson: Record<number, number> = {};
          for (let i = 0; i < aliasIds.length; i += 50)
            for (const a of await rockSearch(env, "personaliases", { where: orIds("Id", aliasIds.slice(i, i + 50)), select: "new { Id, PersonId }", limit: 50 })) aliasToPerson[a.id] = a.personId;
          const personIds = [...new Set(Object.values(aliasToPerson))];
          const personName: Record<number, string> = {};
          for (let i = 0; i < personIds.length; i += 50)
            for (const p of await rockSearch(env, "people", { where: orIds("Id", personIds.slice(i, i + 50)), select: "new { Id, NickName, LastName }", limit: 50 })) personName[p.id] = `${p.nickName || ""} ${p.lastName || ""}`.trim();
          const lines = registrants.map((r) => {
            const pid = aliasToPerson[r.personAliasId];
            const nm = personName[pid] || `PersonAlias ${r.personAliasId}`;
            return `- ${nm}${r.onWaitList ? " [waitlist]" : ""}${regDate[r.registrationId] ? ` — registered ${regDate[r.registrationId]}` : ""} (PersonId ${pid ?? "?"})`;
          }).sort();
          return { content: [{ text: `${target.name} — ${registrants.length} registrant(s), ${regIds.length} registration(s):\n${lines.join("\n")}`, type: "text" }] };
        }
        const out: string[] = [];
        for (const inst of instances.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
          const regs = await rockSearch(env, "registrations", { where: `RegistrationInstanceId == ${inst.id}`, select: "new { Id }", limit: 1000 });
          const regIds = regs.map((r) => r.id).filter(Boolean);
          let singers = 0;
          for (let i = 0; i < regIds.length; i += 50)
            singers += (await rockSearch(env, "registrationregistrants", { where: `(${orIds("RegistrationId", regIds.slice(i, i + 50))})`, select: "new { Id }", limit: 500 })).length;
          const open = inst.startDateTime ? String(inst.startDateTime).slice(0, 10) : "—";
          const close = inst.endDateTime ? String(inst.endDateTime).slice(0, 10) : "—";
          out.push(`• ${inst.name}${inst.isActive ? "" : " (inactive)"}: ${regIds.length} registrations, ${singers} singers · ${open} → ${close}`);
        }
        return { content: [{ text: `Enrollment instances:\n${out.join("\n")}`, type: "text" }] };
      } catch (e: any) { return { content: [{ text: `Error getting registrations: ${e.message}`, type: "text" }] }; }
    },
  );
}
