import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "./browser-runtime.js";
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export * from "./conversion.js";
export * from "./index.js";
