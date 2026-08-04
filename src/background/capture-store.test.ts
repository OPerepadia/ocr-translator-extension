import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CAPTURE_TTL_MS,
  createCaptureStore,
  createMemoryCaptureStore,
  MAX_CAPTURES,
  type CaptureStore,
} from "./capture-store";

// Both implementations answer the same contract, so the suite runs twice.
const implementations: Array<{
  name: string;
  create(now: () => number): CaptureStore;
}> = [
  {
    name: "IndexedDB capture store",
    create: (now) => createCaptureStore({ factory: new IDBFactory(), now }),
  },
  {
    name: "in-memory capture store",
    create: (now) => createMemoryCaptureStore({ now }),
  },
];

describe.each(implementations)("$name", ({ create }) => {
  let clock = 1_000_000;
  let store: CaptureStore;

  beforeEach(() => {
    clock = 1_000_000;
    store = create(() => clock);
  });

  it("reports nothing for a frame that never captured", async () => {
    await expect(store.get("7:0")).resolves.toBeUndefined();
  });

  it("round-trips a capture, image included", async () => {
    const image = new Blob(["pixels"], { type: "image/png" });
    await store.update("7:0", () => ({
      requestId: "request-1",
      image,
      displaySize: { width: 10, height: 5 },
      sourceLanguage: "auto",
    }));

    const record = await store.get("7:0");
    expect(record?.requestId).toBe("request-1");
    expect(record?.displaySize).toEqual({ width: 10, height: 5 });
    expect(await record?.image?.text()).toBe("pixels");
  });

  it("passes the current record to the mutator", async () => {
    await store.update("7:0", () => ({
      requestId: "request-1",
      sourceLanguage: "auto",
    }));
    await store.update("7:0", (current) =>
      current ? { ...current, sourceLanguage: "ja" } : undefined,
    );

    await expect(store.get("7:0")).resolves.toMatchObject({
      requestId: "request-1",
      sourceLanguage: "ja",
    });
  });

  it("leaves the record alone when the mutator declines", async () => {
    await store.update("7:0", () => ({
      requestId: "request-1",
      sourceLanguage: "auto",
    }));
    await store.update("7:0", () => undefined);

    await expect(store.get("7:0")).resolves.toMatchObject({
      requestId: "request-1",
    });
  });

  it("keeps frames apart", async () => {
    await store.update("7:0", () => ({
      requestId: "top",
      sourceLanguage: "auto",
    }));
    await store.update("7:4", () => ({
      requestId: "iframe",
      sourceLanguage: "auto",
    }));

    await expect(store.get("7:0")).resolves.toMatchObject({
      requestId: "top",
    });
    await expect(store.get("7:4")).resolves.toMatchObject({
      requestId: "iframe",
    });
  });

  it("treats an expired capture as gone", async () => {
    await store.update("7:0", () => ({
      requestId: "request-1",
      sourceLanguage: "auto",
    }));

    clock += CAPTURE_TTL_MS + 1;

    await expect(store.get("7:0")).resolves.toBeUndefined();
  });

  it("evicts the oldest capture past the cap", async () => {
    for (let index = 0; index < MAX_CAPTURES + 2; index += 1) {
      clock += 1;
      await store.update(`7:${index}`, () => ({
        requestId: `request-${index}`,
        sourceLanguage: "auto",
      }));
    }

    await expect(store.get("7:0")).resolves.toBeUndefined();
    await expect(store.get("7:1")).resolves.toBeUndefined();
    await expect(store.get(`7:${MAX_CAPTURES + 1}`)).resolves.toMatchObject({
      requestId: `request-${MAX_CAPTURES + 1}`,
    });
  });

  // Or an overlay the user is still working with is evicted ahead of idle ones.
  it("counts a rewrite as the newest capture", async () => {
    for (let index = 0; index < MAX_CAPTURES; index += 1) {
      clock += 1;
      await store.update(`7:${index}`, () => ({
        requestId: `request-${index}`,
        sourceLanguage: "auto",
      }));
    }

    clock += 1;
    await store.update("7:0", (current) =>
      current ? { ...current, sourceLanguage: "ja" } : undefined,
    );

    clock += 1;
    await store.update("7:new", () => ({
      requestId: "request-new",
      sourceLanguage: "auto",
    }));

    await expect(store.get("7:0")).resolves.toMatchObject({
      sourceLanguage: "ja",
    });
    await expect(store.get("7:1")).resolves.toBeUndefined();
  });
});
