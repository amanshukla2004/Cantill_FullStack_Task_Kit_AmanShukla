import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { Express } from 'express';

class MockSocket extends Duplex {
  public remoteAddress = '127.0.0.1';
  public chunks: Buffer[] = [];
  private inputChunks: Buffer[];
  private readIdx = 0;

  constructor(input?: Buffer) {
    super();
    this.inputChunks = input ? [input] : [];
  }

  override _read(): void {
    if (this.readIdx < this.inputChunks.length) {
      this.push(this.inputChunks[this.readIdx++]);
    } else {
      this.push(null);
    }
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }
}

export interface TestResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export async function invokeExpress(
  app: Express,
  opts: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    url: string;
    json?: unknown;
    file?: { field: string; filePath: string; contentType?: string };
    headers?: Record<string, string>;
  }
): Promise<TestResponse> {
  const headers: Record<string, string> = {
    host: 'localhost',
    ...(opts.headers || {})
  };

  let bodyBuf: Buffer | undefined;

  if (opts.file) {
    const boundary = '----CantillTestBoundary7MA4YWxkTrZu0gW';
    const fileBuf = fs.readFileSync(opts.file.filePath);
    const filename = path.basename(opts.file.filePath);
    const mime = opts.file.contentType || 'application/octet-stream';

    const headerPart = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${opts.file.field}"; filename="${filename}"\r\n` +
        `Content-Type: ${mime}\r\n\r\n`,
      'utf-8'
    );
    const footerPart = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    bodyBuf = Buffer.concat([headerPart, fileBuf, footerPart]);
    headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
    headers['content-length'] = String(bodyBuf.length);
  } else if (opts.json !== undefined) {
    bodyBuf = Buffer.from(JSON.stringify(opts.json), 'utf-8');
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(bodyBuf.length);
  }

  const reqSocket = new MockSocket(bodyBuf);
  const req = new http.IncomingMessage(reqSocket as unknown as import('node:net').Socket);
  req.method = opts.method;
  req.url = opts.url;
  req.headers = headers;

  // Push body into IncomingMessage stream
  if (bodyBuf) {
    req.push(bodyBuf);
  }
  req.push(null);

  const resSocket = new MockSocket();
  const res = new http.ServerResponse(req);
  res.assignSocket(resSocket as unknown as import('node:net').Socket);

  return new Promise<TestResponse>((resolve, reject) => {
    res.on('finish', () => {
      const raw = Buffer.concat(resSocket.chunks).toString('utf-8');
      const sepIdx = raw.indexOf('\r\n\r\n');
      let bodyText = sepIdx >= 0 ? raw.slice(sepIdx + 4) : raw;

      // Decode chunked transfer encoding if present
      const te = String(res.getHeader('transfer-encoding') || '').toLowerCase();
      if (te.includes('chunked')) {
        bodyText = decodeChunked(bodyText);
      }

      const outHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.getHeaders())) {
        if (v !== undefined) {
          outHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
        }
      }

      let parsedBody: unknown = undefined;
      if ((outHeaders['content-type'] || '').includes('application/json') && bodyText.trim()) {
        try {
          parsedBody = JSON.parse(bodyText);
        } catch {
          parsedBody = bodyText;
        }
      }

      resolve({
        status: res.statusCode,
        headers: outHeaders,
        text: bodyText,
        body: parsedBody
      });
    });

    res.on('error', reject);
    app(req, res);
  });
}

function decodeChunked(input: string): string {
  let out = '';
  let idx = 0;
  while (idx < input.length) {
    const lineEnd = input.indexOf('\r\n', idx);
    if (lineEnd === -1) break;
    const size = parseInt(input.slice(idx, lineEnd).trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = lineEnd + 2;
    out += input.slice(start, start + size);
    idx = start + size + 2;
  }
  return out;
}
