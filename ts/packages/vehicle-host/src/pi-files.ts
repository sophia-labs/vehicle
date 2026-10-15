/**
 * pi's session file in a session's `pi/` folder: `<timestamp>_<id>.jsonl`.
 *
 * An `agent` body writes that folder itself (it records its own conversation), so the host treats what it finds
 * there as the body's word: it opens only regular files, never a symbolic link a body could point at another
 * session's file or anything else of the host's.
 */

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function findPiSessionFile(piDir: string): string | undefined {
	if (!existsSync(piDir)) return undefined;
	const files = readdirSync(piDir)
		.filter((name) => name.endsWith(".jsonl"))
		.filter((name) => {
			try {
				return lstatSync(join(piDir, name)).isFile();
			} catch {
				return false;
			}
		})
		.sort();
	const last = files.at(-1);
	return last ? join(piDir, last) : undefined;
}
