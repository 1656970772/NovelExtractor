import type { ResourceState } from "../assets/AssetsPage";

export interface GraphPlaceholderPageProps {
  state: ResourceState;
  errorMessage?: string;
}

export function GraphPlaceholderPage({ state, errorMessage }: GraphPlaceholderPageProps) {
  return (
    <section className="page-surface" aria-labelledby="graph-title">
      <div className="page-heading">
        <div>
          <p className="section-kicker">Graph</p>
          <h1 id="graph-title">关系图谱</h1>
        </div>
        <span className="status-chip">图谱视图准备中</span>
      </div>

      {state === "loading" ? (
        <div className="state-banner">正在读取书籍上下文</div>
      ) : null}
      {state === "error" ? (
        <div className="state-banner state-banner--danger" role="alert">
          {errorMessage ?? "读取书籍上下文失败"}
        </div>
      ) : null}

      <div className="graph-placeholder">
        <div className="graph-placeholder__map" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div>
          <h2>当前书籍暂无图谱资产</h2>
          <p>完成资料整理后，可在这里查看人物、地点与线索之间的关系。</p>
        </div>
      </div>
    </section>
  );
}
