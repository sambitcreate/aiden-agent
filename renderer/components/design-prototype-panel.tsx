import * as React from "react";
import type { DesignProjectSnapshot } from "../shared/design-projects";
import { designPrototypeStatus, type DesignPrototypeEdgeV1 } from "../shared/design-prototype";
import { designerApi } from "../lib/ipc";
import { Button, Text } from "./ui";

export function DesignPrototypePanel({ project, disabled, screenTitles, prepareProject, onProjectChange }: {
  project: DesignProjectSnapshot;
  disabled: boolean;
  screenTitles: Record<string,string>;
  prepareProject: () => Promise<DesignProjectSnapshot>;
  onProjectChange: (project:DesignProjectSnapshot) => void;
}) {
  const screens=project.canvas.nodes.filter(node=>node.kind==="artboard");
  const graph=project.version===2?project.prototype:undefined;
  const status=graph&&project.version===2?designPrototypeStatus(graph,project.canvas):"No prototype";
  const [edges,setEdges]=React.useState<DesignPrototypeEdgeV1[]>(graph?.edges??[]);
  const [included,setIncluded]=React.useState<string[]>(graph?.nodes.map(node=>node.mediaId)??screens.slice(0,20).map(node=>node.activeMediaId!));
  const [entry,setEntry]=React.useState(graph?.entryMediaId??"");
  const entryMediaId=included.includes(entry)?entry:included[0]??"";
  const [from,setFrom]=React.useState("");
  const [to,setTo]=React.useState("");
  const [trigger,setTrigger]=React.useState<DesignPrototypeEdgeV1["trigger"]>("click");
  const [selector,setSelector]=React.useState("");
  const [key,setKey]=React.useState("Enter");
  const [transition,setTransition]=React.useState<"none"|"fade">("none");
  const [dirty,setDirty]=React.useState(false);
  const [busy,setBusy]=React.useState(false);
  const [error,setError]=React.useState<string>();
  const source=from||included[0]||"";
  const destination=to||included[1]||included[0]||"";
  const title=(mediaId:string)=>screenTitles[mediaId]??`Screen ${screens.findIndex(node=>node.activeMediaId===mediaId)+1}`;
  const act=async(action:()=>Promise<void>)=>{setBusy(true);setError(undefined);try{await action();}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setBusy(false);}};
  const adopt=(next:DesignProjectSnapshot)=>{onProjectChange(next);if(next.version===2&&next.prototype){setEntry(next.prototype.entryMediaId);setEdges(next.prototype.edges);setIncluded(next.prototype.nodes.map(node=>node.mediaId));}setDirty(false);};
  return <details className="px-3 py-2" aria-label="Project prototype">
    <summary className="cursor-pointer text-small-strong">Prototype · {status}</summary>
    <div className="mt-2 space-y-2">
      <Text as="p" variant="small" color="secondary">Link exact Screen revisions. Verification checks the links in a sandbox before Play becomes available.</Text>
      <fieldset disabled={disabled||busy} className="space-y-2">
        <details><summary className="cursor-pointer text-small text-secondary">Included screens ({included.length}/20)</summary>
          {screens.map((screen,index)=><label key={screen.id} className="flex items-center gap-2 text-small text-secondary"><input type="checkbox" checked={included.includes(screen.activeMediaId!)} disabled={!included.includes(screen.activeMediaId!)&&included.length>=20} onChange={e=>{const id=screen.activeMediaId!;setIncluded(current=>e.target.checked?[...current,id]:current.filter(item=>item!==id));setEdges(current=>current.filter(edge=>e.target.checked||(edge.fromMediaId!==id&&edge.toMediaId!==id)));setFrom("");setTo("");setDirty(true);}}/>{screenTitles[screen.activeMediaId!]??`Screen ${index+1}`}</label>)}
        </details>
        <label className="block text-small text-secondary">Start Screen <select aria-label="Prototype start Screen" className="max-w-full rounded-control bg-control p-1 text-primary" value={entryMediaId} onChange={e=>{setEntry(e.target.value);setDirty(true);}}>{included.map(id=><option key={id} value={id}>{title(id)}</option>)}</select></label>
        <div className="flex flex-wrap gap-2">
          <label className="text-small text-secondary">From <select aria-label="Prototype source Screen" className="max-w-full rounded-control bg-control p-1 text-primary" value={source} onChange={e=>setFrom(e.target.value)}>{included.map(id=><option key={id} value={id}>{title(id)}</option>)}</select></label>
          <label className="text-small text-secondary">To <select aria-label="Prototype destination Screen" className="max-w-full rounded-control bg-control p-1 text-primary" value={destination} onChange={e=>setTo(e.target.value)}>{included.map(id=><option key={id} value={id}>{title(id)}</option>)}</select></label>
          <label className="text-small text-secondary">Trigger <select aria-label="Prototype trigger" className="rounded-control bg-control p-1 text-primary" value={trigger} onChange={e=>setTrigger(e.target.value as DesignPrototypeEdgeV1["trigger"])}>{["click","submit","change","keydown"].map(value=><option key={value}>{value}</option>)}</select></label>
        </div>
        <label className="block text-small text-secondary">Element<input aria-label="Prototype element selector" className="mt-1 w-full rounded-control bg-control p-2 text-primary" placeholder={'#continue or [data-aiden-id="continue"]'} value={selector} maxLength={128} onChange={e=>setSelector(e.target.value)}/></label>
        {trigger==="keydown"?<label className="block text-small text-secondary">Key <select aria-label="Prototype key" className="rounded-control bg-control p-1 text-primary" value={key} onChange={e=>setKey(e.target.value)}>{["Enter"," ","Escape","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].map(value=><option key={value} value={value}>{value===" "?"Space":value}</option>)}</select></label>:null}
        <label className="block text-small text-secondary">Transition <select aria-label="Prototype transition" className="rounded-control bg-control p-1 text-primary" value={transition} onChange={e=>setTransition(e.target.value as "none"|"fade")}><option value="none">None</option><option value="fade">Fade</option></select></label>
        <Button size="small" variant="transparent" disabled={!source||!destination||!selector.trim()||edges.length>=40} onClick={()=>{setEdges(current=>[...current,{id:crypto.randomUUID(),fromMediaId:source,toMediaId:destination,trigger,selector:selector.trim(),...(trigger==="keydown"?{key}:{}),transition}]);setDirty(true);}}>Add link</Button>
        <ol className="max-h-40 space-y-1 overflow-auto">{edges.map((edge,index)=><li key={edge.id} className="flex items-center gap-1"><Text variant="small" className="min-w-0 flex-1">{title(edge.fromMediaId)} → {title(edge.toMediaId)} · {edge.trigger}</Text><Button size="small" variant="transparent" aria-label={`Remove prototype link ${index+1}`} onClick={()=>{setEdges(current=>current.filter(item=>item.id!==edge.id));setDirty(true);}}>Remove</Button></li>)}</ol>
        <div className="flex flex-wrap gap-1">
          <Button size="small" variant="transparent" disabled={!screens.length} onClick={()=>{
            const map=new Map(graph?.nodes.map(node=>[node.mediaId,project.canvas.nodes.find(screen=>screen.lineageId===node.lineageId)?.activeMediaId])??[]);
            const ids=screens.slice(0,20).map(node=>node.activeMediaId!);
            setEntry(map.get(entryMediaId)??entryMediaId);setIncluded(ids);setEdges(current=>current.map(edge=>({...edge,fromMediaId:map.get(edge.fromMediaId)??edge.fromMediaId,toMediaId:map.get(edge.toMediaId)??edge.toMediaId})).filter(edge=>ids.includes(edge.fromMediaId)&&ids.includes(edge.toMediaId)));setFrom("");setTo("");setDirty(true);
          }}>Use current revisions</Button>
          <Button size="small" variant="accent" disabled={!included.length} onClick={()=>void act(async()=>{const current=await prepareProject();adopt(await designerApi.savePrototype({projectId:project.id,expectedRevision:current.revision,entryMediaId,mediaIds:included,edges}));})}>Save prototype</Button>
          <Button size="small" variant="transparent" disabled={dirty||!graph||!graph.edges.length||status==="stale"||status==="broken"} onClick={()=>void act(async()=>{const current=await prepareProject();const result=await designerApi.verifyPrototype({projectId:project.id,expectedRevision:current.revision});adopt(result.project);if(result.error)throw new Error(result.error);})}>Verify links</Button>
          <Button size="small" variant="transparent" disabled={dirty||status!=="verified"} onClick={()=>void act(async()=>{await designerApi.playPrototype({projectId:project.id});})}>Play prototype</Button>
        </div>
        {dirty?<Text as="p" variant="small" color="secondary">Save these changes before verifying or playing.</Text>:null}
      </fieldset>
      {error?<Text as="p" variant="small" color="red" role="alert">{error}</Text>:null}
    </div>
  </details>;
}
