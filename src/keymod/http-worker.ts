/**
 * HTTP Worker Thread — runs async fetch in a separate thread.
 *
 * Communicates with the main thread via SharedArrayBuffer + Atomics:
 *   - signalBuf (Int32Array[4]): [state, dataLength, 0, 0]
 *     state: 0=idle, 1=request-ready, 2=response-ready, -1=shutdown
 *   - dataBuf (Uint8Array[262144]): shared request/response JSON bytes
 *
 * Main thread writes request JSON to dataBuf, sets state=1, notifies.
 * This worker wakes, reads request, does fetch, writes response, sets state=2, notifies.
 */

import { workerData } from 'node:worker_threads';

const { signalBuf, dataBuf, timeout } = workerData as {
  signalBuf: SharedArrayBuffer;
  dataBuf: SharedArrayBuffer;
  timeout: number;
};

const signal = new Int32Array(signalBuf);
const data = new Uint8Array(dataBuf);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function handleRequest(reqJson: string): Promise<string> {
  let template: { method: string; url: string; headers: Record<string, string>; body?: string };
  try {
    template = JSON.parse(reqJson);
  } catch {
    return JSON.stringify({ status: 400, headers: {}, body: 'invalid request JSON' });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(template.url, {
      method: template.method,
      headers: template.headers,
      body: template.body ?? undefined,
      signal: controller.signal,
    });

    clearTimeout(timer);

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const body = await response.text();

    return JSON.stringify({ status: response.status, headers: responseHeaders, body });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ status: 502, headers: {}, body: `fetch error: ${message}` });
  }
}

// Main loop — wait for requests, process them, signal back
async function loop(): Promise<void> {
  while (true) {
    // Wait for state to change from 0 (idle)
    Atomics.wait(signal, 0, 0);

    const state = Atomics.load(signal, 0);
    if (state === -1) break; // shutdown
    if (state !== 1) continue; // spurious wake

    // Read request from shared buffer
    const reqLen = Atomics.load(signal, 1);
    const reqJson = decoder.decode(data.slice(0, reqLen));

    // Do the async fetch
    const respJson = await handleRequest(reqJson);

    // Write response to shared buffer
    const respBytes = encoder.encode(respJson);
    if (respBytes.length > data.length) {
      // Response too large — write truncated error
      const errJson = encoder.encode(JSON.stringify({
        status: 502, headers: {}, body: 'response too large for shared buffer',
      }));
      data.set(errJson, 0);
      Atomics.store(signal, 1, errJson.length);
    } else {
      data.set(respBytes, 0);
      Atomics.store(signal, 1, respBytes.length);
    }

    // Signal response ready
    Atomics.store(signal, 0, 2);
    Atomics.notify(signal, 0);
  }
}

loop().catch(() => process.exit(1));
