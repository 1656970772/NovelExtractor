import { FormEvent, useEffect, useState } from "react";

export interface ProjectSummary {
  id: string;
  displayName: string;
}

export type ProjectGateState = "loading" | "ready" | "error";

export interface ProjectGateProps {
  errorMessage?: string;
  onCreateProject: (displayName: string) => ProjectSummary | Promise<ProjectSummary>;
  onSelectProject?: (project: ProjectSummary) => void;
  projects?: readonly ProjectSummary[];
  state?: ProjectGateState;
}

export function ProjectGate({
  errorMessage,
  onCreateProject,
  onSelectProject,
  projects = [],
  state = "ready"
}: ProjectGateProps) {
  const [projectName, setProjectName] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState(projects[0]?.id ?? "");
  const [createErrorMessage, setCreateErrorMessage] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const trimmedName = projectName.trim();
  const activeErrorMessage = createErrorMessage ?? errorMessage;
  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  useEffect(() => {
    if (projects.length === 0) {
      setSelectedProjectId("");
      return;
    }

    if (!projects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!trimmedName || isCreating) {
      return;
    }

    setCreateErrorMessage(null);
    setIsCreating(true);

    try {
      await Promise.resolve(onCreateProject(trimmedName));
    } catch (error) {
      setCreateErrorMessage(error instanceof Error ? error.message : "创建项目失败");
      setIsCreating(false);
    }
  }

  function handleOpenProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedProject || !onSelectProject) {
      return;
    }

    onSelectProject(selectedProject);
  }

  return (
    <section className="project-gate" aria-labelledby="project-gate-title">
      <div className="project-gate__mark" aria-hidden="true">
        NE
      </div>
      <div className="project-gate__copy">
        <p className="section-kicker">NovelExtractor</p>
        <h1 id="project-gate-title">{projects.length > 0 ? "选择工作项目" : "创建工作项目"}</h1>
        <p>为本次小说资料整理建立本地工作空间。</p>
      </div>
      {state === "loading" ? <p className="empty-text">正在读取项目</p> : null}
      {projects.length > 0 ? (
        <form className="project-picker" onSubmit={handleOpenProject}>
          <label htmlFor="existing-project">已有项目</label>
          <div className="project-form__row">
            <select
              id="existing-project"
              name="existingProject"
              value={selectedProjectId}
              onChange={(event) => setSelectedProjectId(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.displayName}
                </option>
              ))}
            </select>
            <button
              className="button button--secondary"
              type="submit"
              disabled={!selectedProject || !onSelectProject}
            >
              打开项目
            </button>
          </div>
        </form>
      ) : null}
      <form className="project-form" onSubmit={handleSubmit}>
        <label htmlFor="project-name">项目名称</label>
        <div className="project-form__row">
          <input
            id="project-name"
            name="projectName"
            type="text"
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            aria-invalid={Boolean(activeErrorMessage)}
            aria-describedby={activeErrorMessage ? "project-create-error" : undefined}
            disabled={isCreating}
          />
          <button className="button button--primary" type="submit" disabled={!trimmedName || isCreating}>
            {isCreating ? "创建中" : "创建项目"}
          </button>
        </div>
        {activeErrorMessage ? (
          <p className="form-error" id="project-create-error" role="alert">
            {activeErrorMessage}
          </p>
        ) : null}
      </form>
    </section>
  );
}
