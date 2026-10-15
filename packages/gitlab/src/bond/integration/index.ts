// The GitLab Integration: webhooks as Events, merge request and issue notes
// as Effects, and the GitLab Loop templates. It depends on the credentials
// port only, never on the Binding beside it.

export {
  makeGitLabClient,
  makeGitLabCredentialsFor,
  type GitLabClient,
  type GitLabCredentialOption,
  type GitLabCredentialResolver,
  type GitLabCredentialSource,
  type GitLabCredentials,
} from "./client.js";
export {
  GITLAB_OPERATIONS,
  makeGitLabDelivery,
  type GitLabEffectOperation,
} from "./delivery.js";
export { GITLAB_EVENT_TYPES, normalizeGitLabEvents } from "./events.js";
export {
  GitLabHttpIngressError,
  GitLabHttpSubmissionError,
  decodeGitLabHttpRequest,
  makeGitLabHttpEndpoint,
  verifyGitLabToken,
  type GitLabHttpEndpointOptions,
  type GitLabWebhookInput,
} from "./http.js";
export {
  makeGitLabIntegration,
  type GitLabIntegrationOptions,
} from "./integration.js";
export {
  gitlabMention,
  gitlabMergeRequestReview,
  gitlabTemplates,
} from "./templates.js";
