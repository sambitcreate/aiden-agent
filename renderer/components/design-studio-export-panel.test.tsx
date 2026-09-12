import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DesignStudioExportPanel } from "./design-studio-export-panel";
import type { DesignProjectSnapshotV2 } from "../shared/design-projects";
test("export starts with empty explicit scope and no publish actions",()=>{
 const project:DesignProjectSnapshotV2={version:2,id:"p",revision:1,title:"One",titlePolicy:{state:"manual"},chatId:"c",connectionState:"prototype-only",createdAt:1,updatedAt:1,canvas:{viewport:"desktop",flowViewport:{x:0,y:0,zoom:1},nodes:[]},referenceAssetIds:[]};
 const html=renderToStaticMarkup(<DesignStudioExportPanel project={project} disabled={false} screenTitles={{}} workspaces={[]} prepareProject={async()=>project}/>);
 assert.match(html,/<button[^>]*disabled=""[^>]*>Preview project bundle<\/button>/);
 assert.doesNotMatch(html,/Export reviewed ZIP|Continue with reviewed scope/);
 assert.match(html,/aria-label="Export Project Brief"/);
});
