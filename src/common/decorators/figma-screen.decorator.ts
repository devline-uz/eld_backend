import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import { FIGMA_SCREENS, FigmaScreenId } from './figma-screens';

export const FIGMA_SCREEN_METADATA = 'figma:screens';
/** OpenAPI vendor extension key the generated document carries per operation. */
export const FIGMA_SCREEN_EXTENSION = 'x-figma-screens';

/**
 * Links a controller or route to the Figma screen(s) it serves — tasks.md Global gate
 * "Every new endpoint links to at least one Figma screen".
 *
 * Machine-checkable in two directions:
 *  - the id must exist in `FIGMA_SCREENS` (a typo is a TypeScript error, and every id
 *    there cites the `eld.docs/web/*.pdf` page it was transcribed from);
 *  - the ids land in the OpenAPI document as `x-figma-screens`, so
 *    `test/e2e/openapi-contract.e2e-spec.ts` can assert coverage over every operation
 *    without reading source code.
 *
 * On a controller it applies to every route in it; a route-level decorator replaces the
 * controller-level one for that route (standard Nest metadata precedence, and OpenAPI
 * extensions set on the method win over the class).
 */
export function FigmaScreen(...ids: [FigmaScreenId, ...FigmaScreenId[]]) {
  const screens = ids.map((id) => ({ id, ...FIGMA_SCREENS[id] }));
  return applyDecorators(
    SetMetadata(FIGMA_SCREEN_METADATA, screens),
    ApiExtension(FIGMA_SCREEN_EXTENSION, screens),
  );
}
