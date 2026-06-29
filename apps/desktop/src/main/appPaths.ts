import { app } from "electron";
import { join } from "node:path";

export interface DesktopAppPaths {
  userDataDir: string;
  projectsRoot: string;
  credentialsRoot: string;
}

export function createAppPaths(userDataDir = app.getPath("userData")): DesktopAppPaths {
  return {
    userDataDir,
    projectsRoot: join(userDataDir, "projects"),
    credentialsRoot: join(userDataDir, "credentials")
  };
}
