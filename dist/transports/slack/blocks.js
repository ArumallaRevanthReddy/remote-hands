export const APPROVE_ACTION = "rh_approve";
export const DENY_ACTION = "rh_deny";
/**
 * The message a person actually decides on.
 *
 * The command is shown verbatim in a code block and never summarised: the
 * whole value of this step is that a human sees exactly what will run. A
 * paraphrase would let something through on the strength of a description
 * rather than the thing itself.
 */
export function approvalBlocks(request, approvalId) {
    return [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: `:lock: *Approval needed* — ${request.reason}`,
            },
        },
        {
            type: "section",
            text: { type: "mrkdwn", text: codeBlock(request.detail || request.tool) },
        },
        {
            type: "actions",
            block_id: `rh_approval:${approvalId}`,
            elements: [
                {
                    type: "button",
                    action_id: APPROVE_ACTION,
                    style: "primary",
                    text: { type: "plain_text", text: "Approve" },
                    value: approvalId,
                },
                {
                    type: "button",
                    action_id: DENY_ACTION,
                    style: "danger",
                    text: { type: "plain_text", text: "Deny" },
                    value: approvalId,
                },
            ],
        },
    ];
}
/**
 * Replaces the buttons once a decision exists, so the thread reads as a record
 * of what was decided rather than a row of buttons that no longer do anything.
 */
export function resolvedBlocks(request, resolution) {
    return [
        {
            type: "section",
            text: { type: "mrkdwn", text: headline(resolution) },
        },
        {
            type: "section",
            text: { type: "mrkdwn", text: codeBlock(request.detail || request.tool) },
        },
    ];
}
export function headline(resolution) {
    switch (resolution.type) {
        case "approved":
            return `:white_check_mark: *Approved* by <@${resolution.by}>`;
        case "denied":
            return `:no_entry: *Denied* by <@${resolution.by}>`;
        case "expired":
            return ":hourglass: *Expired* — nobody answered, so it was not run";
        case "lost":
            return (":ghost: *No longer pending* — remote-hands restarted after this was " +
                "asked, so the run it belonged to is gone");
    }
}
/** Plain-text fallback, used for notifications and accessibility. */
export function approvalFallback(request) {
    return `Approval needed: ${request.tool} ${request.detail}`.trim();
}
/**
 * Fences are stripped rather than escaped: a stray ``` inside the command would
 * end the block early and hide the rest of what is about to run.
 */
function codeBlock(text) {
    return `\`\`\`\n${text.replaceAll("```", "'''")}\n\`\`\``;
}
//# sourceMappingURL=blocks.js.map