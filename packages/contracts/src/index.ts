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
export const Sha256Schema = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const MaterialFileSchema = object({ path: Type.String({ minLength: 1, maxLength: 400 }), sha256: Sha256Schema });
export type MaterialFile = Static<typeof MaterialFileSchema>;
const evidenceText = Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' });
const businessEvidenceSchema = object({ label: evidenceText, reference: evidenceText,
  files: Type.Array(MaterialFileSchema, { minItems: 1, maxItems: 100 }),
  ranges: Type.Array(object({ path: Type.String({ minLength: 1, maxLength: 400 }), startLine: Type.Integer({ minimum: 1 }), endLine: Type.Integer({ minimum: 1 }) }), { minItems: 1, maxItems: 100 }),
});
const metadataFields = {
  entityId: IdSchema, title: text, summary: Type.Optional(Type.String({ maxLength: 2000 })),
  templateId: Type.Optional(IdSchema), templateRef: Type.Optional(FixedReferenceSchema),
  scenarioIds: Type.Array(IdSchema, { uniqueItems: true, maxItems: 100 }),
  prerequisites: Type.Array(PrerequisiteSchema, { maxItems: 100 }), sources: Type.Array(SourceSchema, { maxItems: 100 }),
  businessEvidence: Type.Array(businessEvidenceSchema, { maxItems: 100 }),
  files: Type.Optional(Type.Array(MaterialFileSchema, { maxItems: 1000 })),
  openQuestions: Type.Array(object({ blocking: Type.Boolean(), limitation: text, excludedScope: text }), { maxItems: 100 }),
  referencedAssets: Type.Array(SourceSchema, { maxItems: 100 }),
  applicability: Type.Optional(object({ status: Type.Literal('not-applicable'), reason: evidenceText })),
};
const businessQuality = { coreRulesPresent: Type.Boolean(), acceptanceCriteriaPresent: Type.Boolean() };
const scenarioMetadata = { ...metadataFields, kind: Type.Literal('scenario'), flowComplete: Type.Boolean(), templateId: IdSchema, templateRef: FixedReferenceSchema, applicability: Type.Optional(Type.Never()) };
const requirementMetadata = { ...metadataFields, ...businessQuality, kind: Type.Literal('requirement'), templateId: IdSchema, templateRef: FixedReferenceSchema };
const aggregateMetadata = { ...metadataFields, ...businessQuality, kind: Type.Union([Type.Literal('baseline'), Type.Literal('handoff')]),
  prototypeBaseline: Type.Optional(object({ baselineId: IdSchema, commitSha: ShaSchema })) };
