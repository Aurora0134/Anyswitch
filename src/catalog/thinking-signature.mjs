// The signature Claude clients require on a thinking block before showing it.
//
// The two surfaces that render thinking — the Claude Desktop transcript
// loader and the bundled Claude Code CLI — keep a thinking block only when
// its `signature` is a non-empty string that base64-decodes to a protobuf
// message whose field 2 -> field 1 -> field 8 chain spells "narration", the
// kind marker the official backend stamps on API-side thinking summaries
// (redacted_thinking is dropped outright). The check is structural: no
// cryptographic verification, no binding to the thinking text, unknown
// fields ignored — but the whole buffer must parse cleanly to the end, so
// the constant is exactly one minimal message and nothing more.
//
// An OpenAI-compatible gateway cannot mint Anthropic signatures, so its
// reasoning arrives unsigned and every client filter silently drops the
// block. This constant is the minimal structure that passes. It is
// deliberately content-free: the signed block never travels back upstream
// (the request converter drops inbound thinking blocks), so there is
// nothing for an upstream to verify or reject.
export const NARRATION_THINKING_SIGNATURE = "Eg0KC0IJbmFycmF0aW9u";
