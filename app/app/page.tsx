import type { Metadata } from "next";
import AedexaApp from "../components/AedexaApp";

export const metadata: Metadata = {
  title: "AEDEXA — workspace",
  description:
    "Placement and setbacks, DWG topo survey, 2D → 3D reconstruction, and a project archive in one workspace.",
};

/** Features that depend on the server environment */
function serverFeatures() {
  const ai = Boolean(process.env.FEATHERLESS_API_KEY);
  return { ai };
}

export default function WorkspacePage() {
  return <AedexaApp features={serverFeatures()} />;
}
