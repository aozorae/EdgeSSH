import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { SFTPClient, SFTPStatusError } from '../src/ssh/sftp.ts';

function uint32(value: number): Buffer {
  const result = Buffer.alloc(4); result.writeUInt32BE(value); return result;
}
function text(value: string): Buffer {
  const bytes = Buffer.from(value); return Buffer.concat([uint32(bytes.length), bytes]);
}
function frame(type: number, ...fields: Uint8Array[]): Buffer {
  const body = Buffer.concat([Buffer.from([type]), ...fields]);
  return Buffer.concat([uint32(body.length), body]);
}
async function fixture(extension?: string) {
  const sent: Buffer[] = [];
  const client = new SFTPClient(packet => { sent.push(Buffer.from(packet)); });
  const initialized = client.initialize();
  client.feed(frame(2, uint32(3), ...(extension === undefined ? [] : [text('posix-rename@openssh.com'), text(extension)])));
  await initialized; sent.length = 0;
  return { client, sent };
}

test('atomic overwrite uses the negotiated OpenSSH extension and STATUS response', async () => {
  const { client, sent } = await fixture('1');
  try {
    const renamed = client.rename('/tmp/upload', '/tmp/existing', true);
    assert.deepEqual(sent, [frame(200, uint32(1), text('posix-rename@openssh.com'), text('/tmp/upload'), text('/tmp/existing'))]);
    client.feed(frame(101, uint32(1), uint32(0), text(''), text('')));
    await renamed;
  } finally { client.dispose(); }
});
test('ordinary rename retains SFTP v3 no-overwrite semantics', async () => {
  const { client, sent } = await fixture('1');
  try {
    const renamed = client.rename('old', 'new');
    assert.deepEqual(sent, [frame(18, uint32(1), text('old'), text('new'))]);
    client.feed(frame(101, uint32(1), uint32(4), text('existing target'), text('')));
    await assert.rejects(renamed, SFTPStatusError);
  } finally { client.dispose(); }
});
test('missing or unknown atomic rename extension sends no destructive request', async () => {
  for (const version of [undefined, '2']) {
    const { client, sent } = await fixture(version);
    try {
      await assert.rejects(client.rename('upload', 'existing', true), /does not support atomic overwrite/);
      assert.deepEqual(sent, []);
    } finally { client.dispose(); }
  }
});

const bundle = await build({ stdin: { contents: "export { SFTPHandler } from './src/backend/sftp-handler.ts';", resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' }, bundle: true, format: 'esm', platform: 'neutral', write: false });
const { SFTPHandler } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

for (const failure of [false, true]) {
  test(`overwrite upload ${failure ? 'failure removes only temporary file' : 'commits with atomic rename'}`, async () => {
    const messages: any[] = [], renames: unknown[][] = [], removed: string[] = [];
    let temporary = '';
    const handler = new SFTPHandler({}, async () => {}, (message: unknown) => messages.push(message), () => {});
    handler.ready = true;
    handler.client = {
      openFile: async (path: string) => { temporary = path; return new Uint8Array([1]); },
      closeHandle: async () => {},
      rename: async (...args: unknown[]) => { renames.push(args); if (failure) throw new Error('atomic rename failed'); },
      removeFile: async (path: string) => { removed.push(path); },
    };
    await handler.startUpload('test', '/tmp/existing', 0, true);
    await handler.finishUpload('test');
    assert.match(temporary, /^\/tmp\/\.cf-webssh-upload-/);
    assert.deepEqual(renames, [[temporary, '/tmp/existing', true]]);
    assert.deepEqual(removed, failure ? [temporary] : []);
    assert.equal(messages.at(-1).type, failure ? 'sftp_error' : 'sftp_upload_complete');
  });
}
