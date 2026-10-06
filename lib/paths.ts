import { join } from "node:path";

/** RULEBOOK_WORKSPACE points the app at another workspace (tests, demos); default ./workspace. */
export const WORKSPACE = process.env.RULEBOOK_WORKSPACE || join(process.cwd(), "workspace");
export const AGENT_DIR = join(WORKSPACE, "agent");
export const STORE_DIR = join(WORKSPACE, ".rulebook");
