/**
 * Incremental newline splitter for a child process' stdout. CLI agents emit
 * JSONL, but a single `data` chunk can hold a partial line or several lines.
 */
export class LineSplitter {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split(/\r?\n/);
    this.buffer = parts.pop() ?? "";
    return parts.filter((line) => line.trim() !== "");
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest === "" ? [] : [rest];
  }
}

export function tryParseJson(line: string): unknown | undefined {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}
