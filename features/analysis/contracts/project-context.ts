export interface ProjectContext {
  /**
   * Repository-relative paths discovered during project scanning.
   *
   * Examples:
   * - src/index.ts
   * - src/utils/helpers.ts
   * - tests/example.test.ts
   */
  files: string[];

  /**
   * True only when the file inventory is known to be complete
   * for the project being analysed.
   */
  inventoryComplete: boolean;

  /**
   * Whether package.json or equivalent package metadata
   * was successfully discovered and read.
   *
   * Used by package dependency resolution, not the
   * relative-import resolver.
   */
  manifestAvailable: boolean;

  /**
   * Whether relevant resolution configuration was discovered
   * and read, such as tsconfig.json paths/baseUrl.
   *
   * Used by alias resolution.
   */
  resolutionConfigAvailable: boolean;

  /**
   * Files or directories that could not be inspected.
   *
   * Paths must be repository-relative.
   * An inaccessible directory makes files beneath it uncertain.
   */
  inaccessiblePaths: string[];
}
