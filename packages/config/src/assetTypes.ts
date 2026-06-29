import { getDefaultConfig } from "./defaults";
import type { AssetTypeConfig } from "./schema";

export function getAssetTypes(): AssetTypeConfig[] {
  return getDefaultConfig().assetTypes;
}
