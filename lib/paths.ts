import { join } from "node:path";

export const WORKSPACE = join(process.cwd(), "workspace");
export const AGENT_DIR = join(WORKSPACE, "agent");
export const STORE_DIR = join(WORKSPACE, ".rulebook");
