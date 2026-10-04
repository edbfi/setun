import { describeCause, log } from "../logging";

/**
 * The in-process job scheduler (PRD §6, §16, §21).
 *
 * §6 puts the scheduler inside the application rather than beside it: three
 * containers, one of which is the app, and no fourth for cron. Development runs
 * the Vite dev server under Node while production runs the adapter-bun build
 * under Bun, so this is `setInterval` and nothing Bun-specific — `Bun.cron`
 * would work in production and silently not exist in dev.
 *
 * What the scheduler guarantees, and jobs therefore need not: a job never runs
 * concurrently with itself, a throwing job does not stop the timer or take the
 * process down, and stopping is complete.
 *
 * Jobs are idempotent and time-driven rather than tick-driven — each decides
 * from the clock what is due — so a missed tick over a restart costs nothing and
 * an extra one does nothing.
 */

export interface ScheduledJob {
  /** Appears in the scheduler's log lines. No content, only the name (§16). */
  readonly name: string;
  readonly intervalMs: number;
  /** Run once as soon as the scheduler starts, before waiting out the first interval. */
  readonly runAtStart?: boolean;
  run(now: Date): void | Promise<void>;
}

export interface SchedulerOptions {
  /** Injected in tests; production leaves it as the wall clock. */
  now?(): Date;
  onError?(job: string, error: unknown): void;
}

/** Console by default: the name and the failure, never a payload (§16). */
function defaultOnError(job: string, error: unknown): void {
  log.error(`job ${job} failed`, { cause: describeCause(error) });
}

export class JobScheduler {
  readonly #jobs: ScheduledJob[] = [];
  readonly #timers = new Map<string, ReturnType<typeof setInterval>>();
  readonly #running = new Set<string>();
  readonly #now: () => Date;
  readonly #onError: (job: string, error: unknown) => void;

  constructor(options: SchedulerOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? defaultOnError;
  }

  register(job: ScheduledJob): this {
    this.#jobs.push(job);
    return this;
  }

  start(): void {
    for (const job of this.#jobs) {
      if (this.#timers.has(job.name)) continue;

      const timer = setInterval(() => void this.trigger(job.name), job.intervalMs);
      // Node and Bun both offer this on a timer handle; a browser-shaped one
      // would not, and a scheduler must never be the reason a process lingers.
      timer.unref?.();
      this.#timers.set(job.name, timer);

      if (job.runAtStart) void this.trigger(job.name);
    }
  }

  stop(): void {
    for (const timer of this.#timers.values()) clearInterval(timer);
    this.#timers.clear();
  }

  /**
   * Run one job now, by name. Returns once it has finished.
   *
   * The overlap guard is here rather than in each job: a retention pass over a
   * large database can outlast its interval, and two passes deleting the same
   * rows would race for no benefit.
   */
  async trigger(name: string): Promise<void> {
    const job = this.#jobs.find((candidate) => candidate.name === name);
    if (!job || this.#running.has(name)) return;

    this.#running.add(name);
    try {
      await job.run(this.#now());
    } catch (error) {
      this.#onError(name, error);
    } finally {
      this.#running.delete(name);
    }
  }
}
