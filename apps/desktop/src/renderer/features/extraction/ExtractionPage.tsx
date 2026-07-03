import { useEffect, useMemo, useState } from "react";
import {
  getExtractionParameterDefaults,
  type TaskAction
} from "@novel-extractor/config";
import type { CreateJobDto, SaveTemplateDto, TemplateDto } from "../../../shared/ipcTypes";
import type { ResourceState } from "../assets/AssetsPage";
import { ExtractionParameters, type CreateJobState } from "./ExtractionParameters";
import { JobList } from "./JobList";
import { UploadNovelPanel, type UploadState } from "./UploadNovelPanel";
import {
  buildCreateJobDto,
  createExtractionFormState,
  reconcileExtractionFormState,
  type ExtractionBook,
  type ExtractionFormState,
  type ExtractionJob,
  type ExtractionModel
} from "./extractionViewModel";
import { getDefaultTemplateViews, type TemplateView } from "../templates/templateViewModel";
import { TemplateUploadPanel } from "../templates/TemplateUploadPanel";
import { useTransientScrollbar } from "./useTransientScrollbar";

export type { ExtractionBook, ExtractionJob, ExtractionModel } from "./extractionViewModel";

export interface ExtractionPageProps {
  projectId?: string;
  models: ExtractionModel[];
  books: ExtractionBook[];
  jobs: ExtractionJob[];
  state: ResourceState;
  errorMessage?: string;
  uploadState?: UploadState;
  uploadError?: string;
  createState?: CreateJobState;
  createError?: string;
  templates?: TemplateView[];
  selectedTemplateIds?: string[];
  onUploadTxt?: (file: File) => Promise<void>;
  onCreateJob?: (input: CreateJobDto) => Promise<void>;
  onJobAction?: (jobId: string, action: TaskAction) => Promise<void>;
  onDeleteJob?: (jobId: string) => Promise<void>;
  onOpenJobLog?: (jobId: string) => Promise<void>;
  onReadJobLog?: (jobId: string) => Promise<string>;
  onOpenOutputDirectory?: (jobId: string) => Promise<void>;
  onOpenProviderConfig?: () => void;
  onOpenNewTemplate?: () => void;
  onOpenTemplateManager?: () => void;
  onSaveTemplate?: (input: SaveTemplateDto) => Promise<TemplateDto | void>;
  onTemplateSelectionChange?: (templateIds: string[]) => void;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function ExtractionPage({
  projectId,
  models,
  books,
  jobs,
  state,
  errorMessage,
  uploadState,
  uploadError,
  createState,
  createError,
  templates: templatesProp,
  selectedTemplateIds,
  onUploadTxt,
  onCreateJob,
  onJobAction,
  onDeleteJob,
  onReadJobLog,
  onOpenJobLog,
  onOpenOutputDirectory,
  onOpenProviderConfig,
  onOpenNewTemplate,
  onOpenTemplateManager,
  onSaveTemplate,
  onTemplateSelectionChange
}: ExtractionPageProps) {
  const templates = useMemo(() => templatesProp ?? getDefaultTemplateViews(), [templatesProp]);
  const defaults = useMemo(() => getExtractionParameterDefaults(), []);
  const [formState, setFormState] = useState<ExtractionFormState>(() =>
    createExtractionFormState({ books, models, templates, defaults, selectedTemplateIds })
  );
  const [localCreateError, setLocalCreateError] = useState<string | undefined>();
  const layoutScrollbar = useTransientScrollbar();

  useEffect(() => {
    setFormState((currentState) =>
      reconcileExtractionFormState(currentState, {
        books,
        models,
        templates,
        defaults,
        selectedTemplateIds
      })
    );
  }, [books, defaults, models, selectedTemplateIds, templates]);

  function updateFormState(nextState: ExtractionFormState): void {
    const templateSelectionChanged =
      nextState.templateIds.length !== formState.templateIds.length ||
      nextState.templateIds.some((templateId, index) => templateId !== formState.templateIds[index]);

    setFormState(nextState);

    if (templateSelectionChanged) {
      onTemplateSelectionChange?.(nextState.templateIds);
    }
  }

  async function handleCreateJob(): Promise<void> {
    setLocalCreateError(undefined);

    if (!onCreateJob) {
      setLocalCreateError("创建任务入口尚未就绪");
      return;
    }

    try {
      await onCreateJob(buildCreateJobDto(formState, { models }));
    } catch (error) {
      setLocalCreateError(toErrorMessage(error, "创建任务失败"));
    }
  }

  return (
    <section className="page-surface extraction-page" aria-labelledby="extraction-title">
      <div className="extraction-page__chrome">
        <div className="page-heading">
          <div>
            <p className="section-kicker">Extraction</p>
            <h1 id="extraction-title">小说提取</h1>
          </div>
          <span className="status-chip">{models.length > 0 ? `${models.length} 个模型` : "模型状态待确认"}</span>
        </div>

        {state === "error" ? (
          <div className="state-banner state-banner--danger" role="alert">
            {errorMessage ?? "读取任务失败"}
          </div>
        ) : null}

        {state === "loading" ? (
          <div className="state-banner" aria-label="上传和任务加载中">
            正在加载上传信息和任务列表
          </div>
        ) : null}
      </div>

      <div
        className={[
          "extraction-layout",
          "transient-scrollbar",
          layoutScrollbar.isScrollbarActive ? "transient-scrollbar--active" : undefined
        ]
          .filter(Boolean)
          .join(" ")}
        onScroll={layoutScrollbar.onScroll}
      >
        <div className="extraction-layout__stack">
          <UploadNovelPanel
            books={books}
            uploadError={uploadError}
            uploadState={uploadState}
            onUploadTxt={onUploadTxt}
          />
          {projectId && onSaveTemplate ? (
            <section
              aria-labelledby="template-upload-title"
              className="tool-panel template-upload-panel"
            >
              <div className="panel-heading">
                <h2 id="template-upload-title">上传模板</h2>
                <span>.txt / .md</span>
              </div>
              <TemplateUploadPanel
                projectId={projectId}
                templates={templates}
                onOpenNewTemplate={onOpenNewTemplate}
                onSaveTemplate={onSaveTemplate}
              />
            </section>
          ) : null}
        </div>
        <ExtractionParameters
          books={books}
          createError={createError ?? localCreateError}
          createState={createState}
          formState={formState}
          models={models}
          templates={templates}
          onCreateJob={() => {
            void handleCreateJob();
          }}
          onFormChange={updateFormState}
          onOpenProviderConfig={onOpenProviderConfig}
          onOpenTemplateManager={onOpenTemplateManager}
        />
        <JobList
          jobs={jobs}
          onDeleteJob={onDeleteJob}
          onJobAction={onJobAction}
          onOpenJobLog={onOpenJobLog}
          onOpenOutputDirectory={onOpenOutputDirectory}
          onReadJobLog={onReadJobLog}
        />
      </div>
    </section>
  );
}
