// src/jobs/sources/webhookServer.ts
import type { Job, SubmitJobInput, JobType } from "../types.ts";

export interface WebhookACL {
  tokens: Array<{
    name: string;
    secret: string;
    allowed_types: JobType[] | "*";
  }>;
}

interface WebhookServerOptions {
  port: number;
  secret: string;
  acl?: WebhookACL;
}

type SubmitFn = (input: SubmitJobInput) => Job | null;

function validatePayload(
  body: unknown
): { valid: true; input: SubmitJobInput } | { valid: false; error: string } {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "body must be a JSON object" };
  }

  const obj = body as Record<string, unknown>;
  if (!obj.type || typeof obj.type !== "string") {
    return { valid: false, error: "type is required" };
  }
  if (!obj.executor || typeof obj.executor !== "string") {
    return { valid: false, error: "executor is required" };
  }
  if (!obj.title || typeof obj.title !== "string") {
    return { valid: false, error: "title is required" };
  }

  return {
    valid: true,
    input: {
      type: obj.type as JobType,
      executor: obj.executor as string,
      title: obj.title as string,
      priority: (obj.priority as any) ?? undefined,
      source: "webhook",
      dedup_key: (obj.dedup_key as string) ?? undefined,
      payload: (obj.payload as Record<string, unknown>) ?? undefined,
      timeout_ms: (obj.timeout_ms as number) ?? undefined,
      metadata: (obj.metadata as Record<string, unknown>) ?? undefined,
    },
  };
}

function authenticateRequest(
  authHeader: string | null,
  secret: string,
  acl?: WebhookACL,
  jobType?: string
): boolean {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);

  // If ACL exists, check per-token rules
  if (acl) {
    const match = acl.tokens.find((t) => t.secret === token);
    if (!match) return false;
    if (match.allowed_types === "*") return true;
    if (jobType && !match.allowed_types.includes(jobType as JobType)) return false;
    return true;
  }

  // Fallback: single shared secret
  return token === secret;
}

export function createWebhookServer(
  submitJob: SubmitFn,
  options: WebhookServerOptions
): ReturnType<typeof Bun.serve> {
  const { port, secret, acl } = options;

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // Health check
      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json({ status: "ok", timestamp: new Date().toISOString() });
      }

      // Job submission
      if (url.pathname === "/jobs" && req.method === "POST") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "invalid JSON" }, { status: 400 });
        }

        const validation = validatePayload(body);

        // Auth — pass jobType for ACL check
        const jobType = validation.valid ? validation.input.type : undefined;
        if (!authenticateRequest(req.headers.get("Authorization"), secret, acl, jobType)) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }

        if (!validation.valid) {
          return Response.json({ error: validation.error }, { status: 400 });
        }

        const job = submitJob(validation.input);
        if (!job) {
          return Response.json({ error: "duplicate dedup_key" }, { status: 409 });
        }

        return Response.json(job, { status: 201 });
      }

      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  console.log(`[jobs:webhook] server listening on port ${port}`);
  return server;
}
