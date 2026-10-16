/** Use the fixed upstream analyzer's bounded program API for workspace reflection. */
export const STUDIO_TYPERT_EDIT = {
  file: 'packages/typert/generator/src/workspace.ts',
  apply(source) {
    const before = '      ...(this.options.rejectBuildOutputs === undefined ? {} : { rejectBuildOutputs: this.options.rejectBuildOutputs }),\n    }).analyze()'
    const after = '      ...(this.options.rejectBuildOutputs === undefined ? {} : { rejectBuildOutputs: this.options.rejectBuildOutputs }),\n    }).analyzeInBatches()'
    if (source.split(after).length === 2 && !source.includes(before)) return source
    if (source.split(before).length !== 2 || source.includes(after)) throw new Error('Studio Typert edit anchor missing or duplicated.')
    return source.replace(before, after)
  },
}