export const MaterialMetadataSchema = Type.Union([object(scenarioMetadata), object(requirementMetadata), object(aggregateMetadata)]);
export type MaterialMetadata = Static<typeof MaterialMetadataSchema>;
export const ConfirmedMaterialMetadataSchema = Type.Union([
  object(scenarioMetadata),
  object({ ...requirementMetadata, businessEvidence: Type.Array(businessEvidenceSchema, { minItems: 1, maxItems: 100 }) }),
  object({ ...aggregateMetadata, businessEvidence: Type.Array(businessEvidenceSchema, { minItems: 1, maxItems: 100 }) }),
]);
const emptyList = Type.Array(Type.Never(), { maxItems: 0 });
/** Metadata of the system-provisioned general scenario; read only through the strict builtin contract. */
export const BuiltinScenarioMetadataSchema = object({
  entityId: IdSchema, kind: Type.Literal('scenario'), title: Type.Literal('通用场景'), summary: Type.String({ minLength: 1, maxLength: 500 }),
  scenarioIds: emptyList, prerequisites: emptyList, sources: emptyList, referencedAssets: emptyList,
  businessEvidence: emptyList, openQuestions: emptyList,
  flowComplete: Type.Literal(false),
});
export type BuiltinScenarioMetadata = Static<typeof BuiltinScenarioMetadataSchema>;
export function isBuiltinScenarioMetadata(value: unknown): value is BuiltinScenarioMetadata { return Value.Check(BuiltinScenarioMetadataSchema, value); }
export function isConfirmedMaterialMetadata(value: unknown): value is MaterialMetadata { return Value.Check(ConfirmedMaterialMetadataSchema, value); }
export const FixedManifestSchema = object({ schemaVersion: Type.Literal(1), metadata: ConfirmedMaterialMetadataSchema });
export type FixedManifest = Static<typeof FixedManifestSchema>;
export function isFixedManifest(value: unknown): value is FixedManifest { return Value.Check(FixedManifestSchema, value); }
export function isMaterialMetadata(value: unknown): value is MaterialMetadata { return Value.Check(MaterialMetadataSchema, value); }
export const TemplateCatalogSchema = object({ defaultTemplateId: IdSchema, templates: Type.Array(object({ id: IdSchema, name: text, path: Type.String({ minLength: 1, maxLength: 400 }) }), { minItems: 1, maxItems: 100 }) });
export type TemplateCatalog = Static<typeof TemplateCatalogSchema>;
/** Directory layouts declared by accepted project manifests. New projects declare all four. */
export const ProjectDirectoriesSchema = Type.Union([
  Type.Tuple([Type.Literal('场景'), Type.Literal('需求'), Type.Literal('交接'), Type.Literal('原型代码')]),
  Type.Tuple([Type.Literal('场景'), Type.Literal('需求'), Type.Literal('原型代码')]),
]);
export type ProjectDirectories = Static<typeof ProjectDirectoriesSchema>;
export const ProjectManifestSchema = object({ schemaVersion: Type.Literal(1), projectId: IdSchema, gitlabProjectId: Type.Integer({ minimum: 1 }), repositoryUrl: text, stableBranch: text,
  directories: ProjectDirectoriesSchema,
  /** Absent in projects accepted before the template catalogs existed; reading them must not fail. */
  scenarioTemplates: Type.Optional(TemplateCatalogSchema),
  /** Requirement template catalog; new initializations must declare it. */
  requirementTemplates: Type.Optional(TemplateCatalogSchema) });
export type ProjectManifest = Static<typeof ProjectManifestSchema>;
export function isProjectManifest(value: unknown): value is ProjectManifest { return Value.Check(ProjectManifestSchema, value); }
export const OccupationTokenSchema = object({ occupationId: IdSchema, generation: Type.Integer({ minimum: 1 }), taskId: IdSchema, clientId: IdSchema, expectedRevision: RevisionSchema });
export type OccupationToken = Static<typeof OccupationTokenSchema>;
const keyed = { idempotencyKey: IdSchema };
const prototypeRequirementIds = Type.Array(IdSchema, { uniqueItems: true, maxItems: 100 });
const prototypeDevelopmentIds = Type.Array(IdSchema, { uniqueItems: true, minItems: 1, maxItems: 100 });
const prototypePaths = Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { uniqueItems: true, maxItems: 3000 });
const prototypeInstruction = object({ userActionId: IdSchema, summary: Type.String({ minLength: 1, maxLength: 500 }) });
export const PrototypeTaskTokenSchema = object({ prototypeTaskId: IdSchema, generation: Type.Integer({ minimum: 1 }), clientId: IdSchema, expectedRevision: RevisionSchema });
export type PrototypeTaskToken = Static<typeof PrototypeTaskTokenSchema>;
export const DevelopmentClaimTokenSchema = object({ requirementId: IdSchema, claimId: IdSchema, generation: Type.Integer({ minimum: 1 }) });
export type DevelopmentClaimToken = Static<typeof DevelopmentClaimTokenSchema>;
export const CreatePrototypeTaskSchema = object({ ...keyed, title: Type.String({ minLength: 1, maxLength: 200 }), clientId: IdSchema,
  developmentRequirementIds: prototypeDevelopmentIds, referenceRequirementIds: prototypeRequirementIds,
  writeScope: prototypePaths, policyHash: Sha256Schema, instruction: prototypeInstruction });
