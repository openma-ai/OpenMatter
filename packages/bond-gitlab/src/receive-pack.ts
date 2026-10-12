// git-receive-pack request head parsing and push policy. The head is the
// pkt-line command list and optional push options that precede the pack, so
// a proxy can decide before streaming the pack upstream.

export const ZERO_OID = "0".repeat(40);

export interface ReceivePackCommand {
  readonly oldId: string;
  readonly newId: string;
  readonly ref: string;
}

export interface ReceivePackHead {
  readonly commands: readonly ReceivePackCommand[];
  readonly capabilities: readonly string[];
  readonly options: readonly string[];
  /** Bytes consumed by the head. The pack starts here. */
  readonly headLength: number;
}

export type ReceivePackParse =
  | { readonly _tag: "Complete"; readonly head: ReceivePackHead }
  | { readonly _tag: "Incomplete" }
  | { readonly _tag: "Malformed"; readonly reason: string };

const decoder = new TextDecoder();
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Parses as much of the receive-pack head as `bytes` holds. Feed it the
 * buffered prefix of the request body until it returns Complete or
 * Malformed. It never reads the pack itself.
 */
export const parseReceivePackHead = (bytes: Uint8Array): ReceivePackParse => {
  let offset = 0;
  const readPkt = (): string | null | undefined | false => {
    if (bytes.length < offset + 4) return undefined;
    const lenText = decoder.decode(bytes.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/i.test(lenText)) return false;
    const len = Number.parseInt(lenText, 16);
    if (len === 0) {
      offset += 4;
      return null;
    }
    if (len < 4) return false;
    if (bytes.length < offset + len) return undefined;
    const line = decoder
      .decode(bytes.subarray(offset + 4, offset + len))
      .replace(/\n$/, "");
    offset += len;
    return line;
  };

  const commands: ReceivePackCommand[] = [];
  let capabilities: string[] = [];
  for (;;) {
    const line = readPkt();
    if (line === undefined) return { _tag: "Incomplete" };
    if (line === false)
      return { _tag: "Malformed", reason: "bad pkt-line length" };
    if (line === null) break;
    if (line.startsWith("shallow ")) continue;
    const nul = line.indexOf("\0");
    const command = nul === -1 ? line : line.slice(0, nul);
    if (nul !== -1) {
      capabilities = line
        .slice(nul + 1)
        .trim()
        .split(" ")
        .filter(Boolean);
    }
    const [oldId, newId, ref, extra] = command.split(" ");
    if (
      oldId === undefined ||
      newId === undefined ||
      ref === undefined ||
      extra !== undefined ||
      !OID.test(oldId) ||
      !OID.test(newId) ||
      !ref.startsWith("refs/")
    ) {
      return { _tag: "Malformed", reason: "bad receive-pack command" };
    }
    commands.push({ oldId, newId, ref });
  }
  if (commands.length === 0) {
    return { _tag: "Malformed", reason: "no receive-pack commands" };
  }
  const options: string[] = [];
  if (capabilities.includes("push-options")) {
    for (;;) {
      const line = readPkt();
      if (line === undefined) return { _tag: "Incomplete" };
      if (line === false)
        return { _tag: "Malformed", reason: "bad pkt-line length" };
      if (line === null) break;
      options.push(line);
    }
  }
  return {
    _tag: "Complete",
    head: { commands, capabilities, options, headLength: offset },
  };
};

export interface PushPolicy {
  /** The project's default branch name, refreshed from GitLab by project ID. */
  readonly defaultBranch: string;
  /** Allow pushing to the default branch. Default false. */
  readonly allowDefaultBranch?: boolean;
  /** Only branches with this prefix may be updated, when set. */
  readonly branchPrefix?: string;
  /** Label every merge request created by push option must carry. */
  readonly requiredMergeRequestLabel: string;
  /** Whether `merge_request.*` options are allowed at all (the `open_mr` grant). */
  readonly allowMergeRequestOptions: boolean;
}

const MERGE_REQUEST_OPTIONS = [
  /^merge_request\.create$/,
  /^merge_request\.target=[\w./-]{1,255}$/,
  /^merge_request\.title=.{1,255}$/s,
  /^merge_request\.description=.{0,10000}$/s,
  /^merge_request\.label=[\w.:-]{1,100}$/,
  /^merge_request\.remove_source_branch$/,
  /^merge_request\.draft$/,
];

/**
 * Returns the reason a push is denied, or undefined when it is allowed.
 * Denies tags and other non-branch refs, deletions, the default branch, and
 * any push option outside the merge request allow-list. GitLab still applies
 * its own branch protection afterwards.
 */
export const evaluatePush = (
  head: ReceivePackHead,
  policy: PushPolicy,
): string | undefined => {
  for (const c of head.commands) {
    if (!c.ref.startsWith("refs/heads/")) return `ref ${c.ref} is not a branch`;
    if (/^0+$/.test(c.newId)) return `deleting ${c.ref} is not allowed`;
    const branch = c.ref.slice("refs/heads/".length);
    if (branch === policy.defaultBranch && policy.allowDefaultBranch !== true) {
      return "pushing to the default branch is not allowed";
    }
    if (
      policy.branchPrefix !== undefined &&
      !branch.startsWith(policy.branchPrefix)
    ) {
      return `branch ${branch} is outside ${policy.branchPrefix}`;
    }
  }
  for (const option of head.options) {
    const name = option.split("=")[0] ?? option;
    if (
      !policy.allowMergeRequestOptions ||
      !MERGE_REQUEST_OPTIONS.some((re) => re.test(option))
    ) {
      return `push option ${name} is not allowed`;
    }
  }
  if (
    head.options.includes("merge_request.create") &&
    !head.options.includes(
      `merge_request.label=${policy.requiredMergeRequestLabel}`,
    )
  ) {
    return `merge requests must carry merge_request.label=${policy.requiredMergeRequestLabel}`;
  }
  return undefined;
};
