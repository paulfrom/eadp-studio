import type { Context } from '@deepseek-ai/cordis'
import { unwrapRemoteResult } from '@eadp/contracts'
import type {
  KnowledgeCatalog,
  KnowledgeDocument,
  KnowledgeDraft,
  KnowledgeDraftResource,
  KnowledgeImportFile,
  KnowledgeImportReceipt,
  KnowledgeImports,
  KnowledgePackId,
  KnowledgeProposal,
  KnowledgeSourceView,
} from '@eadp/contracts/knowledge'
import type {} from '@eadp/knowledge/remote'

/** Content types the document resources can carry; every other extension is served as binary. */
const RESOURCE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
}

/**
 * Resolve the MIME type of a document resource from its path extension.
 * @param path - document-relative resource path such as `assets/<hash>.png`.
 * @returns the content type for the in-memory Blob.
 */
function resourceMime(path: string): string {
  const dot = path.lastIndexOf('.')
  const extension = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
  return RESOURCE_MIME[extension] ?? 'application/octet-stream'
}

/**
 * Wrap the generated knowledge Remote for the React layer: every call unwraps
 * the transport result, and `readResource` turns the returned bytes into a
 * Blob URL the caller must revoke once the document is left.
 */
export function knowledgeApi(ctx: Context) {
  const remote = ctx.remote.eadpKnowledge
  return {
    catalog: async (): Promise<KnowledgeCatalog> => unwrapRemoteResult(await remote.catalog()),

    readDocument: async (
      packId: KnowledgePackId,
      documentId: string,
      expectedRevisionId: string | null,
    ): Promise<KnowledgeDocument> => unwrapRemoteResult(await remote.readDocument(packId, documentId, expectedRevisionId)),

    /** Returns an object URL; the caller owns `URL.revokeObjectURL`. */
    readResource: async (
      packId: KnowledgePackId,
      documentId: string,
      expectedRevisionId: string,
      path: string,
    ): Promise<string> => {
      const bytes = unwrapRemoteResult(await remote.readResource(packId, documentId, expectedRevisionId, path))
      /* Copy into a plain ArrayBuffer so the Blob never retains the transport-backed view. */
      const buffer = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(buffer).set(bytes)
      return URL.createObjectURL(new Blob([buffer], { type: resourceMime(path) }))
    },

    saveDocument: async (
      documentId: string | null,
      expectedRevisionId: string | null,
      draft: KnowledgeDraft,
      resources: KnowledgeDraftResource[],
    ): Promise<KnowledgeDocument> => unwrapRemoteResult(await remote.saveDocument(documentId, expectedRevisionId, draft, resources)),

    saveManualDocument: async (
      importId: string,
      draft: KnowledgeDraft,
      resources: KnowledgeDraftResource[],
    ): Promise<KnowledgeDocument> => unwrapRemoteResult(await remote.saveManualDocument(importId, draft, resources)),

    setAutoReference: async (
      packId: KnowledgePackId,
      documentId: string,
      expectedRevisionId: string,
      autoReference: boolean,
    ): Promise<void> => {
      unwrapRemoteResult(await remote.setAutoReference(packId, documentId, expectedRevisionId, autoReference))
    },

    removeDocument: async (documentId: string, expectedRevisionId: string): Promise<void> => {
      unwrapRemoteResult(await remote.removeDocument(documentId, expectedRevisionId))
    },

    copyBuiltin: async (documentId: string, expectedRevisionId: string): Promise<KnowledgeDocument> =>
      unwrapRemoteResult(await remote.copyBuiltin(documentId, expectedRevisionId)),

    /** Re-runs the background organization for one saved document. */
    retagDocument: async (documentId: string, expectedRevisionId: string): Promise<void> => {
      unwrapRemoteResult(await remote.retagDocument(documentId, expectedRevisionId))
    },

    imports: async (): Promise<KnowledgeImports> => unwrapRemoteResult(await remote.imports()),

    importFiles: async (files: KnowledgeImportFile[]): Promise<KnowledgeImportReceipt[]> =>
      unwrapRemoteResult(await remote.importFiles(files)),

    retryImport: async (importId: string): Promise<void> => {
      unwrapRemoteResult(await remote.retryImport(importId))
    },

    cancelImport: async (importId: string): Promise<void> => {
      unwrapRemoteResult(await remote.cancelImport(importId))
    },

    clearFinishedImports: async (): Promise<void> => {
      unwrapRemoteResult(await remote.clearFinishedImports())
    },

    sourceView: async (importId: string): Promise<KnowledgeSourceView> => unwrapRemoteResult(await remote.sourceView(importId)),

    proposals: async (): Promise<KnowledgeProposal[]> => unwrapRemoteResult(await remote.listProposals()),

    applyProposal: async (proposalId: string, expectedRevisionId: string | null): Promise<void> => {
      unwrapRemoteResult(await remote.applyProposal(proposalId, expectedRevisionId))
    },

    discardProposal: async (proposalId: string): Promise<void> => {
      unwrapRemoteResult(await remote.discardProposal(proposalId))
    },
  }
}

export type KnowledgeApi = ReturnType<typeof knowledgeApi>
