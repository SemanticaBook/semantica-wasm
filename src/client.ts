import type {
  ClassifiedBlock,
  ClassificationEvent,
  ClassificationProgress,
  ModelLoadProgress,
  ReviewQuestion,
  InferenceSettings,
} from "./index.js";
import { DEFAULT_LAYA_MODEL_BASE_URL } from "./index.js";
import type { ReviewHandler } from "./index.js";

type ClassificationResult = {
  markdown: string;
  blocks: ClassifiedBlock[];
};
type WorkerMessage =
  | { type: "load-progress"; requestId: number; label: string; percent: number }
  | { type: "load-done"; requestId: number }
  | {
      type: "classify-progress";
      requestId: number;
      value: number;
      label: string;
    }
  | { type: "classify-event"; requestId: number; event: ClassificationEvent }
  | {
      type: "review";
      requestId: number;
      reviewId: number;
      question: ReviewQuestion;
    }
  | { type: "classify-done"; requestId: number; result: ClassificationResult }
  | { type: "error"; requestId: number; message: string };

type PendingRequest = {
  onLoadProgress?: ModelLoadProgress;
  onClassificationProgress?: ClassificationProgress;
  onClassificationEvent?: (event: ClassificationEvent) => void;
  onReview?: ReviewHandler;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class BookcliWasmClient {
  private static nextRequestId = 1;
  private static instance: BookcliWasmClient | null = null;
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();

  private constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
      name: "semantica-laya-wasm",
    });
    this.worker.addEventListener(
      "message",
      (event: MessageEvent<WorkerMessage>) => {
        void this.handleMessage(event.data);
      },
    );
    this.worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "Falló el worker de Laya WASM.");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  static async load(
    baseUrl = DEFAULT_LAYA_MODEL_BASE_URL,
    onProgress: ModelLoadProgress = () => undefined,
  ): Promise<BookcliWasmClient> {
    if (BookcliWasmClient.instance) return BookcliWasmClient.instance;
    const client = new BookcliWasmClient();
    try {
      await client.request<void>(
        { type: "load", baseUrl },
        { onLoadProgress: onProgress },
      );
      BookcliWasmClient.instance = client;
      return client;
    } catch (error) {
      client.worker.terminate();
      client.pending.clear();
      throw error;
    }
  }

  classifyText(
    text: string,
    onProgress: ClassificationProgress,
    onReview?: ReviewHandler,
    autoAcceptThreshold = 0.85,
    keepNoise = true,
    onBlock?: (event: ClassificationEvent) => void,
    settings?: Partial<InferenceSettings>,
  ): Promise<ClassificationResult> {
    return this.request<ClassificationResult>(
      { type: "classify", text, autoAcceptThreshold, keepNoise, settings },
      {
        onClassificationProgress: onProgress,
        onReview,
        onClassificationEvent: onBlock,
      },
    );
  }

  private request<T>(
    payload:
      | { type: "load"; baseUrl: string }
      | {
          type: "classify";
          text: string;
          autoAcceptThreshold: number;
          keepNoise: boolean;
          settings?: Partial<InferenceSettings>;
        },
    callbacks: Pick<
      PendingRequest,
      | "onLoadProgress"
      | "onClassificationProgress"
      | "onClassificationEvent"
      | "onReview"
    >,
  ): Promise<T> {
    const requestId = BookcliWasmClient.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        ...callbacks,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.worker.postMessage({ ...payload, requestId });
    });
  }

  private async handleMessage(message: WorkerMessage): Promise<void> {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if (message.type === "load-progress") {
      pending.onLoadProgress?.(message.label, message.percent);
      return;
    }
    if (message.type === "classify-progress") {
      pending.onClassificationProgress?.(message.value, message.label);
      return;
    }
    if (message.type === "classify-event") {
      pending.onClassificationEvent?.(message.event);
      return;
    }
    if (message.type === "review") {
      try {
        const label = pending.onReview
          ? await pending.onReview(message.question)
          : message.question.suggested_label;
        this.worker.postMessage({
          type: "review-answer",
          reviewId: message.reviewId,
          label,
        });
      } catch (error) {
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
        this.pending.delete(message.requestId);
      }
      return;
    }
    this.pending.delete(message.requestId);
    if (message.type === "error") {
      pending.reject(new Error(message.message));
    } else if (message.type === "load-done") {
      pending.resolve(undefined);
    } else {
      pending.resolve(message.result);
    }
  }
}

export { BookcliWasmClient as SemanticaWasmClient };
