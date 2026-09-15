"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { pointInPolygon, polygonBounds } from "../lib/geometry";
import { objectRing, type SiteObject } from "../lib/placement/siteObjects";
import type { ParcelTin } from "../lib/placement/terrain";
import type {
  NeighborBuilding,
  PlacementPoint,
  PlacementPolygon,
  PlacementRelief,
  UtilityRestriction,
} from "../lib/placement/types";
import { buildingParts } from "./buildingParts";

/** Site in 3D */

/** Simple SketchUp-style model */
const PALETTE = {
  /** Sheet under the model */
  background: 0xf5f3ee,
  /** Terrain shading */
  shadeLow: 0xc9c6bf,
  shadeHigh: 0xfaf9f6,
  flat: 0xe4e1da,
  /** Ground without terrain */
  lawn: 0xe4e1da,
  /** Hard paving */
  paving: 0xd6d3cd,
  mesh: 0xbcb9b2,
  contour: 0x6e6c68,
  boundary: 0x101014,
  /** Buildable area */
  spot: 0x45454c,
  /** Utilities: bronze, the value is typical and needs confirmation */
  utility: 0xc8a268,
  base: 0x8e8c86,
  neighbor: 0x6e6c68,
  neighborFace: 0xece9e2,
  object: 0x101014,
  /** The selected structure is highlighted by edge thickness */
  selected: 0x101014,
  /** Violation: terracotta, and only that */
  bad: 0xc4705e,
  face: 0xffffff,
  roof: 0xe6e3dc,
  shadow: 0x45454c,
  skirt: 0xd8d5ce,
} as const;

/** Default height of a neighboring structure, meters */
const NEIGHBOR_HEIGHT = 3;

/** Camera angles: three-quarter, top, front (profile from the south), side (from the east) */
export type PlacementSceneView = "quarter" | "top" | "front" | "side";
export type PlacementSceneHandle = { fit: () => void; view: (kind: PlacementSceneView) => void };

/** Direction from the site to the camera for each angle */
const VIEW_DIRECTIONS: Record<PlacementSceneView, THREE.Vector3> = {
  quarter: new THREE.Vector3(0.55, 0.46, 0.78).normalize(),
  top: new THREE.Vector3(0, 1, 0),
  front: new THREE.Vector3(0, 0.27, 1).normalize(),
  side: new THREE.Vector3(1, 0.27, 0).normalize(),
};

/** Which way the top of the screen points */
const VIEW_UP: Record<PlacementSceneView, THREE.Vector3> = {
  quarter: new THREE.Vector3(0, 1, 0),
  top: new THREE.Vector3(0, 0, -1),
  front: new THREE.Vector3(0, 1, 0),
  side: new THREE.Vector3(0, 1, 0),
};

type PlacementSceneProps = {
  parcel: PlacementPolygon;
  /** True buildable area */
  spots: PlacementPolygon[][];
  utilities: UtilityRestriction[];
  neighbors: NeighborBuilding[];
  relief?: PlacementRelief;
  tin: ParcelTin | null;
  objects: SiteObject[];
  selectedId?: string;
  /** Structures with violations */
  badIds: string[];
  /** Shadow outlines */
  shadows?: PlacementPolygon[];
  /** Vertical exaggeration factor */
  exaggeration?: number;
  /** Whether to show the base drawing */
  showBase?: boolean;
  onSelect?: (id?: string) => void;
  onMove?: (id: string, x: number, y: number) => void;
  /** The scene puts its "fit" action here so an outside button can call it */
  handleRef?: MutableRefObject<PlacementSceneHandle | null>;
};

function supportsWebGl() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function disposeNode(node: THREE.Object3D) {
  const mesh = node as THREE.Mesh | THREE.Line;
  mesh.geometry?.dispose();
  const material = (mesh as THREE.Mesh).material;
  if (Array.isArray(material)) material.forEach((item) => item.dispose());
  else material?.dispose();
}

