"use client";

import { ArrowRight, ArrowUp, Box, FileCheck2, LandPlot, Layers, Map } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import Mark from "../Mark";
import LandingKnot from "./LandingKnot";
import Reveal from "./Reveal";

/** Landing page */

/** What the product does */
const CHAPTERS = [
  {
    tone: "light" as const,
    step: "01",
    eyebrow: "READING",
    title: "Source files parsed with no manual markup",
    text: "DWG and DXF files are read right in the browser: layers, land-use boundaries, utilities, contour lines, spot elevations, and units. AEDEXA detects the drawing type and the purpose of every layer on its own — there is nothing to mark up by hand. Your file stays on your device.",
    plate: "/arche/sketch/1_3f3943-strokes.png",
    alt: "Section and plan: what the app reads",
    icon: <Layers size={18} />,
  },
  {
    tone: "dark" as const,
    step: "02",
    eyebrow: "SETBACKS",
    title: "A buildable area that cites the code clause",
    text: "Boundary setbacks, utility protection zones, and fire separation distances are subtracted from the site outline. Every constraint is labeled with its clause of SP RK 3.01-101-2013*, so you can see where every meter comes from. A pipe crossing the site splits the buildable area into parts, each with its own area.",
    plate: "/arche/sketch/23_db0855-strokes.png",
    alt: "A volume cut out of the sheet plane",
    icon: <LandPlot size={18} />,
  },
  {
    tone: "light" as const,
    step: "03",
    eyebrow: "TERRAIN",
    title: "Terrain built from your own elevations",
    text: "Contour lines and spot elevations are merged into a Delaunay triangulation and clipped to the site boundary. The surface is built only within the survey extent, so slopes, elevation differences, and slope areas are measured from your drawing, not interpolated.",
    plate: "/arche/sketch/39_e8ee6f-strokes.png",
    alt: "Section along a slope: elevations define the surface",
    icon: <Map size={18} />,
  },
  {
    tone: "dark" as const,
    step: "04",
    eyebrow: "VOLUME",
    title: "The site and its structures in 3D",
    text: "A house, garage, bathhouse, septic tank, canopy, and pad sit on the surface and are checked against sanitary separation distances within the site. Cut and fill are calculated from the terrain, so you know the earthworks volume before you visit the site.",
    plate: "/arche/sketch/27_dd3705-strokes.png",
    alt: "A volume built from lines",
    icon: <Box size={18} />,
  },
  {
    tone: "light" as const,
    step: "05",
    eyebrow: "DOCUMENT",
    title: "A site plan ready to submit",
    text: "The site planning scheme (SPOZU) exports to DXF with a title block, schedule, legend, and corner coordinates. Every schedule row remembers its source: a layer in the source file or a code clause. Opens in AutoCAD and nanoCAD.",
    plate: "/arche/sketch/Ink-Hatching-Architecture-Sketches-_-Black---Whi-strokes.png",
    alt: "Ink hatching: density instead of color",
    icon: <FileCheck2 size={18} />,
  },
];

/** Workspace screenshots */
const SHOWCASE = [
  {
    src: "/showcase/site.webp",
    title: "Site from the map",
    alt: "A 5-point outline over a satellite image, with neighboring buildings found automatically",
  },
  {
    src: "/showcase/topo.webp",
    title: "Terrain and objects",
    alt: "DWG topo survey in 3D: a surface from 2,041 spot elevations, 82 buildings, 617 trees",
  },
  {
    src: "/showcase/model.webp",
    title: "Drawing in 3D",
    alt: "A pedestrian overpass assembled from drawing views: 587 parts, with accuracy flagged",
  },
];

const NUMBERS = [
  { value: "69", label: "third-party drawings tested", note: "63 parsed, 6 unreadable" },
  { value: "275", label: "automated checks", note: "on every release" },
  { value: "19", label: "rules in the code registry", note: "each with a source" },
  {
    value: "0",
    label: "DWG files sent to the server",
    note: "2D → 3D sends the model sheet views only",
  },
];

/** Sheet illustration */
function Plate({ src, alt, tone }: { src: string; alt: string; tone: "light" | "dark" }) {
  return (
    <figure className={`landing-plate ${tone}`}>
      <img src={src} alt={alt} loading="lazy" decoding="async" />
      <figcaption>{alt}</figcaption>
    </figure>
  );
}

/** Who is signed in */
function useAccountName() {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { account?: { name: string } | null } | null) => {
        if (alive) setName(payload?.account?.name ?? null);
      })
      .catch(() => {
        // No response
      });
    return () => {
      alive = false;
    };
  }, []);

  return name;
}

