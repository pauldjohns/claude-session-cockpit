/**
 * Plain-English renderings of the API's refusal `reason` codes. the user is not a developer and must
 * never see a raw reason string or a stack trace — every branch here is a full sentence.
 */

export interface RefusalView {
  message: string;
  /** Show `detail` (small, muted) underneath the message when present. */
  showDetail: boolean;
  /** The `alive` case: a prominent "Open it in Claude" button, not an error box. */
  prominentJump: boolean;
}

/** POST /api/sessions/[id]/continue refusal reasons (guard reasons, bad-request, spawn-failed, + any unknown). */
export function refusalView(reason: string): RefusalView {
  switch (reason) {
    case "alive":
      return {
        message: "This session is open in Claude right now. Writing to it would split the conversation.",
        showDetail: false,
        prominentJump: true,
      };
    case "busy":
      return {
        message: "Another message to this session is still going. Wait for it to finish.",
        showDetail: false,
        prominentJump: false,
      };
    case "transcript-changed":
      return {
        message: "The session changed while I was checking. Nothing was written. Try again.",
        showDetail: false,
        prominentJump: false,
      };
    case "missing-cwd":
      return {
        message: "This session's folder no longer exists, so it can't be continued.",
        showDetail: false,
        prominentJump: false,
      };
    case "unresolvable":
      return {
        message: "Could not confirm nothing else is using this session right now.",
        showDetail: true,
        prominentJump: false,
      };
    case "missing-transcript":
      return {
        message: "Could not find this session's saved conversation.",
        showDetail: true,
        prominentJump: false,
      };
    case "spawn-failed":
      return {
        message: "Claude could not be started to answer this.",
        showDetail: true,
        prominentJump: false,
      };
    case "bad-request":
      return {
        message: "That message could not be sent as written.",
        showDetail: true,
        prominentJump: false,
      };
    default:
      return {
        message: "Something went wrong sending that message.",
        showDetail: true,
        prominentJump: false,
      };
  }
}

/** POST /api/dispatch refusal reasons ('missing-cwd' | 'bad-request' | 'spawn-failed', + any unknown). */
export function dispatchRefusalMessage(reason: string): string {
  switch (reason) {
    case "missing-cwd":
      return "That folder doesn't exist anymore. Pick another project.";
    case "bad-request":
      return "Enter a prompt before starting.";
    case "spawn-failed":
      return "Claude could not be started.";
    default:
      return "Could not start that session.";
  }
}
