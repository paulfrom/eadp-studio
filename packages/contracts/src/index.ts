import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
export type { Static, TSchema } from '@sinclair/typebox';

const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });
export const IdSchema = Type.String({ minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' });
const text = Type.String({ minLength: 1, maxLength: 500 });
export const ShaSchema = Type.String({ pattern: '^[a-f0-9]{40}$' });
export const RevisionSchema = Type.Integer({ minimum: 0 });
export const EntityKindSchema = Type.Union([Type.Literal('scenario'), Type.Literal('requirement'), Type.Literal('baseline'), Type.Literal('handoff')]);
export type EntityKind = Static<typeof EntityKindSchema>;
export const FixedReferenceSchema = object({ commitSha: ShaSchema, path: Type.String({ minLength: 1, maxLength: 400 }), sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }) });
export type FixedReference = Static<typeof FixedReferenceSchema>;
export const SourceSchema = object({ projectId: IdSchema, entityId: IdSchema, version: Type.Integer({ minimum: 1 }) });
export type AssetSource = Static<typeof SourceSchema>;
export const PrerequisiteSchema = object({ requirementId: IdSchema, version: Type.Integer({ minimum: 1 }) });
export type Prerequisite = Static<typeof PrerequisiteSchema>;
export const MaterialMetadataSchema = object({
  entityId: IdSchema, kind: EntityKindSchema, title: text, categoryId: IdSchema,
  scenarioIds: Type.Array(IdSchema, { uniqueItems: true, maxItems: 100 }),
  prerequisites: Type.Array(PrerequisiteSchema, { maxItems: 100 }),
  sources: Type.Array(SourceSchema, { maxItems: 100 }),
  businessEvidence: Type.Array(object({ label: text, reference: text }), { minItems: 1, maxItems: 100 }),
  coreRulesPresent: Type.Boolean(), acceptanceCriteriaPresent: Type.Boolean(),
  openQuestions: Type.Array(object({ blocking: Type.Boolean(), limitation: text, excludedScope: text }), { maxItems: 100 }),
  referencedAssets: Type.Array(SourceSchema, { maxItems: 100 }),
  applicability: Type.Optional(object({ status: Type.Literal('not-applicable'), reason: text })),
});
export type MaterialMetadata = Static<typeof MaterialMetadataSchema>;
export const FixedManifestSchema = object({ schemaVersion: Type.Literal(1), metadata: MaterialMetadataSchema });
export type FixedManifest = Static<typeof FixedManifestSchema>;
export function isFixedManifest(value: unknown): value is FixedManifest { return Value.Check(FixedManifestSchema, value); }
export function isMaterialMetadata(value: unknown): value is MaterialMetadata { return Value.Check(MaterialMetadataSchema, value); }
export const OccupationTokenSchema = object({ occupationId: IdSchema, generation: Type.Integer({ minimum: 1 }), taskId: IdSchema, clientId: IdSchema, expectedRevision: RevisionSchema });
export type OccupationToken = Static<typeof OccupationTokenSchema>;
const keyed = { idempotencyKey: IdSchema };
const numericId = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export interface StudioUser { id: number; username: string; name: string; email: string; admin: boolean; gitlabUserId: number; gitlabUsername: string; gitlabEmail?: string }
export interface StudioIdentity { user: StudioUser; gitlabOrigin: string }
export const LoginSchema = object({ username: Type.String({ minLength: 1, maxLength: 100 }), password: Type.String({ minLength: 1, maxLength: 200 }) });
export type LoginRequest = Static<typeof LoginSchema>;
export interface LoginResponse extends StudioIdentity { token: string; expiresAt: string }
export interface NamespaceView { id: number; name: string; fullPath: string }
export const CreateProjectSchema = object({ ...keyed, name: Type.String({ minLength: 1, maxLength: 200 }), namespaceId: numericId, path: Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }) });
export type CreateProjectRequest = Static<typeof CreateProjectSchema>;
export const InitializeProjectSchema = object({ ...keyed, commitSha: ShaSchema });
export type InitializeProjectRequest = Static<typeof InitializeProjectSchema>;
export const CategorySchema = object({ ...keyed, categoryId: IdSchema, name: text, expectedRevision: RevisionSchema });
export type CategoryRequest = Static<typeof CategorySchema>;
export const ReserveEntitySchema = object({ ...keyed, kind: EntityKindSchema, title: text, categoryId: IdSchema, sourceCandidateId: Type.Optional(IdSchema), batch: Type.Optional(object({ scenarioId: IdSchema, token: OccupationTokenSchema })) });
export type ReserveEntityRequest = Static<typeof ReserveEntitySchema>;
export const ClaimSchema = object({ ...keyed, expectedRevision: RevisionSchema, taskId: IdSchema, clientId: IdSchema, purpose: Type.Union([Type.Literal('design'), Type.Literal('prototype'), Type.Literal('scenario-batch')]) });
export type ClaimRequest = Static<typeof ClaimSchema>;
export const ReleaseSchema = object({ ...keyed, token: OccupationTokenSchema, reason: text });
export type ReleaseRequest = Static<typeof ReleaseSchema>;
export const UpdateRelationsSchema = object({ ...keyed, token: OccupationTokenSchema, scenarioIds: Type.Array(IdSchema, { uniqueItems: true, maxItems: 100 }), prerequisites: Type.Array(PrerequisiteSchema, { maxItems: 100 }) });
export type UpdateRelationsRequest = Static<typeof UpdateRelationsSchema>;
export const CheckEvidenceSchema = object({
  candidateSha: ShaSchema, passed: Type.Literal(true),
  checks: Type.Array(object({ name: text, passed: Type.Literal(true), evidenceHash: Type.String({ pattern: '^[a-f0-9]{64}$' }) }), { minItems: 1, maxItems: 100 }),
});
export type CheckEvidence = Static<typeof CheckEvidenceSchema>;
export const ConfirmationInputSchema = object({
  entityId: IdSchema, expectedRevision: RevisionSchema, fixed: FixedReferenceSchema, metadata: MaterialMetadataSchema,
  confirmationMethod: Type.Union([Type.Literal('direct'), Type.Literal('ai-assisted')]),
  authorConfirmed: Type.Literal(true),
});
export type ConfirmationInput = Static<typeof ConfirmationInputSchema>;
export const PrepareIntegrationSchema = object({
  ...keyed, entityId: IdSchema, token: OccupationTokenSchema,
  stage: Type.Union([Type.Literal('material'), Type.Literal('prototype'), Type.Literal('scenario-batch')]),
  sourceSha: ShaSchema, expectedHead: ShaSchema, candidateSha: ShaSchema,
  allowedPaths: Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { minItems: 1, maxItems: 3000, uniqueItems: true }),
  checks: CheckEvidenceSchema, confirmations: Type.Array(ConfirmationInputSchema, { minItems: 1, maxItems: 100 }),
  expectedAssociationRevision: Type.Optional(RevisionSchema),
  batchRequirementIds: Type.Optional(Type.Array(IdSchema, { maxItems: 100, uniqueItems: true })),
});
export type PrepareIntegrationRequest = Static<typeof PrepareIntegrationSchema>;
export const CompleteIntegrationSchema = object({ ...keyed, token: OccupationTokenSchema });
export type CompleteIntegrationRequest = Static<typeof CompleteIntegrationSchema>;
export const EligibilitySchema = object({ ...keyed, version: Type.Integer({ minimum: 1 }), enabled: Type.Boolean(), reason: text });
export type EligibilityRequest = Static<typeof EligibilitySchema>;
export const AdoptSchema = object({ ...keyed, source: SourceSchema, targetEntityId: IdSchema, targetTaskId: IdSchema, scope: Type.Union([Type.Literal('material-package'), Type.Literal('prototype-package')]), adjustmentSummary: text });
export type AdoptRequest = Static<typeof AdoptSchema>;
export const AdoptionSuccessSchema = object({ ...keyed, targetConfirmationId: IdSchema });
export type AdoptionSuccessRequest = Static<typeof AdoptionSuccessSchema>;
export const ReconcileSchema = object({ ...keyed, expectedHead: ShaSchema, correctedHead: ShaSchema, reason: text });
export type ReconcileRequest = Static<typeof ReconcileSchema>;
export const HandoffReceiptSchema = object({ ...keyed, confirmationId: IdSchema, note: text });
export type HandoffReceiptRequest = Static<typeof HandoffReceiptSchema>;
export const PublicationAuthorizationSchema = object({ baselineId: IdSchema });
export type PublicationAuthorizationRequest = Static<typeof PublicationAuthorizationSchema>;
export interface PublicationCurrent { baselineId: string; commitSha: string; acceptedHead: string; completionEvidence: string }
export const DeploymentSchema = object({ ...keyed, baselineId: IdSchema, url: Type.String({ format: 'uri', maxLength: 1000 }), artifactSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }) });
export type DeploymentRequest = Static<typeof DeploymentSchema>;

