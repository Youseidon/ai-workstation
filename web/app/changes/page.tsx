import { ChangesIndex } from "@/components/changes/ChangesView";
import { PageChrome } from "@/components/shell/chrome";

export default function ChangesPage(){return <main className="flex h-full flex-col bg-surface-0 text-fg"><PageChrome title="Changes"/><div className="min-h-0 flex-1 overflow-y-auto"><ChangesIndex/></div></main>;}
