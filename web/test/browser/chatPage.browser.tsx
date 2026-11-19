import { createRoot } from "react-dom/client";
import Page from "@/app/page";
import { AppShell } from "@/components/shell/AppShell";
import { ToastProvider } from "@/components/ui/Toast";
import { DialogProvider } from "@/components/ui/Dialogs";
createRoot(document.getElementById("root")!).render(<ToastProvider><DialogProvider><AppShell><Page /></AppShell></DialogProvider></ToastProvider>);