export type CreatePrototypeTaskRequest = Static<typeof CreatePrototypeTaskSchema>;
export const UpdatePrototypeClaimsSchema = object({ ...keyed, token: PrototypeTaskTokenSchema, developmentRequirementIds: prototypeDevelopmentIds, instruction: prototypeInstruction });
export type UpdatePrototypeClaimsRequest = Static<typeof UpdatePrototypeClaimsSchema>;
export const UpdatePrototypeReferencesSchema = object({ ...keyed, token: PrototypeTaskTokenSchema, referenceRequirementIds: prototypeRequirementIds });
export type UpdatePrototypeReferencesRequest = Static<typeof UpdatePrototypeReferencesSchema>;
export const UpdatePrototypeScopeSchema = object({ ...keyed, token: PrototypeTaskTokenSchema, writeScope: prototypePaths, policyHash: Sha256Schema, instruction: prototypeInstruction });
export type UpdatePrototypeScopeRequest = Static<typeof UpdatePrototypeScopeSchema>;
export const UpdatePrototypeSourceBaseSchema = object({ ...keyed, token: PrototypeTaskTokenSchema,
  sourceOperationId: IdSchema, sourceRef: Type.String({ minLength: 1, maxLength: 400 }), sourceSha: ShaSchema, newBaseHead: ShaSchema,
  developmentClaims: Type.Array(DevelopmentClaimTokenSchema, { minItems: 1, maxItems: 100 }), claimsDigest: Sha256Schema });
export type UpdatePrototypeSourceBaseRequest = Static<typeof UpdatePrototypeSourceBaseSchema>;
export const CancelPrototypeTaskSchema = object({ ...keyed, token: PrototypeTaskTokenSchema, reason: text });
export type CancelPrototypeTaskRequest = Static<typeof CancelPrototypeTaskSchema>;
export const ReleasePrototypeTaskSchema = object({ ...keyed, expectedGeneration: Type.Integer({ minimum: 1 }), expectedRevision: RevisionSchema, reason: text });
export type ReleasePrototypeTaskRequest = Static<typeof ReleasePrototypeTaskSchema>;
export interface PrototypeTaskView {
  id: string; prototypeId: string; ownerId: number; clientId: string; generation: number; revision: number;
  status: 'active' | 'cancelled' | 'released' | 'accepted'; title: string; branch: string; startHead: string; sourceBaseHead: string;
  developmentRequirementIds: string[]; referenceRequirementIds: string[]; developmentClaims: DevelopmentClaimToken[]; claimsDigest: string;
  writeScope: string[]; policyHash: string;
}
/** A conflict-base change retains the exact independently verified source operation. */
export interface PrototypeSourceBaseResult {
  task: PrototypeTaskView;
  source: { operationId: string; ref: string; sha: string; previousBaseHead: string; newBaseHead: string; mergeBaseSha: string };
}
export interface ProjectPrototypeView { id: string; projectId: string; currentBaselineId?: string; recognizedHead: string; tasks: PrototypeTaskView[] }
export interface PrototypeBaselineView { id: string; prototypeId: string; sequence: number; acceptanceId: string; integrationId: string; prototypeTaskId: string; commitSha: string; relatedRequirementIds: string[]; confirmedBy: number; acceptedAt: string }
export const PrototypeEngineeringEvidenceSchema = object({ sourceTreeHash: Sha256Schema, rulesHash: Sha256Schema, buildArtifactSha256: Sha256Schema, candidateSha: ShaSchema,
  checks: Type.Array(object({ name: Type.Union([Type.Literal('engineering'), Type.Literal('mock'), Type.Literal('browser')]), passed: Type.Literal(true), evidenceHash: Sha256Schema }), { minItems: 3, maxItems: 3 }) });
