# Drawings for review

Three real files, so you can see the program at work without a drawing of your own.
Open them at https://aedexa.site — the file stays on your device, and parsing
runs in the browser.

## Topographic survey

**DWG topo survey** mode: terrain, objects, 2D drawing, and 3D scene.

- **`topo.dwg`** — an individual housing block, 1.9 MB. Site of 3,100 m², 1,891 spot elevations,
  6.77 m of relief, 21 utility lines, 20 neighboring structures. Parsing takes 4 seconds.
- **`road.dwg`** — a road project, 20 MB. Site of 1,263 m², 150 utility lines.
  Parsing takes about two and a half minutes: the file is large, that is expected.

Both also work in **Placement & setbacks** mode — the program recognizes them
as site surveys on its own and calculates the buildable area.

## 2D → 3D

**2D → 3D** mode: a drawing becomes a 3D model.

- **`bridge.dwg`** — a bridge, 340 KB. It has no site layers, and the program
  notices: it does not run placement on such a drawing and moves on to reconstruction.

The mode is available when a language model key is configured.
