import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);

try {
  process.loadEnvFile(fileURLToPath(new URL(".env", root)));
} catch {
  // No file means no keys: the normal state of a fresh checkout
}

async function render(path = "/app") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: {
        accept: "text/html",
        host: "localhost",
        "x-forwarded-proto": "http",
      },
    }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

/** Whether the language model is configured */
function hasModelKey() {
  return Boolean(process.env.FEATHERLESS_API_KEY);
}

test("home page is server-rendered", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /<title>AEDEXA/);
  assert.match(html, /<h1[^>]*>AEDEXA<\/h1>/);
  assert.doesNotMatch(
    html,
    /The drawing becomes a model|Early-stage environment|Every number on the sheet/,
  );
  assert.match(html, /Open workspace/);
  assert.match(html, /Create account/);
  // The landing page does not pull in the workspace: it stands on its own
  assert.doesNotMatch(html, /Upload the site surroundings/);
});

test("app shell is server-rendered", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>AEDEXA/);
  assert.match(html, /Code-compliant building placement/);
  assert.match(html, /Placement and setbacks/);
  assert.match(html, /DWG topo survey/);
  const railItem = /<span>2D → 3D<\/span>/;
  const aiConfigured = hasModelKey();
  if (aiConfigured) assert.match(html, railItem);
  else assert.doesNotMatch(html, railItem);
  assert.match(html, /All projects/);
  // The "Key metrics" (TEP) and "Comparison" modes were removed from the product
  assert.doesNotMatch(html, />Key metrics<|> Comparison</);
  assert.match(html, /Upload the site surroundings/);
  assert.doesNotMatch(html, /AI Studio|>Studio</);
  assert.match(html, /og:title/);
  assert.doesNotMatch(html, /og:image|twitter:image/);
  assert.match(html, /Golos Text/);
  assert.match(html, /JetBrains Mono/);
  assert.match(html, /Jost/);
});

test("the build ships finished resources with no scaffolding left over", async () => {
  const [page, layout, app, archive, cadProcessing, reconstruction, viewport, css, packageJson] =
    await Promise.all([
      readFile(new URL("../app/app/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
      Promise.all(
        ["AedexaApp.tsx", "placement/PlacementWorkspace.tsx"].map((path) =>
          readFile(new URL(`../app/components/${path}`, import.meta.url), "utf8"),
        ),
      ).then((parts) => parts.join("\n")),
      readFile(new URL("../app/components/ArchiveWorkspace.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/components/CadProcessingView.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/components/ReconstructionWorkspace.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/components/CadViewport.tsx", import.meta.url), "utf8"),
      // The stylesheet is split into parts; check it as a whole, imports included
      readFile(new URL("../app/globals.css", import.meta.url), "utf8").then(async (manifest) => {
        const parts = [...manifest.matchAll(/@import "\.\/([^"]+)"/g)].map((m) => m[1]);
        const bodies = await Promise.all(
          parts.map((name) => readFile(new URL(`../app/${name}`, import.meta.url), "utf8")),
        );
        return [manifest, ...bodies].join("\n");
      }),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
    ]);

  assert.match(page, /AedexaApp/);
  assert.match(layout, /generateMetadata/);
  assert.match(layout, /code-compliant building placement/);
  assert.match(app, /SURROUNDINGS → SITE → CONSTRAINTS → PLACEMENT/);
  assert.match(app, /WHAT HAPPENS NEXT/);
  assert.match(app, /Verifiable placement/);
  assert.match(app, /placement-upload-card/);
  assert.doesNotMatch(app, /placement-empty/);
  assert.match(app, /contextObjects/);
  assert.match(app, /Close outline/);
  assert.match(app, /Building codes/);
  assert.match(app, /analyzePlacement/);
  assert.match(app, /CadProcessingView/);
  assert.match(app, /ReconstructionWorkspace/);
  assert.match(app, /archivedPlacement/);
  assert.match(archive, /PlacementWorkspace/);
  assert.match(archive, /CadProcessingView/);
  assert.match(archive, /ReconstructionWorkspace/);
  assert.doesNotMatch(archive, /PlacementArchivePreview|CadViewport|ReconstructionViewport/);
  assert.match(cadProcessing, /archivedEntry/);
  assert.match(reconstruction, /archivedEntry/);
  assert.doesNotMatch(app, /AI Studio|FULL CYCLE · 12 STAGES|placement-steps/);
  assert.doesNotMatch(
    viewport,
    /terrainMesh\.rotation/,
    "terrain coordinates are not rotated into a vertical plane",
  );
  assert.match(viewport, /!isCadFeatureRenderable\(feature\)/);
  assert.match(viewport, /const elevationScale = worldScale/);
  assert.doesNotMatch(viewport, /verticalExaggeration/);
  assert.match(cadProcessing, /useState<"2d" \| "3d">\(\s*\(\) =>\s*archivedEntry/);
  assert.equal(
    cadProcessing.match(/setViewMode\("3d"\)/g)?.length,
    2,
    "valid terrain opens in 3D and stays a separate mode",
  );
  assert.match(viewport, /viewMode === "3d" && terrain\.triangles\.length/);
  assert.match(viewport, /viewMode === "3d" &&\s*isBuildingFootprint\(feature\)/);
  assert.match(viewport, /controls\.mouseButtons\.LEFT = THREE\.MOUSE\.PAN/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /button:focus-visible/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(packageJson, /@huggingface\/transformers/);
  assert.doesNotMatch(app, /imageAi|enrichPlanImageWithAi|AI segmentation/);
  await assert.rejects(access(new URL("app/_sites-preview", root)));
});
