import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DesignLanguagePanel } from "./design-language-panel";
import type { DesignProjectSnapshotV2 } from "../shared/design-projects";
const project:DesignProjectSnapshotV2={version:2,id:"project:one",revision:1,title:"One",titlePolicy:{state:"manual"},chatId:"chat:one",connectionState:"prototype-only",createdAt:1,updatedAt:1,canvas:{viewport:"desktop",flowViewport:{x:0,y:0,zoom:1},nodes:[]},referenceAssetIds:[]};
test("prototype projects can author and import language without workspace authority",()=>{
  const html=renderToStaticMarkup(<DesignLanguagePanel project={project} disabled={false} prepareProject={async()=>project} onProjectChange={()=>{}}/>);
  assert.match(html,/Design Language · None applied/);
  assert.match(html,/Preview description/);
  assert.match(html,/Import DESIGN.md/);
  assert.match(html,/aria-label="Design Language description"/);
  assert.doesNotMatch(html,/Save reviewed language/);
});
