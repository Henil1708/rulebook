// Commit-message helpers: the sanitiser and trailer build/parse. Pure functions.

export type Trailers = Record<string, string>;

const TRAILER_KEY = /^[A-Za-z][A-Za-z0-9-]*$/;

/** Keep only `[\w\s.,:()#/-—]`, collapse whitespace (newlines included) to one line, cap the length. */
export function sanitiseMessage(text: string, max = 120): string {
  return text
    .replace(/[^\w\s.,:()#/\-—]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/** Subject + optional body + a trailer block. Trailer values are flattened to one line. */
export function buildCommitMessage(subject: string, trailers: Trailers = {}, body = ""): string {
  const lines = Object.entries(trailers).map(([k, v]) => {
    if (!TRAILER_KEY.test(k)) throw new Error(`invalid trailer key: ${k}`);
    return `${k}: ${String(v).replace(/\s+/g, " ").trim()}`;
  });
  return [subject.replace(/\s+/g, " ").trim(), body.trim(), lines.join("\n")].filter(Boolean).join("\n\n") + "\n";
}

/** Trailers = the last paragraph, if every line in it is `Key: value`. */
export function parseTrailers(message: string): Trailers {
  const paragraphs = message.trim().split(/\n\s*\n/);
  if (paragraphs.length < 2) return {};
  const lines = paragraphs[paragraphs.length - 1].split("\n");
  const out: Trailers = {};
  for (const line of lines) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):\s?(.*)$/.exec(line);
    if (!m) return {};
    out[m[1]] = m[2].trim();
  }
  return out;
}
