/**
 * Animated planning feedback for OpenWebQA.
 *
 * While the AI agent compiles the markdown plan into a TestPlanGraph the CLI
 * would otherwise sit silently for seconds or minutes. {@link PlanningFeedback}
 * keeps the user aware that planning is happening:
 *
 *   - An animated status line (spinner + elapsed time) runs for the whole
 *     planning phase, so a slow model call is visibly alive.
 *   - When the "deep" agent (see ./deep.ts) calls an exploration tool, the
 *     command is printed inline, in place: its line appears with a spinner as
 *     the tool starts, and is rewritten in place with a one-line summary of
 *     the result when the tool finishes (e.g.
 *     `  ✓ read_file src/app.ts — 2 KB`).
 *
 * Output goes to stderr so stdout stays clean for the plan/execution report.
 * When stderr is a TTY with a known size the status block is redrawn in
 * place using only the three most universal VT operations — cursor-up
 * (\x1b[nA, never with a 0 parameter), carriage return (\r), and line feed
 * (\n). Old line content is overwritten with spaces rather than cleared
 * with \x1b[2K (EL), and the column is reset with \r rather than \x1b[1G
 * (CHA): terminals that lack either of those silently drop them, which
 * makes in-place redraw drift mid-line and leave ghost fragments. When
 * stderr is not a TTY, reports no size, or animation is disabled (e.g. via
 * the CLI --no-anim flag), plain lines are printed instead (tool lines on
 * completion, a summary line at the end) and no animation is used — that
 * output is just text plus newlines and cannot garble on any terminal.
 * If the status block ever grows taller than the terminal, feedback
 * degrades to plain mode so in-place redraw can never corrupt the screen.
 */

/** Minimal writable-stream surface PlanningFeedback needs. */
export interface FeedbackStream {
  write(chunk: string): boolean;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

/** Options for {@link PlanningFeedback}. */
export interface PlanningFeedbackOptions {
  /**
   * Text of the animated status line (default "planning"). The CLI passes
   * something like "compiling plan with gpt-4o-mini".
   */
  label?: string;
  /** Output stream (default process.stderr). */
  stream?: FeedbackStream;
  /**
   * Force in-place animation on/off. Default: on when the stream is a TTY
   * with a known size and FORCE_COLOR is not "0".
   */
  animate?: boolean;
  /** Spinner frame interval in ms (default 80). */
  intervalMs?: number;
}

/** Handle for one tool call, returned by {@link PlanningFeedback.toolStart}. */
export interface ToolCallHandle {
  /**
   * Finalize the tool line in place: `result` is summarized (see
   * {@link summarizeToolResult}) and the line is rewritten with a ✓/✗ and
   * the summary.
   */
  end(result: string): void;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_INTERVAL_MS = 80;
/** Minimum terminal width (columns) before lines are clipped to fit. */
const MIN_WIDTH = 40;
/** Cap for a tool-call target (path) shown on the console. */
const MAX_TARGET_LENGTH = 100;
/** Cap for an error detail shown on the console. */
const MAX_DETAIL_LENGTH = 70;

/** One line of the status block: an exploration command and its state. */
interface ToolLine {
  /** "list_dir src" / "read_file .env" as requested by the model. */
  label: string;
  done: boolean;
  ok?: boolean;
  detail?: string;
}

/**
 * In-place redraw is only safe when the stream is a TTY with a known size:
 * without `columns` a logical line could wrap (the redraw steps lines with
 * \n and assumes one physical line per logical line), and without `rows`
 * the block cannot be checked against the screen. A pty that reports a TTY
 * but no size (some remote/web containers) tends to have an unreliable
 * control-character path anyway, so plain lines are the safe default there.
 */
function canAnimate(s: FeedbackStream): boolean {
  if (process.env.FORCE_COLOR === "0") return false;
  if (s.isTTY !== true) return false;
  if (typeof s.columns !== "number" || s.columns < MIN_WIDTH) return false;
  if (typeof s.rows !== "number" || s.rows < 1) return false;
  return true;
}

/**
 * Animated planning feedback. Create one per planning run, call
 * {@link PlanningFeedback.start} before the agent request,
 * {@link PlanningFeedback.toolStart} around each tool execution (deep
 * agent), and {@link PlanningFeedback.finish} / {@link PlanningFeedback.fail}
 * when the request settles.
 */
export class PlanningFeedback {
  private readonly stream: FeedbackStream;
  private readonly label: string;
  private readonly intervalMs: number;
  private animate: boolean;
  private active = false;
  private startedAt = 0;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tools: ToolLine[] = [];
  private summaryLine: string | null = null;
  private renderedCount = 0;
  /** Display length of the last write per line (for space-based clearing). */
  private lineLens: number[] = [];

