/**
 * 在线编辑器只接受 ≤ 2 MiB 的 UTF-8 文本；超限或二进制文件仍然走下载通道。
 * 二进制判定与 git 同口径：前 8 KiB 出现 NUL 字节即视为二进制。
 */

export const MAX_TEXT_FILE_SIZE = 2 * 1024 * 1024;
export const BINARY_SNIFF_BYTES = 8 * 1024;

export type TextFileRejection = 'too-large' | 'binary' | 'encoding';

/** 带机器可读 reason 的读取失败，前端据此给出双语提示。 */
export class TextFileError extends Error {
  readonly reason: TextFileRejection;

  constructor(reason: TextFileRejection, message: string) {
    super(message);
    this.name = 'TextFileError';
    this.reason = reason;
  }
}

export function assertTextFileSize(size: number | null): void {
  if (size !== null && size > MAX_TEXT_FILE_SIZE) {
    throw new TextFileError('too-large', 'File exceeds the 2 MiB editor limit');
  }
}

export function hasBinaryPrefix(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < limit; index++) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

export function decodeTextFile(bytes: Uint8Array): string {
  if (bytes.length > MAX_TEXT_FILE_SIZE) {
    throw new TextFileError('too-large', 'File exceeds the 2 MiB editor limit');
  }
  if (hasBinaryPrefix(bytes)) {
    throw new TextFileError('binary', 'File appears to be binary');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new TextFileError('encoding', 'File is not valid UTF-8 text');
  }
}

/** Incremental validation keeps the Worker read buffer at one SFTP chunk. */
export class TextFileDecoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private size = 0;

  push(chunk: Uint8Array): void {
    assertTextFileSize(this.size + chunk.length);
    if (this.size < BINARY_SNIFF_BYTES && hasBinaryPrefix(chunk.subarray(0, BINARY_SNIFF_BYTES - this.size))) {
      throw new TextFileError('binary', 'File appears to be binary');
    }
    this.size += chunk.length;
    this.decode(chunk);
  }

  finish(): void { this.decode(); }

  private decode(chunk?: Uint8Array): void {
    try { this.decoder.decode(chunk, { stream: chunk !== undefined }); }
    catch { throw new TextFileError('encoding', 'File is not valid UTF-8 text'); }
  }
}
