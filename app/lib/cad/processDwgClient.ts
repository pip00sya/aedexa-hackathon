import CadProcessingWorker from "./cadProcessing.worker?worker";
import type { CadProcessingResult } from "./types";

const MAX_FILE_BYTES = 80 * 1024 * 1024;

type WorkerMessage =
  | { type: "progress"; progress: number; label: string }
  | { type: "result"; result: CadProcessingResult }
  | { type: "error"; message: string };

export async function processDwgFile(
  file: File,
  onProgress?: (progress: number, label: string) => void,
): Promise<CadProcessingResult> {
  if (!file.name.toLowerCase().endsWith(".dwg")) {
    throw new Error("A DWG file is required. A separate DXF importer will be added.");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      "The file is larger than 80 MB. Split the topographic survey or purge external references.",
    );
  }

  onProgress?.(5, "Reading the file from disk");
  const content = await file.arrayBuffer();
  onProgress?.(10, "Sending the DWG to the background CAD engine");

  return new Promise<CadProcessingResult>((resolve, reject) => {
    const worker = new CadProcessingWorker({ name: "aedexa-dwg-processor" });
    const finish = () => worker.terminate();
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (event.data.type === "progress") {
        onProgress?.(event.data.progress, event.data.label);
        return;
      }
      if (event.data.type === "result") {
        finish();
        resolve(event.data.result);
        return;
      }
      finish();
      reject(new Error(event.data.message));
    };
    worker.onerror = (event) => {
      finish();
      reject(
        new Error(event.message || "The background CAD engine stopped. Try re-saving the DWG."),
      );
    };
    worker.postMessage({ type: "process", fileName: file.name, fileSize: file.size, content }, [
      content,
    ]);
  });
}
