/**
 * CommonMark (what the model writes) -> Slack mrkdwn (what Slack renders).
 *
 * These are different languages that happen to look alike, and the overlaps are
 * the dangerous part: `*text*` is bold in CommonMark and italic in Slack, so
 * passing model output through untouched silently changes emphasis everywhere.
 *
 * Code spans and fenced blocks are passed through untouched — a converter that
 * rewrites the inside of a shell snippet is worse than no converter.
 */
/**
 * Sentinels for constructs converted early and restored last, so the
 * single-asterisk italic pass cannot see what the bold pass just produced.
 *
 * Private Use Area code points, not readable text: a sentinel spelled with
 * ordinary characters would corrupt any message that happened to contain that
 * same sequence. Stripped from input so they cannot be injected either.
 */
const BOLD_OPEN = "\uE000";
const BOLD_CLOSE = "\uE001";
const STRIKE_OPEN = "\uE002";
const STRIKE_CLOSE = "\uE003";
const SENTINELS = /[\uE000-\uE003]/g;
/** Matches a fenced block or an inline code span, as a capture so split() keeps it. */
const CODE_SEGMENT = /(```[\s\S]*?```|`[^`\n]+`)/;
export function toMrkdwn(markdown) {
    const withTables = tablesToCodeBlocks(markdown.replace(SENTINELS, ""));
    // Odd indices are code (the capture group); leave those exactly as they are.
    return withTables
        .split(CODE_SEGMENT)
        .map((segment, index) => (index % 2 === 1 ? segment : convertText(segment)))
        .join("");
}
function convertText(text) {
    let out = text;
    // Escape Slack's control characters first, so anything the model wrote
    // literally survives. `>` at the start of a line is left alone because that
    // is Slack's blockquote and CommonMark's, spelled the same way.
    out = out.replace(/&/g, "&amp;");
    out = out.replace(/</g, "&lt;");
    out = out.replace(/(^|[^\n])>/g, (_match, before) => before === "" ? ">" : `${before}&gt;`);
    // Links, before emphasis, so URL punctuation is never treated as markup.
    // Images degrade to plain links; Slack has no inline image in mrkdwn.
    out = out.replace(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, label, url) => label.trim() ? `<${url}|${label.trim()}>` : `<${url}>`);
    // Bold and strikethrough become sentinels now and real markup at the end,
    // so the single-asterisk italic pass below cannot see the output of this one.
    out = out.replace(/\*\*([^\n*]+)\*\*/g, (_m, inner) => `${BOLD_OPEN}${inner}${BOLD_CLOSE}`);
    out = out.replace(/__([^\n_]+)__/g, (_m, inner) => `${BOLD_OPEN}${inner}${BOLD_CLOSE}`);
    out = out.replace(/~~([^\n~]+)~~/g, (_m, inner) => `${STRIKE_OPEN}${inner}${STRIKE_CLOSE}`);
    // Headings have no equivalent; bold on its own line is the closest Slack gets.
    out = out.replace(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, (_m, title) => `${BOLD_OPEN}${title}${BOLD_CLOSE}`);
    // Remaining single-asterisk emphasis is CommonMark italic, which is `_` here.
    out = out.replace(/(^|[^*\w])\*([^\n*]+)\*(?![*\w])/g, "$1_$2_");
    // Bullets. Slack renders `-` literally, so use a real bullet character.
    out = out.replace(/^(\s*)[-*+]\s+/gm, "$1• ");
    // Horizontal rules have no equivalent either.
    out = out.replace(/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "──────────");
    return out
        .replaceAll(BOLD_OPEN, "*")
        .replaceAll(BOLD_CLOSE, "*")
        .replaceAll(STRIKE_OPEN, "~")
        .replaceAll(STRIKE_CLOSE, "~");
}
/**
 * Slack mrkdwn has no tables. Rendered as prose a pipe table becomes unreadable,
 * so wrap it in a code fence — monospace at least keeps the columns aligned.
 */
function tablesToCodeBlocks(markdown) {
    const lines = markdown.split("\n");
    const out = [];
    let index = 0;
    while (index < lines.length) {
        const line = lines[index] ?? "";
        const next = lines[index + 1];
        const looksLikeHeader = line.trim().startsWith("|") && line.includes("|");
        const looksLikeDivider = next !== undefined && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(next) && next.includes("-");
        if (looksLikeHeader && looksLikeDivider) {
            const block = [];
            while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) {
                block.push(lines[index] ?? "");
                index += 1;
            }
            out.push("```", ...block, "```");
            continue;
        }
        out.push(line);
        index += 1;
    }
    return out.join("\n");
}
/**
 * Split a long message into Slack-sized chunks, preferring paragraph breaks and
 * never cutting inside a fenced code block — a half-open fence would swallow
 * the formatting of everything after it.
 */
export function splitMessage(text, limit = 3800) {
    if (text.length <= limit)
        return [text];
    const chunks = [];
    let current = "";
    let fenceOpen = false;
    const flush = () => {
        if (!current.trim()) {
            current = "";
            return;
        }
        chunks.push(fenceOpen ? `${current}\n\`\`\`` : current);
        current = fenceOpen ? "```\n" : "";
    };
    for (const line of text.split("\n")) {
        if (current.length + line.length + 1 > limit)
            flush();
        current += (current ? "\n" : "") + line;
        if (line.trimStart().startsWith("```"))
            fenceOpen = !fenceOpen;
    }
    if (current.trim())
        chunks.push(current);
    return chunks.length > 0 ? chunks : [text.slice(0, limit)];
}
//# sourceMappingURL=mrkdwn.js.map