/** A bounded receiver for the binary editor read stream; no DOM or connection state. */
export class TextReadBuffer {
  readonly requestId: string;
  private readonly limit: number;
  private readonly chunks: Uint8Array[] = [];
  private size = 0;

  constructor(requestId: string, limit: number) {
    this.requestId = requestId;
    this.limit = limit;
  }

  append(bytes: Uint8Array): void {
    if (this.size + bytes.length > this.limit) throw new Error('Text exceeds the editor limit');
    this.chunks.push(bytes);
    this.size += bytes.length;
  }

  finish(expectedSize: number | null): string {
    if (expectedSize === null || this.size !== expectedSize) throw new Error('Incomplete text file');
    const bytes = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    this.chunks.length = 0;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  }
}
