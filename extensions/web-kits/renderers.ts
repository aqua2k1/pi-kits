import {
  compactCall,
  compactResult,
  record,
} from "../../shared/ui/renderers.ts";

export const renderSearchCall = compactCall("Web Search", (args) => {
  const query = record(args).query;
  return typeof query === "string" ? query : "";
});
export const renderSearchResult = compactResult((details) => {
  const data = record(details);
  if (typeof data.resultCount !== "number" || !Array.isArray(data.results))
    return;
  const first = record(data.results[0]);
  return {
    status: `completed · ${data.resultCount} results`,
    preview:
      typeof first.title === "string"
        ? first.title
        : data.hasSummary
          ? "Summary available"
          : "No results",
    truncated: data.truncated === true,
  };
});
export const renderFetchCall = compactCall("Web Fetch", (args) => {
  const url = record(args).url;
  if (typeof url !== "string") return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "Invalid URL";
  }
});
export const renderFetchResult = compactResult((details) => {
  const data = record(details);
  const savedContent = record(data.savedContent);
  if (typeof savedContent.path !== "string") return;
  return {
    status: "completed",
    preview:
      typeof data.title === "string"
        ? data.title
        : typeof data.finalUrl === "string"
          ? data.finalUrl
          : "Content saved",
    truncated: savedContent.truncated === true,
  };
});