  constructor(options: PlanningFeedbackOptions = {}) {
    this.stream = options.stream ?? process.stderr;
    this.label = options.label ?? "planning";
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.animate = options.animate ?? canAnimate(this.stream);
  }

  /** True while in-place (animated) redraw is active. */
  get isAnimated(): boolean {
    return this.animate;
  }

  /** Start the planning phase: begin the animation (or nothing, in plain mode). */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.startedAt = Date.now();
    if (this.animate) {
      this.draw(this.blockLines());
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
        this.render();
      }, this.intervalMs);
      this.timer.unref?.();
    }
  }

  /**
   * An exploration tool is about to run. Returns a handle whose
   * {@link ToolCallHandle.end} finalizes the tool line in place with a
   * summary of the result. In plain mode the line is printed at end() time.
   */
  toolStart(name: string, target: string): ToolCallHandle {
    const label = `${name} ${clipKeepTail(target || ".", MAX_TARGET_LENGTH)}`;
    const line: ToolLine = { label, done: false };
    if (this.active) {
      this.tools.push(line);
      this.render();
    }
    return {
      end: (result: string) => {
        if (!this.active) return;
        const { ok, detail } = summarizeToolResult(name, result);
        line.done = true;
        line.ok = ok;
        line.detail = detail;
        if (this.animate) {
          this.render();
        } else {
          this.stream.write(this.toolLine(line) + "\n");
        }
      },
    };
  }

  /** Planning succeeded: stop the animation and print a summary line. */
  finish(message?: string): void {
    const text =
      message ?? `plan compiled in ${formatElapsed(Date.now() - this.startedAt)}`;
    this.finalize(`✓ ${text}`);
  }

  /** Planning failed: stop the animation and print a summary line. */
  fail(): void {
    this.finalize(`✗ planning failed in ${formatElapsed(Date.now() - this.startedAt)}`);
  }

  // --- internals -----------------------------------------------------------

  private finalize(summary: string): void {
    if (!this.active) return;
    this.active = false;
    this.stopTimer();
    this.summaryLine = summary;
    if (this.animate) {
      this.draw(this.blockLines());
      this.stream.write("\n");
    } else {
      this.stream.write(summary + "\n");
    }
  }

  /** Redraw the current status block (no-op unless active and animated). */
  private render(): void {
    if (!this.active || !this.animate) return;
    this.draw(this.blockLines());
  }

  /**
   * Redraw `lines` in place: move the cursor to the first line of the
   * previously rendered block, then rewrite every line from column 0. The
   * block only ever grows, so leftover slots below the new last line are
   * simply cleared. After the call the cursor sits on the last line.
   *
   * Only CUU (\x1b[nA, and only when n > 0 — an explicit 0 parameter is a
   * no-op per ECMA-48 but some terminals read it as "up 1"), CR (\r) and LF
   * (\n) are emitted. \x1b[2K (EL) and \x1b[1G (CHA) are deliberately NOT
   * used: terminals without them drop the sequences silently, so the block
   * would drift mid-line (no column reset) or upward (0-param CUU) and
   * leave ghost fragments. Stale line tails are overwritten with spaces up
   * to the terminal width instead.
   */
  private draw(lines: string[]): void {
    const s = this.stream;
    const rows = typeof s.rows === "number" ? s.rows : 0;
    if (rows > 0 && lines.length > rows) {
      // The block would not fit in the terminal; stop managing the screen.
      this.clearBlock();
      this.animate = false;
      if (this.summaryLine !== null) {
        s.write(this.summaryLine + "\n");
      }
      return;
    }
    const prev = this.renderedCount;
    const n = Math.max(prev, lines.length);
    if (prev === 0) {
      s.write(lines.join("\n"));
      this.lineLens = lines.map((l) => l.length);
    } else {
      let out = prev > 1 ? `\x1b[${prev - 1}A` : "";
      for (let i = 0; i < n; i++) {
        if (i > 0) out += "\n";
        out += "\r";
        const line = i < lines.length ? lines[i] : "";
        out += line + " ".repeat(Math.max(0, this.clearCells(i) - line.length));
        if (i < lines.length) this.lineLens[i] = line.length;
      }
      s.write(out);
    }
    this.renderedCount = n;
  }

  /**
   * Number of cells to overwrite when erasing a line: just long enough to
   * cover the previous write (never the full terminal width, so each frame
   * stays a short write and a broken cursor reset cannot fling a full row
   * of spaces across the screen).
   */
  private clearCells(lineIndex: number): number {
    return Math.max(this.lineLens[lineIndex] ?? 0, 0);
  }

  /** Erase the previously rendered block, line by line. */
  private clearBlock(): void {
    if (this.renderedCount === 0) return;
    const n = this.renderedCount;
    let out = n > 1 ? `\x1b[${n - 1}A` : "";
    for (let i = 0; i < n; i++) {
      if (i > 0) out += "\n";
      out += "\r" + " ".repeat(this.clearCells(i));
    }
    // Leave the cursor in column 0 so any plain write that follows (e.g. the
    // summary line after degrading to plain mode) starts at the line start.
    out += "\r";
    this.stream.write(out);
    this.renderedCount = 0;
    this.lineLens = [];
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The status block: one line per tool call, then the live/summary line. */
  private blockLines(): string[] {
    const lines = this.tools.map((t) => this.toolLine(t));
    lines.push(this.summaryLine ?? this.planningLine());
    return lines.map((l) => this.clip(l));
  }

  private planningLine(): string {
    const elapsed = formatElapsed(Date.now() - this.startedAt);
    return `${SPINNER_FRAMES[this.frame]} ${this.label}… ${elapsed}`;
  }

  private toolLine(t: ToolLine): string {
    if (t.done) {
      return `  ${t.ok ? "✓" : "✗"} ${t.label} — ${t.detail}`;
    }
    return `  ${SPINNER_FRAMES[this.frame]} ${t.label}…`;
  }

  /**
   * Clip a line to the terminal width so a single logical line can never
   * wrap (the in-place redraw steps lines with \n and assumes one physical
   * line per logical line). Falls back to a conservative 120 cells when the
   * stream does not report a width.
   */
  private clip(text: string): string {
    const columns = this.stream.columns;
    const width =
      typeof columns === "number" && columns >= MIN_WIDTH ? columns : 120;
    if (text.length <= width) return text;
    return "…" + text.slice(text.length - (width - 1));
  }
}

