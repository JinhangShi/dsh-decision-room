import { createRoot } from "react-dom/client"
import { ChatSetup } from "./chat-setup.js"
import { App } from "./app.js"

const query = new URLSearchParams(location.search)
const scope = {
  sessionId: query.get("sessionId") ?? "local-preview",
  workspaceId: query.get("workspaceId") ?? "local-preview",
}
const layout = query.get("layout")
createRoot(document.getElementById("root")!).render(
  layout === "chat" || layout === "progress" || layout === "sidebar" ? (
    <ChatSetup scope={scope} progressOnly={layout !== "chat"} />
  ) : (
    <App scope={scope} />
  ),
)
