/** Incremental SSE framing; UTF-8 decoding belongs to the response reader. */
export class SseDecoder {
  private buffer = "";
  private data: string[] = [];
  private id = "";

  push(chunk: string): Array<{ id: string; data: string }> {
    this.buffer += chunk;
    const frames: Array<{ id: string; data: string }> = [];
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) {
        if (this.data.length) frames.push({ id: this.id, data: this.data.join("\n") });
        this.data = [];
        this.id = "";
      } else if (line.startsWith("data:")) this.data.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("id:")) this.id = line.slice(3).replace(/^ /, "");
    }
    return frames;
  }
}
