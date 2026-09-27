import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Node resolves module URLs through symlinks, while argv can retain an alias
// (notably /var -> /private/var on macOS and npm's executable links).
export function isMain(moduleURL, entry = process.argv[1]) {
  if (!entry) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(moduleURL)); }
  catch { return false; }
}
