import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    // Task worktrees (dev-workflow) live inside the project directory.
    watch: { ignored: ["**/.worktrees/**"] },
  },
});
