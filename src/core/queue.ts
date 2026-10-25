import type { Logger } from 'pino';

/**
 * In-process FIFO queue with at-most-one event in flight.
 *
 * Firefly only retries when it gets a non-2xx, so replying 202 quickly and
 * retrying *ourselves* (with backoff) is what covers SparkyFitness being
 * down. The queue is deliberately small: a personal bridge sees a handful of
 * deliveries a day.
 */

export class RetryLater extends Error {
  constructor(
    public readonly delayMs: number,
  ) {
    super(`retry in ${Math.round(delayMs / 1000)}s`);
    this.name = 'RetryLater';
  }
}

export interface QueueOptions {
  logger: Logger;
  maxDelayMs: number;
  process: (eventId: number) => Promise<void>;
}

export class EventQueue {
  private readonly queued: number[] = [];
  private readonly inFlight = new Set<number>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private loopPromise: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly opts: QueueOptions) {}

  /** Enqueue an event for processing. Returns false if already tracked. */
  enqueue(eventId: number): boolean {
    if (this.stopping) return false;
    if (this.inFlight.has(eventId) || this.queued.includes(eventId) || this.timers.has(eventId)) {
      return false;
    }
    this.queued.push(eventId);
    this.pump();
    return true;
  }

  /** Number of events currently waiting (excluding the one in flight). */
  get size(): number {
    return this.queued.length;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Wait for the in-flight event (and any retries already scheduled to fire
   *  is NOT included); pending retries are cancelled and stay in the DB. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    while (this.loopPromise) {
      await this.loopPromise;
    }
    // Unprocessed items remain 'pending'/'failed' in the DB and are
    // re-queued on the next start.
    this.queued.length = 0;
  }

  private schedule(eventId: number, delayMs: number): void {
    if (this.stopping) return;
    const clamped = Math.max(1, Math.min(delayMs, this.opts.maxDelayMs));
    const timer = setTimeout(() => {
      this.timers.delete(eventId);
      this.enqueue(eventId);
    }, clamped);
    timer.unref?.();
    this.timers.set(eventId, timer);
  }

  private pump(): void {
    if (this.loopPromise || this.queued.length === 0) return;
    this.loopPromise = this.loop().catch((err: unknown) => {
      this.opts.logger.error({ err }, 'queue loop crashed unexpectedly');
    }).finally(() => {
      this.loopPromise = null;
    });
  }

  private async loop(): Promise<void> {
    for (;;) {
      const eventId = this.queued.shift();
      if (eventId === undefined) return;
      this.inFlight.add(eventId);
      try {
        await this.opts.process(eventId);
      } catch (err) {
        if (err instanceof RetryLater) {
          this.opts.logger.warn(
            { event: eventId, retryInMs: err.delayMs },
            'event failed; retry scheduled',
          );
          this.schedule(eventId, err.delayMs);
        } else {
          // processEvent is expected to translate all failures into either a
          // terminal status or RetryLater; anything else is a bug — log it,
          // but do not loop forever.
          this.opts.logger.error({ event: eventId, err }, 'unexpected processor error; not retrying');
        }
      } finally {
        this.inFlight.delete(eventId);
      }
    }
  }
}
