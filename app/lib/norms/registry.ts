// TODO: check values against the official SP RK text

export type NormRuleStatus = "operator" | "unverified";

export type NormRule = {
  id: string;
  domain: "placement" | "utility" | "insolation" | "tep" | "sgp" | "vertical";
  title: string;
  document: string;
  clause: string;
  /** Edition the values were taken from, as stated by whoever entered them */
  editionDate: string;
  /** When the rule was added to the registry */
  addedAt: string;
  verifiedBy: NormRuleStatus;
  applicability: string;
  parameters: Record<string, number | string>;
  sourceUrl?: string;
  notes?: string;
};

export const PLANNING_DOCUMENT = "SP RK 3.01-101-2013*";

const rules: NormRule[] = [
  {
    id: "utility.water-supply",
    domain: "utility",
    title: "Distance from building to water supply",
    document: PLANNING_DOCUMENT,
    clause: "table of distances to utilities",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Water supply and pressure sewer outside the foundation zone",
    parameters: { distanceMeters: 5 },
    notes: "Typical value; check against the current edition before confirming.",
  },
  {
    id: "utility.sewer",
    domain: "utility",
    title: "Distance from building to gravity sewer",
    document: PLANNING_DOCUMENT,
    clause: "table of distances to utilities",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Domestic and storm gravity sewer",
    parameters: { distanceMeters: 3 },
    notes: "Typical value; check against the current edition before confirming.",
  },
  {
    id: "utility.drainage",
    domain: "utility",
    title: "Distance from building to drainage and irrigation ditches",
    document: PLANNING_DOCUMENT,
    clause: "table of distances to utilities",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Drainage lines, irrigation ditches, gutters",
    parameters: { distanceMeters: 3 },
    notes: "Typical value; check against the current edition before confirming.",
  },
  {
    id: "utility.gas-low",
    domain: "utility",
    title: "Distance from building to low-pressure gas pipeline",
    document: PLANNING_DOCUMENT,
    clause: "table of distances to utilities",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Low-pressure gas pipeline",
    parameters: { distanceMeters: 2 },
    notes: "Typical value; check against the current edition before confirming.",
  },
  {
    id: "utility.gas-medium",
    domain: "utility",
    title: "Distance from building to medium-pressure gas pipeline",
    document: PLANNING_DOCUMENT,
    clause: "table of distances to utilities",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Medium-pressure gas pipeline",
    parameters: { distanceMeters: 4 },
    notes: "Typical value; check against the current edition before confirming.",
  },
  {
    id: "utility.gas-high",
    domain: "utility",
    title: "Distance from building to high-pressure gas pipeline",
    document: PLANNING_DOCUMENT,
    clause: "table of distances to utilities",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability:
      "High-pressure gas pipeline; also the conservative value for a gas pipeline with unspecified pressure",
    parameters: { distanceMeters: 7 },
    notes: "Typical value; check against the current edition before confirming.",
  },
  {
    id: "utility.heat",
    domain: "utility",
    title: "Distance from building to heating networks",
    document: PLANNING_DOCUMENT,
    clause: "table of distances to utilities",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Heating networks (from the outer wall of the duct or casing)",
    parameters: { distanceMeters: 5 },
    notes: "Typical value; check against the current edition before confirming.",
  },
  {
    id: "utility.power-cable",
    domain: "utility",
    title: "Distance from building to power cables",
    document: PLANNING_DOCUMENT,
    clause: "table of distances to utilities",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Underground power cables of all voltages",
    parameters: { distanceMeters: 0.6 },
    notes: "Typical value; check against the current edition before confirming.",
  },
  {
    id: "utility.communication",
    domain: "utility",
    title: "Distance from building to communication cables",
    document: PLANNING_DOCUMENT,
    clause: "table of distances to utilities",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Communication cables and low-voltage networks",
    parameters: { distanceMeters: 0.6 },
    notes: "Typical value; check against the current edition before confirming.",
  },
  {
    id: "utility.overhead-0_4",
    domain: "utility",
    title: "Overhead line protection zone, up to 1 kV",
    document: "Rules for the protection of electrical networks",
    clause: "protection zones of overhead lines",
    editionDate: "typical edition",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Overhead line up to 1 kV",
    parameters: { distanceMeters: 2 },
    notes:
      "Measured from the outermost wires; applied here from the surveyed centerline as a conservative approximation.",
  },
  {
    id: "utility.overhead-10",
    domain: "utility",
    title: "Overhead line protection zone, 1–20 kV",
    document: "Rules for the protection of electrical networks",
    clause: "protection zones of overhead lines",
    editionDate: "typical edition",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Overhead line 1–20 kV; also overhead lines with unspecified voltage",
    parameters: { distanceMeters: 10 },
    notes:
      "Measured from the outermost wires; applied here from the surveyed centerline as a conservative approximation.",
  },
  {
    id: "utility.overhead-35",
    domain: "utility",
    title: "Overhead line protection zone, 35 kV",
    document: "Rules for the protection of electrical networks",
    clause: "protection zones of overhead lines",
    editionDate: "typical edition",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Overhead line 35 kV",
    parameters: { distanceMeters: 15 },
  },
  {
    id: "utility.overhead-110",
    domain: "utility",
    title: "Overhead line protection zone, 110 kV",
    document: "Rules for the protection of electrical networks",
    clause: "protection zones of overhead lines",
    editionDate: "typical edition",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Overhead line 110 kV",
    parameters: { distanceMeters: 20 },
  },
  {
    id: "tep.loggia-coefficient",
    domain: "tep",
    title: "Loggia area factor",
    document: "SP RK 3.02-101 (area calculation rules)",
    clause: "appendix on area calculation",
    editionDate: "typical edition",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Loggias in apartment area calculation",
    parameters: { coefficient: 0.5 },
    notes: "Typical value; check against the current edition before confirming.",
  },
  {
    id: "tep.balcony-coefficient",
    domain: "tep",
    title: "Balcony and terrace area factor",
    document: "SP RK 3.02-101 (area calculation rules)",
    clause: "appendix on area calculation",
    editionDate: "typical edition",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Balconies and terraces in apartment area calculation",
    parameters: { coefficient: 0.3 },
    notes: "Typical value; check against the current edition before confirming.",
  },
  {
    id: "placement.waste-to-house",
    domain: "placement",
    title: "Clearance from waste collection pad to house",
    document: PLANNING_DOCUMENT,
    clause: "sanitary clearances in residential areas",
    editionDate: "2013",
    addedAt: "2026-09-08",
    verifiedBy: "unverified",
    applicability: "Waste container pad in a residential area",
    parameters: { distanceMeters: 20 },
    notes:
      "Typical value 20 m to houses, playgrounds and sports grounds; check against the current edition and local rules.",
  },
  {
    id: "placement.well-to-septic",
    domain: "placement",
    title: "Clearance from water source to septic tank or cesspit",
    document: PLANNING_DOCUMENT,
    clause: "sanitary protection of water supply sources",
    editionDate: "2013",
    addedAt: "2026-09-08",
    verifiedBy: "unverified",
    applicability: "Private drinking water well or borehole",
    parameters: { distanceMeters: 20 },
    notes:
      "Depends on soil permeability and aquifer depth; the value needs confirming by a hydrogeologist.",
  },
  {
    id: "placement.tree-to-wall",
    domain: "placement",
    title: "Distance from tree trunk to building wall",
    document: PLANNING_DOCUMENT,
    clause: "landscaping",
    editionDate: "2013",
    addedAt: "2026-09-08",
    verifiedBy: "unverified",
    applicability: "Existing and proposed trees on the site",
    parameters: { distanceMeters: 5 },
    notes:
      "Typical value 5 m for a tree, 1.5 m for a shrub; depends on species and crown diameter.",
  },
  {
    id: "vertical.min-drain-slope",
    domain: "vertical",
    title: "Minimum pad slope for drainage",
    document: PLANNING_DOCUMENT,
    clause: "grading",
    editionDate: "2013",
    addedAt: "2026-08-29",
    verifiedBy: "unverified",
    applicability: "Graded pads without dedicated drainage",
    parameters: { minSlope: 0.005 },
    notes: "Typical value 5‰; check against the current edition before confirming.",
  },
];

const ruleIndex = new Map(rules.map((rule) => [rule.id, rule]));

export function findNormRule(id: string): NormRule | undefined {
  return ruleIndex.get(id);
}

export function normRuleDistance(id: string, fallback: number): number {
  const rule = ruleIndex.get(id);
  const value = rule?.parameters.distanceMeters;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function listNormRules(domain?: NormRule["domain"]): NormRule[] {
  return domain ? rules.filter((rule) => rule.domain === domain) : [...rules];
}

/** An unverified rule cannot confirm a clean PASS */
export function ruleCapStatus(id: string): "operator" | "unverified" {
  return ruleIndex.get(id)?.verifiedBy === "operator" ? "operator" : "unverified";
}
