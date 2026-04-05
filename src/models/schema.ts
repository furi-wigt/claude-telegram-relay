// src/models/schema.ts
import { z } from "zod";

const CircuitBreakerSchema = z.object({
  enabled: z.boolean(),
  failureThreshold: z.number().int().positive(),
  resetAfterMs: z.number().int().positive(),
});

const ProviderSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["openai-compat", "claude"]),
  url: z.string().url().optional(),
  model: z.string().min(1),
  dimensions: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  chunkTimeoutMs: z.number().int().positive().optional(),
  maxConcurrent: z.number().int().positive().optional(),
  circuitBreaker: CircuitBreakerSchema.optional(),
});

const SlotsSchema = z.object({
  routine: z.array(z.string()).min(1),
  stm: z.array(z.string()).min(1),
  ltm: z.array(z.string()).min(1),
  classify: z.array(z.string()).min(1),
  embed: z.tuple([z.string()]),  // exactly one
});

export const ModelsConfigSchema = z.object({
  providers: z.array(ProviderSchema).min(1),
  slots: SlotsSchema,
}).superRefine((data, ctx) => {
  const ids = new Set<string>();
  for (const p of data.providers) {
    if (ids.has(p.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate provider id: "${p.id}"` });
    }
    ids.add(p.id);
    if (p.type === "openai-compat" && !p.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Provider "${p.id}" is openai-compat but missing url` });
    }
  }
  const providerMap = new Map(data.providers.map(p => [p.id, p]));
  const allSlotIds = [
    ...data.slots.routine, ...data.slots.stm, ...data.slots.ltm,
    ...data.slots.classify, ...data.slots.embed,
  ];
  for (const id of allSlotIds) {
    if (!providerMap.has(id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Slot references unknown provider id: "${id}"` });
    }
  }
  const embedProvider = providerMap.get(data.slots.embed[0]);
  if (embedProvider && embedProvider.type !== "openai-compat") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Embed slot provider must be openai-compat (Claude cannot embed)` });
  }
});