export type PrototypeEngineeringEvidence = Static<typeof PrototypeEngineeringEvidenceSchema>;
export const PrototypeIntegrationSchema = object({ ...keyed, stage: Type.Literal('prototype'), prototypeId: IdSchema, token: PrototypeTaskTokenSchema,
  sourceSha: ShaSchema, sourceBaseHead: ShaSchema, expectedHead: ShaSchema, candidateSha: ShaSchema, allowedPaths: prototypePaths,
  sourceRef: Type.String({ minLength: 1, maxLength: 400 }), candidateRef: Type.String({ minLength: 1, maxLength: 400 }),
  developmentRequirementIds: prototypeDevelopmentIds, developmentClaims: Type.Array(DevelopmentClaimTokenSchema, { minItems: 1, maxItems: 100 }), claimsDigest: Sha256Schema,
  evidence: PrototypeEngineeringEvidenceSchema,
  derivation: Type.Union([object({ kind: Type.Literal('author-confirmed') }), object({ kind: Type.Literal('clean-merge'), mergeBaseSha: ShaSchema })]),
  authorConfirmation: object({ confirmationId: IdSchema, sourceSha: ShaSchema, authorConfirmed: Type.Literal(true), claimsDigest: Sha256Schema, mergePolicy: Type.Literal('clean-merge-and-recheck') }) });
export type PrototypeIntegrationRequest = Static<typeof PrototypeIntegrationSchema>;
export const CompletePrototypeIntegrationSchema = object({ ...keyed, token: PrototypeTaskTokenSchema,
  developmentClaims: Type.Array(DevelopmentClaimTokenSchema, { minItems: 1, maxItems: 100 }), claimsDigest: Sha256Schema });
export type CompletePrototypeIntegrationRequest = Static<typeof CompletePrototypeIntegrationSchema>;
export const AbortPrototypeIntegrationSchema = object({ ...keyed, token: PrototypeTaskTokenSchema });
export type AbortPrototypeIntegrationRequest = Static<typeof AbortPrototypeIntegrationSchema>;
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
const reserveFields = { ...keyed, title: text, sourceCandidateId: Type.Optional(IdSchema) };
export const ReserveEntitySchema = Type.Union([
  object({ ...reserveFields, kind: Type.Literal('scenario'), templateId: Type.Optional(IdSchema), templateRef: Type.Optional(FixedReferenceSchema), sources: Type.Optional(Type.Never()) }),
  object({ ...reserveFields, kind: Type.Literal('requirement'), templateId: IdSchema, templateRef: FixedReferenceSchema, sources: Type.Array(SourceSchema, { minItems: 1, maxItems: 100 }) }),
  object({ ...reserveFields, kind: Type.Union([Type.Literal('baseline'), Type.Literal('handoff')]), templateId: Type.Optional(Type.Never()), templateRef: Type.Optional(Type.Never()), sources: Type.Optional(Type.Array(SourceSchema, { maxItems: 100 })) }),
]);
export type ReserveEntityRequest = Static<typeof ReserveEntitySchema>;
export const ClaimSchema = object({ ...keyed, expectedRevision: RevisionSchema, taskId: IdSchema, clientId: IdSchema, purpose: Type.Literal('design') });
export type ClaimRequest = Static<typeof ClaimSchema>;
export const ReleaseSchema = object({ ...keyed, token: OccupationTokenSchema, reason: text });
export type ReleaseRequest = Static<typeof ReleaseSchema>;
export const UpdateEntitySchema = object({ ...keyed, token: OccupationTokenSchema, title: text, summary: Type.Optional(Type.String({ maxLength: 2000 })) });
export type UpdateEntityRequest = Static<typeof UpdateEntitySchema>;
export const UpdateRelationsSchema = object({ ...keyed, token: OccupationTokenSchema, sources: Type.Array(SourceSchema, { minItems: 1, maxItems: 100 }), scenarioIds: Type.Array(IdSchema, { uniqueItems: true, maxItems: 100 }), prerequisites: Type.Array(PrerequisiteSchema, { maxItems: 100 }) });
export type UpdateRelationsRequest = Static<typeof UpdateRelationsSchema>;
export const CheckEvidenceSchema = object({
  candidateSha: ShaSchema, passed: Type.Literal(true),
  checks: Type.Array(object({ name: text, passed: Type.Literal(true), evidenceHash: Type.String({ pattern: '^[a-f0-9]{64}$' }) }), { minItems: 1, maxItems: 100 }),
});
export type CheckEvidence = Static<typeof CheckEvidenceSchema>;
const confirmationFields = { entityId: IdSchema, expectedRevision: RevisionSchema, fixed: FixedReferenceSchema, readHash: Sha256Schema, authorConfirmed: Type.Literal(true) };
export const ConfirmationInputSchema = Type.Union([
  object({ ...confirmationFields, confirmationMethod: Type.Literal('direct') }),
  object({ ...confirmationFields, confirmationMethod: Type.Literal('ai-assisted'), reviewEvidence: object({ candidateSha: ShaSchema, inputHash: Sha256Schema, reportHash: Sha256Schema, dispositionHash: Sha256Schema }) }),
  object({ ...confirmationFields, confirmationMethod: Type.Literal('ai-repair'), repairTaskId: IdSchema }),
]);
export type ConfirmationInput = Static<typeof ConfirmationInputSchema>;
const integrationFields = { ...keyed, sourceSha: ShaSchema, expectedHead: ShaSchema, candidateSha: ShaSchema,
  allowedPaths: Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { minItems: 1, maxItems: 3000, uniqueItems: true }), checks: CheckEvidenceSchema };