/** Cuts a polyline into pieces that lie inside the outline */
function clipInside(
  line: readonly PlacementPoint[],
  ring: readonly PlacementPoint[],
): PlacementPoint[][] {
  const pieces: PlacementPoint[][] = [];
  let current: PlacementPoint[] = [];
  for (const point of line) {
    if (pointInPolygon(point, ring)) {
      current.push(point);
    } else if (current.length) {
      if (current.length >= 2) pieces.push(current);
      current = [];
    }
  }
  if (current.length >= 2) pieces.push(current);
  return pieces;
}

export default function PlacementScene({
  parcel,
  spots,
  utilities,
  neighbors,
  relief,
  tin,
  objects,
  selectedId,
  badIds,
  shadows = [],
  exaggeration = 1,
  showBase = true,
  onSelect,
  onMove,
  handleRef,
}: PlacementSceneProps) {
  const holder = useRef<HTMLDivElement>(null);
  // Machine without WebGL
  const [broken, setBroken] = useState(() => typeof window !== "undefined" && !supportsWebGl());
  // The scene is built once per site
  const world = useRef<{
    group: THREE.Group;
    lift: (z: number) => number;
    height: (x: number, y: number) => number;
    toLocal: (point: PlacementPoint) => PlacementPoint;
    k: number;
  } | null>(null);
  // Mouse handlers are attached once, but they need fresh data
  const hands = useRef({ objects, onSelect, onMove });
  useEffect(() => {
    hands.current = { objects, onSelect, onMove };
  }, [objects, onSelect, onMove]);

  useEffect(() => {
    const mount = holder.current;
    if (!mount || parcel.length < 3) return;

    // Survey coordinates can look like 4 500 000
    const box = polygonBounds(parcel);
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const toLocal = (point: PlacementPoint) => ({ x: point.x - center.x, y: point.y - center.y });
    const span = Math.max(box.width, box.height, 1);
    const base = tin ? (tin.minZ + tin.maxZ) / 2 : 0;
    const k = exaggeration;
    const lift = (z: number) => (z - base) * k;
    const height = (x: number, y: number) => (tin ? (tin.sample({ x, y }) ?? base) : 0);
    const vertex = (point: PlacementPoint, raise: number) => {
      const local = toLocal(point);
      return new THREE.Vector3(local.x, lift(height(point.x, point.y)) + raise, -local.y);
    };

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PALETTE.background);
    // Two cameras
    const perspective = new THREE.PerspectiveCamera(42, 1, 0.1, span * 40);
    const orthographic = new THREE.OrthographicCamera(-span, span, span, -span, 0.1, span * 40);
    let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = perspective;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch (error) {
      console.error("WebGL is unavailable", error);
      queueMicrotask(() => setBroken(true));
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    type SceneCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
    let controls: OrbitControls<SceneCamera> = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    // Below 76° the site collapses into a line and there is nothing to see
    controls.maxPolarAngle = Math.PI * 0.42;

    // Low, slanted light
    scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c4d2, 0.78));
    const sun = new THREE.DirectionalLight(0xfff7ea, 1.7);
    sun.position.set(span * 1.1, span * 0.9, span * 0.45);
    // Real shadow on the ground
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = span * 0.05;
    sun.shadow.camera.far = span * 6;
    sun.shadow.camera.left = -span;
    sun.shadow.camera.right = span;
    sun.shadow.camera.top = span;
    sun.shadow.camera.bottom = -span;
    // The bias removes "striped" self-shadowing on nearly flat terrain
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = Math.max(0.02, span * 0.002);
    scene.add(sun);
    const rim = new THREE.DirectionalLight(0xdbe4f0, 0.5);
    rim.position.set(-span * 0.9, span * 0.5, -span * 0.8);
    scene.add(rim);

    // surface from contour lines, or a flat base if there are none
    if (tin) {
      const surface = new THREE.BufferGeometry();
      const positions = new Float32Array(tin.positions.length);
      const shade = new Float32Array(tin.positions.length);
      const range = Math.max(tin.maxZ - tin.minZ, 1e-6);
      const low = new THREE.Color(PALETTE.shadeLow);
      const high = new THREE.Color(PALETTE.shadeHigh);
      const tone = new THREE.Color();
      for (let i = 0; i < tin.positions.length; i += 3) {
        positions[i] = tin.positions[i] - center.x;
        positions[i + 1] = lift(tin.positions[i + 2]);
        positions[i + 2] = -(tin.positions[i + 1] - center.y);
        // Shading by elevation
        tone.copy(low).lerp(high, (tin.positions[i + 2] - tin.minZ) / range);
        shade[i] = tone.r;
        shade[i + 1] = tone.g;
        shade[i + 2] = tone.b;
      }
      // The scene mirrors the site Y axis into -Z, which flips the triangle winding
      const facing = new Uint32Array(tin.indices.length);
      for (let i = 0; i < tin.indices.length; i += 3) {
        facing[i] = tin.indices[i];
        facing[i + 1] = tin.indices[i + 2];
        facing[i + 2] = tin.indices[i + 1];
      }
      surface.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      surface.setAttribute("color", new THREE.BufferAttribute(shade, 3));
      surface.setIndex(new THREE.BufferAttribute(facing, 1));
      surface.computeVertexNormals();
      const ground = new THREE.Mesh(
        surface,
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 }),
      );
      ground.receiveShadow = true;
      scene.add(ground);
      scene.add(
        new THREE.LineSegments(
          new THREE.WireframeGeometry(surface),
          new THREE.LineBasicMaterial({ color: PALETTE.mesh, transparent: true, opacity: 0.28 }),
        ),
      );

      // Contour lines only inside the site
      const contourSegments: number[] = [];
      for (const contour of relief?.contours ?? []) {
        for (const piece of clipInside(contour.points, parcel)) {
          for (let i = 0; i < piece.length - 1; i += 1) {
            const a = toLocal(piece[i]);
            const b = toLocal(piece[i + 1]);
            contourSegments.push(
              a.x,
              lift(contour.z) + 0.07,
              -a.y,
              b.x,
              lift(contour.z) + 0.07,
              -b.y,
            );
          }
        }
      }
      if (contourSegments.length) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(contourSegments, 3));
        scene.add(
          new THREE.LineSegments(
            geometry,
            new THREE.LineBasicMaterial({
              color: PALETTE.contour,
              transparent: true,
              opacity: 0.8,
            }),
          ),
        );
      }
    } else {
      const pad = new THREE.ShapeGeometry(
        new THREE.Shape(
          parcel.map((point) => {
            const local = toLocal(point);
            return new THREE.Vector2(local.x, local.y);
          }),
        ),
      );
      pad.rotateX(Math.PI / 2);
      const plane = new THREE.Mesh(
        pad,
        new THREE.MeshStandardMaterial({
          color: PALETTE.lawn,
          roughness: 0.98,
          side: THREE.DoubleSide,
        }),
      );
      plane.receiveShadow = true;
      scene.add(plane);
    }

    // base drawing: the rest of the drawing graphics, draped on the terrain
    if (showBase && relief?.base.length) {
      const segments: number[] = [];
      for (const line of relief.base) {
        const last = line.closed ? line.points.length : line.points.length - 1;
        for (let i = 0; i < last; i += 1) {
          const a = vertex(line.points[i], 0.03);
          const b = vertex(line.points[(i + 1) % line.points.length], 0.03);
          segments.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
      }
      if (segments.length) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(segments, 3));
        scene.add(
          new THREE.LineSegments(
            geometry,
            new THREE.LineBasicMaterial({ color: PALETTE.base, transparent: true, opacity: 0.55 }),
          ),
        );
      }
    }

    // neighboring structures
    for (const neighbor of neighbors) {
      if (neighbor.polygon.length < 3) continue;
      const ground = Math.min(...neighbor.polygon.map((point) => height(point.x, point.y)));
      const shape = new THREE.Shape(
        neighbor.polygon.map((point) => {
          const local = toLocal(point);
          return new THREE.Vector2(local.x, -local.y);
        }),
      );
      const prism = new THREE.ExtrudeGeometry(shape, {
        depth: NEIGHBOR_HEIGHT * k,
        bevelEnabled: false,
      });
      prism.rotateX(-Math.PI / 2);
      prism.translate(0, lift(ground), 0);
      scene.add(
        new THREE.Mesh(
          prism,
          new THREE.MeshBasicMaterial({
            color: PALETTE.neighborFace,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
          }),
        ),
      );
      scene.add(
        new THREE.LineSegments(
          new THREE.EdgesGeometry(prism, 22),
          new THREE.LineBasicMaterial({ color: PALETTE.neighbor, transparent: true, opacity: 0.8 }),
        ),
      );
    }

    // site edge wall
    const skirtDepth = Math.max(1.5, span * 0.07);
    const skirtBottom = lift(tin ? tin.minZ : 0) - skirtDepth;
    {
      const wall: number[] = [];
      for (let i = 0; i < parcel.length; i += 1) {
        const a = vertex(parcel[i], 0);
        const b = vertex(parcel[(i + 1) % parcel.length], 0);
        wall.push(a.x, a.y, a.z, b.x, b.y, b.z, b.x, skirtBottom, b.z);
        wall.push(a.x, a.y, a.z, b.x, skirtBottom, b.z, a.x, skirtBottom, a.z);
      }
      const skirt = new THREE.BufferGeometry();
      skirt.setAttribute("position", new THREE.Float32BufferAttribute(wall, 3));
      scene.add(
        new THREE.Mesh(
          skirt,
          new THREE.MeshBasicMaterial({ color: PALETTE.skirt, side: THREE.DoubleSide }),
        ),
      );

      const cap = new THREE.ShapeGeometry(
        new THREE.Shape(
          parcel.map((point) => {
            const local = toLocal(point);
            return new THREE.Vector2(local.x, local.y);
          }),
        ),
      );
      cap.rotateX(Math.PI / 2);
      const bottom = new THREE.Mesh(
        cap,
        new THREE.MeshBasicMaterial({ color: PALETTE.skirt, side: THREE.DoubleSide }),
      );
      bottom.position.y = skirtBottom;
      scene.add(bottom);

      const bottomRing = parcel.map((point) => {
        const local = toLocal(point);
        return new THREE.Vector3(local.x, skirtBottom, -local.y);
      });
      scene.add(
        new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(bottomRing),
          new THREE.LineBasicMaterial({ color: PALETTE.contour, transparent: true, opacity: 0.5 }),
        ),
      );
    }

    // buildable area draped on the terrain
    for (const rings of spots) {
      const outer = rings[0];
      if (!outer || outer.length < 3) continue;
      const shape = new THREE.Shape(
        outer.map((point) => {
          const local = toLocal(point);
          return new THREE.Vector2(local.x, local.y);
        }),
      );
      for (const hole of rings.slice(1)) {
        if (hole.length >= 3)
          shape.holes.push(
            new THREE.Path(
              hole.map((point) => {
                const local = toLocal(point);
                return new THREE.Vector2(local.x, local.y);
              }),
            ),
          );
      }
      const geometry = new THREE.ShapeGeometry(shape);
      const position = geometry.getAttribute("position");
      const draped = new Float32Array(position.count * 3);
      for (let i = 0; i < position.count; i += 1) {
        const x = position.getX(i);
        const y = position.getY(i);
        draped[i * 3] = x;
        draped[i * 3 + 1] = lift(height(x + center.x, y + center.y)) + 0.16;
        draped[i * 3 + 2] = -y;
      }
      geometry.setAttribute("position", new THREE.BufferAttribute(draped, 3));
      geometry.computeVertexNormals();
      scene.add(
        new THREE.Mesh(
          geometry,
          new THREE.MeshBasicMaterial({
            color: PALETTE.spot,
            transparent: true,
            opacity: 0.22,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        ),
      );

      for (const ring of rings) {
        if (ring.length < 3) continue;
        const outline = ring.map((point) => vertex(point, 0.2));
        outline.push(outline[0].clone());
        scene.add(
          new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(outline),
            new THREE.LineDashedMaterial({
              color: PALETTE.spot,
              dashSize: span * 0.014,
              gapSize: span * 0.01,
            }),
          ).computeLineDistances(),
        );
      }
    }

    // site boundary
    {
      const border = parcel.map((point) => vertex(point, 0.3));
      border.push(border[0].clone());
      scene.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(border),
          new THREE.LineBasicMaterial({ color: PALETTE.boundary }),
        ),
      );
    }

    // utility center lines inside the site
    for (const utility of utilities) {
      for (const piece of clipInside(utility.polyline, parcel)) {
        scene.add(
          new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(piece.map((point) => vertex(point, 0.3))),
            new THREE.LineDashedMaterial({
              color: PALETTE.utility,
              dashSize: span * 0.022,
              gapSize: span * 0.014,
            }),
          ).computeLineDistances(),
        );
      }
    }

    const group = new THREE.Group();
    scene.add(group);
    world.current = { group, lift, height, toLocal, k };

    const FILL = 0.88;
    const frameFrom = (direction: THREE.Vector3, up: THREE.Vector3 = VIEW_UP.quarter) => {
      camera.up.copy(up);
      const bounds = new THREE.Box3();
      for (const point of parcel) bounds.expandByPoint(vertex(point, 0));
      let tallest = 0;
      for (const object of hands.current.objects) tallest = Math.max(tallest, object.height * k);
      bounds.max.y += Math.max(1.5, tallest * 1.25);
      if (bounds.isEmpty()) return;

      const size = bounds.getSize(new THREE.Vector3());
      const target = bounds.getCenter(new THREE.Vector3());
      const corners: THREE.Vector3[] = [];
      for (const x of [bounds.min.x, bounds.max.x]) {
        for (const y of [bounds.min.y, bounds.max.y]) {
          for (const z of [bounds.min.z, bounds.max.z]) corners.push(new THREE.Vector3(x, y, z));
        }
      }
      let distance = Math.max(size.x, size.y, size.z, 1) * 1.4;
      const settle = () => {
        camera.position.copy(target).addScaledVector(direction, distance);
        camera.near = Math.max(0.05, distance / 500);
        camera.far = distance * 6;
        if (camera instanceof THREE.OrthographicCamera) {
          // With a parallel projection, framing is set by bounds, not by distance
          const aspect =
            renderer.domElement.clientWidth / Math.max(1, renderer.domElement.clientHeight);
          const half = Math.max(size.x, size.y, size.z) * 0.62;
          camera.left = -half * aspect;
          camera.right = half * aspect;
          camera.top = half;
          camera.bottom = -half;
        }
        camera.lookAt(target);
        camera.updateMatrixWorld(true);
        camera.updateProjectionMatrix();
      };
      for (let step = 0; step < 4; step += 1) {
        settle();
        let reach = 0;
        for (const corner of corners) {
          const projected = corner.clone().project(camera);
          reach = Math.max(reach, Math.abs(projected.x), Math.abs(projected.y));
        }
        if (reach <= 0) break;
        distance *= reach / FILL;
      }
      settle();
      controls.target.copy(target);
      controls.minDistance = distance * 0.22;
      controls.maxDistance = distance * 3.2;
      scene.fog = new THREE.Fog(PALETTE.background, distance * 1.3, distance * 3.4);
      controls.update();
    };
    /** Orthographic views use a parallel projection, orbit uses perspective */
    const switchCamera = (next: SceneCamera) => {
      if (camera === next) return;
      const target = controls.target.clone();
      controls.dispose();
      camera = next;
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.maxPolarAngle = Math.PI * 0.42;
      controls.target.copy(target);
    };

    const fit = () => {
      switchCamera(perspective);
      frameFrom(VIEW_DIRECTIONS.quarter, VIEW_UP.quarter);
    };
    const view = (kind: PlacementSceneView) => {
      switchCamera(kind === "quarter" ? perspective : orthographic);
      frameFrom(VIEW_DIRECTIONS[kind], VIEW_UP[kind]);
    };
    if (handleRef) handleRef.current = { fit, view };

    let frame = 0;
    const render = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };

    const resize = () => {
      const { clientWidth, clientHeight } = mount;
      if (!clientWidth || !clientHeight) return;
      renderer.setSize(clientWidth, clientHeight);
      const aspect = clientWidth / clientHeight;
      perspective.aspect = aspect;
      perspective.updateProjectionMatrix();
      if (camera instanceof THREE.OrthographicCamera) {
        const half = (camera.top - camera.bottom) / 2;
        camera.left = -half * aspect;
        camera.right = half * aspect;
        camera.updateProjectionMatrix();
      }
    };

    // Dragging in 3D
    const pointer = new THREE.Vector2();
    const ray = new THREE.Raycaster();
    const plane = new THREE.Plane();
    const hit = new THREE.Vector3();
    let dragging: { id: string; dx: number; dy: number } | null = null;

    const atPointer = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      ray.setFromCamera(pointer, camera);
    };
    const groundAt = (y: number) => {
      plane.set(new THREE.Vector3(0, 1, 0), -y);
      return ray.ray.intersectPlane(plane, hit)
        ? { x: hit.x + center.x, y: -hit.z + center.y }
        : null;
    };
    const onDown = (event: PointerEvent) => {
      const { objects: current, onSelect: select, onMove: move } = hands.current;
      if (!move || event.button !== 0) return;
      atPointer(event);
      const found = ray.intersectObjects(group.children, false)[0];
      if (!found) {
        select?.(undefined);
        return;
      }
      const at = { x: found.point.x + center.x, y: -found.point.z + center.y };
      const target = [...current]
        .reverse()
        .find((object) => pointInPolygon(at, objectRing(object)));
      if (!target) return;
      const ground = groundAt(found.point.y);
      if (!ground) return;
      dragging = { id: target.id, dx: target.x - ground.x, dy: target.y - ground.y };
      controls.enabled = false;
      select?.(target.id);
      renderer.domElement.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
    const onDrag = (event: PointerEvent) => {
      if (!dragging) return;
      atPointer(event);
      const ground = groundAt(hit.y);
      if (!ground) return;
      hands.current.onMove?.(dragging.id, ground.x + dragging.dx, ground.y + dragging.dy);
    };
    const onUp = (event: PointerEvent) => {
      if (!dragging) return;
      dragging = null;
      controls.enabled = true;
      if (renderer.domElement.hasPointerCapture(event.pointerId))
        renderer.domElement.releasePointerCapture(event.pointerId);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointermove", onDrag);
    renderer.domElement.addEventListener("pointerup", onUp);
    renderer.domElement.addEventListener("pointercancel", onUp);

    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();
    fit();
    render();

    return () => {
      cancelAnimationFrame(frame);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointermove", onDrag);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.domElement.removeEventListener("pointercancel", onUp);
      observer.disconnect();
      controls.dispose();
      world.current = null;
      if (handleRef) handleRef.current = null;
      scene.traverse(disposeNode);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [parcel, spots, utilities, neighbors, relief, tin, exaggeration, showBase, handleRef]);

  // structures are rebuilt separately
  useEffect(() => {
    const current = world.current;
    if (!current) return;
    const { group, lift, height, toLocal, k } = current;
    for (const child of [...group.children]) {
      group.remove(child);
      disposeNode(child);
    }

    // Shadows first
    for (const polygon of shadows) {
      if (polygon.length < 3) continue;
      const shape = new THREE.Shape(
        polygon.map((point) => {
          const local = toLocal(point);
          return new THREE.Vector2(local.x, local.y);
        }),
      );
      const fill = new THREE.ShapeGeometry(shape);
      const position = fill.getAttribute("position");
      const flat = new Float32Array(position.count * 3);
      for (let i = 0; i < position.count; i += 1) {
        const x = position.getX(i);
        const y = position.getY(i);
        const world = {
          x: x + (polygon[0].x - toLocal(polygon[0]).x),
          y: y + (polygon[0].y - toLocal(polygon[0]).y),
        };
        flat[i * 3] = x;
        flat[i * 3 + 1] = lift(height(world.x, world.y)) + 0.04;
        flat[i * 3 + 2] = -y;
      }
      fill.setAttribute("position", new THREE.BufferAttribute(flat, 3));
      group.add(
        new THREE.Mesh(
          fill,
          new THREE.MeshBasicMaterial({
            color: PALETTE.shadow,
            transparent: true,
            opacity: 0.14,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        ),
      );
    }

    const bad = new Set(badIds);
    for (const object of objects) {
      const ring = objectRing(object);
      // Seat it at the lowest point of the footprint
      const ground = Math.min(...ring.map((point) => height(point.x, point.y)));
      const ink = bad.has(object.id)
        ? PALETTE.bad
        : object.id === selectedId
          ? PALETTE.selected
          : PALETTE.object;
      const local = toLocal(object);
      const place = (node: THREE.Object3D) => {
        node.position.set(local.x, lift(ground) + 0.05, -local.y);
        node.rotation.y = -object.rotation;
        node.scale.y = k;
      };

      // The footprint on the ground is always drawn
      const footprint = ring.map((point) => {
        const at = toLocal(point);
        return new THREE.Vector3(at.x, lift(height(point.x, point.y)) + 0.06, -at.y);
      });
      group.add(
        new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(footprint),
          new THREE.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.85 }),
        ),
      );
      if (object.kind === "yard") {
        const shape = new THREE.Shape(
          ring.map((point) => {
            const at = toLocal(point);
            return new THREE.Vector2(at.x, at.y);
          }),
        );
        const pad = new THREE.ShapeGeometry(shape);
        const position = pad.getAttribute("position");
        const draped = new Float32Array(position.count * 3);
        for (let i = 0; i < position.count; i += 1) {
          const x = position.getX(i);
          const y = position.getY(i);
          draped[i * 3] = x;
          draped[i * 3 + 1] =
            lift(height(x + (object.x - local.x), y + (object.y - local.y))) + 0.05;
          draped[i * 3 + 2] = -y;
        }
        pad.setAttribute("position", new THREE.BufferAttribute(draped, 3));
        // A pad is hard paving: flat color, like lawn and paths
        const paving = new THREE.Mesh(
          pad,
          new THREE.MeshLambertMaterial({ color: PALETTE.paving, side: THREE.DoubleSide }),
        );
        paving.receiveShadow = true;
        group.add(paving);
        continue;
      }

      const parts = buildingParts(object.kind, object.width, object.depth, object.height);
      for (const geometry of parts.roof ? [parts.solid, parts.roof] : [parts.solid]) {
        // Faces are white, as in SketchUp
        const face = geometry === parts.roof ? PALETTE.roof : PALETTE.face;
        // Faces are light and matte
        const body = new THREE.Mesh(
          geometry,
          new THREE.MeshLambertMaterial({
            color: face,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
          }),
        );
        body.castShadow = true;
        body.receiveShadow = true;
        place(body);
        group.add(body);

        const edges = new THREE.EdgesGeometry(geometry, 22);
        const hidden = new THREE.LineSegments(
          edges,
          new THREE.LineDashedMaterial({
            color: ink,
            transparent: true,
            opacity: 0.18,
            depthTest: false,
            depthWrite: false,
            dashSize: 0.35,
            gapSize: 0.3,
          }),
        );
        hidden.computeLineDistances();
        hidden.renderOrder = -1;
        place(hidden);
        group.add(hidden);

        const visible = new THREE.LineSegments(
          edges.clone(),
          new THREE.LineBasicMaterial({
            color: ink,
            transparent: true,
            opacity: object.id === selectedId ? 1 : 0.9,
          }),
        );
        place(visible);
        group.add(visible);
      }
    }
    // The scene is rebuilt when the site or terrain changes
  }, [
    objects,
    selectedId,
    badIds,
    shadows,
    parcel,
    spots,
    utilities,
    neighbors,
    relief,
    tin,
    exaggeration,
    showBase,
  ]);

  if (broken) {
    return (
      <div className="placement-scene placement-scene-broken">
        <strong>Cannot build the 3D view</strong>
        <p>
          WebGL is not available in this browser, so the 3D scene cannot start. The plan still
          works: it shows the same site from above, with dimensions and structures.
        </p>
      </div>
    );
  }
  return <div ref={holder} className="placement-scene" />;
}
