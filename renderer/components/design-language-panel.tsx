import * as React from "react";
import type { DesignProjectSnapshot } from "../shared/design-projects";
import type { DesignLanguageDocumentV1 } from "../shared/design-language";
import type { DesignLanguageProposal, DesignLanguageProposalInput } from "../shared/design-language-proposals";
import { designerApi } from "../lib/ipc";
import { Button, Text } from "./ui";

const EMPTY_TOKENS = { colors: {}, spacing: {}, typography: {}, radii: {} };
export function DesignLanguagePanel({ project, disabled, selectedMediaId, prepareProject, onProjectChange }: {
  project: DesignProjectSnapshot;
  disabled: boolean;
  selectedMediaId?: string;
  prepareProject: () => Promise<DesignProjectSnapshot>;
  onProjectChange: (project: DesignProjectSnapshot) => void;
}) {
  const languages = project.version === 2 ? project.designLanguages ?? [] : [];
  const active = project.version === 2 ? languages.find(item=>item.id===project.activeDesignLanguage?.id) : undefined;
  const [selectedId,setSelectedId] = React.useState(active?.id ?? "");
  const selected = languages.find(item=>item.id===selectedId) ?? active;
  const [name,setName] = React.useState(active?.document.name ?? "Project language");
  const [guidance,setGuidance] = React.useState(active?.document.guidance ?? "");
  const [tokens,setTokens] = React.useState(JSON.stringify(active?.document.tokens ?? EMPTY_TOKENS,null,2));
  const [pending,setPending] = React.useState<{input:DesignLanguageProposalInput;proposal:DesignLanguageProposal;revision:number}>();
  const [busy,setBusy] = React.useState(false);
  const [error,setError] = React.useState<string>();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const act = async (action:()=>Promise<void>) => {
    setBusy(true);setError(undefined);
    try { await action(); } catch(cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {setBusy(false);}
  };
  const document = ():DesignLanguageDocumentV1 => ({version:1,name,guidance,tokens:JSON.parse(tokens)});
  const preview = async (input:DesignLanguageProposalInput, refresh=false) => {
    setPending(undefined);
    let current=await prepareProject();
    if(refresh) {
      current=(await designerApi.refreshDesignSystem({projectId:current.id,expectedRevision:current.revision})).project;
      onProjectChange(current);
    }
    const proposal=await designerApi.previewDesignLanguage(input);
    setPending({input,proposal,revision:current.revision});
  };
  const edit = (action:()=>void) => {setPending(undefined);action();};
  return <details className="px-3 py-2" aria-label="Project Design Language">
    <summary className="cursor-pointer text-small-strong">Design Language · {active?.document.name ?? "None applied"}</summary>
    <div className="mt-2 space-y-2">
      <Text as="p" variant="small" color="secondary">Describe reusable colors, spacing, and typography. Review changes before applying them to future generations.</Text>
      <fieldset disabled={disabled || busy} className="space-y-2">
        <label className="block text-small text-secondary">Name<input aria-label="Design Language name" className="mt-1 w-full rounded-control bg-control p-2 text-primary" maxLength={100} value={name} onChange={e=>edit(()=>setName(e.target.value))}/></label>
        <label className="block text-small text-secondary">Description<input aria-label="Design Language description" className="mt-1 w-full rounded-control bg-control p-2 text-primary" maxLength={2000} value={guidance} onChange={e=>edit(()=>setGuidance(e.target.value))}/></label>
        <details><summary className="cursor-pointer text-small text-secondary">Semantic tokens</summary><label className="sr-only" htmlFor={`language-tokens-${project.id}`}>Design Language token values</label><textarea id={`language-tokens-${project.id}`} className="mt-1 h-32 w-full resize-y rounded-control bg-control p-2 font-mono text-small text-primary" value={tokens} onChange={e=>edit(()=>setTokens(e.target.value))} /></details>
        <div className="flex flex-wrap gap-1">
          <Button size="small" variant="transparent" onClick={()=>void act(()=>preview({projectId:project.id,mode:"describe",document:document()}))}>Preview description</Button>
          <Button size="small" variant="transparent" disabled={!selectedMediaId} onClick={()=>void act(()=>preview({projectId:project.id,mode:"derive",mediaId:selectedMediaId}))}>Derive from Screen</Button>
          <Button size="small" variant="transparent" onClick={()=>inputRef.current?.click()}>Import DESIGN.md</Button>
          <Button size="small" variant="transparent" disabled={!project.designSystemBinding} onClick={()=>void act(()=>preview({projectId:project.id,mode:"workspace"},true))}>Refresh from workspace</Button>
        </div>
        <input ref={inputRef} type="file" accept=".md,text/markdown" className="sr-only" aria-label="Import Design Language file" onChange={e=>{
          const file=e.target.files?.[0];e.target.value="";
          if(file) void act(async()=>{if(file.size>32*1024)throw new Error("DESIGN.md must be smaller than 32 KB.");const text=new TextDecoder("utf-8",{fatal:true}).decode(await file.arrayBuffer());await preview({projectId:project.id,mode:"import",text});});
        }}/>
        {languages.length ? <>
          <label className="block text-small text-secondary">Saved languages<select aria-label="Saved Design Languages" className="ml-2 max-w-full rounded-control bg-control p-2 text-primary" value={selected?.id ?? ""} onChange={e=>{setSelectedId(e.target.value);setPending(undefined);}}>{languages.map(item=><option key={item.id} value={item.id}>{item.document.name} · {item.provenance.kind}{item.id===active?.id?" · Applied":""}</option>)}</select></label>
          <div className="flex flex-wrap gap-1">
            <Button size="small" variant="transparent" disabled={!selected || selected.id===active?.id} onClick={()=>void act(async()=>{const current=await prepareProject();onProjectChange(await designerApi.applyDesignLanguage({projectId:project.id,expectedRevision:current.revision,languageId:selected!.id}));})}>Apply selected</Button>
            <Button size="small" variant="transparent" disabled={!selected} onClick={()=>{if(selected){edit(()=>{setName(selected.document.name);setGuidance(selected.document.guidance);setTokens(JSON.stringify(selected.document.tokens,null,2));});}}}>Edit copy</Button>
            <Button size="small" variant="transparent" disabled={!selected} onClick={()=>void act(()=>preview({projectId:project.id,mode:"merge",baseLanguageId:selected!.id,document:document()}))}>Preview merge</Button>
            <Button size="small" variant="transparent" disabled={!selected} onClick={()=>void act(async()=>{await designerApi.exportDesignLanguage({projectId:project.id,languageId:selected!.id});})}>Export DESIGN.md</Button>
            <Button size="small" variant="transparent" disabled={!active} onClick={()=>void act(async()=>{const current=await prepareProject();onProjectChange(await designerApi.detachDesignLanguage({projectId:project.id,expectedRevision:current.revision}));})}>Detach</Button>
          </div>
          <details><summary className="cursor-pointer text-small text-secondary">Compare selected with applied language</summary><Text as="p" variant="small">Applied</Text><pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all text-mini">{active?JSON.stringify(active.document,null,2):"None"}</pre><Text as="p" variant="small">Selected</Text><pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all text-mini">{selected?JSON.stringify(selected.document,null,2):"None"}</pre></details>
        </> : null}
        {pending ? <section aria-label="Review Design Language" className="rounded-card bg-control p-2">
          <Text as="p" variant="small-strong">Review {pending.proposal.provenance.kind} language</Text>
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all text-mini text-secondary">{pending.proposal.markdown}</pre>
          <Button size="small" variant="accent" onClick={()=>void act(async()=>{const next=await designerApi.saveDesignLanguage({proposal:pending.input,expectedRevision:pending.revision,expectedHash:pending.proposal.reviewHash});onProjectChange(next);if(next.version===2)setSelectedId(next.designLanguages?.[next.designLanguages.length-1]?.id ?? "");setPending(undefined);})}>Save reviewed language</Button>
        </section> : null}
      </fieldset>
      {error ? <Text as="p" variant="small" color="red" role="alert">{error}</Text>:null}
    </div>
  </details>;
}
