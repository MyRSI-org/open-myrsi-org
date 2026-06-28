
import React, { useState, useEffect, useRef } from 'react';
import { useConfig } from '../../../contexts/ConfigContext';
import { TabPageHeader } from '../../shared/ui';
import { useNotification } from '../../../contexts/NotificationContext';

const DEFAULT_TOS_HTML = `
<h2 class="text-xl font-semibold text-sky-300 border-b-2 border-sky-500/30 pb-1">1. Introduction to Services</h2>
<section class="space-y-2">
  <div class="text-slate-300 space-y-3 prose-p:my-0">
    <p>These Terms of Service ("Terms") create an agreement between you (the "Client") and the Organisation ("ORG"), a lawful emergency services and rescue organisation operating within United Empire of Earth (UEE) jurisdiction.</p>
    <p>By submitting a request through the ORG Operations Portal, Discord, or in-game communication, the Client acknowledges and accepts these Terms.</p>
    <p>The Organisation provides the following service categories:</p>
    <ul class="list-inside space-y-2 pl-4 list-disc">
      <li>Security: escort, overwatch, deterrence, patrol, asset protection</li>
      <li>Rescue: personnel recovery, medical support, extraction from hazardous environments</li>
      <li>Logistics: cargo transport, delivery, supply chain assistance, lawful salvage recovery</li>
    </ul>
    <p>All operations are conducted in-game only within the LIVE PU environment. Requests originating from the PTU may be denied.</p>
  </div>
</section>
<h2 class="text-xl font-semibold text-sky-300 border-b-2 border-sky-500/30 pb-1">2. Availability and Response</h2>
<section class="space-y-2">
  <div class="text-slate-300 space-y-3 prose-p:my-0">
    <p>The Organisation operates on an on-duty personnel model. Response times may vary based on:</p>
    <ul class="list-inside space-y-2 pl-4 list-disc">
      <li>Member availability</li>
      <li>Operational tempo &amp; current mission load</li>
      <li>Game server stability or outages</li>
    </ul>
    <p>The Organisation cannot guarantee immediate response, full team availability, or successful completion of any requested task.</p>
    <p>The Client acknowledges that Star Citizen is in active development, and technical issues may prevent or interrupt service at any time.</p>
  </div>
</section>
<h2 class="text-xl font-semibold text-sky-300 border-b-2 border-sky-500/30 pb-1">3. Client Conduct Requirements</h2>
<section class="space-y-2">
  <div class="text-slate-300 space-y-3 prose-p:my-0">
    <p>The Client agrees to:</p>
    <ol class="list-inside space-y-2 pl-4 list-decimal">
      <li>Provide accurate information when submitting a service request.</li>
      <li>Follow reasonable instructions issued by ORG Dispatch or responding personnel.</li>
      <li>Not interfere with or obstruct ORG operations.</li>
      <li>Avoid hostile or deceptive conduct.</li>
    </ol>
    <p>Failure to comply may result in cancellation of service, withdrawal of personnel, and/or Client blocklisting.</p>
  </div>
</section>
<h2 class="text-xl font-semibold text-sky-300 border-b-2 border-sky-500/30 pb-1">4. Service Refusal and Termination</h2>
<section class="space-y-2">
  <div class="text-slate-300 space-y-3 prose-p:my-0">
    <p>The Organisation reserves the right to deny or terminate service when:</p>
    <ul class="list-inside space-y-2 pl-4 list-disc">
      <li>The client's location is inaccessible, unstable, or non-viable due to game conditions.</li>
      <li>The operational environment contains overwhelming hostile force beyond safe risk tolerance.</li>
      <li>The request is determined to be a trap, ambush, or baiting attempt.</li>
      <li>The client has engaged in piracy, griefing, harassment, or targeted attacks.</li>
      <li>The client or their organisation has previously acted with hostility toward the Organisation.</li>
    </ul>
    <p>The Organisation is a lawful organisation and does not support piracy, criminal activity, or griefing. Clients requesting support during the commission of an active criminal act may be denied or receive reduced assistance.</p>
  </div>
</section>
<h2 class="text-xl font-semibold text-sky-300 border-b-2 border-sky-500/30 pb-1">5. Limitations of Service</h2>
<section class="space-y-2">
  <div class="text-slate-300 space-y-3 prose-p:my-0">
    <p>The Organisation does not guarantee:</p>
    <ul class="list-inside space-y-2 pl-4 list-disc">
      <li>Recovery of ship, cargo, gear, corps, or equipment</li>
      <li>Protection from criminal penalties arising from client actions</li>
      <li>Success of any escort, rescue, patrol, transport or other mission</li>
    </ul>
    <p>The Organisation will attempt recovery of client property when reasonable and lawful, but outcomes are not guaranteed.</p>
  </div>
</section>
<h2 class="text-xl font-semibold text-sky-300 border-b-2 border-sky-500/30 pb-1">6. Limitations of Liability</h2>
<section class="space-y-2">
  <div class="text-slate-300 space-y-3 prose-p:my-0">
    <p>To the fullest extent permitted under UEE Civil Code, the Organisation is not liable for:</p>
    <ul class="list-inside space-y-2 pl-4 list-disc">
      <li>Loss of ships, vehicles, equipment, or cargo</li>
      <li>Loss of in-game currency or character reputation</li>
      <li>Character death or respawn penalties</li>
      <li>Service interruption due to game instability or server issues</li>
    </ul>
    <p>The Client accepts all operational risks.</p>
  </div>
</section>
<h2 class="text-xl font-semibold text-sky-300 border-b-2 border-sky-500/30 pb-1">7. Amendments</h2>
<section class="space-y-2">
  <div class="text-slate-300 space-y-3 prose-p:my-0">
    <p>The Organisation may update or modify these Terms at any time. Continued use of the Organisation's services constitutes acceptance of the current version.</p>
  </div>
</section>
<h2 class="text-xl font-semibold text-sky-300 border-b-2 border-sky-500/30 pb-1">8. Acknowledgement</h2>
<section class="space-y-2">
  <div class="text-slate-300 space-y-3 prose-p:my-0">
    <p>By requesting the Organisation's services, the Client confirms that they:</p>
    <ul class="list-inside space-y-2 pl-4 list-disc">
      <li>Have read and understood these Terms</li>
      <li>Agree to comply with all lawful instructions from ORG personnel</li>
      <li>Accept all risks associated with in-game operations</li>
    </ul>
  </div>
</section>
`;