export const MaterialIntegrationSchema = object({ ...integrationFields, entityId: IdSchema, token: OccupationTokenSchema,
  stage: Type.Literal('material'),
  confirmations: Type.Array(ConfirmationInputSchema, { minItems: 1, maxItems: 100 }),
});
export type MaterialIntegrationRequest = Static<typeof MaterialIntegrationSchema>;
/** Validate a persisted fixed-material integration before resuming its effects. */
export function isMaterialIntegrationRequest(value: unknown): value is MaterialIntegrationRequest { return Value.Check(MaterialIntegrationSchema, value); }
export const TemplateIntegrationSchema = object({ ...integrationFields, stage: Type.Literal('template'), expectedProjectRevision: RevisionSchema });
export type TemplateIntegrationRequest = Static<typeof TemplateIntegrationSchema>;
export const PrepareIntegrationSchema = Type.Union([MaterialIntegrationSchema, TemplateIntegrationSchema]);
export type PrepareIntegrationRequest = Static<typeof PrepareIntegrationSchema>;
/** Stable review input bytes shared by Host and API; object key order is not evidence. */
export function reviewInputText(input: Pick<MaterialIntegrationRequest, 'stage' | 'expectedHead' | 'token'> & { confirmations: readonly Pick<ConfirmationInput, 'entityId' | 'expectedRevision' | 'fixed'>[] }, root: Pick<EntityView, 'current' | 'occupation'>): string {
  const value = { expectedHead: input.expectedHead, token: input.token,
    inputs: input.confirmations.map(c => ({ entityId: c.entityId, revision: c.expectedRevision, sha256: c.fixed.sha256 })).sort((a, b) => a.entityId.localeCompare(b.entityId)),
  };
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, item]) => [k, stable(item)])) : v;
  return JSON.stringify(stable(value));
}
export const CompleteIntegrationSchema = object({ ...keyed, token: Type.Optional(OccupationTokenSchema) });
export type CompleteIntegrationRequest = Static<typeof CompleteIntegrationSchema>;
export const EligibilitySchema = object({ ...keyed, version: Type.Integer({ minimum: 1 }), enabled: Type.Boolean(), reason: text });
export type EligibilityRequest = Static<typeof EligibilitySchema>;
export const AdoptSchema = object({ ...keyed, source: SourceSchema, targetEntityId: IdSchema, targetTaskId: IdSchema, scope: Type.Literal('material-package'), adjustmentSummary: text });
export type AdoptRequest = Static<typeof AdoptSchema>;
export const AdoptionSuccessSchema = object({ ...keyed, targetConfirmationId: IdSchema });
export type AdoptionSuccessRequest = Static<typeof AdoptionSuccessSchema>;
export const PrototypeAdoptSchema = object({ ...keyed, source: object({ projectId: IdSchema, baselineId: IdSchema }), targetTaskId: IdSchema, adjustmentSummary: text });
export type PrototypeAdoptRequest = Static<typeof PrototypeAdoptSchema>;
export const PrototypeAdoptionSuccessSchema = object({ ...keyed, targetBaselineId: IdSchema });
export type PrototypeAdoptionSuccessRequest = Static<typeof PrototypeAdoptionSuccessSchema>;
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
  createdAt: string;
}
export interface AuditIdentity { id: number; account: string; name: string; at: string }
export interface FixedVersion {
  version: number; fixed: FixedReference; metadata: MaterialMetadata | BuiltinScenarioMetadata; confirmationId: string;
  builtin?: boolean;
  confirmedBy: number; confirmedAt: string; reuse: { enabled: boolean; reason: string };
  title?: string; summary?: string; applicability?: 'applicable' | 'not-applicable'; applicabilityReason?: string; readHash?: string;
}
/**
 * An accepted fixed material whose document predates the current material
 * contract. It is readable and attributable but never edited, confirmed or
 * reused; the accepted bytes stay authoritative in Git.
 */
