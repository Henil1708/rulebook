import { z } from "zod";

/** JSON schema for a tool's input, from the same zod schema the handler validates with. */
export function toolSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/** Parse tool args or throw one readable line the model can act on. */
export function parseArgs<T>(schema: z.ZodType<T>, args: unknown): T {
  const r = schema.safeParse(args ?? {});
  if (r.success) return r.data;
  throw new Error(r.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; "));
}
