interface LatestRequestOptions<T> {
  onStart?: () => void;
  request: (requestId: string) => Promise<T>;
  onSuccess: (value: T) => void;
  onError: (error: unknown) => void;
  onSettled?: () => void;
}

/**
 * Owns the single latest-wins request slot used by the content UI. Starting a
 * request cancels its predecessor; results, errors, and settled callbacks from
 * superseded requests are ignored.
 */
export class LatestRequestRunner {
  private activeId: string | null = null;
  private disposed = false;

  constructor(
    private readonly createId: () => string,
    private readonly notifyCancel: (requestId: string) => void,
  ) {}

  get activeRequestId(): string | null {
    return this.activeId;
  }

  cancel(): void {
    const requestId = this.activeId;
    this.activeId = null;
    if (requestId) {
      this.notifyCancel(requestId);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  async run<T>(options: LatestRequestOptions<T>): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.cancel();
    const requestId = this.createId();
    this.activeId = requestId;

    try {
      options.onStart?.();
      const value = await options.request(requestId);
      if (!this.isCurrent(requestId)) {
        return;
      }
      options.onSuccess(value);
    } catch (error) {
      if (this.isCurrent(requestId)) {
        options.onError(error);
      }
    } finally {
      if (this.isCurrent(requestId)) {
        this.activeId = null;
        options.onSettled?.();
      }
    }
  }

  private isCurrent(requestId: string): boolean {
    return this.activeId === requestId;
  }
}
