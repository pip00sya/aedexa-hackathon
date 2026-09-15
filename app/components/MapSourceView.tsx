"use client";

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { ArrowLeft, Building2, Check, Crosshair, Search, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isSimplePolygon } from "../lib/geometry";
import {
  anchorOf,
  buildingsToNeighbors,
  DEFAULT_ANCHOR,
  fetchNearbyBuildings,
  searchPlace,
  TILE_SOURCES,
  toLocal,
  type LatLon,
  type OsmBuilding,
  type Place,
} from "../lib/placement/geo";
import type { PlacementSource } from "../lib/placement/types";

/** Map as the site source */

type Basemap = "plan" | "satellite";

type Props = {
  onSource: (source: PlacementSource) => void;
  onCancel: () => void;
};

/** Radius for fetching neighboring buildings from OpenStreetMap, m */
const NEIGHBOR_RADIUS_METERS = 120;

export default function MapSourceView({ onSource, onCancel }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const tiles = useRef<L.TileLayer | null>(null);
  const drawing = useRef<L.LayerGroup | null>(null);
  const around = useRef<L.LayerGroup | null>(null);
  const request = useRef<AbortController | null>(null);

  const [basemap, setBasemap] = useState<Basemap>("satellite");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [contourError, setContourError] = useState(false);
  const [vertices, setVertices] = useState<LatLon[]>([]);
  const [buildings, setBuildings] = useState<OsmBuilding[]>([]);
  const [nearbyState, setNearbyState] = useState<"idle" | "busy" | "done" | "error">("idle");

  // the map is created once
  useEffect(() => {
    const node = holder.current;
    if (!node) return;
    const instance = L.map(node, {
      zoomControl: false,
      attributionControl: true,
      doubleClickZoom: false,
    });
    L.control.zoom({ position: "bottomright" }).addTo(instance);
    instance.attributionControl.setPrefix("");
    instance.setView([DEFAULT_ANCHOR.lat, DEFAULT_ANCHOR.lon], 16);
    map.current = instance;
    drawing.current = L.layerGroup().addTo(instance);
    around.current = L.layerGroup().addTo(instance);

    // The listener is attached once, so a vertex is added through an updater function
    const click = (event: L.LeafletMouseEvent) => {
      setVertices((previous) => [...previous, { lat: event.latlng.lat, lon: event.latlng.lng }]);
    };
    instance.on("click", click);

    return () => {
      instance.off("click", click);
      instance.remove();
      map.current = null;
      drawing.current = null;
      around.current = null;
      request.current?.abort();
    };
  }, []);

  // base layer
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    tiles.current?.remove();
    const source = TILE_SOURCES[basemap];
    tiles.current = L.tileLayer(source.url, {
      maxZoom: source.maxZoom,
      attribution: source.credit,
    }).addTo(instance);
  }, [basemap]);

  // site outline
  useEffect(() => {
    const layer = drawing.current;
    if (!layer) return;
    layer.clearLayers();
    const path = vertices.map((vertex) => [vertex.lat, vertex.lon] as [number, number]);
    if (path.length >= 3) {
      L.polygon(path, {
        color: "#2563eb",
        weight: 2,
        fillColor: "#2563eb",
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(layer);
    } else if (path.length === 2) {
      L.polyline(path, { color: "#2563eb", weight: 2, interactive: false }).addTo(layer);
    }
    path.forEach((point, index) => {
      L.circleMarker(point, {
        radius: 5,
        color: "#fff",
        weight: 2,
        fillColor: index === 0 ? "#16a34a" : "#2563eb",
        fillOpacity: 1,
        interactive: false,
      }).addTo(layer);
    });
  }, [vertices]);

  // neighboring buildings from OpenStreetMap
  useEffect(() => {
    const layer = around.current;
    if (!layer) return;
    layer.clearLayers();
    for (const building of buildings) {
      L.polygon(
        building.ring.map((point) => [point.lat, point.lon] as [number, number]),
        {
          color: "#94a3b8",
          weight: 1.2,
          fillColor: "#cbd5e1",
          fillOpacity: 0.35,
          interactive: false,
        },
      ).addTo(layer);
    }
  }, [buildings]);

  const search = async () => {
    const text = query.trim();
    if (text.length < 3) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setSearching(true);
    setSearchFailed(false);
    try {
      setFound(await searchPlace(text, controller.signal));
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        console.error("Place search failed", error);
        setSearchFailed(true);
        setFound(null);
      }
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  };

  const goTo = (place: Place) => {
    map.current?.setView([place.lat, place.lon], 18);
    setFound(null);
  };

  const loadNeighbors = async () => {
    const instance = map.current;
    if (!instance) return;
    const center = vertices.length
      ? anchorOf(vertices)
      : { lat: instance.getCenter().lat, lon: instance.getCenter().lng };
    setNearbyState("busy");
    try {
      setBuildings(await fetchNearbyBuildings(center, NEIGHBOR_RADIUS_METERS));
      setNearbyState("done");
    } catch (error) {
      console.error("Could not fetch neighboring buildings", error);
      setNearbyState("error");
    }
  };

  const useParcel = () => {
    if (vertices.length < 3) return;
    const anchor = anchorOf(vertices);
    const parcel = vertices.map((vertex) => toLocal(vertex, anchor));
    if (!isSimplePolygon(parcel)) {
      setContourError(true);
      return;
    }
    setContourError(false);
    const neighbors = buildingsToNeighbors(buildings, anchor, parcel);
    const warnings = [
      "The outline was traced on a satellite image, so it is only as accurate as the image and your hand. Confirm the boundary against the cadastre.",
      "No red line set: a preliminary setback from the selected street side is shown.",
    ];
    if (neighbors.length)
      warnings.push(
        "Neighboring buildings come from OpenStreetMap: coverage is incomplete and inexact, and fire resistance is unknown.",
      );
    else warnings.push("Neighboring buildings not loaded: fire clearances were not built.");
    onSource({
      kind: "map",
      name: `Map · ${anchor.lat.toFixed(5)}, ${anchor.lon.toFixed(5)}`,
      confidence: "local",
      unitLabel: "m",
      coordinateLabel: "Satellite image · meters from the site center, +Y is north",
      parcel,
      parcelConfirmed: false,
      streetEdgeIndex: 0,
      neighbors,
      anchor,
      warnings,
    });
  };

  return (
    <div className="map-source">
      <div className="map-source__bar">
        <div className="map-source__search">
          <input
            type="search"
            value={query}
            placeholder="Address or place: Almaty, Seifullin 500"
            aria-label="Search for a place by address"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void search();
            }}
          />
          <button
            type="button"
            className="placement-button secondary"
            onClick={() => void search()}
            disabled={query.trim().length < 3 || searching}
          >
            <Search size={15} /> {searching ? "Searching…" : "Find"}
          </button>
        </div>
        <div className="map-source__seg" role="group" aria-label="Base map">
          <button
            type="button"
            className={basemap === "satellite" ? "active" : ""}
            onClick={() => setBasemap("satellite")}
          >
            Satellite
          </button>
          <button
            type="button"
            className={basemap === "plan" ? "active" : ""}
            onClick={() => setBasemap("plan")}
          >
            Streets
          </button>
        </div>
      </div>

      {searchFailed && (
        <p className="map-source__note warn">
          Search did not respond: the free OpenStreetMap service sometimes limits requests. Find the
          place by moving the map.
        </p>
      )}
      {contourError && (
        <p role="alert" className="map-source__note warn">
          The outline is degenerate or self-intersecting. Click distinct site corners in order.
        </p>
      )}
      {found?.length === 0 && (
        <p className="map-source__note">Nothing found. Try a more specific query.</p>
      )}
      {found && found.length > 0 && (
        <ul className="map-source__results">
          {found.map((place) => (
            <li key={`${place.lat},${place.lon}`}>
              <button type="button" onClick={() => goTo(place)}>
                <Crosshair size={14} /> {place.title}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div
        ref={holder}
        className="map-source__map"
        aria-label="Map: click the site corners to trace it"
      />

      <div className="map-source__bar bottom">
        <span className="map-source__hint">
          {vertices.length < 3
            ? `Click the site corners on the image: ${vertices.length} points, at least three needed`
            : `Outline of ${vertices.length} points is ready`}
        </span>
        <div className="map-source__actions">
          <button
            type="button"
            className="placement-button secondary"
            onClick={() => setVertices(vertices.slice(0, -1))}
            disabled={!vertices.length}
          >
            <Undo2 size={15} /> Undo point
          </button>
          <button
            type="button"
            className="placement-button secondary"
            onClick={() => setVertices([])}
            disabled={!vertices.length}
          >
            <X size={15} /> Clear
          </button>
          <button
            type="button"
            className="placement-button secondary"
            onClick={() => void loadNeighbors()}
            disabled={nearbyState === "busy"}
          >
            <Building2 size={15} />{" "}
            {nearbyState === "busy"
              ? "Loading…"
              : nearbyState === "done"
                ? `Neighbors: ${buildings.length}`
                : "Neighboring buildings"}
          </button>
          <button
            type="button"
            className="placement-button primary"
            onClick={useParcel}
            disabled={vertices.length < 3}
          >
            <Check size={15} /> Use this site
          </button>
          <button type="button" className="placement-button secondary" onClick={onCancel}>
            <ArrowLeft size={15} /> Back
          </button>
        </div>
      </div>
      {nearbyState === "error" && (
        <p className="map-source__note warn">
          Overpass did not respond; the free service is not always available. Try again in a minute.
        </p>
      )}
      <p className="map-source__note">
        The map and search use the open OpenStreetMap and Esri services: only the point you are
        looking at and the query text leave your device. Open data has no underground utilities;
        take them from a drawing or a utility certificate.
      </p>
    </div>
  );
}
