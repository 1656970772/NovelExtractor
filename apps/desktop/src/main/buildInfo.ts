export interface BuildInfo {
  appVersion: string;
  commit: string;
  time: string;
}

type BuildInfoEnv = Partial<Record<"NOVEL_EXTRACTOR_APP_VERSION" | "NOVEL_EXTRACTOR_BUILD_COMMIT" | "NOVEL_EXTRACTOR_BUILD_TIME", string>>;

interface ResolveBuildInfoInput {
  appVersion?: string;
  env?: BuildInfoEnv;
  injected?: Partial<BuildInfo>;
}

type BuildMetadataEnv = Partial<
  Record<"NOVEL_EXTRACTOR_BUILD_COMMIT" | "NOVEL_EXTRACTOR_BUILD_TIME" | "NOVEL_EXTRACTOR_STRICT_BUILD_INFO", string>
>;

interface CreateBuildMetadataDefineInput {
  command: "serve" | "build";
  env?: BuildMetadataEnv;
  now?: () => string;
  readGitCommit?: () => string | undefined;
}

declare const __NOVEL_EXTRACTOR_APP_VERSION__: string | undefined;
declare const __NOVEL_EXTRACTOR_BUILD_COMMIT__: string | undefined;
declare const __NOVEL_EXTRACTOR_BUILD_TIME__: string | undefined;

const UNKNOWN_BUILD_VALUE = "unknown";

function normalizeBuildValue(value: string | undefined): string | undefined {
  const trimmedValue = value?.trim();
  return trimmedValue ? trimmedValue : undefined;
}

function normalizeResolvedBuildMetadataValue(value: string | undefined): string | undefined {
  const normalizedValue = normalizeBuildValue(value);
  if (!normalizedValue || normalizedValue.toLowerCase() === UNKNOWN_BUILD_VALUE) {
    return undefined;
  }

  return normalizedValue;
}

function readInjectedBuildInfo(): Partial<BuildInfo> {
  return {
    appVersion:
      typeof __NOVEL_EXTRACTOR_APP_VERSION__ === "string" ? __NOVEL_EXTRACTOR_APP_VERSION__ : undefined,
    commit: typeof __NOVEL_EXTRACTOR_BUILD_COMMIT__ === "string" ? __NOVEL_EXTRACTOR_BUILD_COMMIT__ : undefined,
    time: typeof __NOVEL_EXTRACTOR_BUILD_TIME__ === "string" ? __NOVEL_EXTRACTOR_BUILD_TIME__ : undefined
  };
}

export function resolveBuildInfo(input: ResolveBuildInfoInput = {}): BuildInfo {
  const env = input.env ?? process.env;
  const injected = { ...readInjectedBuildInfo(), ...input.injected };

  return {
    appVersion:
      normalizeBuildValue(input.appVersion) ??
      normalizeBuildValue(injected.appVersion) ??
      normalizeBuildValue(env.NOVEL_EXTRACTOR_APP_VERSION) ??
      UNKNOWN_BUILD_VALUE,
    commit: normalizeBuildValue(injected.commit) ?? normalizeBuildValue(env.NOVEL_EXTRACTOR_BUILD_COMMIT) ?? UNKNOWN_BUILD_VALUE,
    time: normalizeBuildValue(injected.time) ?? normalizeBuildValue(env.NOVEL_EXTRACTOR_BUILD_TIME) ?? UNKNOWN_BUILD_VALUE
  };
}

export function createBuildMetadataDefine(input: CreateBuildMetadataDefineInput): Record<string, string> {
  const env = input.env ?? process.env;
  const commit =
    normalizeResolvedBuildMetadataValue(env.NOVEL_EXTRACTOR_BUILD_COMMIT) ??
    normalizeResolvedBuildMetadataValue(input.readGitCommit?.());
  const buildTime =
    normalizeResolvedBuildMetadataValue(env.NOVEL_EXTRACTOR_BUILD_TIME) ??
    (input.command === "build" && commit
      ? normalizeResolvedBuildMetadataValue((input.now ?? (() => new Date().toISOString()))())
      : undefined);
  const strictBuildInfo =
    input.command === "build" || normalizeBuildValue(env.NOVEL_EXTRACTOR_STRICT_BUILD_INFO) === "1";

  if (strictBuildInfo && (!commit || !buildTime)) {
    throw new Error("Build metadata is required for build output: commit and time must not be unknown");
  }

  return {
    __NOVEL_EXTRACTOR_BUILD_COMMIT__: JSON.stringify(commit ?? UNKNOWN_BUILD_VALUE),
    __NOVEL_EXTRACTOR_BUILD_TIME__: JSON.stringify(buildTime ?? UNKNOWN_BUILD_VALUE)
  };
}

export function formatBuildInfo(buildInfo: BuildInfo): string {
  return [`App Version: ${buildInfo.appVersion}`, `Build Commit: ${buildInfo.commit}`, `Build Time: ${buildInfo.time}`].join(
    "\n"
  );
}
