import "./browser-runtime.js";
import { BookcliWasm } from "./index.js";
import type {
  BookcliLabel,
  ClassificationEvent,
  ClassificationProgress,
  ModelLoadProgress,
  ReviewQuestion,
  InferenceSettings,
} from "./index.js";

type WorkerRequest =
  | { type: "load"; requestId: number; baseUrl: string }
  | {
      type: "classify";
      requestId: number;
      text: string;
      autoAcceptThreshold: number;
      keepNoise: boolean;
      settings?: Partial<InferenceSettings>;
    }
  | { type: "review-answer"; reviewId: number; label: BookcliLabel };

let classifier: BookcliWasm | null = null;
let nextReviewId = 1;
const pendingReviews = new Map<number, (label: BookcliLabel) => void>();

function send(message: Record<string, unknown>) {
  self.postMessage(message);
}

function reportError(requestId: number, error: unknown) {
  const detail = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  send({
    type: "error",
    requestId,
    message: detail,
  });
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === "review-answer") {
    const resolveReview = pendingReviews.get(request.reviewId);
    if (resolveReview) {
      pendingReviews.delete(request.reviewId);
      resolveReview(request.label);
    }
    return;
  }

  if (request.type === "load") {
    const requestId = request.requestId;
    void BookcliWasm.load(request.baseUrl, (label, percent) => {
      const progress: ModelLoadProgress = (status, value) => {
        send({
          type: "load-progress",
          requestId,
          label: status,
          percent: value,
        });
      };
      progress(label, percent);
    })
      .then((loaded) => {
        classifier = loaded;
        send({ type: "load-done", requestId });
      })
      .catch((error: unknown) => reportError(request.requestId, error));
    return;
  }

  if (request.type === "classify") {
    if (!classifier) {
      reportError(
        request.requestId,
        new Error("El modelo Laya WASM aún no está cargado."),
      );
      return;
    }
    const onProgress: ClassificationProgress = (value, label) => {
      send({
        type: "classify-progress",
        requestId: request.requestId,
        value,
        label,
      });
    };
    void classifier
      .classifyText(
        request.text,
        onProgress,
        (question: ReviewQuestion) =>
          new Promise<BookcliLabel>((resolveReview) => {
            const reviewId = nextReviewId++;
            pendingReviews.set(reviewId, resolveReview);
            send({
              type: "review",
              requestId: request.requestId,
              reviewId,
              question,
            });
          }),
        request.autoAcceptThreshold,
        request.keepNoise,
        (classificationEvent: ClassificationEvent) =>
          send({
            type: "classify-event",
            requestId: request.requestId,
            event: classificationEvent,
          }),
        request.settings,
      )
      .then((result) =>
        send({ type: "classify-done", requestId: request.requestId, result }),
      )
      .catch((error: unknown) => reportError(request.requestId, error));
  }
});
