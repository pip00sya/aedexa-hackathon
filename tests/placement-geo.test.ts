import assert from "node:assert/strict";
import test from "node:test";
import {
  anchorOf,
  buildingsToNeighbors,
  parseBuildings,
  parsePlaces,
  toLatLon,
  toLocal,
} from "../app/lib/placement/geo.ts";
import { polygonArea } from "../app/lib/geometry/index.ts";

const almaty = { lat: 43.238949, lon: 76.889709, rotation: 0 };

test("meters ↔ degrees: round trip without loss, +Y is north", () => {
  const point = { x: 25, y: -12 };
  const place = toLatLon(point, almaty);
  assert.ok(place.lat < almaty.lat, "minus Y is further south");
  assert.ok(place.lon > almaty.lon, "plus X is further east");
  const back = toLocal(place, almaty);
  assert.ok(Math.abs(back.x - point.x) < 1e-6 && Math.abs(back.y - point.y) < 1e-6);
});

test("an outline traced on the map becomes a site in meters with a real area", () => {
  // A 40 × 30 m rectangle traced in degrees around a point in Almaty
  const anchor = almaty;
  const corners = [
    toLatLon({ x: -20, y: -15 }, anchor),
    toLatLon({ x: 20, y: -15 }, anchor),
    toLatLon({ x: 20, y: 15 }, anchor),
    toLatLon({ x: -20, y: 15 }, anchor),
  ];
  const center = anchorOf(corners);
  assert.ok(
    Math.abs(center.lat - anchor.lat) < 1e-9 && Math.abs(center.lon - anchor.lon) < 1e-9,
    "the anchor is the outline center",
  );
  const parcel = corners.map((corner) => toLocal(corner, center));
  assert.ok(
    Math.abs(polygonArea(parcel) - 1200) < 0.5,
    `area 1200 m², got ${polygonArea(parcel).toFixed(1)}`,
  );
});

test("a Nominatim response is read as data: junk is dropped", () => {
  const places = parsePlaces([
    { lat: "43.25", lon: "76.95", display_name: "Almaty, Seifullin Avenue 500" },
    { lat: "none", lon: "76.9", display_name: "broken row" },
    "not an object",
    { lat: "43.3", lon: "76.9", display_name: "" },
  ]);
  assert.deepEqual(places, [{ title: "Almaty, Seifullin Avenue 500", lat: 43.25, lon: 76.95 }]);
});

test("Overpass buildings become neighbors in meters, but the site itself does not", () => {
  const anchor = almaty;
  const house = [
    { x: 30, y: 10 },
    { x: 40, y: 10 },
    { x: 40, y: 18 },
    { x: 30, y: 18 },
  ].map((point) => toLatLon(point, anchor));
  const self = [
    { x: -20, y: -15 },
    { x: 20, y: -15 },
    { x: 20, y: 15 },
    { x: -20, y: 15 },
  ].map((point) => toLatLon(point, anchor));
  const data = {
    elements: [
      { type: "way", id: 1, tags: { building: "house" }, geometry: [...house, house[0]] },
      { type: "way", id: 2, tags: { building: "yes" }, geometry: [...self, self[0]] },
      { type: "way", id: 3, tags: { building: "yes" }, geometry: [house[0], house[1]] },
      { type: "node", id: 4 },
    ],
  };
  const buildings = parseBuildings(data);
  assert.equal(buildings.length, 2, "unclosed and non-way items are dropped");

  const parcel = self.map((point) => toLocal(point, anchor));
  const neighbors = buildingsToNeighbors(buildings, anchor, parcel);
  assert.equal(neighbors.length, 1, "a building matching the site is not a neighbor");
  assert.equal(neighbors[0].id, "osm-1");
  assert.ok(Math.abs(polygonArea(neighbors[0].polygon) - 80) < 0.5, "neighbor 10 × 8 m");
});
