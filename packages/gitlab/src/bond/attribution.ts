// Pure attribution helpers. GitLab merge requests have no delegation marker,
// so output carries a content marker that names the application
// (docs/IDENTITY_MODEL.md).

export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

/** The commit author for a GitLab user: their name and `commit_email`. */
export const commitAuthor = (user: {
  readonly name: string;
  readonly username: string;
  readonly commitEmail?: string;
}): CommitIdentity => {
  if (user.commitEmail === undefined) {
    throw new Error(`GitLab user ${user.username} has no commit email`);
  }
  return { name: user.name || user.username, email: user.commitEmail };
};

const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

/** `Assisted-by: <app> <session URL>`, added to every commit. */
export const assistedByTrailer = (
  appName: string,
  sessionUrl: string,
): string => `Assisted-by: ${oneLine(appName)} <${oneLine(sessionUrl)}>`;

/** `Co-authored-by` for a participant or, with the app principal, the requester. */
export const coAuthoredByTrailer = (who: CommitIdentity): string =>
  `Co-authored-by: ${oneLine(who.name)} <${oneLine(who.email)}>`;

/** Description footer for merge requests and comments. */
export const mergeRequestFooter = (input: {
  readonly appName: string;
  readonly sessionUrl: string;
  /** Username of the requesting user; set when the app principal authors. */
  readonly requestedBy?: string;
}): string =>
  [
    "---",
    input.requestedBy === undefined
      ? `Opened through ${oneLine(input.appName)}: ${oneLine(input.sessionUrl)}`
      : `Requested by @${oneLine(input.requestedBy)} via ${oneLine(input.appName)}: ${oneLine(input.sessionUrl)}`,
  ].join("\n");

/** `git push -o` options that create a labelled merge request. */
export const mergeRequestPushOptions = (input: {
  readonly target: string;
  readonly title: string;
  readonly description: string;
  readonly label: string;
}): readonly string[] => [
  "merge_request.create",
  `merge_request.target=${input.target}`,
  `merge_request.title=${oneLine(input.title)}`,
  // git rejects push options that contain a newline.
  `merge_request.description=${oneLine(input.description)}`,
  `merge_request.label=${input.label}`,
];
