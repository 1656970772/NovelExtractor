import { execSync } from "node:child_process";

export default function globalSetup(): void {
  execSync("pnpm desktop:build", {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
}
