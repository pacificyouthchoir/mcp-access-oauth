import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RockEnv, resolvePerson } from "../rock";

// Server-side allowlist. Anything not listed here is unreachable via this tool
// by construction. Excluded on purpose: Emergency Information (medical/allergy/
// insurance/emergency contact), Safety & Security (background-check results,
// DL number), Legal Notes, Social Media handles, Race/Ethnicity, Pronouns,
// School, Special Needs, Baptism, and psychometrics (DISC/EQ/Motivators/
// Spiritual Gifts/Growth/Conflict). Add a key here only deliberately.
const ALLOWED: Record<string, string> = {
  // — Giving Summary (Bloomerang) —
  BloomerangConstituentId: "Bloomerang Constituent Id",
  CreatedByBloomerangSync: "Created By Bloomerang Sync",
  FirstGiftDate: "First Gift Date",
  GiftCountTotal: "Gift Count Total",
  GivingCurrentFYTD: "Giving — Current FYTD",
  GivingPriorFY: "Giving — Prior FY",
  GivingTrailing12Mo: "Giving — Trailing 12 Mo",
  GivingLastSyncedDate: "Giving Last Synced",
  IsRecurringDonor: "Is Recurring Donor",
  LastGiftAmount: "Last Gift Amount",
  LastGiftDate: "Last Gift Date",
  LifetimeGiving: "Lifetime Giving",
  HH_FirstGiftDate: "Household — First Gift Date",
  HH_GiftCountTotal: "Household — Gift Count Total",
  HH_GivingCurrentFYTD: "Household — Giving Current FYTD",
  HH_GivingPriorFY: "Household — Giving Prior FY",
  HH_GivingTrailing12Mo: "Household — Giving Trailing 12 Mo",
  HH_IsRecurringDonor: "Household — Is Recurring Donor",
  HH_LastGiftAmount: "Household — Last Gift Amount",
  HH_LastGiftDate: "Household — Last Gift Date",
  HH_LifetimeGiving: "Household — Lifetime Giving",
  // — Giving Overview / analytics —
  CurrentJourneyGivingStage: "Current Giving Stage",
  PreviousJourneyGivingStage: "Previous Giving Stage",
  JourneyGivingStageChangeDate: "Giving Stage Changed",
  FrequencyLabel: "Gift Frequency Label",
  GiftAmountMedian: "Gift Amount: Median",
  GivingBin: "Giving Bin",
  GivingPercentile: "Giving Percentile",
  NextExpectedGiftDate: "Next Expected Gift",
  PercentofGiftsScheduled: "% of Gifts Scheduled",
  PreferredSource: "Preferred Source",
  DefaultSoftCredit: "Default Soft Credit",
  DoNotSendGivingStatement: "Do Not Send Giving Statement",
  core_GivingEnvelopeNumber: "Envelope Number",
  // — eRA / Family Analytics —
  core_CurrentlyAnEra: "Currently an eRA",
  core_EraStartDate: "eRA Start Date",
  core_EraEndDate: "eRA End Date",
  core_EraFirstGave: "First Gave",
  core_EraLastGave: "Last Gave",
  core_EraTimesGiven52Wks: "Times Given (52 wks)",
  core_EraTimesGiven6Wks: "Times Given (6 wks)",
  core_EraFirstCheckin: "First Checked-In",
  core_EraLastCheckin: "Last Checked-In",
  core_TimesCheckedIn16Wks: "Times Checked-In (16 wks)",
  // — Membership / source —
  MembershipDate: "Join Date",
  HowdidyouhearaboutPYC: "How did you hear about PYC?",
  FirstVisit: "First Visit",
  SecondVisit: "Second Visit",
  SourceofVisit: "Source of Visit",
  NotReturningSeason: "Not Returning (Season)",
  // — Employment (matching gifts / donor research) —
  Employer: "Employer",
  Position: "Position",
  // — Singer logistics (non-sensitive) —
  VoicePart: "Voice Part",
  "T-ShirtSize": "Shirt Size",
  // — Volunteer screening & training (compliance status) —
  ScreeningStatus: "Screening Status",
  ScreeningLevelCleared: "Screening Level Cleared",
  ScreeningClearedDate: "Screening Cleared Date",
  PolicyAckDate: "Policy & Code of Conduct Ack",
  SafeSportCoreDate: "SafeSport Core — Completed",
  SafeSportRefresherDate: "SafeSport Refresher — Last",
  OregonMandatoryReporterDate: "OR Mandatory Reporter — Completed",
  Tier3OrientationDate: "Tier 3 Orientation",
  YMHFADate: "YMHFA — Completed",
};