/** Sign out */
async function signOut() {
  await fetch("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "logout" }),
  });
  window.location.reload();
}

export default function Landing() {
  const account = useAccountName();

  return (
    <div className="landing" id="landing-top">
      <header className="landing-top">
        <Link className="landing-brand" href="/">
          <Mark size={30} />
          <strong className="aedexa-mark">AEDEXA</strong>
        </Link>
        {/* No need to offer sign in to someone already signed in */}
        {account ? (
          <nav className="landing-top-actions" aria-label="Account">
            <span className="landing-user">{account}</span>
            <button className="landing-link" type="button" onClick={signOut}>
              Sign out
            </button>
          </nav>
        ) : (
          <nav className="landing-top-actions" aria-label="Sign in">
            <Link className="landing-link" href="/login">
              Sign in
            </Link>
            <Link className="landing-pill" href="/register">
              Create account
            </Link>
          </nav>
        )}
      </header>

      {/* Hero */}
      <section className="landing-hero">
        {/* Name - centered, over the mark */}
        <div className="landing-hero-copy">
          <Reveal delay={120}>
            <h1 className="landing-title aedexa-mark">AEDEXA</h1>
          </Reveal>
        </div>

        <Reveal from="scale" delay={160} className="landing-knot">
          <LandingKnot />
        </Reveal>

        {/* Way into the workspace */}
        <Reveal delay={280} className="landing-hero-enter">
          <Link className="landing-link large" href="/app">
            Open workspace <ArrowRight size={17} />
          </Link>
        </Reveal>
      </section>

      {/* Numbers: claims backed by checks */}
      <section className="landing-numbers">
        {NUMBERS.map((item, index) => (
          <Reveal as="article" key={item.label} delay={index * 90} className="landing-number">
            <strong>{item.value}</strong>
            <span>{item.label}</span>
            <small>{item.note}</small>
          </Reveal>
        ))}
      </section>

      {/* Album: sheets alternate tone and side */}
      {CHAPTERS.map((chapter, index) => (
        <section
          key={chapter.step}
          className={`landing-chapter ${chapter.tone}${index % 2 ? " mirrored" : ""}`}
        >
          <Reveal from={index % 2 ? "right" : "left"} className="landing-chapter-copy">
            <p className="landing-eyebrow">
              <span className="landing-step">{chapter.step}</span> {chapter.eyebrow}
            </p>
            <h2>{chapter.title}</h2>
            <p>{chapter.text}</p>
            <span className="landing-chapter-icon">{chapter.icon}</span>
          </Reveal>
          <Reveal
            from={index % 2 ? "left" : "right"}
            delay={140}
            className="landing-chapter-figure"
          >
            <Plate src={chapter.plate} alt={chapter.alt} tone={chapter.tone} />
          </Reveal>
        </section>
      ))}

      {/* In action: real workspace screenshots */}
      <section className="landing-showcase">
        <Reveal className="landing-showcase-head">
          <p className="landing-eyebrow">IN ACTION</p>
          <h2>This is what a site analysis looks like</h2>
          <p>
            These shots come from the workspace on real sites, and your file goes through the same
            steps. Every line in them is calculated, not drawn in by hand.
          </p>
        </Reveal>

        <div className="landing-shots">
          {SHOWCASE.map((shot, index) => (
            <Reveal
              as="figure"
              key={shot.src}
              from={index % 2 ? "left" : "right"}
              delay={index * 90}
              className="landing-shot"
            >
              <img src={shot.src} alt={shot.alt} loading="lazy" decoding="async" />
              <figcaption>
                <strong>{shot.title}</strong>
                <span>{shot.alt}</span>
              </figcaption>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Final spread */}
      <section className="landing-final">
        <Reveal from="scale">
          <Mark size={64} />
          <h2>Check your site before the first sketch</h2>
          <p>
            Upload your DWG or open a sample site. The calculation runs on your device and takes
            seconds. No sign-up needed.
          </p>
          <div className="landing-final-actions">
            <Link className="landing-pill large" href="/app">
              Open workspace <ArrowRight size={17} />
            </Link>
            <Link className="landing-link large" href="/login">
              I have an account
            </Link>
          </div>
          <div className="landing-final-back">
            <a href="#landing-top">
              <ArrowUp size={15} /> Try it now
            </a>
          </div>
        </Reveal>
      </section>

      <footer className="landing-foot">
        <Mark size={22} />
        <span>
          <span className="aedexa-mark">AEDEXA</span> · pre-design site check
        </span>
        <span className="landing-foot-note">
          Automated calculation. Must be reviewed by a certified professional.
        </span>
      </footer>
    </div>
  );
}
