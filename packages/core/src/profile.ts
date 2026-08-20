export interface ProfileRef {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export interface BoundDefinitionRef {
  readonly profile: ProfileRef;
  readonly surfaceId: string;
  readonly authorityId: string;
  readonly definitionId: string;
}

export interface OperationRef {
  readonly profile: ProfileRef;
  readonly surfaceId: string;
  readonly authorityId: string;
  readonly operationId: string;
}
