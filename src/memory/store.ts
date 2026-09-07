import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CjError } from "../shared/errors.js";

const memorySchema = z.object({
  version: z.literal(1),
  facts: z.array(z.object({
    id: z.string().uuid(),
    text: z.string().min(1).max(2_000),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  }).strict()).max(1_000)
}).strict();

export type MemoryFact = z.infer<typeof memorySchema>["facts"][number];
type MemoryDocument = z.infer<typeof memorySchema>;
const emptyMemory: MemoryDocument = { version: 1, facts: [] };

/** Explicit, local-only preferences/facts. This store is never populated from a model response. */
export class MemoryStore {
  constructor(readonly file: string) {}

  private async write(document: MemoryDocument): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(memorySchema.parse(document), null, 2)}\n`, { mode: 0o600 });
      if (process.platform !== "win32") await chmod(temporary, 0o600);
      await rename(temporary, this.file);
      if (process.platform !== "win32") await chmod(this.file, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async load(): Promise<MemoryDocument> {
    try {
      if (process.platform !== "win32") {
        const mode = (await stat(this.file)).mode & 0o777;
        if ((mode & 0o077) !== 0) throw new CjError("CONFIG_INVALID", `Memory file permissions are too broad: ${this.file}`);
      }
      const parsed = memorySchema.safeParse(JSON.parse(await readFile(this.file, "utf8")));
      if (!parsed.success) throw new CjError("CONFIG_INVALID", `Invalid memory store: ${parsed.error.message}`);
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyMemory;
      if (error instanceof CjError) throw error;
      throw new CjError("CONFIG_INVALID", `Cannot read memory store: ${this.file}`, { cause: error });
    }
  }

  async list(): Promise<MemoryFact[]> {
    return (await this.load()).facts;
  }

  async add(text: string): Promise<MemoryFact> {
    const document = await this.load();
    const now = new Date().toISOString();
    const fact: MemoryFact = { id: randomUUID(), text: text.trim(), createdAt: now, updatedAt: now };
    if (!fact.text) throw new CjError("CONFIG_INVALID", "Memory text cannot be empty");
    await this.write({ ...document, facts: [...document.facts, fact] });
    return fact;
  }

  async forget(id: string): Promise<boolean> {
    const document = await this.load();
    const facts = document.facts.filter((fact) => fact.id !== id);
    if (facts.length === document.facts.length) return false;
    await this.write({ ...document, facts });
    return true;
  }

  async clear(): Promise<void> {
    const document = await this.load();
    await this.write({ ...document, facts: [] });
  }
}
