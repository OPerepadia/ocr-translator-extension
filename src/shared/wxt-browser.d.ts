import "wxt/browser";

declare module "wxt/browser" {
  interface WxtRuntime {
    getBrowserInfo?(): Promise<{ name: string; version: string }>;
  }
}
