import { execSync } from "node:child_process";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/** The git commit being built, recorded in each saved audit. */
function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// Task worktrees (dev-workflow) live in .worktrees/ inside the project
// directory. Ignore only the ones nested under this checkout: a dev server
// run from a worktree has /.worktrees/ in every path, and must still watch
// its own files.
const worktreesDir = fileURLToPath(new URL(".worktrees", import.meta.url));

export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(gitCommit()),
  },
  server: {
    watch: {
      ignored: [
        (path: string) =>
          path === worktreesDir || path.startsWith(worktreesDir + sep),
      ],
    },
  },
});
