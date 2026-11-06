import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppIdentityBridge } from "@hosty-sdk/app/react";
import { appFetch } from "@hosty-sdk/app/browser-auth";

function App() {
  const [app, setApp] = useState<{ name: string; description?: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { appFetch("/api/app").then(async r => {
    if (!r.ok) throw new Error("App is unavailable. Reload to retry.");
    setApp(await r.json());
  }).catch(e => setError(e.message)); }, []);
  return <main style={{ maxWidth: 720, margin: "10vh auto", padding: 24 }}>
    <p>Local preview</p><h1>{app?.name ?? "Your application"}</h1>
    <p>{error || app?.description || "The workspace is ready. Ask your assistant to build your application."}</p>
    <p>This preview uses its own Hosty users and application data.</p>
  </main>;
}
createRoot(document.getElementById("root")!).render(<AppIdentityBridge><App /></AppIdentityBridge>);
