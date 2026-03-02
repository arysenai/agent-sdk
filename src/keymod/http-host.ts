/**
 * HTTP execution host import implementation.
 *
 * Provides HTTP request execution via Node.js global `fetch`.
 * Parses JSON request templates and returns JSON responses.
 */

import type { RequestTemplate, HttpResponse } from './types.js';

const DEFAULT_TIMEOUT = 30_000;

export class HttpHost {
  private readonly timeout: number;

  constructor(timeout?: number) {
    this.timeout = timeout ?? DEFAULT_TIMEOUT;
  }

  /**
   * Execute an HTTP request from a JSON request template string.
   * Returns a JSON response string.
   */
  async execute(requestJson: string): Promise<string> {
    let template: RequestTemplate;
    try {
      template = JSON.parse(requestJson) as RequestTemplate;
    } catch {
      return JSON.stringify({
        status: 400,
        headers: {},
        body: 'invalid request JSON',
      } satisfies HttpResponse);
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);

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

      return JSON.stringify({
        status: response.status,
        headers: responseHeaders,
        body,
      } satisfies HttpResponse);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        status: 502,
        headers: {},
        body: `fetch error: ${message}`,
      } satisfies HttpResponse);
    }
  }
}
