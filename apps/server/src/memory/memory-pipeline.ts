/**
 * Bridge 4 (`PLAN.md`): the single seam between Person 2's group runner and
 * Person 3's governed-memory pipeline.
 *
 * The runner hands over ids only. Person 3's `TaskBufferBuilder` reads the
 * store itself -- the runner never shapes a consolidator prompt and never
 * depends on any memory module (Bridge 5).
 *
 * `components/GROUP-RUNNER.md` sketches a different shape, in which the runner
 * builds a `TaskBuffer` and passes it in. Bridge 4 and Bridge 5 are the
 * narrower and more recent contract, so this is the one implemented. Recorded
 * in `middlewaredoc/MILESTONE.md` -> Resolved contradiction.
 */
export interface MemoryPipeline {
  /**
   * Called once, after `decideFlush()` returns `shouldFlush: true`.
   *
   * Must never throw a group task into failure: the caller catches and logs,
   * and the completed task stays completed (Bridge 4 -> Failure behavior).
   */
  runMemoryPipeline(groupTaskId: string, sinkNodeIds: string[]): Promise<void>;
}

/**
 * The default until Person 3 lands the real pipeline. Records its calls so a
 * group-runner test can assert the handover happened with the right ids
 * without pulling in any memory module.
 */
export class NoopMemoryPipeline implements MemoryPipeline {
  readonly calls: Array<{ groupTaskId: string; sinkNodeIds: string[] }> = [];

  async runMemoryPipeline(
    groupTaskId: string,
    sinkNodeIds: string[],
  ): Promise<void> {
    this.calls.push({ groupTaskId, sinkNodeIds });
  }
}
