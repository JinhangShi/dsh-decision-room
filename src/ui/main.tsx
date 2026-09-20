import { createRoot } from "react-dom/client"
import { App } from "./app.js"

const query = new URLSearchParams(location.search)
const scope = {
  sessionId: query.get("sessionId") ?? "local-preview",
  workspaceId: query.get("workspaceId") ?? "local-preview",
}
createRoot(document.getElementById("root")!).render(<App scope={scope} sidebar={query.get("layout") === "sidebar"} />)
