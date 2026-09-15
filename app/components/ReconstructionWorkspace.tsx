"use client";
import { downloadBlob as download } from "../lib/browser/download";
import { readAnalysisResponse } from "../lib/ai/readResponse";

import {
  AlertTriangle,
  Box,
  Check,
  Download,
  FileImage,
  FileText,
  FileUp,
  LoaderCircle,
  RefreshCw,
  Ruler,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { createArchiveId, saveArchiveEntry, type ReconstructionArchiveEntry } from "../lib/archive";
import { exportReconstructionDae, exportReconstructionGlb } from "../lib/reconstruction/modelScene";
import { prepareDrawing } from "../lib/reconstruction/prepareDrawing";
import type {
  PreparedDrawing,
  ReconstructionHints,
  ReconstructionModel,
  ReconstructionPart,
  ReconstructionUnit,
} from "../lib/reconstruction/types";
import ReconstructionViewport from "./ReconstructionViewport";

const initialHints: ReconstructionHints = { allowInferredGeometry: true };

const unitLabels: Record<ReconstructionUnit, string> = {
  mm: "millimeters",
  cm: "centimeters",
  m: "meters",
  in: "inches",
};

function safeFileStem(name: string) {
  return (
    name
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zа-яё0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "") || "aedexa-model"
  );
}

function formatElapsed(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

type ReconstructionEvent = {
  stage?: string;
  percent?: number;
  done?: boolean;
  model?: ReconstructionModel;
  error?: string;
};

function compactNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);
}

function partGeometry(part: ReconstructionPart, unit: ReconstructionUnit) {
  if (part.kind === "box")
    return `${compactNumber(part.size.x)} × ${compactNumber(part.size.y)} × ${compactNumber(part.size.z)} ${unit}`;
  if (part.kind === "cylinder")
    return `Ø ${compactNumber(part.radius * 2)} × ${compactNumber(part.height)} ${unit}`;
  if (part.kind === "extrusion")
    return `${part.profile.length} points · H ${compactNumber(part.height)} ${unit}`;
  if (part.kind === "revolution") return `${part.profile.length} revolution profile points`;
  return `${part.faces.length.toLocaleString("en-US")} faces`;
}

