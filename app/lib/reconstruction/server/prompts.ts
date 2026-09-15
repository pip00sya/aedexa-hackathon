import { type ReconstructionHints, type DrawingAnalysis } from "../types";
function describeHints(hints: ReconstructionHints) {
  const unit = hints.unit || "unit not confirmed";
  return [
    `units=${unit}`,
    `mode=${hints.allowInferredGeometry === false ? "proven dimensions only" : "AI reconstructs unknowns on its own as draft assumptions"}`,
    hints.width ? `width=${hints.width} ${unit}` : "",
    hints.height ? `height=${hints.height} ${unit}` : "",
    hints.depth ? `depth=${hints.depth} ${unit}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function inferencePolicy(hints: ReconstructionHints) {
  if (hints.allowInferredGeometry === false) {
    return `STRICT MODE: use only dimensions and shapes proven by the user, dimension text, CAD coordinates, or consistent views. Do not substitute typical values. Leave unknowns in unresolved.`;
  }
  return `AUTONOMOUS AI RECONSTRUCTION MODE: the goal is to build the most likely complete 3D draft even when the source data is incomplete.
- Choose the structurally most likely option yourself, based on symmetry, repeating modules, dimension chains, agreement between projections, proportions, and the typical logic of the object shown. Do not ask the user a question instead of building.
- If several options are possible, choose the simplest and most conservative one that agrees with all visible data; briefly list the rejected options in warnings.
- Add every reconstructed dimension to dimensions with source=inferred and confidence no higher than 0.65. In the evidence of every part that depends on it, add the line "AI assumption: …" with the reason for the choice. The confidence of such a part must not exceed 0.65.
- Do not hide uncertainty: keep the matching unresolved item, return status=needs_input and canExport=false. An assumption lets you build a draft, but it never becomes a proven fact.
- parts must not be empty when a connected object is visible on the sheet and the units or a reasonable technical scale can be determined. If the units are unknown, use mm only as the technical unit of the draft and warn about it.`;
}

export function buildAnalysisPrompt(
  sourceName: string,
  context: string,
  hints: ReconstructionHints,
) {
  return `Run stage one: a metrology audit of the technical drawing "${sourceName}". Do not build 3D yet.

1. First identify the FULL OBJECT from the title block and the sheet title, then the sheet type and all consistent views: front, top, side, sections, detail views, and isometric views. In CAD, documentIdentity.titleCandidates takes priority for objectName. documentIdentity.repeatedComponentLabels are local repeated component labels; never treat such a label as the name of the whole object.
2. Transcribe only readable numeric dimensions, without rounding. Give the source: drawing for dimension text, cad for an exact CAD coordinate, user for confirmed input, inferred only for a logical deduction with confidence no higher than 0.8.
3. Identify the shape-defining features: main bodies, cutouts, holes, slots, chamfers, fillets, arrays, and axes. Give visible evidence for each.
4. State explicit conclusions about how the projections correspond to each other. Do not treat identical lines as one feature unless they agree in at least two views or a section.
5. Any hidden dimension, scale, repeat count, or internal surface without evidence must go to unresolved. If the units are unknown, return unit=unknown and a critical uncertainty.
6. sufficientFor3d=true is allowed only when the units, the overall scale, and all dimensions that affect the final shape are proven. A perspective image without dimensions is never sufficient.
7. For CAD context V3, decode the abbreviations with entitySchema. Always read Paper/Layout Space (s=p:...) as the title block and view names, but do not turn the sheet border into object geometry. The audit stage receives exact dimensions, labels, inserts, and full type/region summaries; detailed vector geometry will be passed to the next, building stage.
8. If a printed display/nominal dimension differs from the geometric anchorMeasurement, treat the printed number as the design nominal and the difference as a warning to check. Priority: confirmed user data, printed nominal, CAD geometry, then raster.
9. Attachments come in this order: an overview of the whole sheet, then zoomed tiles from left to right and top to bottom. Use the tiles for small text and contours, and the overview to relate the views.
10. Keep the report compact and free of repetition: return up to 16 shape-defining dimensions, 10 features, 8 conclusions, and 6 unresolved. For each feature/conclusion keep the one strongest evidence item, and write each text field as one short sentence. Group repeated identical dimensions; the full machine CAD passport stays available to the building stage.

${inferencePolicy(hints)}
At the audit stage, AI assumptions do not make sufficientFor3d=true: this field reflects only whether the production geometry is proven.

User-confirmed data: ${describeHints(hints)}.
User comment: ${hints.notes || "none"}.
Machine-extracted CAD context:
${context || "none — analyze the image only"}`;
}

export function buildModelPrompt(
  sourceName: string,
  analysis: DrawingAnalysis,
  context: string,
  hints: ReconstructionHints,
) {
  return `Run stage two: build a verifiable parametric 3D model of the object "${sourceName}" from the attached AI audit and the source drawing.

The AI audit is a starting hypothesis that you must check against the title block, documentIdentity, and CAD geometry. If the audit objectName matches repeatedComponentLabels, correct the model intent with titleCandidates and build the whole object, not a single component:
${JSON.stringify(analysis)}

Machine-extracted CAD context:
${context || "none"}

Coordinate system: X is width from left to right, Y is height upward, Z is depth from front to back. Position is the part center. For box use size X/Y/Z. For cylinder use radius and height, axis Y. For extrusion the profile is given by X/Z points, height runs along Y, and through holes are holes contours. For an axisymmetric part use revolution: profile.x is the radius, profile.z is the position along the axis.

Use the overview and ALL zoomed tiles to trace contours. Evidence priority: user, the title block for object identity, printed nominal/display, CAD coordinates, then raster. For s=b:<name>, apply INSERT/MINSERT. Take into account bulge, arcs, circles, ellipses, splines, HATCH boundaries, thickness, elevation, extrusionDirection, layers, handle, and spatial regions. Do not create mesh: a mesh is allowed only from direct CAD geometry.

Engineering geometry constraints:
- HATCH marks a material or a section; it is not a separate solid body. Do not create a part from a hatch name/boundary alone without a confirming part contour.
- Do not transfer the overall size of the sheet or of the whole object to a local part. Each size must match the physical size of that exact part; mark an unknown thickness as an AI assumption.
- Model repeated posts, columns, and supports as separate parts at proven coordinates. Do not replace an array with one solid box along the whole object length.
- First build a hierarchy: whole object → major assemblies → individual structural elements. A local element label never replaces the whole object.
- After building, mentally project the model onto each detected view. If the silhouette or the number of supports, stairs, landings, openings, or axes does not match, fix parts before answering.
- Write all names, conclusions, warnings, and evidence in English.

${inferencePolicy(hints)}

If sufficientFor3d=false, you must return status=needs_input and canExport=false, but build the most complete preliminary object within the selected mode. If unit=unknown, use mm only as the technical unit of the preliminary result and do not allow export. Carry over only unique shape-defining unresolved items from the audit. Each part must have one short evidence item that references a dimension, view, handle, audit conclusion, or a clearly marked AI assumption. Use as many separate parts as needed to preserve the topology, but no more than 28; you may merge only a physically continuous element with one cross-section. Do not repeat detectedViews and dimensions: the schema requires empty arrays for them.`;
}

export function buildDraftRecoveryPrompt(
  sourceName: string,
  analysis: DrawingAnalysis,
  context: string,
  hints: ReconstructionHints,
) {
  return `The first pass produced no geometry for the object "${sourceName}". Run a targeted recovery of a verifiable 3D draft.

Audit:
${JSON.stringify(analysis)}

CAD context V3:
${context || "none"}

In the consistent views, find at least one fully dimensioned volume: a deck/body, support, column, beam, landing, step, opening, or another structural part. Build all such volumes with box, cylinder, extrusion, or revolution. Use printed nominal/display values, CAD coordinates, and repeated dimensions. Do not require the whole object to be proven in order to build a proven part.

${inferencePolicy(hints)}

In AI mode, do not repeat the empty answer: choose a conservative thickness/depth yourself from the view relationships, repeated dimensions, and proportions, mark it as an AI assumption, and build a connected object. In strict mode, parts must not be empty if at least one fully proven volume exists. Always leave unconfirmed items in unresolved, status=needs_input, canExport=false.`;
}

export function buildTopologyRepairPrompt(
  sourceName: string,
  analysis: DrawingAnalysis,
  context: string,
  hints: ReconstructionHints,
  candidateModel: Record<string, unknown>,
) {
  return `The first 3D pass for the object "${sourceName}" lost major assemblies or collapsed them into shared boxes. Return a FULL replacement model, not a list of fixes.

Verified audit:
${JSON.stringify(analysis)}

Incomplete model:
${JSON.stringify(candidateModel)}

CAD context V3:
${context || "none"}

Topology recovery rules:
- Map every feature with kind=solid to at least one physical part. Repeated left/right assemblies must be separate parts.
- For an object with six or more major assemblies, return at least eight non-zero parts: span/deck, roof or railing where present, supports, landings, stair/escalator flights, lift shafts, and foundations.
- The overall span length sets only the longitudinal axis of the matching element. The clearance above the road sets the elevation, and the width of the road or foundation is not the deck thickness or depth.
- Do not create a box with the overall X/Y/Z size of the whole structure. The size of each part is its own physical size; position is its center.
- A rotated box with non-zero thickness and width is allowed for an inclined flight, and a separate box for a landing. No zero dimensions.
- Do not give all parts the same 90° rotation. A horizontal span and landings usually have rotationDegrees=0; only specific stair/escalator flights are inclined.
- Check the number and placement of parts against the front view, the plan, and both elevations. Return detectedViews and dimensions as empty arrays; one short evidence item per part.

${inferencePolicy(hints)}
If a part is reconstructed from symmetry or proportions, mark its evidence as "AI assumption", with confidence no higher than 0.65, status=needs_input and canExport=false.`;
}

export function buildReviewPrompt(
  sourceName: string,
  context: string,
  hints: ReconstructionHints,
  initialAnalysis: DrawingAnalysis,
  candidateModel: Record<string, unknown>,
) {
  return `Run an independent engineering acceptance check of the reconstruction of the object "${sourceName}" and return only a compact review record. Do not repeat analysis, model, or parts in full.

Expected result: the geometry must match the source drawing in every visible projection and contain only proven elements. Do not approve the draft automatically — read the source sheet again.

${inferencePolicy(hints)}

Acceptance criteria:
- Start the check again from the title block. documentIdentity.titleCandidates defines the whole object, and repeatedComponentLabels are its local components. Fix analysis.objectName, model.title, and the whole topology if the initial audit confused a component with the object.
- Check the front view, top view, side views, sections, detail views, hidden lines, and axes. One contour does not confirm depth or internal shape without a second view, a section, or a numeric dimension.
- Re-read all readable dimensions and units. User data has source user and takes priority; exact CAD coordinates have source cad. Do not measure dimensions in pixels unless the scale is explicitly given.
- In CAD context V3, decode entitySchema and check all spatial regions and entity types. For s=b:<name>, apply the matching INSERT/MINSERT. Check handle and layer. Priority: user, printed nominal/display, CAD geometry, raster; a conflict between nominal and anchorMeasurement is a warning, not a reason to delete proven geometry.
- Check every model part: body type, center position, rotation, X/Y/Z dimensions, radius, height, profile, holes, slots, chamfers, fillets, symmetry, and repeat count. Return numeric errors of an existing part in corrections; list completely false parts in rejectedPartIds.
- Project the final model onto each detected view and compare silhouettes, axes, dimension chains, and repeat counts. A set of large boxes that repeat the overall object size instead of separate assemblies fails acceptance.
- The model has already been converted to X = length, Y = height, Z = depth. The same 90° rotation on all parts is an error. Paired "left/right" parts cannot have exactly the same position. A support foundation cannot be one slab along the whole span if the view shows separate footings.
- Check the coordinate system: X is width, Y is height, Z is depth. For box, size sets X/Y/Z; cylinder runs along Y; extrusion is extruded along Y; revolution is defined by a radius/axis profile.
- Do not create mesh. In strict mode, do not invent invisible geometry. In AI mode, the most likely invisible geometry is allowed only when clearly marked "AI assumption", with confidence no higher than 0.65 and production export blocked. If a shape-defining dimension is not proven, keep it as a critical uncertainty, status=needs_input, sufficientFor3d=false and canExport=false.
- If the draft model contains at least one dimensioned part, do not replace all parts with an empty array. Fix wrong parts, remove only unproven ones, and keep at least one proven part; lower status/canExport instead of destroying a verifiable draft.
- Remove an uncertainty only when a dimension, consistent view, section, CAD coordinate, or confirmed user input truly resolves it.
- Calibrate confidence by evidence: 1.0 is allowed only for exact CAD geometry; 0.95–0.99 for a fully dimensioned and consistent multi-view drawing; 0.85–0.94 only with minor uncertainty that does not affect the shape; with an unknown shape-defining dimension, the result must be below 0.85. Do not raise the number to make the result look good.
- accepted=true only if no critical error affects the visible shape. In unresolved, return only new unique problems; in warnings, only brief remarks. Determine objectName again from the title block. Do not rewrite geometry: corrections contains only changed numeric parameters of existing parts.

User-confirmed data: ${describeHints(hints)}.
User comment: ${hints.notes || "none"}.
Machine-extracted CAD context:
${context || "none"}

Initial audit to check and fix if needed:
${JSON.stringify(initialAnalysis)}

Draft 3D model to check and rebuild if needed:
${JSON.stringify(candidateModel)}`;
}
