import fs from "node:fs/promises";
import path from "node:path";
import { createProjectSlug, type Clock, type IdGenerator, type Project } from "@novel-extractor/domain";

export interface MainProjectStore {
  createProject(input: { displayName: string }): Promise<Project>;
  ensureProject(projectId: string): Promise<Project>;
  getProject(projectId: string): Promise<Project | undefined>;
  listProjects(): Promise<Project[]>;
}

export interface FileProjectStoreOptions {
  workspaceRoot: string;
  projectsRoot?: string | (() => string);
  filePath?: string;
  clock: Clock;
  idGenerator: IdGenerator;
}

interface ProjectStoreState {
  projects: Project[];
}

const PROJECT_ID_COLLISION_RETRY_LIMIT = 20;

function cloneProject(project: Project): Project {
  return { ...project };
}

function createEmptyState(): ProjectStoreState {
  return { projects: [] };
}

function toSafeSegment(value: string): string {
  const normalized = value
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return normalized || "project";
}

function normalizeProjectState(value: unknown): ProjectStoreState {
  if (!value || typeof value !== "object") {
    return createEmptyState();
  }

  const projects = Array.isArray((value as ProjectStoreState).projects)
    ? (value as ProjectStoreState).projects
    : [];

  return {
    projects: projects.filter(
      (project): project is Project =>
        Boolean(project) &&
        typeof project.id === "string" &&
        typeof project.displayName === "string" &&
        typeof project.slug === "string" &&
        typeof project.rootPath === "string" &&
        typeof project.createdAt === "string"
    )
  };
}

export function createFileProjectStore(options: FileProjectStoreOptions): MainProjectStore {
  const workspaceRoot = options.workspaceRoot;
  const filePath = options.filePath ?? path.join(workspaceRoot, "projects.json");
  let statePromise: Promise<ProjectStoreState> | null = null;

  function getProjectsRoot(): string {
    return path.resolve(
      typeof options.projectsRoot === "function"
        ? options.projectsRoot()
        : options.projectsRoot ?? path.join(workspaceRoot, "projects")
    );
  }

  async function loadState(): Promise<ProjectStoreState> {
    if (statePromise) {
      return statePromise;
    }

    statePromise = (async () => {
      try {
        const raw = await fs.readFile(filePath, "utf8");
        return normalizeProjectState(JSON.parse(raw));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        return createEmptyState();
      }
    })();

    return statePromise;
  }

  async function saveState(state: ProjectStoreState): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async function upsertProject(project: Project): Promise<Project> {
    const state = await loadState();
    state.projects = [
      ...state.projects.filter((currentProject) => currentProject.id !== project.id),
      cloneProject(project)
    ];
    await fs.mkdir(project.rootPath, { recursive: true });
    await saveState(state);
    return cloneProject(project);
  }

  async function getProject(projectId: string): Promise<Project | undefined> {
    const state = await loadState();
    const project = state.projects.find((currentProject) => currentProject.id === projectId);
    return project ? cloneProject(project) : undefined;
  }

  return {
    async createProject(input) {
      const displayName = input.displayName.trim();
      if (!displayName) {
        throw new Error("Project name must not be blank");
      }

      const state = await loadState();
      const slug = createProjectSlug(displayName);
      if (
        state.projects.some(
          (project) => project.displayName === displayName || project.slug === slug
        )
      ) {
        throw new Error("项目名称已存在");
      }
      const usedProjectIds = new Set(state.projects.map((project) => project.id));
      let projectId = options.idGenerator.createId("project");
      for (let attempt = 1; usedProjectIds.has(projectId) && attempt < PROJECT_ID_COLLISION_RETRY_LIMIT; attempt += 1) {
        projectId = options.idGenerator.createId("project");
      }

      if (usedProjectIds.has(projectId)) {
        throw new Error("项目 ID 已存在，请重试");
      }

      return upsertProject({
        id: projectId,
        displayName,
        slug,
        rootPath: path.join(getProjectsRoot(), slug),
        createdAt: options.clock.now()
      });
    },

    async ensureProject(projectId) {
      const existingProject = await getProject(projectId);
      if (existingProject) {
        await fs.mkdir(existingProject.rootPath, { recursive: true });
        return existingProject;
      }

      const slug = toSafeSegment(projectId);
      return upsertProject({
        id: projectId,
        displayName: projectId,
        slug,
        rootPath: path.join(getProjectsRoot(), slug),
        createdAt: options.clock.now()
      });
    },

    getProject,

    async listProjects() {
      const state = await loadState();
      return state.projects.map(cloneProject);
    }
  };
}
