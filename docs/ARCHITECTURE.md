# How AEDEXA is built

The app runs on `vinext` (React Server Components on top of Vite). It deploys as a single
Cloudflare Worker: the server is `worker/index.ts`, static assets are `dist/client`.

## The path of a drawing

1. A DWG or DXF file is read in the browser. `app/lib/cad` starts LibreDWG (WASM) in a web
   worker and collects entities by layer.
2. `app/lib/cad/classification.ts` detects the document type: topographic survey, site plan,
   building, or detail.
3. For a site, `app/lib/placement` builds the boundary, utility zones, setbacks, and the buildable
   area, and `terrain.ts` builds the terrain.
4. The result is shown in `PlacementWorkspace`, the site layout sheet (SPOZU) is exported through
   `dxfAdapter.ts`, and projects are saved in the browser.

2D → 3D mode runs on the server: `app/lib/reconstruction/server` assembles the context
and calls the model, and `buildingSolver.ts` builds the geometry. A server key is needed only
for this mode.

## Folders

| Path | Contents |
|---|---|
| `app/components/AedexaApp.tsx` | Header and mode switching |
| `app/components/placement/PlacementWorkspace.tsx` | Placement and opening a saved project |
| `app/components/CadProcessingView.tsx` | Topo survey |
| `app/components/ReconstructionWorkspace.tsx` | Client side of reconstruction |
| `app/lib/geometry` | Shared geometry |
| `app/lib/placement` | Boundary, zones, building codes, placement options, terrain |
| `app/lib/cad` | DWG reading, classification, surfaces, export |
| `app/lib/reconstruction` | Model, schemas, solver |
| `app/lib/reconstruction/server` | Server side of reconstruction |
| `app/lib/norms` | Building code registry |
| `app/api` | HTTP routes |
| `worker` | Cloudflare entry point |
| `tests`, `scripts` | Tests and utility scripts |

A rule without a confirmed basis gets `MISSING_DATA` or `EXPERT_REVIEW`,
never `PASS`.

## Checks

`npm run check` — types, ESLint, formatting, build, and tests.

Run over a set of drawings (the `fixtures/drawings` folder is not in the repository; three
samples are in `judges/`):

```bash
npm run check:drawings -- fixtures/drawings
```