function optionalNumber(value: string) {
  if (!value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

type ReconstructionWorkspaceProps = {
  archivedEntry?: ReconstructionArchiveEntry;
};

export default function ReconstructionWorkspace({ archivedEntry }: ReconstructionWorkspaceProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const archiveIdRef = useRef<string | undefined>(archivedEntry?.id);
  const archiveCreatedAtRef = useRef<string | undefined>(archivedEntry?.createdAt);
  const sourceFileRef = useRef<File | undefined>(archivedEntry?.sourceFile);
  const [hasSourceFile, setHasSourceFile] = useState(() => Boolean(archivedEntry?.sourceFile));
  const [prepared, setPrepared] = useState<PreparedDrawing | null>(null);
  const [model, setModel] = useState<ReconstructionModel | null>(
    () => archivedEntry?.payload ?? null,
  );
  const [hints, setHints] = useState<ReconstructionHints>(
    () => archivedEntry?.hints ?? initialHints,
  );
  const [processing, setProcessing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [error, setError] = useState("");
  /** When the model request started */
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (startedAt === null) return;
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const [dragging, setDragging] = useState(false);

  const saveReconstructionArchive = (nextModel: ReconstructionModel) => {
    const archiveId = archiveIdRef.current;
    const createdAt = archiveCreatedAtRef.current;
    if (!archiveId || !createdAt) return;
    void saveArchiveEntry({
      schema: 1,
      id: archiveId,
      kind: "reconstruction",
      title: nextModel.title || nextModel.sourceName.replace(/\.[^.]+$/, "") || "3D model",
      sourceName: nextModel.sourceName,
      summary: `${nextModel.parts.length} ${nextModel.parts.length === 1 ? "part" : "parts"} · ${Math.round(nextModel.overallConfidence * 100)}% confidence · ${nextModel.summary}`,
      status:
        nextModel.status === "ready"
          ? "ready"
          : nextModel.status === "unsupported"
            ? "blocked"
            : "review",
      createdAt,
      updatedAt: new Date().toISOString(),
      sourceFile: sourceFileRef.current,
      hints,
      payload: nextModel,
    }).catch((reason) =>
      setError(
        reason instanceof Error ? reason.message : "Could not save the 3D result to the archive.",
      ),
    );
  };

  const analyzeWithAi = async (source: PreparedDrawing) => {
    setProcessing(true);
    setError("");
    setStartedAt(Date.now());
    setProgress(14);
    setProgressLabel(
      hints.allowInferredGeometry === false
        ? "AI is reading the drawing, building 3D, and checking it against the source views"
        : "AI is reading the sheet, reconstructing 3D, and matching the model back to the drawing",
    );
    try {
      const response = await fetch("/api/reconstruct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceName: source.name,
          dataUrl: source.apiDataUrl,
          dataUrls: source.apiDataUrls,
          context: source.context,
          hints,
        }),
      });
      const payload = await readAnalysisResponse<ReconstructionEvent>(response, (event) => {
        if (typeof event.percent === "number") setProgress(event.percent);
        if (event.stage) setProgressLabel(event.stage);
      });
      if (!response.ok || !payload.model)
        throw new Error(payload.error || "The analysis returned no verifiable geometry.");
      setProgress(94);
      setProgressLabel(
        hints.allowInferredGeometry === false
          ? "Engineering re-check complete"
          : "3D draft with AI assumptions ready",
      );
      setModel(payload.model);
      saveReconstructionArchive(payload.model);
      setProgress(100);
    } catch (caught) {
      setModel(null);
      setError(caught instanceof Error ? caught.message : "Could not analyze the drawing.");
    } finally {
      setProcessing(false);
      setStartedAt(null);
    }
  };

  const loadFile = async (file: File, preserveArchiveEntry = false) => {
    setProcessing(true);
    setPrepared(null);
    setModel(null);
    setError("");
    setProgress(12);
    setProgressLabel("Checking file format and size");
    sourceFileRef.current = file;
    setHasSourceFile(true);
    if (!preserveArchiveEntry) {
      archiveIdRef.current = createArchiveId("reconstruction");
      archiveCreatedAtRef.current = new Date().toISOString();
    }
    try {
      setProgress(28);
      setProgressLabel(
        file.name.toLowerCase().endsWith(".dwg") || file.name.toLowerCase().endsWith(".dxf")
          ? "Reading CAD entities, dimensions, and coordinates"
          : "Preparing the drawing without losing small text",
      );
      const source = await prepareDrawing(file);
      setPrepared(source);
      if (source.exactModel) {
        setModel(source.exactModel);
        saveReconstructionArchive(source.exactModel);
        setProgress(100);
        setProgressLabel("Exact CAD geometry ready");
        setProcessing(false);
        return;
      }
      setProcessing(false);
      await analyzeWithAi(source);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open the file.");
      setProcessing(false);
    }
  };

  const clear = () => {
    setPrepared(null);
    setModel(null);
    setError("");
    setProgress(0);
    setProgressLabel("");
    archiveIdRef.current = undefined;
    archiveCreatedAtRef.current = undefined;
    sourceFileRef.current = undefined;
    setHasSourceFile(false);
  };

  const rebuild = () => {
    if (prepared) {
      void analyzeWithAi(prepared);
      return;
    }
    if (sourceFileRef.current) {
      void loadFile(sourceFileRef.current, true);
      return;
    }
    inputRef.current?.click();
  };

  const exportGlb = async () => {
    if (!model?.parts.length) return;
    setExporting(true);
    setError("");
    try {
      download(
        `${safeFileStem(model.sourceName)}${model.canExport ? "" : "-draft"}.glb`,
        await exportReconstructionGlb(model),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not export GLB.");
    } finally {
      setExporting(false);
    }
  };

  const exportDae = () => {
    if (!model?.parts.length) return;
    setExporting(true);
    setError("");
    try {
      download(
        `${safeFileStem(model.sourceName)}-sketchup${model.canExport ? "" : "-draft"}.dae`,
        exportReconstructionDae(model),
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not export the model for SketchUp.",
      );
    } finally {
      setExporting(false);
    }
  };

  const exportAudit = () => {
    if (!model) return;
    download(
      `${safeFileStem(model.sourceName)}-audit.json`,
      new Blob([JSON.stringify(model, null, 2)], { type: "application/json" }),
    );
  };

  const confidence = Math.round((model?.overallConfidence || 0) * 100);
  const statusLabel =
    model?.status === "ready"
      ? "Ready to export"
      : model?.status === "unsupported"
        ? "Drawing format not recognized"
        : model?.parts.length
          ? "3D draft ready"
          : "Source dimensions needed";

  return (
    <section className="reconstruction-page" id="placement-workspace">
      <div className="reconstruction-hero">
        <div>
          <p className="placement-eyebrow">EVIDENCE-BASED RECONSTRUCTION</p>
          <h1>From a full 2D drawing to a verifiable 3D model</h1>
          <p>
            DWG, SVG, or an image. AEDEXA matches views and dimensions, and reconstructs missing
            geometry as a clearly labeled engineering AI assumption.
          </p>
        </div>
        <div className="reconstruction-principle">
          <ShieldCheck size={19} />
          <div>
            <strong>Controlled AI assumptions</strong>
            <small>AI completes the 3D, but never passes a guess off as an exact dimension.</small>
          </div>
        </div>
      </div>

      {processing && !prepared && (
        <div className="placement-progress reconstruction-progress" role="status">
          <LoaderCircle className="spin" size={18} />
          <span>{progressLabel}</span>
          <div>
            <i style={{ width: `${progress}%` }} />
          </div>
          <strong>{progress}%</strong>
        </div>
      )}
      {error && (
        <div className="placement-error reconstruction-error" role="alert">
          <AlertTriangle size={17} />
          <span>{error}</span>
          <button type="button" onClick={() => setError("")} aria-label="Close error">
            <X size={15} />
          </button>
        </div>
      )}

      <div className="reconstruction-grid">
        <div className="reconstruction-main">
          <header className="reconstruction-panel-head">
            <div>
              <p className="placement-eyebrow">
                {model
                  ? "3D RESULT"
                  : processing && prepared
                    ? "BUILDING 3D"
                    : prepared
                      ? "SOURCE SHEET"
                      : "SOURCE FILE"}
              </p>
              <h2>{model?.title || prepared?.name || "New object"}</h2>
            </div>
            {prepared ? (
              <button type="button" className="reconstruction-clear" onClick={clear}>
                <X size={15} /> Remove file
              </button>
            ) : (
              model && (
                <button
                  type="button"
                  className="reconstruction-clear"
                  onClick={() => inputRef.current?.click()}
                >
                  <Upload size={15} /> Replace source
                </button>
              )
            )}
          </header>

          {model ? (
            <ReconstructionViewport model={model} />
          ) : !prepared ? (
            <button
              type="button"
              className={`reconstruction-dropzone ${dragging ? "dragging" : ""}`}
              onClick={() => inputRef.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                const file = event.dataTransfer.files[0];
                if (file) void loadFile(file);
              }}
              disabled={processing}
            >
              <span className="reconstruction-drop-icon">
                <FileUp size={30} />
              </span>
              <span className="placement-eyebrow">STEP 01</span>
              <strong>Drop the full drawing of the object</strong>
              <small>
                Sheets with a front view, a top or side view, and marked dimensions give the best
                result.
              </small>
              <span className="placement-upload-action">
                <Upload size={17} /> Choose a DWG or image
              </span>
              <span className="reconstruction-format-row">
                <b>CAD up to 80 MB</b>
                <b>Image up to 15 MB</b>
                <b>PNG · JPEG · WEBP · SVG</b>
              </span>
            </button>
          ) : processing ? (
            <div className="reconstruction-building-state" role="status" aria-live="polite">
              <span className="reconstruction-building-icon" aria-hidden="true">
                <Box size={36} />
              </span>
              <p className="placement-eyebrow">3D WORKSPACE</p>
              <strong>
                <LoaderCircle className="spin" size={19} aria-hidden="true" /> The model is being
                built in this window
              </strong>
              <p>{progressLabel}</p>
              <div
                className="reconstruction-building-progress"
                role="progressbar"
                aria-label="Building the 3D model"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress}
              >
                <i style={{ width: `${progress}%` }} />
              </div>
              <small>
                {progress}% · {formatElapsed(elapsed)} · usually 3–6 minutes with an open-weight
                model · the finished object will appear here automatically
              </small>
            </div>
          ) : (
            <div className="reconstruction-source-preview">
              {prepared.previewDataUrl ? (
                <Image
                  src={prepared.previewDataUrl}
                  alt={`Prepared 2D drawing ${prepared.name}`}
                  fill
                  sizes="(max-width: 1120px) 100vw, calc(100vw - 430px)"
                  unoptimized
                />
              ) : (
                <div className="reconstruction-pdf-placeholder">
                  <FileText size={42} />
                  <strong>{prepared.name}</strong>
                  <small>Source preview was not saved.</small>
                </div>
              )}
            </div>
          )}

          {model && (
            <footer className="reconstruction-model-footer">
              <span>
                <i className={`reconstruction-status-dot ${model.status}`} />
                {statusLabel}
              </span>
              <span>
                {model.parts.length} {model.parts.length === 1 ? "part" : "parts"}
              </span>
              <span>{unitLabels[model.unit]}</span>
              <span>
                {model.method === "cad_exact"
                  ? "Direct CAD geometry"
                  : model.method === "cad_parametric"
                    ? "Parametric CAD assembly"
                    : model.method === "ai_agent"
                      ? "Cloud AI agent + CAD tools"
                      : "Cloud AI + engineering re-check"}
              </span>
            </footer>
          )}
        </div>

        <aside className="reconstruction-inspector">
          <section className="reconstruction-card">
            <div className="inspector-heading">
              <div>
                <p className="placement-eyebrow">ACCURACY AND SCALE</p>
                <h2>Confirmed dimensions</h2>
              </div>
              <Ruler size={18} />
            </div>
            <p>Fill in only what you know for sure. These values take priority over recognition.</p>
            <label className="reconstruction-field full">
              <span>Unknown dimensions</span>
              <select
                value={hints.allowInferredGeometry === false ? "strict" : "assisted"}
                onChange={(event) =>
                  setHints({ ...hints, allowInferredGeometry: event.target.value === "assisted" })
                }
              >
                <option value="assisted">AI reconstructs them</option>
                <option value="strict">Proven dimensions only</option>
              </select>
            </label>
            <label className="reconstruction-field full">
              <span>Drawing units</span>
              <select
                value={hints.unit ?? ""}
                onChange={(event) =>
                  setHints({
                    ...hints,
                    unit: event.target.value
                      ? (event.target.value as ReconstructionUnit)
                      : undefined,
                  })
                }
              >
                <option value="">Detect from drawing</option>
                {Object.entries(unitLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <div className="reconstruction-dimensions">
              <label className="reconstruction-field">
                <span>Width X</span>
                <input
                  inputMode="decimal"
                  type="number"
                  min="0"
                  value={hints.width ?? ""}
                  onChange={(event) =>
                    setHints({ ...hints, width: optionalNumber(event.target.value) })
                  }
                  placeholder="unknown"
                />
              </label>
              <label className="reconstruction-field">
                <span>Height Y</span>
                <input
                  inputMode="decimal"
                  type="number"
                  min="0"
                  value={hints.height ?? ""}
                  onChange={(event) =>
                    setHints({ ...hints, height: optionalNumber(event.target.value) })
                  }
                  placeholder="unknown"
                />
              </label>
              <label className="reconstruction-field">
                <span>Depth Z</span>
                <input
                  inputMode="decimal"
                  type="number"
                  min="0"
                  value={hints.depth ?? ""}
                  onChange={(event) =>
                    setHints({ ...hints, depth: optionalNumber(event.target.value) })
                  }
                  placeholder="unknown"
                />
              </label>
            </div>
            <label className="reconstruction-field full">
              <span>Note on views</span>
              <textarea
                rows={3}
                maxLength={800}
                value={hints.notes ?? ""}
                onChange={(event) => setHints({ ...hints, notes: event.target.value })}
                placeholder="For example: front view on the left, section A–A on the right"
              />
            </label>
            {(prepared || hasSourceFile) &&
              (!model || model.method !== "cad_exact" || model.status !== "ready") && (
                <button
                  type="button"
                  className="placement-button primary wide"
                  disabled={processing}
                  onClick={rebuild}
                >
                  {processing ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <RefreshCw size={17} />
                  )}{" "}
                  {model ? "Rebuild with corrections" : "Run analysis"}
                </button>
              )}
          </section>

          {!model ? (
            <section className="reconstruction-card reconstruction-pipeline">
              <p className="placement-eyebrow">PIPELINE</p>
              <h2>What the system checks</h2>
              <ol>
                <li>
                  <span>01</span>
                  <div>
                    <strong>Format and vectors</strong>
                    <small>CAD is read as entities, images at maximum detail.</small>
                  </div>
                </li>
                <li>
                  <span>02</span>
                  <div>
                    <strong>Views and dimensions</strong>
                    <small>
                      Elevation, plan, sections, grid lines, and dimension chains are matched.
                    </small>
                  </div>
                </li>
                <li>
                  <span>03</span>
                  <div>
                    <strong>Parametric geometry</strong>
                    <small>
                      AI picks the most likely structure from the views, symmetry, and dimension
                      chains.
                    </small>
                  </div>
                </li>
                <li>
                  <span>04</span>
                  <div>
                    <strong>Assumption control</strong>
                    <small>
                      Every reconstructed dimension is flagged and stays a draft until confirmed.
                    </small>
                  </div>
                </li>
              </ol>
            </section>
          ) : (
            <>
              <section className={`reconstruction-card reconstruction-verdict ${model.status}`}>
                <div className="reconstruction-score">
                  <span>{confidence}%</span>
                  <small>overall confidence</small>
                </div>
                <div>
                  <p className="placement-eyebrow">CHECK RESULT</p>
                  <h2>{statusLabel}</h2>
                  <p>{model.summary}</p>
                </div>
              </section>

              {model.analysis && (
                <section className="reconstruction-card reconstruction-ai-audit">
                  <div className="inspector-heading">
                    <div>
                      <p className="placement-eyebrow">AI DRAWING ANALYSIS</p>
                      <h2>How AI read the sheet</h2>
                    </div>
                    <ShieldCheck size={18} />
                  </div>
                  <p>{model.analysis.summary}</p>
                  <div className="reconstruction-audit-status">
                    <strong>
                      {model.analysis.sufficientFor3d
                        ? "Enough data for 3D"
                        : model.parts.length
                          ? "3D built with verifiable assumptions"
                          : "More data needed"}
                    </strong>
                    <span>{Math.round(model.analysis.overallConfidence * 100)}% confidence</span>
                  </div>
                  <div className="reconstruction-audit-tags">
                    {model.analysis.detectedViews.map((view) => (
                      <span key={view}>{view}</span>
                    ))}
                    <span>
                      {model.analysis.unit === "unknown"
                        ? "Units not detected"
                        : `Units: ${model.analysis.unit}`}
                    </span>
                  </div>
                  {model.analysis.conclusions.length > 0 && (
                    <div className="reconstruction-conclusions">
                      {model.analysis.conclusions.slice(0, 8).map((conclusion) => (
                        <article key={conclusion.id}>
                          <span>{Math.round(conclusion.confidence * 100)}%</span>
                          <p>{conclusion.statement}</p>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              )}

              {model.agentTrace && (
                <section className="reconstruction-card reconstruction-ai-audit">
                  <div className="inspector-heading">
                    <div>
                      <p className="placement-eyebrow">AI AGENT LOG</p>
                      <h2>What the program did on its own</h2>
                    </div>
                    <ShieldCheck size={18} />
                  </div>
                  <p>
                    These are the actual server calls from this run, not a description of a
                    pre-built model.
                  </p>
                  <div className="reconstruction-audit-status">
                    <strong>
                      {model.agentTrace.completed
                        ? "AI checked and accepted the 3D"
                        : model.parts.length
                          ? "AI found mismatches, showing a draft"
                          : "AI passed the model to general reconstruction"}
                    </strong>
                    <span>AI · {model.agentTrace.model}</span>
                  </div>
                  <div className="reconstruction-audit-tags">
                    <span>
                      {model.agentTrace.llmInvoked
                        ? "LLM was actually called"
                        : "LLM was not called"}
                    </span>
                    <span>
                      {model.agentTrace.solver === "none"
                        ? "No dedicated solver"
                        : `Solver: ${model.agentTrace.solver}`}
                    </span>
                    <span>
                      {model.agentTrace.previewCompared
                        ? "AI reviewed the 3D projections"
                        : "Projections not checked yet"}
                    </span>
                    {model.agentTrace.previewCompared && (
                      <span>
                        View match: {Math.round((model.agentTrace.reviewConfidence ?? 0) * 100)}%
                      </span>
                    )}
                    {model.agentTrace.previewCompared && (
                      <span>
                        Verified elements: {model.agentTrace.verifiedElements?.length ?? 0}/
                        {model.agentTrace.solver === "building_massing" ? 11 : 9}
                      </span>
                    )}
                  </div>
                  <div className="reconstruction-conclusions">
                    {model.agentTrace.steps.map((step) => (
                      <article key={`${step.sequence}-${step.action}`}>
                        <span>{String(step.sequence).padStart(2, "0")}</span>
                        <p>
                          <strong>{step.action}</strong>
                          <br />
                          {step.reason}
                        </p>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {model.unresolved.length > 0 && (
                <section className="reconstruction-card">
                  <div className="inspector-heading">
                    <div>
                      <p className="placement-eyebrow">UNCERTAINTIES</p>
                      <h2>What cannot be proven</h2>
                    </div>
                    <AlertTriangle size={18} />
                  </div>
                  <div className="reconstruction-issues">
                    {model.unresolved.map((issue) => (
                      <article key={issue.id} className={issue.severity}>
                        <strong>{issue.label}</strong>
                        <p>{issue.reason}</p>
                        <small>{issue.requiredFromUser}</small>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              <section className="reconstruction-card">
                <div className="inspector-heading">
                  <div>
                    <p className="placement-eyebrow">MODEL CONTENTS</p>
                    <h2>Parts and evidence</h2>
                  </div>
                  <Box size={18} />
                </div>
                <div className="reconstruction-parts">
                  {model.parts.map((part) => (
                    <article key={part.id}>
                      <span>{Math.round(part.confidence * 100)}%</span>
                      <div>
                        <strong>{part.name}</strong>
                        <small>{partGeometry(part, model.unit)}</small>
                        <p>{part.evidence[0] || "No evidence given"}</p>
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              <section
                className={`reconstruction-card reconstruction-export ${model.canExport ? "" : "draft"}`}
              >
                <div className="inspector-heading">
                  <div>
                    <p className="placement-eyebrow">EXPORT</p>
                    <h2>
                      {model.canExport
                        ? "Model handoff"
                        : model.parts.length
                          ? "Draft for review"
                          : "No geometry built"}
                    </h2>
                  </div>
                  {model.canExport ? <Check size={18} /> : <AlertTriangle size={18} />}
                </div>
                <p>
                  {model.canExport
                    ? "COLLADA DAE is exported in meters and imports directly into SketchUp with part names and materials."
                    : model.parts.length
                      ? "You can download and check the built geometry. The file is marked as a draft: dimensions are not confirmed, so it is not for construction."
                      : "AI built no parts, so an empty 3D file cannot be created. Download the audit and add the missing views or dimensions."}
                </p>
                <button
                  type="button"
                  className="placement-button primary wide"
                  disabled={!model.parts.length || exporting}
                  onClick={exportDae}
                >
                  {exporting ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}{" "}
                  {model.canExport ? "Download for SketchUp (.DAE)" : "Download SketchUp draft"}
                </button>
                <button
                  type="button"
                  className="placement-button secondary wide"
                  disabled={!model.parts.length || exporting}
                  onClick={() => void exportGlb()}
                >
                  <Download size={17} /> {model.canExport ? "Download GLB" : "Download GLB draft"}
                </button>
                <button
                  type="button"
                  className="placement-button secondary wide"
                  onClick={exportAudit}
                >
                  <FileImage size={17} /> Download JSON audit
                </button>
              </section>
            </>
          )}
        </aside>
      </div>

      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept=".dwg,.svg,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp,image/svg+xml"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void loadFile(file);
          event.target.value = "";
        }}
      />
      <footer className="placement-disclaimer reconstruction-disclaimer">
        <ShieldCheck size={17} />
        <p>
          <strong>Accuracy limit:</strong> AI mode creates a draft you can view and open in SketchUp
          even from an incomplete sheet. Construction still needs confirmed views, dimensions, and a
          review by a structural engineer.
        </p>
      </footer>
    </section>
  );
}
