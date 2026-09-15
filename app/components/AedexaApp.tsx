"use client";
import { Box, FolderArchive, LandPlot, LoaderCircle, Map, ShieldCheck } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState } from "react";
import Mark from "./Mark";
import PlacementWorkspace from "./placement/PlacementWorkspace";

export type ServerFeatures = { ai: boolean };

type WorkspaceMode = "placement" | "topography" | "reconstruction" | "archive";

const CadProcessingView = dynamic(() => import("./CadProcessingView"), {
  ssr: false,
  loading: () => (
    <div>
      <LoaderCircle className="spin" /> Loading DWG module…
    </div>
  ),
});

const ReconstructionWorkspace = dynamic(() => import("./ReconstructionWorkspace"), {
  ssr: false,
  loading: () => <div>Loading 2D → 3D module…</div>,
});

const ArchiveWorkspace = dynamic(() => import("./ArchiveWorkspace"), {
  ssr: false,
  loading: () => <div>Opening project archive…</div>,
});

/** Caption under the name */
const MODE_CAPTION: Record<WorkspaceMode, string> = {
  placement: "Code-compliant building placement",
  topography: "Site terrain and objects",
  reconstruction: "Accurate 3D reconstruction",
  archive: "Saved results",
};

const MODE_STATUS: Record<WorkspaceMode, string> = {
  placement: "Pre-design check",
  topography: "DWG read on your device",
  reconstruction: "Accuracy-checked geometry",
  archive: "Autosave on",
};

/** Sections you can link to */
const MODE_IDS: WorkspaceMode[] = ["placement", "topography", "reconstruction", "archive"];

function modeFromAddress(): WorkspaceMode {
  if (typeof window === "undefined") return "placement";
  const asked = new URLSearchParams(window.location.search).get("mode");
  return MODE_IDS.find((id) => id === asked) ?? "placement";
}

export default function AedexaApp({ features = { ai: false } }: { features?: ServerFeatures }) {
  const [mode, setMode] = useState<WorkspaceMode>("placement");

  // The section is read from the URL on open, and the URL updates on navigation
  useEffect(() => {
    const asked = modeFromAddress();
    if (asked !== "placement") queueMicrotask(() => setMode(asked));
  }, []);

  const openMode = (next: WorkspaceMode) => {
    setMode(next);
    if (typeof window === "undefined") return;
    const address = new URL(window.location.href);
    if (next === "placement") address.searchParams.delete("mode");
    else address.searchParams.set("mode", next);
    window.history.replaceState(null, "", address);
  };

  // Modes live in a fixed sidebar
  const modes: Array<{ id: WorkspaceMode; label: string; icon: React.ReactNode; shown: boolean }> =
    [
      {
        id: "placement",
        label: "Placement and setbacks",
        icon: <LandPlot size={18} />,
        shown: true,
      },
      { id: "topography", label: "DWG topo survey", icon: <Map size={18} />, shown: true },
      { id: "reconstruction", label: "2D → 3D", icon: <Box size={18} />, shown: features.ai },
      { id: "archive", label: "All projects", icon: <FolderArchive size={18} />, shown: true },
    ];

  return (
    <div className="aedexa-shell">
      <a className="skip-link" href="#placement-workspace">
        Skip to workspace
      </a>

      <nav className="aedexa-rail" aria-label="App sections">
        <Link className="aedexa-rail-brand" href="/" aria-label="AEDEXA — home">
          <Mark size={38} />
          <span>
            <strong className="aedexa-mark">AEDEXA</strong>
            <small>{MODE_CAPTION[mode]}</small>
          </span>
        </Link>

        <ul className="aedexa-rail-modes">
          {modes
            .filter((item) => item.shown)
            .map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={mode === item.id ? "active" : ""}
                  aria-current={mode === item.id ? "page" : undefined}
                  onClick={() => openMode(item.id)}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              </li>
            ))}
        </ul>

        <p className="aedexa-rail-status">
          <ShieldCheck size={15} />
          <span>{MODE_STATUS[mode]}</span>
        </p>
      </nav>

      <main className="placement-app">
        <PlacementWorkspace active={mode === "placement"} />
        {mode !== "placement" && (
          <div className="app-main">
            {mode === "topography" ? (
              <section className="topography-preserved" id="placement-workspace">
                <div className="topography-intro">
                  <div>
                    <p className="placement-eyebrow">SITE TERRAIN AND OBJECTS</p>
                    <h1>DWG → terrain and survey objects</h1>
                    <p>
                      DWG reading, terrain from spot elevations, object classification, DAE export.
                      Placement lives in the first mode.
                    </p>
                  </div>
                </div>
                <CadProcessingView onToast={() => undefined} />
              </section>
            ) : mode === "reconstruction" ? (
              <ReconstructionWorkspace />
            ) : mode === "archive" ? (
              <ArchiveWorkspace />
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}
