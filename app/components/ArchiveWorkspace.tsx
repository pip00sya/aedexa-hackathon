"use client";

import {
  Box,
  Check,
  ChevronLeft,
  Clock3,
  FolderArchive,
  LandPlot,
  Layers3,
  LoaderCircle,
  Map,
  Search,
  ShieldCheck,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import {
  ARCHIVE_UPDATED_EVENT,
  listArchiveEntries,
  type ArchiveEntry,
  type ArchiveKind,
  type PlacementArchiveEntry,
  type ReconstructionArchiveEntry,
  type TopographyArchiveEntry,
} from "../lib/archive";
import ArchivePreview from "./ArchivePreview";

const PlacementWorkspace = dynamic(() => import("./placement/PlacementWorkspace"), {
  ssr: false,
  loading: () => (
    <div className="archive-preview-loading">
      <LoaderCircle className="spin" /> Loading placement results…
    </div>
  ),
});

const CadProcessingView = dynamic(() => import("./CadProcessingView"), {
  ssr: false,
  loading: () => (
    <div className="archive-preview-loading">
      <LoaderCircle className="spin" /> Loading DWG module…
    </div>
  ),
});

const ReconstructionWorkspace = dynamic(() => import("./ReconstructionWorkspace"), {
  ssr: false,
  loading: () => (
    <div className="archive-preview-loading">
      <LoaderCircle className="spin" /> Loading reconstruction module…
    </div>
  ),
});

const kindMeta: Record<ArchiveKind, { label: string; icon: typeof LandPlot }> = {
  placement: { label: "Placement and setbacks", icon: LandPlot },
  topography: { label: "DWG topo survey", icon: Map },
  reconstruction: { label: "2D → 3D", icon: Box },
};

const statusLabels = {
  ready: "Ready",
  review: "Needs review",
  blocked: "Has constraints",
} as const;

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function entryMetrics(entry: ArchiveEntry) {
  if (entry.kind === "placement") {
    const blocking = entry.payload.analysis.rules.filter(
      (rule) => rule.status === "FAIL" || rule.status === "MISSING_DATA",
    ).length;
    return [
      `${entry.payload.analysis.parcelArea.toFixed(0)} m² site`,
      `${entry.payload.analysis.buildableArea.toFixed(0)} m² buildable`,
      blocking ? `${blocking} flagged` : "no conflicts",
    ];
  }
  if (entry.kind === "topography") {
    return [
      `${entry.payload.features.length.toLocaleString("en-US")} objects`,
      `${Math.floor(entry.payload.terrain.triangles.length / 3).toLocaleString("en-US")} terrain faces`,
      `${entry.payload.layers.length} layers`,
    ];
  }
  return [
    `${entry.payload.parts.length} parts`,
    `${Math.round(entry.payload.overallConfidence * 100)}% confidence`,
    entry.payload.unit,
  ];
}

function ArchiveResultWorkspace({ entry }: { entry: ArchiveEntry }) {
  if (entry.kind === "placement") {
    return (
      <div className="archive-full-workspace placement">
        <PlacementWorkspace
          key={entry.id}
          archivedPlacement={entry as PlacementArchiveEntry}
          embedded
        />
      </div>
    );
  }
  if (entry.kind === "topography") {
    return (
      <div className="archive-full-workspace topography">
        <section className="topography-preserved">
          <CadProcessingView
            key={entry.id}
            archivedEntry={entry as TopographyArchiveEntry}
            onToast={() => undefined}
          />
        </section>
      </div>
    );
  }
  return (
    <div className="archive-full-workspace reconstruction">
      <ReconstructionWorkspace key={entry.id} archivedEntry={entry as ReconstructionArchiveEntry} />
    </div>
  );
}

export default function ArchiveWorkspace() {
  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  const [filter, setFilter] = useState<ArchiveKind | "all">("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await listArchiveEntries();
        if (active) {
          setEntries(next);
          setError("");
        }
      } catch (caught) {
        if (active)
          setError(caught instanceof Error ? caught.message : "Could not open the archive.");
      } finally {
        if (active) setLoading(false);
      }
    };
    void refresh();
    globalThis.addEventListener(ARCHIVE_UPDATED_EVENT, refresh);
    return () => {
      active = false;
      globalThis.removeEventListener(ARCHIVE_UPDATED_EVENT, refresh);
    };
  }, []);

  const selected = entries.find((entry) => entry.id === selectedId);
  const counts = useMemo(
    () =>
      Object.fromEntries([
        ["all", entries.length],
        ...Object.keys(kindMeta).map((kind) => [
          kind,
          entries.filter((entry) => entry.kind === kind).length,
        ]),
      ]) as Record<ArchiveKind | "all", number>,
    [entries],
  );
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
    return entries.filter((entry) => {
      if (filter !== "all" && entry.kind !== filter) return false;
      if (!normalizedQuery) return true;
      return `${entry.title} ${entry.sourceName} ${entry.summary}`
        .toLocaleLowerCase("en-US")
        .includes(normalizedQuery);
    });
  }, [entries, filter, query]);

  if (selected) {
    const meta = kindMeta[selected.kind];
    const Icon = meta.icon;
    return (
      <section className="archive-page" id="placement-workspace">
        <button type="button" className="archive-back" onClick={() => setSelectedId(undefined)}>
          <ChevronLeft size={17} /> All projects
        </button>
        <div className="archive-detail-head">
          <div className={`archive-kind-icon ${selected.kind}`}>
            <Icon size={22} />
          </div>
          <div>
            <p className="placement-eyebrow">{meta.label.toLocaleUpperCase("en-US")}</p>
            <h1>{selected.title}</h1>
            <p>{selected.summary}</p>
          </div>
          <span className={`archive-status ${selected.status}`}>
            <Check size={14} />
            {statusLabels[selected.status]}
          </span>
        </div>
        <div className="archive-detail-metrics">
          {entryMetrics(selected).map((metric) => (
            <span key={metric}>{metric}</span>
          ))}
          <span>
            <Clock3 size={14} />
            {formatDate(selected.updatedAt)}
          </span>
        </div>
        <div className="archive-detail-preview">
          <ArchivePreview entry={selected} />
        </div>
        <ArchiveResultWorkspace entry={selected} />
      </section>
    );
  }

  return (
    <section className="archive-page" id="placement-workspace">
      <div className="archive-hero">
        <div>
          <p className="placement-eyebrow">AEDEXA ARCHIVE</p>
          <h1>All projects and results</h1>
          <p>
            Placement results, DWG topo surveys, and 3D models are saved here automatically after
            every run.
          </p>
        </div>
        <div className="archive-local-note">
          <ShieldCheck size={19} />
          <div>
            <strong>Saved in this browser</strong>
            <small>Results survive a page reload on this computer.</small>
          </div>
        </div>
      </div>

      <div className="archive-toolbar">
        <div className="archive-filters" aria-label="Filter results">
          <button
            type="button"
            className={filter === "all" ? "active" : ""}
            onClick={() => setFilter("all")}
          >
            <FolderArchive size={15} /> All <span>{counts.all}</span>
          </button>
          {(Object.entries(kindMeta) as [ArchiveKind, (typeof kindMeta)[ArchiveKind]][]).map(
            ([kind, meta]) => {
              const Icon = meta.icon;
              return (
                <button
                  type="button"
                  key={kind}
                  className={filter === kind ? "active" : ""}
                  onClick={() => setFilter(kind)}
                >
                  <Icon size={15} /> {meta.label} <span>{counts[kind]}</span>
                </button>
              );
            },
          )}
        </div>
        <label className="archive-search">
          <Search size={16} />
          <span className="visually-hidden">Find a project</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by file name"
          />
        </label>
      </div>

      {error && (
        <div className="placement-error archive-error" role="alert">
          <span>{error}</span>
        </div>
      )}
      {loading ? (
        <div className="archive-empty">
          <LoaderCircle className="spin" size={28} />
          <strong>Opening saved projects</strong>
        </div>
      ) : filtered.length ? (
        <div className="archive-grid">
          {filtered.map((entry) => {
            const meta = kindMeta[entry.kind];
            const Icon = meta.icon;
            return (
              <article className="archive-card" key={entry.id}>
                <div className="archive-card-head">
                  <span className={`archive-kind-icon ${entry.kind}`}>
                    <Icon size={19} />
                  </span>
                  <span className={`archive-status ${entry.status}`}>
                    {statusLabels[entry.status]}
                  </span>
                </div>
                <ArchivePreview entry={entry} />
                <p className="placement-eyebrow">{meta.label.toLocaleUpperCase("en-US")}</p>
                <h2>{entry.title}</h2>
                <p className="archive-card-summary">{entry.summary}</p>
                <div className="archive-card-metrics">
                  {entryMetrics(entry).map((metric) => (
                    <span key={metric}>{metric}</span>
                  ))}
                </div>
                <footer>
                  <span>
                    <Clock3 size={13} />
                    {formatDate(entry.updatedAt)}
                  </span>
                  <button type="button" onClick={() => setSelectedId(entry.id)}>
                    Open
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="archive-empty">
          <Layers3 size={34} />
          <strong>{entries.length ? "Nothing matches this filter" : "The archive is empty"}</strong>
          <p>
            {entries.length
              ? "Change the filter or the search text."
              : "Run any AEDEXA tool — the result will show up here on its own."}
          </p>
        </div>
      )}
    </section>
  );
}
