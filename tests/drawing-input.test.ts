import assert from "node:assert/strict";
import test from "node:test";
import { prepareDrawing } from "../app/lib/reconstruction/prepareDrawing.ts";

test("unsupported DXF for reconstruction suggests an alternative before the browser CAD parser loads", async () => {
  const file = new File(["0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n"], "drawing.dxf");
  await assert.rejects(prepareDrawing(file), /DXF is supported in the placement module/);
});

test("empty reconstruction input is rejected before parsing", async () => {
  await assert.rejects(prepareDrawing(new File([], "empty.dwg")), /The file is empty/);
});
