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

/** Bounds on a hostile head. Exceeding one is Malformed, never Incomplete. */
export interface ReceivePackLimits {
  /** Default 1 MiB. */
  readonly maxHeadBytes?: number;
  /** Default 1000. */
  readonly maxCommands?: number;
  /** Default 100. */
  readonly maxOptions?: number;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * A strict subset of `git check-ref-format`: a full `refs/` name with no
 * control characters, no characters git forbids, no empty, dot-leading, or
 * `.lock` components, no `..`, and no `@{`.
 */
export const isValidRefName = (ref: string): boolean => {
  if (!ref.startsWith("refs/") || ref.length > 1024) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref)) return false;
  if (ref.includes("..") || ref.includes("@{") || ref.endsWith(".")) {
    return false;
  }
  return ref
    .split("/")
    .every((c) => c !== "" && !c.startsWith(".") && !c.endsWith(".lock"));
};

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

export interface ReceivePackHeadParser {
  /** Feeds the next chunk of the request body. */
  readonly push: (chunk: Uint8Array) => ReceivePackParse;
  /**
   * Bytes after the head in the chunk that completed it: the start of the
   * pack. Later chunks are not buffered; stream them upstream directly.
   */
  readonly remainder: () => Uint8Array;
}

/**
 * Incremental receive-pack head parser. Each byte is examined once, and only
 * an unfinished pkt-line is buffered, so a head fed in many small chunks
 * costs linear time. Capabilities are the union over every command line, as
 * in git's `read_head`: a client cannot hide `push-options` behind a later
 * line without them.
 */
export const makeReceivePackHeadParser = (
  limits: ReceivePackLimits = {},
): ReceivePackHeadParser => {
  const maxHeadBytes = limits.maxHeadBytes ?? 1024 * 1024;
  const maxCommands = limits.maxCommands ?? 1000;
  const maxOptions = limits.maxOptions ?? 100;
  let pending: Uint8Array = new Uint8Array(0);
  let consumed = 0;
  let phase: "commands" | "options" | "done" = "commands";
  const commands: ReceivePackCommand[] = [];
  const capabilities = new Set<string>();
  const options: string[] = [];
  let result: ReceivePackParse = { _tag: "Incomplete" };

  const malformed = (reason: string): ReceivePackParse => {
    result = { _tag: "Malformed", reason };
    phase = "done";
    return result;
  };

  const complete = (): ReceivePackParse => {
    phase = "done";
    result = {
      _tag: "Complete",
      head: {
        commands,
        capabilities: [...capabilities],
        options,
        headLength: consumed,
      },
    };
    return result;
  };

  /** One pkt-line: text, null for a flush, undefined when more bytes are needed. */
  const nextPkt = (): string | null | undefined | ReceivePackParse => {
    if (pending.length < 4) return undefined;
    let lenText: string;
    try {
      lenText = decoder.decode(pending.subarray(0, 4));
    } catch {
      return malformed("bad pkt-line length");
    }
    if (!/^[0-9a-f]{4}$/i.test(lenText))
      return malformed("bad pkt-line length");
    const len = Number.parseInt(lenText, 16);
    if (len === 0) {
      pending = pending.subarray(4);
      consumed += 4;
      return null;
    }
    if (len < 4) return malformed("bad pkt-line length");
    if (pending.length < len) return undefined;
    let line: string;
    try {
      line = decoder.decode(pending.subarray(4, len));
    } catch {
      return malformed("pkt-line is not valid UTF-8");
    }
    pending = pending.subarray(len);
    consumed += len;
    return line.endsWith("\n") ? line.slice(0, -1) : line;
  };

  const step = (): ReceivePackParse => {
    for (;;) {
      const pkt = nextPkt();
      if (pkt === undefined) {
        return consumed + pending.length > maxHeadBytes
          ? malformed("receive-pack head is too large")
          : result;
      }
      if (typeof pkt === "object" && pkt !== null) return pkt;
      if (phase === "commands") {
        if (pkt === null) {
          if (commands.length === 0) {
            return malformed("no receive-pack commands");
          }
          if (!capabilities.has("push-options")) return complete();
          phase = "options";
          continue;
        }
        if (pkt.startsWith("shallow ")) continue;
        const nul = pkt.indexOf("\0");
        const command = nul === -1 ? pkt : pkt.slice(0, nul);
        if (nul !== -1) {
          for (const cap of pkt.slice(nul + 1).split(" ")) {
            if (cap !== "") capabilities.add(cap);
          }
        }
        const [oldId, newId, ref, extra] = command.split(" ");
        if (
          oldId === undefined ||
          newId === undefined ||
          ref === undefined ||
          extra !== undefined ||
          !OID.test(oldId) ||
          !OID.test(newId)
        ) {
          return malformed("bad receive-pack command");
        }
        if (!isValidRefName(ref)) return malformed("invalid ref name");
        if (commands.length >= maxCommands) {
          return malformed("too many receive-pack commands");
        }
        commands.push({ oldId, newId, ref });
        continue;
      }
      // Push options.
      if (pkt === null) return complete();
      if (options.length >= maxOptions)
        return malformed("too many push options");
      options.push(pkt);
    }
  };

  return {
    push: (chunk) => {
      if (phase === "done") return result;
      pending = concat(pending, chunk);
      return step();
    },
    remainder: () => (phase === "done" ? pending : new Uint8Array(0)),
  };
};

/**
 * Parses as much of the receive-pack head as `bytes` holds. A convenience
 * for a buffered prefix; streaming proxies should use
 * `makeReceivePackHeadParser` and feed chunks as they arrive.
 */
export const parseReceivePackHead = (
  bytes: Uint8Array,
  limits?: ReceivePackLimits,
): ReceivePackParse => makeReceivePackHeadParser(limits).push(bytes);

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
