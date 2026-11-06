/** Generate the Shell Remote contract with the fixed official analyzer; no runtime services load. */
import { pathToFileURL } from 'node:url'
import path from 'node:path'
const root = process.argv[2]
if (!root) throw new Error('Expected assembled workspace path')
const { WorkspaceTypertGenerator } = await import(pathToFileURL(path.join(root, 'packages/typert/generator/src/workspace.ts')).href)
const { writeWorkspaceArtifacts } = await import(pathToFileURL(path.join(root, 'packages/typert/generator/src/artifact-files.ts')).href)
const artifacts = new WorkspaceTypertGenerator(root, { checkDiagnostics: false }).generateContributors(['host'])
writeWorkspaceArtifacts(root, artifacts)