const ToolbarButton: React.FC<{ icon: string; cmd: string; arg?: string; title: string; onExec: (command: string, value?: string) => void }> = ({ icon, cmd, arg, title, onExec }) => (
    <button
        type="button"
        onClick={(e) => { e.preventDefault(); onExec(cmd, arg); }}
        className="p-2 text-slate-400 hover:text-white hover:bg-slate-700/50 rounded-sm transition-colors"
        title={title}
    >
        <i className={`fa-solid ${icon}`}></i>
    </button>
);

const RichTextEditor: React.FC<{ value: string; onChange: (html: string) => void }> = ({ value, onChange }) => {
    const editorRef = useRef<HTMLDivElement>(null);
    const [isFocused, setIsFocused] = useState(false);

    useEffect(() => {
        if (editorRef.current) {
            if (document.activeElement !== editorRef.current) {
                if (editorRef.current.innerHTML !== value) {
                    editorRef.current.innerHTML = value || '';
                }
            }
        }
    }, [value]);

    const handleInput = () => {
        if (editorRef.current) {
            onChange(editorRef.current.innerHTML);
        }
    };

    const execCmd = (command: string, value: string | undefined = undefined) => {
        document.execCommand(command, false, value);
        if (editorRef.current) editorRef.current.focus();
    };

    return (
        <div className={`border rounded-lg overflow-hidden flex flex-col min-h-[400px] transition-all ${isFocused ? 'border-slate-400 ring-1 ring-slate-400/40' : 'border-slate-700 bg-slate-900/30'}`}>
            <div className="bg-slate-900/60 border-b border-slate-700 p-1 flex space-x-1 flex-wrap">
                <ToolbarButton icon="fa-heading" cmd="formatBlock" arg="H2" title="Heading" onExec={execCmd} />
                <ToolbarButton icon="fa-paragraph" cmd="formatBlock" arg="P" title="Paragraph" onExec={execCmd} />
                <div className="w-px h-6 bg-slate-700 mx-2 self-center"></div>
                <ToolbarButton icon="fa-bold" cmd="bold" title="Bold" onExec={execCmd} />
                <ToolbarButton icon="fa-italic" cmd="italic" title="Italic" onExec={execCmd} />
                <ToolbarButton icon="fa-underline" cmd="underline" title="Underline" onExec={execCmd} />
                <div className="w-px h-6 bg-slate-700 mx-2 self-center"></div>
                <ToolbarButton icon="fa-list-ul" cmd="insertUnorderedList" title="Bullet List" onExec={execCmd} />
                <ToolbarButton icon="fa-list-ol" cmd="insertOrderedList" title="Numbered List" onExec={execCmd} />
                <div className="w-px h-6 bg-slate-700 mx-2 self-center"></div>
                <ToolbarButton icon="fa-rotate-left" cmd="undo" title="Undo" onExec={execCmd} />
                <ToolbarButton icon="fa-rotate-right" cmd="redo" title="Redo" onExec={execCmd} />
            </div>
            <div
                ref={editorRef}
                contentEditable
                onInput={handleInput}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                className="grow p-4 text-slate-300 outline-hidden prose prose-invert prose-sm max-w-none overflow-y-auto"
                style={{ minHeight: '300px' }}
            />
        </div>
    );
};