export interface LegacyFixedVersion {
  version: number; fixed: FixedReference; confirmationId: string;
  confirmedBy: number; confirmedAt: string; title: string; summary?: string;
  /** Why the document cannot be read under the current contract. */
  reason: string;
}
export interface EntityView {
  id: string; kind: EntityKind; builtinKey?: 'general'; title: string; sequence?: number; code?: string; templateId?: string; templateRef?: FixedReference; summary?: string; creator?: AuditIdentity; lastEditor?: AuditIdentity; revision: number; generation: number;
  materialVersion: number; confirmationStatus: 'draft' | 'confirmed'; taskStatus: 'idle' | 'active' | 'aborted' | 'completed';
  scenarioIds: string[]; scenarioSources?: AssetSource[]; files?: string[]; prerequisites: Prerequisite[]; current?: FixedVersion;
  /** Set instead of `current` when the accepted document predates the current material contract. */
  legacyCurrent?: LegacyFixedVersion; authorId: number;
  occupation?: OccupationView;
}
export type EntityOccupancyView = Pick<EntityView, 'id' | 'kind' | 'builtinKey' | 'title' | 'summary' | 'sequence' | 'code' | 'creator' | 'lastEditor' | 'authorId' | 'revision' | 'confirmationStatus' | 'materialVersion' | 'taskStatus' | 'occupation'>;
export interface ProjectView {
  id: string; gitlabProjectId: number; repositoryUrl: string; stableBranch: string; name: string;
  namespaceId: number; namespacePath: string; initializationStatus: 'pending' | 'ready';
  revision: number; recognizedHead: string | null;
  generalScenario?: { entityId: string; code: string }; deployment?: { baselineId: string; url: string; artifactSha256: string; deployedAt: string };
}
export interface ProjectState { project: ProjectView; entities: Array<EntityView | EntityOccupancyView>; integrations: IntegrationView[]; baselines: PrototypeBaselineView[] }
export interface IntegrationView {
  id: string; entityId?: string; ownerId: number; status: 'prepared' | 'accepted' | 'aborted';
  sourceSha: string; expectedHead: string; candidateSha: string; stage: PrepareIntegrationRequest['stage'];
  confirmationIds?: string[]; baselineId?: string; createdAt: string;
}
export interface ConfirmationEvent { id: string; projectId: string; entityId: string; version: number; fixed: FixedReference; revision: number; confirmedBy: number; confirmedAt: string }
export interface ApiError { error: { code: string; message: string; details?: unknown } }

