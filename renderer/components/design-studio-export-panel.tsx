import * as React from "react";
import type { DesignProjectSnapshot } from "../shared/design-projects";
import type { DesignStudioExportRequest, DesignStudioExportPreview } from "../shared/design-studio-export";
import { designerApi } from "../lib/ipc";
import { Button, Text } from "./ui";
export function DesignStudioExportPanel({project,disabled,screenTitles,workspaces,prepareProject}:{project:DesignProjectSnapshot;disabled:boolean;screenTitles:Record<string,string>;workspaces:Array<{id:string;name:string}>;prepareProject:()=>Promise<DesignProjectSnapshot>}){
  const screens=project.canvas.nodes.filter(node=>node.kind==="artboard");
  const [mediaIds,setMediaIds]=React.useState<string[]>([]);
  const [referenceAssetIds,setReferences]=React.useState<string[]>([]);
  const [brief,setBrief]=React.useState("");
  const [accessibilityNotes,setNotes]=React.useState("");
  const [includeLanguage,setLanguage]=React.useState(false);
  const [includePrototype,setPrototype]=React.useState(false);
  const [preview,setPreview]=React.useState<{request:DesignStudioExportRequest;result:DesignStudioExportPreview}>();
  const [workspaceId,setWorkspaceId]=React.useState(project.workspaceId??"");
  const [kind,setKind]=React.useState<"managed-worktree"|"existing-workspace">("managed-worktree");
  const [target,setTarget]=React.useState<{digest:string;description:string;ack:string|null}>();
  const [acknowledged,setAcknowledged]=React.useState(false);
  const [busy,setBusy]=React.useState(false);
  const [error,setError]=React.useState<string>();
  const [message,setMessage]=React.useState<string>();
  React.useEffect(()=>{
    const currentScreens=new Set(project.canvas.nodes.filter(node=>node.kind==="artboard").map(node=>node.activeMediaId));
    setMediaIds(current=>current.every(id=>currentScreens.has(id))?current:current.filter(id=>currentScreens.has(id)));
    setReferences(current=>current.every(id=>project.referenceAssetIds.includes(id))?current:current.filter(id=>project.referenceAssetIds.includes(id)));
    if(project.version!==2||!project.activeDesignLanguage)setLanguage(false);
    if(project.version!==2||!project.prototype)setPrototype(false);
    if(project.workspaceId)setWorkspaceId(project.workspaceId);
    setPreview(current=>current&&current.result.projectRevision!==project.revision?undefined:current);
    setTarget(undefined);
    setAcknowledged(false);
  },[project]);
  const edit=(fn:()=>void)=>{fn();setPreview(undefined);setTarget(undefined);setAcknowledged(false);setMessage(undefined);};
  const act=async(fn:()=>Promise<void>)=>{setBusy(true);setError(undefined);try{await fn();}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setBusy(false);}};
  return <details className="px-3 py-2" aria-label="Review project export">
    <summary className="cursor-pointer text-small-strong">Export and handoff</summary>
    <div className="mt-2 space-y-2">
      <Text as="p" variant="small" color="secondary">Choose exact current Screens and review what leaves this project.</Text>
      <fieldset disabled={disabled||busy} className="space-y-2">
        <details><summary className="cursor-pointer text-small">Screens ({mediaIds.length}/20)</summary>{screens.map((node,index)=><label key={node.id} className="flex items-center gap-2 text-small"><input type="checkbox" checked={mediaIds.includes(node.activeMediaId!)} disabled={!mediaIds.includes(node.activeMediaId!)&&mediaIds.length>=20} onChange={e=>edit(()=>setMediaIds(current=>e.target.checked?[...current,node.activeMediaId!]:current.filter(id=>id!==node.activeMediaId)))}/>{screenTitles[node.activeMediaId!]??`Screen ${index+1}`}</label>)}</details>
        <details><summary className="cursor-pointer text-small">References ({referenceAssetIds.length}/10)</summary>{project.referenceAssetIds.map((id,index)=><label key={id} className="flex items-center gap-2 text-small"><input type="checkbox" checked={referenceAssetIds.includes(id)} disabled={!referenceAssetIds.includes(id)&&referenceAssetIds.length>=10} onChange={e=>edit(()=>setReferences(current=>e.target.checked?[...current,id]:current.filter(item=>item!==id)))}/>Reference {index+1}</label>)}</details>
        <label className="block text-small text-secondary">Project brief<textarea aria-label="Export Project Brief" className="mt-1 w-full rounded-control bg-control p-2 text-primary" maxLength={4096} value={brief} onChange={e=>edit(()=>setBrief(e.target.value))}/></label>
        <label className="block text-small text-secondary">Accessibility notes<textarea aria-label="Export accessibility notes" className="mt-1 w-full rounded-control bg-control p-2 text-primary" maxLength={2048} value={accessibilityNotes} onChange={e=>edit(()=>setNotes(e.target.value))}/></label>
        <label className="flex items-center gap-2 text-small"><input type="checkbox" checked={includeLanguage} disabled={project.version!==2||!project.activeDesignLanguage} onChange={e=>edit(()=>setLanguage(e.target.checked))}/>Include applied Design Language</label>
        <label className="flex items-center gap-2 text-small"><input type="checkbox" checked={includePrototype} disabled={project.version!==2||!project.prototype} onChange={e=>edit(()=>setPrototype(e.target.checked))}/>Include prototype graph</label>
        <Button size="small" variant="transparent" disabled={!mediaIds.length} onClick={()=>void act(async()=>{await prepareProject();const request={projectId:project.id,mediaIds,referenceAssetIds,brief,accessibilityNotes,includeLanguage,includePrototype};setPreview({request,result:await designerApi.previewStudioExport(request)});setTarget(undefined);setAcknowledged(false);})}>Preview project bundle</Button>
        {preview?<section aria-label="Reviewed project bundle" className="space-y-2 rounded-card bg-control p-2">
          <Text as="p" variant="small-strong">{preview.result.fileName} · {Math.ceil(preview.result.byteSize/1024)} KB</Text>
          <details><summary className="cursor-pointer text-small">Review files and exact sources</summary><pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all text-mini">{preview.result.manifestJson}</pre></details>
          <details><summary className="cursor-pointer text-small">Review brief and Design Language</summary><pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all text-mini">{preview.result.briefMarkdown+"\n"+preview.result.designMarkdown}</pre></details>
          <Button size="small" variant="accent" onClick={()=>void act(async()=>{const result=await designerApi.exportStudioBundle({request:preview.request,reviewDigest:preview.result.reviewDigest});if(result.status==="saved")setMessage(`Saved ${result.fileName}`);})}>Export reviewed ZIP</Button>
          <label className="block text-small">Workspace <select aria-label="Handoff workspace" disabled={Boolean(project.workspaceId)} className="max-w-full rounded-control bg-control p-1 text-primary" value={workspaceId} onChange={e=>{setWorkspaceId(e.target.value);setTarget(undefined);setAcknowledged(false);}}><option value="">Choose workspace</option>{workspaces.map(workspace=><option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
          <label className="block text-small">Destination <select aria-label="Handoff destination" className="max-w-full rounded-control bg-control p-1 text-primary" value={kind} onChange={e=>{setKind(e.target.value as typeof kind);setTarget(undefined);setAcknowledged(false);}}><option value="managed-worktree">New managed worktree</option><option value="existing-workspace">Existing workspace</option></select></label>
          <Button size="small" variant="transparent" disabled={!workspaceId} onClick={()=>void act(async()=>{if(kind==="managed-worktree"){const result=await designerApi.previewManagedHandoff(project.id,workspaceId);setTarget({digest:result.previewDigest,description:`${result.source.workspaceLabel} · ${result.source.branchLabel}`,ack:result.requiredDirtyCheckoutAcknowledgement});}else{const result=await designerApi.previewExistingHandoff(project.id,workspaceId);setTarget({digest:result.previewDigest,description:`${result.target.workspaceLabel} · ${result.target.branchLabel}`,ack:result.requiredStrongWarningAcknowledgement});}setAcknowledged(false);})}>Review workspace handoff</Button>
          {target?<><Text as="p" variant="small">{target.description}</Text>{target.ack?<label className="flex items-start gap-2 text-small"><input type="checkbox" checked={acknowledged} onChange={e=>setAcknowledged(e.target.checked)}/>{target.ack}</label>:null}<Text as="p" variant="small" color="secondary">Creates a workspace task with this reviewed context. Workspace permissions still apply.</Text><Button size="small" variant="accent" disabled={Boolean(target.ack)&&!acknowledged} onClick={()=>void act(async()=>{const result=await designerApi.beginStudioHandoff({request:preview.request,reviewDigest:preview.result.reviewDigest,sourceWorkspaceId:workspaceId,targetDigest:target.digest,kind,acknowledged,operationId:crypto.randomUUID()});setMessage(result.status==="published"?"Handoff created. Open the workspace task to continue.":`Handoff ${result.status}. Check project recovery before retrying.`);setTarget(undefined);})}>Continue with reviewed scope</Button></>:null}
        </section>:null}
      </fieldset>
      {error?<Text as="p" variant="small" color="red" role="alert">{error}</Text>:null}
      {message?<Text as="p" variant="small" role="status">{message}</Text>:null}
    </div>
  </details>;
}