const LegalDocumentsTab: React.FC = () => {
    const { brandingConfig, updateBrandingConfig } = useConfig();
    const { addToast, confirm } = useNotification();
    const [tosHtml, setTosHtml] = useState<string>(brandingConfig.termsOfService || '');
    const [isSaving, setIsSaving] = useState(false);
    const [isSaved, setIsSaved] = useState(false);

    // Re-seed the local editable copy whenever the source-of-truth changes
    // (initial hydration from the server, or refreshMain after a successful save).
    // Done during render via a previous-value tracker — the React-recommended
    // "adjusting state when a prop changes" pattern — instead of an effect, so it
    // does not trigger a cascading render. Local edits (keystrokes / Reset Template)
    // mutate tosHtml only, leaving brandingConfig.termsOfService unchanged, so the
    // tracker stays equal and edits are preserved exactly as before.
    const sourceTos = brandingConfig.termsOfService || '';
    const [prevSourceTos, setPrevSourceTos] = useState<string>(sourceTos);
    if (prevSourceTos !== sourceTos) {
        setPrevSourceTos(sourceTos);
        setTosHtml(sourceTos);
    }

    const handleLoadDefaultTos = async () => {
        const confirmed = await confirm({ title: 'Reset Template', message: 'This will overwrite the current Terms of Service text with the default template. Continue?', confirmText: 'Reset', variant: 'danger' });
        if (!confirmed) return;
        setTosHtml(DEFAULT_TOS_HTML);
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            await updateBrandingConfig({ ...brandingConfig, termsOfService: tosHtml });
            setIsSaved(true);
            setTimeout(() => setIsSaved(false), 2000);
        } catch (err) {
            console.error(err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to save legal documents." });
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="p-4 md:p-8 space-y-6 animate-fade-in">
            <TabPageHeader
                title="Legal Documents"
                icon="fa-solid fa-scale-balanced"
                accent="slate"
                subtitle="Terms of Service shown to clients on intake and dashboard."
            />

            <div className="bg-slate-900/80 backdrop-blur-md border border-slate-700/50 rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-white/5 bg-white/5 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-lg bg-slate-800/80 border border-slate-700 flex items-center justify-center">
                            <i className="fa-solid fa-file-contract text-slate-300 text-sm"></i>
                        </div>
                        <div>
                            <h3 className="text-xs font-black uppercase tracking-widest text-slate-200">Terms of Service</h3>
                            <p className="text-[10px] text-slate-500 mt-0.5">Shown to clients on request submission and on their dashboard.</p>
                        </div>
                    </div>
                    <button
                        onClick={handleLoadDefaultTos}
                        className="text-[10px] font-bold text-slate-300 hover:text-white uppercase tracking-wider px-3 py-1.5 rounded-md border border-slate-700 hover:border-slate-500 transition-colors"
                    >
                        <i className="fa-solid fa-rotate-right mr-1.5"></i>
                        Reset Template
                    </button>
                </div>
                <div className="p-5">
                    <RichTextEditor value={tosHtml} onChange={setTosHtml} />
                </div>
            </div>

            <div className="flex justify-end pt-4">
                <button
                    onClick={handleSave}
                    disabled={isSaving || isSaved}
                    className={`px-8 py-3 text-xs font-black uppercase tracking-widest rounded-lg border transition-all shadow-lg transform active:scale-95 ${isSaving
                        ? 'bg-slate-800 border-slate-700 text-slate-400 cursor-wait'
                        : isSaved
                            ? 'bg-green-500/10 border-green-500/40 text-green-300'
                            : 'bg-slate-700 hover:bg-slate-600 border-slate-600 text-white'}`}
                >
                    {isSaving ? <><i className="fa-solid fa-spinner animate-spin mr-2" />Saving</> : isSaved ? <><i className="fa-solid fa-check mr-2" />Saved</> : 'Publish Legal Documents'}
                </button>
            </div>
        </div>
    );
};

export default LegalDocumentsTab;
