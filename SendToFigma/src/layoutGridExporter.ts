import { normalizeLayoutGrids } from "../../shared/layoutGridUtils";

// Empty public getters can also mean lazy host data. Normal export records
// that uncertainty once per file; it never changes selection to probe nodes.
export function readResolvedLayoutGrids(node: any): any[] {
  return normalizeLayoutGrids(node.layoutGrids);
}
