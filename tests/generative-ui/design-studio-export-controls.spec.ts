import playwrightTest from "@playwright/test";
import type * as PlaywrightTestModule from "@playwright/test";
const {test,expect}=playwrightTest as unknown as typeof PlaywrightTestModule;
import { build } from "esbuild";
import path from "node:path";

test("same-project changes reconcile reviewed export selection and workspace",async({page})=>{
  const root=path.resolve(import.meta.dirname,"../..");
  const bundle=await build({stdin:{contents:`
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {DesignStudioExportPanel} from './renderer/components/design-studio-export-panel';
    import {designerApi} from './renderer/lib/ipc';
    let project={version:2,id:'project:one',revision:1,title:'One',titlePolicy:{state:'manual'},chatId:'chat:one',connectionState:'prototype-only',createdAt:1,updatedAt:1,referenceAssetIds:[],activeDesignLanguage:{id:'language:one',revision:1,contentHash:'a'.repeat(64)},canvas:{viewport:'desktop',flowViewport:{x:0,y:0,zoom:1},nodes:[{kind:'artboard',canonicalOrigin:'generated-artifact',id:'node:a',lineageId:'lineage:a',activeMediaId:'design:old',artifactMediaIds:['design:old'],x:0,y:0,presentation:{surface:'web',frame:{preset:'desktop',width:1000,height:800}}}]}};
    designerApi.previewStudioExport=async request=>{window.lastScope=request;return {projectRevision:project.revision,reviewDigest:'a'.repeat(64),fileName:'one.zip',entryPaths:[],manifestJson:'{}',briefMarkdown:'Brief',designMarkdown:'Language',byteSize:10}};
    const target=createRoot(document.getElementById('root'));
    function render(){target.render(<DesignStudioExportPanel project={project} disabled={false} screenTitles={{'design:old':'Old Screen','design:new':'New Screen'}} workspaces={[{id:'workspace:one',name:'Connected app'}]} prepareProject={async()=>project}/>)}
    window.changeProject=()=>{project={...project,revision:2,activeDesignLanguage:undefined,connectionState:'connected',workspaceId:'workspace:one',canvas:{...project.canvas,nodes:project.canvas.nodes.map(node=>({...node,activeMediaId:'design:new',artifactMediaIds:['design:old','design:new']}))}};render()};render();
  `,resolveDir:root,loader:"tsx"},bundle:true,format:"iife",platform:"browser",write:false,define:{"process.env.NODE_ENV":'"test"'}});
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({content:bundle.outputFiles[0]!.text});
  await page.getByText("Export and handoff",{exact:true}).click();
  await page.getByText("Screens (0/20)",{exact:true}).click();
  await page.getByLabel("Old Screen",{exact:true}).check();
  await page.getByLabel("Include applied Design Language",{exact:true}).check();
  await page.getByRole("button",{name:"Preview project bundle",exact:true}).click();
  await expect(page.getByRole("region",{name:"Reviewed project bundle"})).toBeVisible();
  await page.evaluate(()=>{(window as unknown as {changeProject:()=>void}).changeProject();});
  await expect(page.getByRole("region",{name:"Reviewed project bundle"})).toHaveCount(0);
  await expect(page.getByLabel("Include applied Design Language",{exact:true})).not.toBeChecked();
  await expect(page.getByRole("button",{name:"Preview project bundle",exact:true})).toBeDisabled();
  await page.getByLabel("New Screen",{exact:true}).check();
  await page.getByRole("button",{name:"Preview project bundle",exact:true}).click();
  const scope=await page.evaluate(()=>(window as unknown as {lastScope:{mediaIds:string[];includeLanguage:boolean}}).lastScope);
  expect(scope.mediaIds).toEqual(["design:new"]);expect(scope.includeLanguage).toBe(false);
  await expect(page.getByLabel("Handoff workspace")).toHaveValue("workspace:one");
  await expect(page.getByRole("button",{name:"Review workspace handoff",exact:true})).toBeEnabled();
});