export const BindTemplateSchema = object({ ...keyed, token: OccupationTokenSchema, templateId: IdSchema, templateRef: FixedReferenceSchema });
export type BindTemplateRequest = Static<typeof BindTemplateSchema>;
const repairFields = { ...keyed, token: OccupationTokenSchema };
export const RepairStartSchema = object({ ...repairFields, userActionId: IdSchema, startHash: Sha256Schema });
export type RepairStartRequest = Static<typeof RepairStartSchema>;
export const RepairTerminationReasonSchema = Type.Union([Type.Literal('cancelled'), Type.Literal('concurrent-edit'), Type.Literal('missing-evidence'), Type.Literal('no-improvement'), Type.Literal('round-limit')]);
export const RepairEventSchema = Type.Union([
  object({ ...repairFields, type: Type.Literal('round'), expectedHash: Sha256Schema, hashAfter: Sha256Schema, improved: Type.Boolean() }),
  object({ ...repairFields, type: Type.Literal('pause'), expectedHash: Sha256Schema, reason: Type.Literal('business-answer-required') }),
  object({ ...repairFields, type: Type.Literal('resume'), expectedHash: Sha256Schema, userActionId: IdSchema }),
  object({ ...repairFields, type: Type.Literal('terminate'), expectedHash: Sha256Schema, reason: RepairTerminationReasonSchema }),
]);
export type RepairEventRequest = Static<typeof RepairEventSchema>;
export interface RepairTaskView { id: string; entityId: string; occupationId: string; userActionId: string; startHash: string; currentHash: string; status: 'active' | 'paused' | 'terminated' | 'completed'; roundsUsed: number; terminationReason?: Static<typeof RepairTerminationReasonSchema> | 'completed' | 'occupation-ended'; createdBy: number; createdAt: string }
export const ComparisonFailureSchema = Type.Union((['model-failed', 'timeout', 'permission-denied', 'read-failed', 'context-limit', 'relationship-unavailable', 'submission-failed', 'cancelled', 'internal-error'] as const).map(value => Type.Literal(value)));
export type ComparisonFailure = Static<typeof ComparisonFailureSchema>;
const conflictSummary = Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' });
export const ConsistencyConflictInputSchema = object({
  id: IdSchema, ordinal: Type.Integer({ minimum: 1, maximum: 100 }), summary: conflictSummary,
  relation: Type.Union([Type.Literal('formal'), Type.Literal('potential')]),
  entities: Type.Array(IdSchema, { minItems: 1, maxItems: 100, uniqueItems: true }),
});
export type ConsistencyConflictInput = Static<typeof ConsistencyConflictInputSchema>;
const comparisonBase = { ...keyed, id: IdSchema, entityId: IdSchema,
  coverage: Type.Union([Type.Literal('complete'), Type.Literal('partial')]),
  conflicts: Type.Array(ConsistencyConflictInputSchema, { maxItems: 100 }) };
