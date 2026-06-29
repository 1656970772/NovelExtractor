import { getDefaultConfig } from "./defaults";
import type { ExtractionParameterDefaults } from "./schema";

export function getExtractionParameterDefaults(): ExtractionParameterDefaults {
  return getDefaultConfig().extractionParameterDefaults;
}