const GROUPS: Array<{ label: string; keys: string[] }> = [
  { label: "Giving (Bloomerang)", keys: ["LifetimeGiving", "GivingCurrentFYTD", "GivingPriorFY", "GivingTrailing12Mo", "GiftCountTotal", "FirstGiftDate", "LastGiftDate", "LastGiftAmount", "IsRecurringDonor", "BloomerangConstituentId", "CreatedByBloomerangSync", "GivingLastSyncedDate"] },
  { label: "Household giving", keys: ["HH_LifetimeGiving", "HH_GivingCurrentFYTD", "HH_GivingPriorFY", "HH_GivingTrailing12Mo", "HH_GiftCountTotal", "HH_FirstGiftDate", "HH_LastGiftDate", "HH_LastGiftAmount", "HH_IsRecurringDonor"] },
  { label: "Giving analytics", keys: ["CurrentJourneyGivingStage", "PreviousJourneyGivingStage", "JourneyGivingStageChangeDate", "GivingBin", "GivingPercentile", "GiftAmountMedian", "FrequencyLabel", "NextExpectedGiftDate", "PercentofGiftsScheduled", "PreferredSource", "DefaultSoftCredit", "DoNotSendGivingStatement", "core_GivingEnvelopeNumber"] },
  { label: "Engagement (eRA)", keys: ["core_CurrentlyAnEra", "core_EraStartDate", "core_EraEndDate", "core_EraFirstGave", "core_EraLastGave", "core_EraTimesGiven52Wks", "core_EraTimesGiven6Wks", "core_EraFirstCheckin", "core_EraLastCheckin", "core_TimesCheckedIn16Wks"] },
  { label: "Membership & source", keys: ["MembershipDate", "HowdidyouhearaboutPYC", "FirstVisit", "SecondVisit", "SourceofVisit", "NotReturningSeason"] },
  { label: "Employment", keys: ["Employer", "Position"] },
  { label: "Singer info", keys: ["VoicePart", "T-ShirtSize"] },
  { label: "Volunteer screening & training", keys: ["ScreeningStatus", "ScreeningLevelCleared", "ScreeningClearedDate", "PolicyAckDate", "SafeSportCoreDate", "SafeSportRefresherDate", "OregonMandatoryReporterDate", "Tier3OrientationDate", "YMHFADate"] },
];

async function rockGet(env: RockEnv, path: string): Promise<any> {
  const res = await fetch(`${env.ROCK_BASE_URL}${path}`, {
    headers: { "Authorization-Token": env.ROCK_API_KEY },
  });
  if (!res.ok) throw new Error(`Rock API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// Normalize whatever shape the endpoint returns into key -> displayable value.
function normalize(raw: any): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: any, v: any) => {
    if (!k) return;
    const key = String(k);
    let val = v;
    if (val && typeof val === "object") val = val.value ?? val.textValue ?? JSON.stringify(val);
    if (val === null || val === undefined || String(val).trim() === "") return;
    out[key] = String(val);
  };
  if (Array.isArray(raw)) {
    for (const item of raw) put(item?.key ?? item?.attributeKey ?? item?.Key, item?.value ?? item?.Value ?? item);
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) put(k, v);
  }
  return out;
}

export function registerAttributes(server: McpServer, getEnv: () => RockEnv) {
  server.tool(
    "rock_get_person_attributes",
    "Read a PYC person's donor, engagement, membership, and volunteer-compliance attributes (including Bloomerang giving summary and household roll-ups). Read-only. Returns only an approved set of non-sensitive fields; medical, legal, safety, social-media, demographic, and assessment attributes are intentionally not available through this tool.",
    {
      query: z.string().min(2).describe("Name or email of the person"),
      area: z.enum(["all", "giving", "volunteer", "membership"]).default("all").describe("Narrow the output: giving (donor + household + analytics + eRA), volunteer (screening/training), membership (join/source/singer info), or all."),
    },
    async ({ query, area }) => {
      try {
        const env = getEnv();
        const people = await resolvePerson(env, query);
        if (people.length === 0) return { content: [{ text: `No person found matching "${query}".`, type: "text" }] };
        if (people.length > 1)
          return { content: [{ text: `Multiple match "${query}" — narrow it:\n${people.map((p) => `- ${(p.nickName || p.firstName || "")} ${p.lastName || ""} (Id ${p.id})`).join("\n")}`, type: "text" }] };
        const person = people[0];
        const name = `${person.nickName || person.firstName || ""} ${person.lastName || ""}`.trim();

        const raw = await rockGet(env, `/api/v2/models/people/${person.id}/attributevalues`);
        const values = normalize(raw);

        const wanted = new Set<string>();
        for (const g of GROUPS) {
          const inArea =
            area === "all" ||
            (area === "giving" && ["Giving (Bloomerang)", "Household giving", "Giving analytics", "Engagement (eRA)"].includes(g.label)) ||
            (area === "volunteer" && g.label === "Volunteer screening & training") ||
            (area === "membership" && ["Membership & source", "Employment", "Singer info"].includes(g.label));
          if (inArea) for (const k of g.keys) wanted.add(k);
        }

        const sections: string[] = [];
        for (const g of GROUPS) {
          const lines = g.keys
            .filter((k) => wanted.has(k) && ALLOWED[k] && values[k] !== undefined)
            .map((k) => `  - ${ALLOWED[k]}: ${values[k]}`);
          if (lines.length) sections.push(`${g.label}:\n${lines.join("\n")}`);
        }

        if (sections.length === 0)
          return { content: [{ text: `${name}: no values set for the available attribute set${area === "all" ? "" : ` (area: ${area})`}.`, type: "text" }] };

        return { content: [{ text: `Attributes for ${name}${area === "all" ? "" : ` — ${area}`}:\n${sections.join("\n")}`, type: "text" }] };
      } catch (e: any) {
        return { content: [{ text: `Error getting attributes: ${e.message}`, type: "text" }] };
      }
    },
  );
}