const comparisonResults = [
  { result: Type.Literal('completed'), failureCode: Type.Optional(Type.Never()), summary: Type.String({ maxLength: 500 }) },
  { result: Type.Literal('failed'), failureCode: Type.Union((['model-failed', 'timeout', 'permission-denied', 'read-failed', 'context-limit', 'relationship-unavailable', 'submission-failed', 'internal-error'] as const).map(value => Type.Literal(value))), summary: conflictSummary },
  { result: Type.Literal('cancelled'), failureCode: Type.Literal('cancelled'), summary: Type.String({ maxLength: 500 }) },
] as const;
/** Whitelist-only comparison submission; conclusions and conflict digests, never material content. */
export const SubmitConsistencyComparisonSchema = Type.Union([
  ...comparisonResults.map(r => object({ ...comparisonBase, ...r, trigger: Type.Literal('manual'), confirmationId: Type.Optional(Type.Never()) })),
  ...comparisonResults.map(r => object({ ...comparisonBase, ...r, trigger: Type.Literal('confirmation'), confirmationId: IdSchema })),
]);
export type SubmitConsistencyComparisonRequest = Static<typeof SubmitConsistencyComparisonSchema>;
export function isSubmitConsistencyComparisonRequest(value: unknown): value is SubmitConsistencyComparisonRequest { return Value.Check(SubmitConsistencyComparisonSchema, value); }
export interface ConsistencyConflictView { id: string; ordinal: number; summary: string; relation: 'formal' | 'potential'; entities: string[] }
export interface ConsistencyComparisonView {
  id: string; entityId: string; trigger: 'manual' | 'confirmation'; confirmationId?: string;
  result: 'completed' | 'failed' | 'cancelled'; coverage: 'complete' | 'partial'; failureCode?: ComparisonFailure; summary: string;
  conflictCount: number; creator: AuditIdentity; createdAt: string; conflicts: ConsistencyConflictView[];
}
/** Filters for independent comparison history or the latest observation per target. */
export interface ConsistencyComparisonFilter {
  entityId?: string; result?: ConsistencyComparisonView['result']; latestPerEntity?: boolean; limit: number; offset: number;
}
export const MaterialStatusTriggerSchema = Type.Union((['occupation-start', 'save', 'pre-confirmation'] as const).map(value => Type.Literal(value)));
export type MaterialStatusTrigger = Static<typeof MaterialStatusTriggerSchema>;
/** One append-only record of local material git status; the backend only records it. */
export const SubmitMaterialStatusReportSchema = object({
  ...keyed, id: IdSchema, entityId: IdSchema, trigger: MaterialStatusTriggerSchema,
  baseHead: Type.String({ pattern: '^[a-f0-9]{40}$' }),
  worktreeHead: Type.String({ pattern: '^[a-f0-9]{40}$' }),
  changedPathCount: Type.Integer({ minimum: 0, maximum: 3000 }),
  summary: Type.String({ maxLength: 500 }),
});
export type SubmitMaterialStatusReportRequest = Static<typeof SubmitMaterialStatusReportSchema>;
export function isSubmitMaterialStatusReportRequest(value: unknown): value is SubmitMaterialStatusReportRequest { return Value.Check(SubmitMaterialStatusReportSchema, value); }
export interface MaterialStatusReportView {
  id: string; entityId: string; trigger: MaterialStatusTrigger;
  baseHead: string; worktreeHead: string; changedPathCount: number; summary: string;
  creator: AuditIdentity; createdAt: string;
}
export interface MaterialStatusReportFilter { entityId?: string; limit: number; offset: number }
/** Formal relation catalog for one comparison target; control fields only, never material content. */
export interface ConsistencyContextView {
  builtinScenario?: { entityId: string; path: '场景/通用场景.md' };
  entity: { id: string; kind: EntityKind; builtinKey?: 'general'; code?: string; title: string; revision: number; materialVersion: number; confirmationStatus: 'draft' | 'confirmed'; occupied: boolean; /** Last accepted project-relative material path, when one exists. */ path?: string };
  sources: Array<{ entityId: string; code?: string; title: string; version: number; confirmationId: string; fixed: FixedReference }>;
  requirements: Array<{ id: string; code?: string; title: string; revision: number; materialVersion: number; confirmationStatus: 'draft' | 'confirmed'; occupied: boolean; path?: string; sources: AssetSource[] }>;
  prerequisites: Array<{ requirementId: string; code?: string; title: string; version: number; confirmationId: string; path?: string }>;
}
