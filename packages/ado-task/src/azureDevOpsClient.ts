import fetch, { RequestInit, Response } from 'node-fetch';
import { Agent } from 'https';
import * as tl from 'azure-pipelines-task-lib/task';

/**
 * Minimal REST client for Azure DevOps.
 *
 * Responsibilities:
 * - Inject OAuth bearer token (System.AccessToken)
 * - Apply correct content type headers
 * - Provide basic logging on failure
 *
 * Security note:
 * - Do NOT disable TLS verification by default in production.
 */
export class AzureDevOpsClient {
  /**
   * Allows insecure TLS only if explicitly enabled (prototype escape hatch).
   * Many corporate environments require custom CA bundles instead of disabling TLS.
   */
  private readonly httpsAgent = new Agent({
    rejectUnauthorized: tl.getVariable('DEVOPS_AI_REVIEWER_INSECURE_TLS') !== 'true',
  });

  /** Performs a JSON GET and parses the response body. */
  async get<T = any>(endpoint: string): Promise<T> {
    // Use the low-level fetch method.
    const response = await this.fetch({ endpoint });
    // Parse and return JSON body.
    return (await response.json()) as T;
  }

  /** Performs a JSON POST and returns the raw Response. */
  async post(endpoint: string, body: object): Promise<Response> {
    return this.fetch({ endpoint, method: 'POST', body });
  }

  /**
   * Performs a JSON Patch request (ADO expects application/json-patch+json).
   *
   * @param endpoint Full URL
   * @param body Patch operations array
   */
  async patch(endpoint: string, body: object): Promise<Response> {
    // Use correct content type for JSON Patch.
    return this.fetch({
      endpoint,
      method: 'PATCH',
      body,
      overrides: {
        headers: {
          Authorization: `Bearer ${tl.getVariable('System.AccessToken')}`,
          'Content-Type': 'application/json-patch+json',
        },
      },
    });
  }

  /** Performs a DELETE request. */
  async delete(endpoint: string): Promise<Response> {
    return this.fetch({ endpoint, method: 'DELETE' });
  }

  /**
   * Low-level request method used by all verbs.
   *
   * Notes:
   * - Logs warnings on non-2xx status.
   * - Returns Response so caller can decide how to handle failures.
   */
  private async fetch({
    endpoint,
    method = 'GET',
    body,
    overrides,
  }: {
    endpoint: string;
    method?: string;
    body?: any;
    overrides?: RequestInit;
  }): Promise<Response> {
    // Get the OAuth token from pipeline variables.
    const token = tl.getVariable('System.AccessToken');

    // Build the request payload.
    const payload: RequestInit = {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      agent: this.httpsAgent,
      method,
      body: body ? JSON.stringify(body) : undefined,
      ...overrides,
    };

    // Perform the fetch.
    const response = await fetch(endpoint, payload);

    // Log a warning if the request failed.
    if (!response.ok) {
      tl.warning(`ADO request failed: ${method} ${endpoint} -> ${response.status} ${response.statusText}`);
    }

    return response;
  }
}