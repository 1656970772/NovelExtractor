import { getAssetTypes } from "@novel-extractor/config";
import type { ReportDto } from "../../../shared/ipcTypes";

export type ResourceState = "ready" | "loading" | "error";

export interface AssetTypeLike {
  id: string;
  label: string;
}

export interface BookAsset {
  id: string;
  displayName: string;
  fileName?: string;
  chapterCount?: number;
}

export function getVisibleAssetTypes(
  assetTypes: readonly AssetTypeLike[] = getAssetTypes()
): AssetTypeLike[] {
  return assetTypes
    .filter((assetType) => assetType.id === "book")
    .map((assetType) => ({ id: assetType.id, label: assetType.label }));
}

export function getBookAssetTypeLabel(
  assetTypes: readonly AssetTypeLike[] = getAssetTypes()
): string {
  return getVisibleAssetTypes(assetTypes)[0]?.label ?? "书籍";
}

export function getBookSummary(book: BookAsset): string {
  if (book.chapterCount && book.chapterCount > 0) {
    return `${book.chapterCount} 章`;
  }

  return book.fileName ?? "等待分章";
}

export function getReportSummary(report: ReportDto): string {
  return `${report.fileName} / ${formatByteSize(report.byteSize)}`;
}

function formatByteSize(byteSize: number): string {
  if (!Number.isFinite(byteSize) || byteSize < 0) {
    return "0 B";
  }

  if (byteSize < 1024) {
    return `${byteSize} B`;
  }

  const kilobytes = byteSize / 1024;
  const rounded = Number.isInteger(kilobytes) ? kilobytes.toString() : kilobytes.toFixed(1);
  return `${rounded} KB`;
}