export interface OccupationView extends OccupationToken {
  entityId: string; ownerId: number; purpose: ClaimRequest['purpose']; inputVersion: number;
  prerequisiteBindings: Array<{ requirementId: string; version: number; confirmationId: string; integrationSha: string }>;
  createdAt: string;
}
export interface FixedVersion {
  version: number; fixed: FixedReference; metadata: MaterialMetadata; confirmationId: string;
  confirmedBy: number; confirmedAt: string; reuse: { enabled: boolean; reason: string };
  prototypeBaselineId?: string;
}
export interface EntityView {
  id: string; kind: EntityKind; title: string; categoryId: string; revision: number; generation: number;
  materialVersion: number; confirmationStatus: 'draft' | 'confirmed'; taskStatus: 'idle' | 'active' | 'aborted' | 'completed';
  scenarioIds: string[]; prerequisites: Prerequisite[]; current?: FixedVersion; authorId: number;
  occupation?: OccupationView; frozenBy: string[]; associationRevision: number; completedVersion?: number; completionConfirmationId?: string; completedIntegrationSha?: string;
  completions?: Array<{ version: number; confirmationId: string; integrationSha: string; baselineId: string }>;
}
export interface EntityOccupancyView { id: string; kind: EntityKind; revision: number; taskStatus: EntityView['taskStatus']; occupation?: OccupationView }
export interface ProjectView {
  id: string; gitlabProjectId: number; repositoryUrl: string; stableBranch: string; name: string;
  namespaceId: number; namespacePath: string; initializationStatus: 'pending' | 'ready';
  revision: number; recognizedHead: string | null; currentBaselineId?: string;
  categories: Array<{ id: string; name: string }>; deployment?: { baselineId: string; url: string; artifactSha256: string; deployedAt: string };
}
export interface ProjectState { project: ProjectView; entities: Array<EntityView | EntityOccupancyView>; integrations: IntegrationView[]; baselines: BaselineView[] }
export interface IntegrationView {
  id: string; entityId: string; ownerId: number; status: 'prepared' | 'accepted' | 'aborted';
  sourceSha: string; expectedHead: string; candidateSha: string; stage: PrepareIntegrationRequest['stage'];
  confirmationIds?: string[]; baselineId?: string; createdAt: string;
}
export interface BaselineView { id: string; entityId: string; version: number; commitSha: string; confirmationId: string; createdAt: string }
export interface ConfirmationEvent { id: string; projectId: string; entityId: string; version: number; fixed: FixedReference; revision: number; confirmedBy: number; confirmedAt: string }
export interface ApiError { error: { code: string; message: string; details?: unknown } }