// --- Summaries -------------------------------------------------------------

/** Clip a long path from the front, keeping the tail (the filename). */
function clipKeepTail(text: string, max: number): string {
  if (text.length <= max) return text;
  return "…" + text.slice(text.length - (max - 1));
}

/**
 * Turn a raw tool result into a short human summary for the console.
 * `error:` results become ✗ lines; successful `list_dir` results report the
 * entry count; successful `read_file` results report the size shown.
 */
export function summarizeToolResult(
  name: string,
  result: string,
): { ok: boolean; detail: string } {
  if (result.startsWith("error:")) {
    const detail = result.slice("error:".length).trim() || "error";
    return {
      ok: false,
      detail: clipKeepTail(detail, MAX_DETAIL_LENGTH),
    };
  }
  if (name === "list_dir") {
    const entries = result
      .split("\n")
      .filter((l) => /^\s+\[(dir |file|link)\] /.test(l)).length;
    const truncated = /truncated: showing \d+ of \d+/.test(result);
    const count = entries === 1 ? "1 entry" : `${entries} entries`;
    const size = formatBytes(Buffer.byteLength(result, "utf8"));
    return {
      ok: true,
      detail: `${entries === 0 ? "empty" : count}, ${size}${truncated ? " (truncated)" : ""}`,
    };
  }
  if (name === "read_file") {
    const total = result.match(/^File: [^(]*\((\d+) bytes\)/);
    if (result.includes("[binary file; content not shown]")) {
      return {
        ok: true,
        detail: total ? `binary, ${formatBytes(Number(total[1]))}` : "binary",
      };
    }
    const showing = result.match(/\[showing first (\d+) of (\d+) bytes\]/);
    if (showing) {
      return {
        ok: true,
        detail: `${formatBytes(Number(showing[1]))} of ${formatBytes(Number(showing[2]))}`,
      };
    }
    return { ok: true, detail: total ? formatBytes(Number(total[1])) : "read" };
  }
  return { ok: true, detail: "done" };
}

/** Format a byte count as a short human string (B / KB / MB). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${trimOne(kb)} KB`;
  return `${trimOne(kb / 1024)} MB`;
}

/** Format a millisecond duration as a short human string (s / m ss). */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

function trimOne(x: number): string {
  return x.toFixed(1).replace(/\.0$/, "");
}
