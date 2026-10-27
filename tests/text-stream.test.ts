import assert from 'node:assert/strict';
import test from 'node:test';
import { TextFileDecoder, MAX_TEXT_FILE_SIZE } from '../src/backend/text-file.ts';
import { TextReadBuffer } from '../frontend/src/file-text-buffer.ts';

test('UTF-8 code points may cross SFTP chunk boundaries', () => {
  const bytes = new TextEncoder().encode('A中B');
  const decoder = new TextFileDecoder();
  const read = new TextReadBuffer('r', MAX_TEXT_FILE_SIZE);
  for (const byte of bytes) { decoder.push(new Uint8Array([byte])); read.append(new Uint8Array([byte])); }
  decoder.finish();
  assert.equal(read.finish(bytes.length), 'A中B');
});

test('stream size, NUL prefix and incomplete UTF-8 are rejected', () => {
  assert.throws(() => new TextFileDecoder().push(new Uint8Array([65, 0])), /binary/);
  const invalid = new TextFileDecoder();
  invalid.push(new Uint8Array([0xe4]));
  assert.throws(() => invalid.finish(), /UTF-8/);
  const large = new TextFileDecoder();
  const chunk = new Uint8Array(64 * 1024).fill(65);
  for (let i = 0; i < 32; i++) large.push(chunk);
  assert.throws(() => large.push(new Uint8Array([65])), /limit/);
});

test('receiver rejects incomplete/oversized text and preserves a UTF-8 BOM', () => {
  const partial = new TextReadBuffer('r', 4);
  partial.append(new Uint8Array([65]));
  assert.throws(() => partial.finish(2), /Incomplete/);
  assert.throws(() => partial.append(new Uint8Array(4)), /limit/);
  const bom = new TextReadBuffer('bom', 10);
  bom.append(new Uint8Array([0xef, 0xbb, 0xbf, 65]));
  assert.equal(bom.finish(4), '\uFEFFA');
});
