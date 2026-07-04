import { execSync } from "node:child_process";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { createBuildMetadataDefine } from "./src/main/buildInfo";

function readGitCommit(): string | undefined {
  try {
    return execSync("git rev-parse HEAD", { cwd: __dirname, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

export default defineConfig(({ command }) => ({
  main: {
    define: createBuildMetadataDefine({
      command,
      env: process.env,
      readGitCommit
    }),
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@novel-extractor/config",
          "@novel-extractor/domain",
          "@novel-extractor/extraction",
          "@novel-extractor/jobs",
          "@novel-extractor/llm",
          "@novel-extractor/markdown",
          "@novel-extractor/persistence",
          "@novel-extractor/tools",
          "iconv-lite"
        ]
      })
    ],
    build: {
      outDir: "dist/main",
      rollupOptions: {
        input: {
          main: resolve(__dirname, "src/main/main.ts")
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts")
        },
        output: {
          entryFileNames: "[name].cjs",
          format: "cjs"
        }
      }
    }
  },
  renderer: {
    root: ".",
    plugins: [react()],
    build: {
      outDir: "dist/renderer",
      rollupOptions: {
        input: resolve(__dirname, "index.html")
      }
    }
  }
}));
