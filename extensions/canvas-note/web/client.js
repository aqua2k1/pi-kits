import { createDocumentView } from "./document-view.js";
import { startOnlineController } from "./online-controller.js";

// Only a nonblank payload selects static mode; the common template is online.
const data = document.getElementById("document-data")?.textContent?.trim();
const payload = data ? JSON.parse(data) : null;
const staticMode = !!data;
document.documentElement.dataset.mode = staticMode ? "static" : "online";
const events = {};
const view = createDocumentView({
  staticMode,
  initialView: payload?.view,
  resources: payload?.resources,
  events,
});
if (staticMode) {
  document.title = payload.title || "Canvas Note";
  document.getElementById("document-id").textContent = payload.documentId || "";
  view.reconcile(payload.doc);
} else {
  startOnlineController(view, events);
}
