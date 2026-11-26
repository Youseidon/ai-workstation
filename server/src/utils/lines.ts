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
