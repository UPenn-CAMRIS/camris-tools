import { execSync } from "node:child_process";
import { defineConfig } from "vite";

/** The git commit being built, recorded in each saved audit. */
function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(gitCommit()),
  },
  server: {
    // Task worktrees (dev-workflow) live inside the project directory.
    watch: { ignored: ["**/.worktrees/**"] },
  },
});
